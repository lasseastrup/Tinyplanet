import { PROP_KINDS, PROP_VARIANTS, type PropKind, type PropSet } from '../planet/props';
import { propGeometry } from '../render/propGeometry';

interface Bounds {
  /** Model height and trunk-to-crown radius, in model units (multiply by the prop's scale). */
  height: number;
  radius: number;
}

let bounds: Map<string, Bounds> | null = null;

/** Collision cylinders of every prop model, measured once from the geometry. */
function boundsOf(kind: PropKind, variant: number): Bounds {
  if (!bounds) {
    bounds = new Map();
    for (const k of PROP_KINDS) {
      for (let v = 0; v < PROP_VARIANTS[k]; v++) {
        const g = propGeometry(k, v);
        g.computeBoundingBox();
        const b = g.boundingBox!;
        const r = Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z);
        bounds.set(`${k}:${v}`, { height: b.max.y, radius: r * 0.8 });
        g.dispose();
      }
    }
  }
  return bounds.get(`${kind}:${Math.min(PROP_VARIANTS[kind] - 1, variant)}`)!;
}

/**
 * The planet's props as upright cylinders in a spatial hash, for "did this bolt hit a tree?" and
 * "how high must the ship fly here?". Positions are planet-local.
 */
export class PropField {
  count = 0;
  kinds: PropKind[] = [];
  /** Index of each prop within its PropSet. */
  indices = new Int32Array(0);
  base = new Float32Array(0);
  up = new Float32Array(0);
  height = new Float32Array(0);
  radius = new Float32Array(0);
  alive = new Uint8Array(0);
  /** Linear RGB: main tint (foliage, roof, rock) and secondary (trunk, walls). */
  color = new Float32Array(0);
  color2 = new Float32Array(0);
  private cells = new Map<number, number[]>();
  private cell = 1;
  private margin = 0;

  /**
   * @param unit typical prop height (planet radii)
   * @param margin largest padding later queries will use
   */
  build(sets: PropSet[], unit: number, margin: number): void {
    const n = sets.reduce((s, set) => s + set.count, 0);
    this.count = n;
    this.kinds = new Array<PropKind>(n);
    this.indices = new Int32Array(n);
    this.base = new Float32Array(n * 3);
    this.up = new Float32Array(n * 3);
    this.height = new Float32Array(n);
    this.radius = new Float32Array(n);
    this.alive = new Uint8Array(n).fill(1);
    this.color = new Float32Array(n * 3);
    this.color2 = new Float32Array(n * 3);
    this.cells = new Map();
    this.cell = unit * 1.5;
    this.margin = margin;
    let i = 0;
    for (const set of sets) {
      for (let k = 0; k < set.count; k++, i++) {
        const b = boundsOf(set.kind, set.variants[k]);
        const s = set.scales[k];
        this.kinds[i] = set.kind;
        this.indices[i] = k;
        for (let c = 0; c < 3; c++) {
          this.base[i * 3 + c] = set.positions[k * 3 + c];
          this.up[i * 3 + c] = set.ups[k * 3 + c];
          this.color[i * 3 + c] = set.colors[k * 3 + c];
          this.color2[i * 3 + c] = set.colors2[k * 3 + c];
        }
        this.height[i] = b.height * s;
        this.radius[i] = b.radius * s;
        this.insert(i);
      }
    }
  }

  private key(ix: number, iy: number, iz: number): number {
    return ((ix + 1024) * 2048 + (iy + 1024)) * 2048 + (iz + 1024);
  }

  /** File the prop under every cell its padded bounding box touches. */
  private insert(i: number): void {
    const h = this.height[i] / 2;
    const ext = Math.hypot(h, this.radius[i]) + this.margin;
    const cx = this.base[i * 3] + this.up[i * 3] * h;
    const cy = this.base[i * 3 + 1] + this.up[i * 3 + 1] * h;
    const cz = this.base[i * 3 + 2] + this.up[i * 3 + 2] * h;
    const c = this.cell;
    for (let ix = Math.floor((cx - ext) / c); ix <= Math.floor((cx + ext) / c); ix++) {
      for (let iy = Math.floor((cy - ext) / c); iy <= Math.floor((cy + ext) / c); iy++) {
        for (let iz = Math.floor((cz - ext) / c); iz <= Math.floor((cz + ext) / c); iz++) {
          const k = this.key(ix, iy, iz);
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
      }
    }
  }

  private near(x: number, y: number, z: number): number[] | undefined {
    const c = this.cell;
    return this.cells.get(this.key(Math.floor(x / c), Math.floor(y / c), Math.floor(z / c)));
  }

  /** First standing prop whose cylinder (grown by `pad`) contains the point, or -1. */
  hitAt(x: number, y: number, z: number, pad: number): number {
    const list = this.near(x, y, z);
    if (!list) return -1;
    for (const i of list) {
      if (!this.alive[i]) continue;
      const dx = x - this.base[i * 3];
      const dy = y - this.base[i * 3 + 1];
      const dz = z - this.base[i * 3 + 2];
      const h = dx * this.up[i * 3] + dy * this.up[i * 3 + 1] + dz * this.up[i * 3 + 2];
      if (h < -pad || h > this.height[i] + pad) continue;
      const lat2 = dx * dx + dy * dy + dz * dz - h * h;
      const r = this.radius[i] + pad;
      if (lat2 <= r * r) return i;
    }
    return -1;
  }

  /**
   * Distance from the planet centre of the highest standing prop top within `reach` of the
   * vertical line through the point (0 if none).
   */
  topNear(x: number, y: number, z: number, reach: number): number {
    const list = this.near(x, y, z);
    if (!list) return 0;
    const len = Math.hypot(x, y, z) || 1;
    const rx = x / len;
    const ry = y / len;
    const rz = z / len;
    let top = 0;
    for (const i of list) {
      if (!this.alive[i]) continue;
      const bx = this.base[i * 3];
      const by = this.base[i * 3 + 1];
      const bz = this.base[i * 3 + 2];
      // Lateral distance between the prop's axis and the query line (both roughly radial).
      const along = bx * rx + by * ry + bz * rz;
      const lx = bx - rx * along;
      const ly = by - ry * along;
      const lz = bz - rz * along;
      const r = this.radius[i] + reach;
      if (lx * lx + ly * ly + lz * lz > r * r) continue;
      top = Math.max(top, along + this.height[i]);
    }
    return top;
  }

  kill(i: number): void {
    this.alive[i] = 0;
  }

  /** Planet-local centre of a prop's cylinder. */
  center(i: number, out: { x: number; y: number; z: number }): void {
    const h = this.height[i] / 2;
    out.x = this.base[i * 3] + this.up[i * 3] * h;
    out.y = this.base[i * 3 + 1] + this.up[i * 3 + 1] * h;
    out.z = this.base[i * 3 + 2] + this.up[i * 3 + 2] * h;
  }
}

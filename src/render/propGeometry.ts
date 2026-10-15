/**
 * Low-poly, flat-shaded prop models built procedurally. Object space: +Y is up, the base sits at
 * y = 0 and the model is roughly 1 unit tall (instances scale it).
 *
 * Each vertex has an `aPart` id used for colouring:
 *   0 = wood / door, 1 = tinted (foliage, rock, roof, cactus — per-instance colour),
 *   2 = walls, 3 = windows (glow at night), 4 = cloud.
 */
import * as THREE from 'three';
import type { PropKind, PropSet } from '../planet/props';

export const PART = { wood: 0, tint: 1, wall: 2, window: 3, cloud: 4 } as const;

/** Fixed colours of the untinted parts (sRGB hex). */
export const PROP_COLORS = { wood: '#6b4a33', wall: '#f1e4cb', window: '#2f3b4c', windowGlow: '#ffb85c' } as const;

type V3 = [number, number, number];

class FlatBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly part: number[] = [];

  tri(a: V3, b: V3, c: V3, part: number): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return;
    nx /= l;
    ny /= l;
    nz /= l;
    for (const v of [a, b, c]) {
      this.pos.push(v[0], v[1], v[2]);
      this.nor.push(nx, ny, nz);
      this.part.push(part);
    }
  }

  quad(a: V3, b: V3, c: V3, d: V3, part: number): void {
    this.tri(a, b, c, part);
    this.tri(a, c, d, part);
  }

  /** Vertical prism/frustum (sides + optional caps); radiusTop 0 makes a cone. */
  prism(rBottom: number, rTop: number, y0: number, y1: number, sides: number, part: number, phase = 0, cx = 0, cz = 0): void {
    const ring = (r: number, y: number): V3[] =>
      Array.from({ length: sides }, (_, i) => {
        const a = phase + (i / sides) * Math.PI * 2;
        return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r] as V3;
      });
    const bottom = ring(rBottom, y0);
    const top = ring(rTop, y1);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (rTop <= 1e-6) this.tri(bottom[j], bottom[i], [cx, y1, cz], part);
      else this.quad(bottom[j], bottom[i], top[i], top[j], part);
    }
    // bottom cap (faces down) and top cap (faces up)
    for (let i = 1; i < sides - 1; i++) this.tri(bottom[0], bottom[i + 1], bottom[i], part);
    if (rTop > 1e-6) for (let i = 1; i < sides - 1; i++) this.tri(top[0], top[i], top[i + 1], part);
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, part: number): void {
    const p = (x: number, y: number, z: number): V3 => [x, y, z];
    this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), part); // front +z
    this.quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), part); // back
    this.quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), part); // +x
    this.quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), part); // -x
    this.quad(p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0), part); // top
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), part); // bottom
  }

  /** Flat rectangle just proud of an axis-aligned wall (door, window). `c` is its centre along the wall. */
  panel(side: '+x' | '-x' | '+z' | '-z', plane: number, c: number, hw: number, y0: number, y1: number, part: number): void {
    const e = 0.006;
    switch (side) {
      case '+x':
        this.quad([plane + e, y0, c + hw], [plane + e, y0, c - hw], [plane + e, y1, c - hw], [plane + e, y1, c + hw], part);
        break;
      case '-x':
        this.quad([-plane - e, y0, c - hw], [-plane - e, y0, c + hw], [-plane - e, y1, c + hw], [-plane - e, y1, c - hw], part);
        break;
      case '+z':
        this.quad([c - hw, y0, plane + e], [c + hw, y0, plane + e], [c + hw, y1, plane + e], [c - hw, y1, plane + e], part);
        break;
      case '-z':
        this.quad([c + hw, y0, -plane - e], [c - hw, y0, -plane - e], [c - hw, y1, -plane - e], [c + hw, y1, -plane - e], part);
        break;
    }
  }

  /** Low-poly blob: an icosahedron with deterministic vertex jitter. */
  blob(cx: number, cy: number, cz: number, r: number, sx: number, sy: number, sz: number, jitter: number, seed: number, part: number, detail = 0): void {
    const ico = new THREE.IcosahedronGeometry(1, detail);
    const pos = ico.getAttribute('position') as THREE.BufferAttribute;
    const jit = (x: number, y: number, z: number): number => {
      const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453;
      return (h - Math.floor(h)) * 2 - 1;
    };
    const tf = (i: number): V3 => {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const k = 1 + jit(Math.round(x * 1e3), Math.round(y * 1e3), Math.round(z * 1e3)) * jitter;
      return [cx + x * r * sx * k, cy + y * r * sy * k, cz + z * r * sz * k];
    };
    for (let i = 0; i < pos.count; i += 3) this.tri(tf(i), tf(i + 1), tf(i + 2), part);
    ico.dispose();
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.computeBoundingSphere();
    return g;
  }
}

function conifer(): THREE.BufferGeometry {
  const b = new FlatBuilder();
  b.prism(0.075, 0.06, 0, 0.24, 5, PART.wood);
  b.prism(0.42, 0, 0.14, 0.62, 7, PART.tint, 0.2);
  b.prism(0.33, 0, 0.38, 0.86, 7, PART.tint, 0.7);
  b.prism(0.23, 0, 0.62, 1.06, 7, PART.tint, 1.1);
  return b.build();
}

function broadleaf(): THREE.BufferGeometry {
  const b = new FlatBuilder();
  b.prism(0.08, 0.055, 0, 0.44, 5, PART.wood);
  b.blob(0, 0.68, 0, 0.36, 1, 0.92, 1, 0.12, 1, PART.tint);
  b.blob(0.17, 0.52, 0.08, 0.24, 1, 0.9, 1, 0.15, 2, PART.tint);
  b.blob(-0.14, 0.56, -0.1, 0.22, 1, 0.9, 1, 0.15, 3, PART.tint);
  return b.build();
}

function jungle(): THREE.BufferGeometry {
  const b = new FlatBuilder();
  b.prism(0.06, 0.04, 0, 0.66, 5, PART.wood);
  b.blob(0, 0.76, 0, 0.46, 1, 0.42, 1, 0.12, 4, PART.tint);
  b.blob(0.05, 0.9, -0.03, 0.28, 1, 0.5, 1, 0.12, 5, PART.tint);
  return b.build();
}

function cactus(): THREE.BufferGeometry {
  const b = new FlatBuilder();
  b.prism(0.13, 0.12, 0, 0.82, 6, PART.tint);
  b.prism(0.12, 0.05, 0.82, 0.92, 6, PART.tint);
  // left arm
  b.box(-0.3, -0.1, 0.34, 0.44, -0.05, 0.05, PART.tint);
  b.prism(0.07, 0.065, 0.34, 0.66, 6, PART.tint, 0, -0.28, 0);
  // right arm
  b.box(0.1, 0.26, 0.48, 0.56, -0.045, 0.045, PART.tint);
  b.prism(0.06, 0.055, 0.48, 0.74, 6, PART.tint, 0, 0.25, 0);
  return b.build();
}

function rock(): THREE.BufferGeometry {
  const b = new FlatBuilder();
  b.blob(0, 0.22, 0, 0.5, 1, 0.62, 0.82, 0.22, 7, PART.tint);
  return b.build();
}

function house(): THREE.BufferGeometry {
  const b = new FlatBuilder();
  const w = 0.36;
  const d = 0.27;
  const h = 0.42;
  b.box(-w, w, 0, h, -d, d, PART.wall);
  // Gable roof with overhang (ridge along x).
  const ox = w + 0.06;
  const oz = d + 0.08;
  const eave = h - 0.04;
  const ridge = 0.78;
  b.quad([-ox, eave, oz], [ox, eave, oz], [ox, ridge, 0], [-ox, ridge, 0], PART.tint);
  b.quad([ox, eave, -oz], [-ox, eave, -oz], [-ox, ridge, 0], [ox, ridge, 0], PART.tint);
  // underside of the overhang
  b.quad([-ox, eave, oz], [-ox, eave, -oz], [ox, eave, -oz], [ox, eave, oz], PART.tint);
  // gables
  b.tri([w, h, d], [w, h, -d], [w, ridge - 0.02, 0], PART.wall);
  b.tri([-w, h, -d], [-w, h, d], [-w, ridge - 0.02, 0], PART.wall);
  // chimney
  b.box(0.12, 0.22, 0.5, 0.86, -0.14, -0.04, PART.wall);
  // door and windows, slightly proud of the walls
  const e = 0.006;
  b.quad([-0.07, 0, d + e], [0.07, 0, d + e], [0.07, 0.22, d + e], [-0.07, 0.22, d + e], PART.wood);
  for (const x of [-0.24, 0.24]) {
    b.quad([x - 0.06, 0.17, d + e], [x + 0.06, 0.17, d + e], [x + 0.06, 0.29, d + e], [x - 0.06, 0.29, d + e], PART.window);
    b.quad([x + 0.06, 0.17, -d - e], [x - 0.06, 0.17, -d - e], [x - 0.06, 0.29, -d - e], [x + 0.06, 0.29, -d - e], PART.window);
  }
  b.quad([w + e, 0.17, 0.06], [w + e, 0.17, -0.06], [w + e, 0.29, -0.06], [w + e, 0.29, 0.06], PART.window);
  b.quad([-w - e, 0.17, -0.06], [-w - e, 0.17, 0.06], [-w - e, 0.29, 0.06], [-w - e, 0.29, -0.06], PART.window);
  return b.build();
}

/** Village chapel: a nave with a gable roof and a front tower with a pointed spire. */
function tower(): THREE.BufferGeometry {
  const b = new FlatBuilder();
  // Nave along z, behind the tower.
  const w = 0.24;
  const back = -0.55;
  const front = 0.1;
  const h = 0.46;
  b.box(-w, w, 0, h, back, front, PART.wall);
  const ox = w + 0.07;
  const eave = h - 0.04;
  const ridge = 0.82;
  const z0 = back - 0.06;
  b.quad([ox, eave, z0], [0, ridge, z0], [0, ridge, front], [ox, eave, front], PART.tint);
  b.quad([-ox, eave, front], [0, ridge, front], [0, ridge, z0], [-ox, eave, z0], PART.tint);
  b.quad([-ox, eave, z0], [ox, eave, z0], [ox, eave, front], [-ox, eave, front], PART.tint);
  b.tri([w, h, back], [-w, h, back], [0, ridge - 0.02, back], PART.wall);
  for (const z of [-0.4, -0.16]) {
    b.panel('+x', w, z, 0.045, 0.18, 0.34, PART.window);
    b.panel('-x', w, z, 0.045, 0.18, 0.34, PART.window);
  }
  // Tower and spire.
  const tw = 0.19;
  const tz = 0.29;
  const top = 1.08;
  b.box(-tw, tw, 0, top, tz - tw, tz + tw, PART.wall);
  b.prism((tw + 0.045) * Math.SQRT2, 0, top, 1.74, 4, PART.tint, Math.PI / 4, 0, tz);
  b.panel('+z', tz + tw, 0, 0.075, 0, 0.27, PART.wood);
  b.panel('+z', tz + tw, 0, 0.05, 0.78, 0.94, PART.window);
  b.panel('+x', tw, tz, 0.05, 0.78, 0.94, PART.window);
  b.panel('-x', tw, tz, 0.05, 0.78, 0.94, PART.window);
  return b.build();
}

/** A cumulus puff: a few flattened blobs. Y is the planet's radial direction. */
export function cloudPuffGeometry(): THREE.BufferGeometry {
  const b = new FlatBuilder();
  b.blob(0, 0, 0, 0.42, 1, 0.62, 0.8, 0.1, 11, PART.cloud, 1);
  b.blob(0.42, -0.05, 0.08, 0.3, 1, 0.6, 0.85, 0.1, 12, PART.cloud, 1);
  b.blob(-0.4, -0.06, -0.06, 0.32, 1, 0.58, 0.8, 0.1, 13, PART.cloud, 1);
  b.blob(0.1, 0.1, -0.22, 0.26, 1, 0.6, 1, 0.1, 14, PART.cloud, 1);
  return b.build();
}

export function propGeometry(kind: PropKind): THREE.BufferGeometry {
  switch (kind) {
    case 'conifer':
      return conifer();
    case 'broadleaf':
      return broadleaf();
    case 'jungle':
      return jungle();
    case 'cactus':
      return cactus();
    case 'rock':
      return rock();
    case 'house':
      return house();
    case 'tower':
      return tower();
  }
}

/** Footprint ellipse of each model for its contact shadow: x radius, z radius, z centre, ground height. */
const SHADOW_SHAPE: Record<PropKind, readonly [number, number, number, number]> = {
  conifer: [0.46, 0.46, 0, 0.065],
  broadleaf: [0.5, 0.5, 0, 0.065],
  jungle: [0.55, 0.55, 0, 0.065],
  cactus: [0.3, 0.3, 0, 0.065],
  rock: [0.55, 0.45, 0, 0.155],
  house: [0.62, 0.52, 0, 0.045],
  tower: [0.42, 0.72, -0.06, 0.045],
};

/** Soft disc on the ground under a prop (aShade: 1 in the middle, 0 at the rim). */
export function shadowGeometry(kind: PropKind): THREE.BufferGeometry {
  const [rx, rz, cz, y] = SHADOW_SHAPE[kind];
  const segments = 12;
  const pos = [0, y, cz];
  const shade = [1];
  const idx: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pos.push(Math.cos(a) * rx, y, cz + Math.sin(a) * rz);
    shade.push(0);
    idx.push(0, 1 + ((i + 1) % segments), 1 + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Instance transform: model +Y along the set's up, +Z along its forward, uniform scale. */
export function propMatrix(set: PropSet, i: number, out: THREE.Matrix4): THREE.Matrix4 {
  const s = set.scales[i];
  const ux = set.ups[i * 3];
  const uy = set.ups[i * 3 + 1];
  const uz = set.ups[i * 3 + 2];
  const fx = set.forwards[i * 3];
  const fy = set.forwards[i * 3 + 1];
  const fz = set.forwards[i * 3 + 2];
  // X = up × forward keeps the basis right-handed.
  const xx = uy * fz - uz * fy;
  const xy = uz * fx - ux * fz;
  const xz = ux * fy - uy * fx;
  return out.set(
    xx * s, ux * s, fx * s, set.positions[i * 3],
    xy * s, uy * s, fy * s, set.positions[i * 3 + 1],
    xz * s, uz * s, fz * s, set.positions[i * 3 + 2],
    0, 0, 0, 1,
  );
}

/** Geometry restricted to one colour part (used to export separate materials). */
export function geometryPart(g: THREE.BufferGeometry, part: number): THREE.BufferGeometry | null {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const parts = g.getAttribute('aPart') as THREE.BufferAttribute;
  const P: number[] = [];
  const N: number[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    if (parts.getX(i) !== part) continue;
    for (let k = 0; k < 3; k++) {
      P.push(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
      N.push(nor.getX(i + k), nor.getY(i + k), nor.getZ(i + k));
    }
  }
  if (P.length === 0) return null;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  return out;
}

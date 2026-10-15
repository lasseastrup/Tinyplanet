/**
 * Surface props (trees, rocks, villages) placed on the terrain by climate and biome.
 * Pure TypeScript and deterministic per seed. Samples are random directions from the planet
 * centre, so props land in the same places on any mesh resolution (preview, full quality or
 * a GLB export); only their height follows the mesh surface.
 */
import { clamp, hexToLinear, lerp, smoothstep } from '../core/math';
import { Simplex3 } from '../core/noise';
import { Rng, mixSeed } from '../core/rng';
import { propScale, type PlanetParams } from './params';

export type PropKind = 'conifer' | 'broadleaf' | 'jungle' | 'cactus' | 'rock' | 'house' | 'tower';
export const PROP_KINDS: readonly PropKind[] = ['conifer', 'broadleaf', 'jungle', 'cactus', 'rock', 'house', 'tower'];

export interface PropSet {
  kind: PropKind;
  count: number;
  /** Planet-local positions (xyz). */
  positions: Float32Array;
  /** Unit "up" vectors (xyz): the model's +Y. */
  ups: Float32Array;
  /** Unit "forward" vectors (xyz), perpendicular to up: the model's +Z. */
  forwards: Float32Array;
  /** Uniform scale (planet radii). */
  scales: Float32Array;
  /** Linear RGB tint (foliage, rock or roof colour). */
  colors: Float32Array;
}

export interface SurfaceMesh {
  positions: Float32Array;
  normals: Float32Array;
  /** height, base temperature, moisture, rockiness */
  data: Float32Array;
  indices: Uint32Array | null;
}

type RGB = [number, number, number];

const LAPSE = 0.45;

interface Sample {
  /** surface point */
  x: number;
  y: number;
  z: number;
  /** radial unit vector */
  rx: number;
  ry: number;
  rz: number;
  /** surface normal */
  nx: number;
  ny: number;
  nz: number;
  height: number;
  baseTemp: number;
  baseMoist: number;
  rock: number;
  slope: number;
  /** forest patch noise */
  forest: number;
  /** Per-sample random seed, so one changed decision doesn't reshuffle everything after it. */
  seed: number;
  // Derived from the climate parameters (see derive()).
  elev: number;
  temp: number;
  moist: number;
}

// --- Direction → triangle lookup --------------------------------------------------------------

/** Cube faces: dominant axis, sign and the two axes used for the gnomonic (u, v) projection. */
const FACES: ReadonlyArray<readonly [axis: number, sign: number, u: number, v: number]> = [
  [0, 1, 1, 2],
  [0, -1, 1, 2],
  [1, 1, 0, 2],
  [1, -1, 0, 2],
  [2, 1, 0, 1],
  [2, -1, 0, 1],
];

/**
 * Finds the mesh triangle hit by a ray from the planet centre. Triangles are bucketed on a
 * cube-map grid; a triangle goes into every face whose hemisphere holds all its vertices,
 * so a lookup only has to test one cell.
 */
class TriangleLocator {
  private readonly m: SurfaceMesh;
  private readonly n: number;
  private readonly start: Uint32Array;
  private readonly items: Uint32Array;
  // Result of the last successful locate().
  ia = 0;
  ib = 0;
  ic = 0;
  wa = 0;
  wb = 0;
  wc = 0;

  constructor(m: SurfaceMesh) {
    this.m = m;
    const T = triangleCount(m);
    const n = (this.n = Math.max(2, Math.min(160, Math.round(Math.sqrt(T / 30)))));
    const cells = 6 * n * n;
    const counts = new Uint32Array(cells);
    this.visitCells(T, (cell) => counts[cell]++);
    const start = new Uint32Array(cells + 1);
    for (let c = 0; c < cells; c++) start[c + 1] = start[c] + counts[c];
    const items = new Uint32Array(start[cells]);
    const fill = start.slice(0, cells);
    this.visitCells(T, (cell, t) => {
      items[fill[cell]++] = t;
    });
    this.start = start;
    this.items = items;
  }

  private visitCells(T: number, visit: (cell: number, t: number) => void): void {
    const P = this.m.positions;
    const I = this.m.indices;
    const n = this.n;
    const toCell = (w: number) => Math.min(n - 1, Math.max(0, Math.floor((w + 1) * 0.5 * n)));
    for (let t = 0; t < T; t++) {
      const a = (I ? I[t * 3] : t * 3) * 3;
      const b = (I ? I[t * 3 + 1] : t * 3 + 1) * 3;
      const c = (I ? I[t * 3 + 2] : t * 3 + 2) * 3;
      for (let f = 0; f < 6; f++) {
        const [axis, sign, ua, va] = FACES[f];
        const ma = P[a + axis] * sign;
        const mb = P[b + axis] * sign;
        const mc = P[c + axis] * sign;
        if (ma <= 1e-6 || mb <= 1e-6 || mc <= 1e-6) continue;
        const u0 = P[a + ua] / ma, u1 = P[b + ua] / mb, u2 = P[c + ua] / mc;
        const v0 = P[a + va] / ma, v1 = P[b + va] / mb, v2 = P[c + va] / mc;
        const uMin = Math.min(u0, u1, u2), uMax = Math.max(u0, u1, u2);
        const vMin = Math.min(v0, v1, v2), vMax = Math.max(v0, v1, v2);
        if (uMin > 1 || uMax < -1 || vMin > 1 || vMax < -1) continue;
        const iu0 = toCell(uMin), iu1 = toCell(uMax);
        const iv0 = toCell(vMin), iv1 = toCell(vMax);
        for (let iv = iv0; iv <= iv1; iv++) {
          for (let iu = iu0; iu <= iu1; iu++) visit((f * n + iv) * n + iu, t);
        }
      }
    }
  }

  /** Locate the triangle under direction d; fills ia/ib/ic and barycentric weights. */
  locate(dx: number, dy: number, dz: number): boolean {
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    let f: number;
    if (ax >= ay && ax >= az) f = dx >= 0 ? 0 : 1;
    else if (ay >= az) f = dy >= 0 ? 2 : 3;
    else f = dz >= 0 ? 4 : 5;
    const [axis, sign, ua, va] = FACES[f];
    const d = [dx, dy, dz];
    const major = d[axis] * sign;
    const n = this.n;
    const iu = Math.min(n - 1, Math.max(0, Math.floor((d[ua] / major + 1) * 0.5 * n)));
    const iv = Math.min(n - 1, Math.max(0, Math.floor((d[va] / major + 1) * 0.5 * n)));
    const cell = (f * n + iv) * n + iu;
    for (let k = this.start[cell]; k < this.start[cell + 1]; k++) {
      if (this.test(this.items[k], dx, dy, dz)) return true;
    }
    // Numerical corner cases: fall back to testing every triangle.
    const T = triangleCount(this.m);
    for (let t = 0; t < T; t++) if (this.test(t, dx, dy, dz)) return true;
    return false;
  }

  private test(t: number, dx: number, dy: number, dz: number): boolean {
    const P = this.m.positions;
    const I = this.m.indices;
    const ia = I ? I[t * 3] : t * 3;
    const ib = I ? I[t * 3 + 1] : t * 3 + 1;
    const ic = I ? I[t * 3 + 2] : t * 3 + 2;
    const ax = P[ia * 3], ay = P[ia * 3 + 1], az = P[ia * 3 + 2];
    if (ax * dx + ay * dy + az * dz <= 0) return false;
    const bx = P[ib * 3], by = P[ib * 3 + 1], bz = P[ib * 3 + 2];
    const cx = P[ic * 3], cy = P[ic * 3 + 1], cz = P[ic * 3 + 2];
    // Triple products d·(A×B), d·(B×C), d·(C×A) are proportional to the barycentric weights.
    const sAB = dx * (ay * bz - az * by) + dy * (az * bx - ax * bz) + dz * (ax * by - ay * bx);
    const sBC = dx * (by * cz - bz * cy) + dy * (bz * cx - bx * cz) + dz * (bx * cy - by * cx);
    const sCA = dx * (cy * az - cz * ay) + dy * (cz * ax - cx * az) + dz * (cx * ay - cy * ax);
    const e = 1e-12;
    const inside = (sAB >= -e && sBC >= -e && sCA >= -e) || (sAB <= e && sBC <= e && sCA <= e);
    const sum = sAB + sBC + sCA;
    if (!inside || Math.abs(sum) < 1e-18) return false;
    this.ia = ia;
    this.ib = ib;
    this.ic = ic;
    this.wa = sBC / sum;
    this.wb = sCA / sum;
    this.wc = sAB / sum;
    return true;
  }
}

function triangleCount(m: SurfaceMesh): number {
  return m.indices ? m.indices.length / 3 : m.positions.length / 9;
}

const locators = new WeakMap<Float32Array, TriangleLocator>();

function locatorFor(m: SurfaceMesh): TriangleLocator {
  let loc = locators.get(m.positions);
  if (!loc) {
    loc = new TriangleLocator(m);
    locators.set(m.positions, loc);
  }
  return loc;
}

/** Surface sample under a direction (unit vector), or null if the ray missed (never on a closed mesh). */
function sampleAt(m: SurfaceMesh, loc: TriangleLocator, dx: number, dy: number, dz: number): Sample | null {
  if (!loc.locate(dx, dy, dz)) return null;
  const { ia, ib, ic, wa, wb, wc } = loc;
  const P = m.positions;
  const N = m.normals;
  const D = m.data;
  const x = P[ia * 3] * wa + P[ib * 3] * wb + P[ic * 3] * wc;
  const y = P[ia * 3 + 1] * wa + P[ib * 3 + 1] * wb + P[ic * 3 + 1] * wc;
  const z = P[ia * 3 + 2] * wa + P[ib * 3 + 2] * wb + P[ic * 3 + 2] * wc;
  let nx = N[ia * 3] * wa + N[ib * 3] * wb + N[ic * 3] * wc;
  let ny = N[ia * 3 + 1] * wa + N[ib * 3 + 1] * wb + N[ic * 3 + 1] * wc;
  let nz = N[ia * 3 + 2] * wa + N[ib * 3 + 2] * wb + N[ic * 3 + 2] * wc;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  return {
    x,
    y,
    z,
    rx: dx,
    ry: dy,
    rz: dz,
    nx,
    ny,
    nz,
    height: D[ia * 4] * wa + D[ib * 4] * wb + D[ic * 4] * wc,
    baseTemp: D[ia * 4 + 1] * wa + D[ib * 4 + 1] * wb + D[ic * 4 + 1] * wc,
    baseMoist: D[ia * 4 + 2] * wa + D[ib * 4 + 2] * wb + D[ic * 4 + 2] * wc,
    rock: D[ia * 4 + 3] * wa + D[ib * 4 + 3] * wb + D[ic * 4 + 3] * wc,
    slope: 1 - Math.max(0, nx * dx + ny * dy + nz * dz),
    forest: 0,
    seed: 0,
    elev: 0,
    temp: 0,
    moist: 0,
  };
}

/** Apply the climate sliders (cheap; lets sea level / temperature drags skip resampling). */
function derive(s: Sample, p: PlanetParams, hasOcean: boolean): Sample {
  s.elev = hasOcean ? s.height - p.seaLevel : Math.max(s.height - p.seaLevel, 0.05);
  s.temp = s.baseTemp + p.temperature - Math.max(s.elev, 0) * LAPSE;
  s.moist = clamp(s.baseMoist + p.humidity, 0, 1);
  return s;
}

/** Uniform random direction inside a spherical cap of the given angular radius. */
function capDirection(rng: Rng, c: Sample, angle: number): RGB {
  const cosT = 1 - rng.next() * (1 - Math.cos(angle));
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = rng.next() * Math.PI * 2;
  const [t1, t2] = tangentFrame(c.rx, c.ry, c.rz);
  const a = Math.cos(phi) * sinT;
  const b = Math.sin(phi) * sinT;
  return [
    c.rx * cosT + t1[0] * a + t2[0] * b,
    c.ry * cosT + t1[1] * a + t2[1] * b,
    c.rz * cosT + t1[2] * a + t2[2] * b,
  ];
}

/** Two unit tangents perpendicular to a unit vector u (and to each other). */
function tangentFrame(ux: number, uy: number, uz: number): [RGB, RGB] {
  // t1 = normalize(u × ref) with ref = +Y, or +X near the poles; t2 = u × t1
  const polar = Math.abs(uy) >= 0.9;
  let ax = polar ? 0 : -uz;
  let ay = polar ? uz : 0;
  let az = polar ? -uy : ux;
  const l = Math.hypot(ax, ay, az) || 1;
  ax /= l;
  ay /= l;
  az /= l;
  return [
    [ax, ay, az],
    [uy * az - uz * ay, uz * ax - ux * az, ux * ay - uy * ax],
  ];
}

interface PoolCache {
  key: string;
  pool: Sample[];
}
const pools = new WeakMap<Float32Array, PoolCache>();

/** Candidate surface samples (cached per mesh, seed and world size). */
function samplePool(m: SurfaceMesh, p: PlanetParams, count: number): Sample[] {
  const key = `${p.seed}|${p.size}|${count}`;
  const cached = pools.get(m.positions);
  if (cached && cached.key === key) return cached.pool;
  const loc = locatorFor(m);
  const rng = new Rng(mixSeed(p.seed, 0x7ee6));
  const forest = new Simplex3(new Rng(mixSeed(p.seed, 0xf0e5)).next);
  // Forest patches: a few big ones on tiny worlds, many small ones on large worlds.
  const ff = lerp(2.2, 6, p.size);
  const pool: Sample[] = [];
  for (let i = 0; i < count; i++) {
    const [dx, dy, dz] = rng.unitVector();
    const seed = (rng.next() * 4294967296) >>> 0;
    const s = sampleAt(m, loc, dx, dy, dz);
    if (!s) continue;
    s.forest = forest.fbm(dx * ff, dy * ff, dz * ff, 3);
    s.seed = seed;
    pool.push(s);
  }
  pools.set(m.positions, { key, pool });
  return pool;
}

/** Spatial hash for minimum-distance checks between props. */
class SpacingGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly pts: number[] = [];
  private readonly cell: number;

  constructor(cell: number) {
    this.cell = cell;
  }

  private key(ix: number, iy: number, iz: number): number {
    return ((ix + 512) * 1024 + (iy + 512)) * 1024 + (iz + 512);
  }

  isFree(x: number, y: number, z: number, minDist: number): boolean {
    const c = this.cell;
    const ix = Math.floor(x / c);
    const iy = Math.floor(y / c);
    const iz = Math.floor(z / c);
    const r = Math.ceil(minDist / c);
    const md2 = minDist * minDist;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const list = this.cells.get(this.key(ix + dx, iy + dy, iz + dz));
          if (!list) continue;
          for (const i of list) {
            const ex = this.pts[i * 4] - x;
            const ey = this.pts[i * 4 + 1] - y;
            const ez = this.pts[i * 4 + 2] - z;
            const need = Math.max(minDist, this.pts[i * 4 + 3]);
            if (ex * ex + ey * ey + ez * ez < Math.max(md2, need * need)) return false;
          }
        }
      }
    }
    return true;
  }

  add(x: number, y: number, z: number, radius: number): void {
    const c = this.cell;
    const k = this.key(Math.floor(x / c), Math.floor(y / c), Math.floor(z / c));
    const idx = this.pts.length / 4;
    this.pts.push(x, y, z, radius);
    const list = this.cells.get(k);
    if (list) list.push(idx);
    else this.cells.set(k, [idx]);
  }
}

class SetBuilder {
  private readonly pos: number[] = [];
  private readonly up: number[] = [];
  private readonly fwd: number[] = [];
  private readonly scl: number[] = [];
  private readonly col: number[] = [];
  readonly kind: PropKind;

  constructor(kind: PropKind) {
    this.kind = kind;
  }

  get count(): number {
    return this.scl.length;
  }

  /**
   * @param upMix  0 = stand along the planet radius, 1 = along the surface normal
   * @param sink   how far to push the model into the ground (fraction of its scale)
   * @param angle  rotation about up (radians); with `face`, a deviation from facing that point
   * @param face   optional point the model's front (+Z) turns towards
   */
  push(s: Sample, upMix: number, sink: number, scale: number, color: RGB, angle: number, face?: Sample): void {
    let ux = s.rx + (s.nx - s.rx) * upMix;
    let uy = s.ry + (s.ny - s.ry) * upMix;
    let uz = s.rz + (s.nz - s.rz) * upMix;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    let fx = 0;
    let fy = 0;
    let fz = 0;
    let fl = 0;
    if (face) {
      fx = face.x - s.x;
      fy = face.y - s.y;
      fz = face.z - s.z;
      const d = fx * ux + fy * uy + fz * uz;
      fx -= d * ux;
      fy -= d * uy;
      fz -= d * uz;
      fl = Math.hypot(fx, fy, fz);
    }
    if (fl < 1e-9) {
      [[fx, fy, fz]] = tangentFrame(ux, uy, uz);
      fl = 1;
    }
    fx /= fl;
    fy /= fl;
    fz /= fl;
    // Rotate about up: f' = f cos a + (up × f) sin a
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const cx = uy * fz - uz * fy;
    const cy = uz * fx - ux * fz;
    const cz = ux * fy - uy * fx;
    this.pos.push(s.x - ux * sink * scale, s.y - uy * sink * scale, s.z - uz * sink * scale);
    this.up.push(ux, uy, uz);
    this.fwd.push(fx * ca + cx * sa, fy * ca + cy * sa, fz * ca + cz * sa);
    this.scl.push(scale);
    this.col.push(color[0], color[1], color[2]);
  }

  build(): PropSet {
    return {
      kind: this.kind,
      count: this.scl.length,
      positions: new Float32Array(this.pos),
      ups: new Float32Array(this.up),
      forwards: new Float32Array(this.fwd),
      scales: new Float32Array(this.scl),
      colors: new Float32Array(this.col),
    };
  }
}

function vary(c: RGB, rng: Rng, amount: number): RGB {
  const k = 1 + (rng.next() * 2 - 1) * amount;
  const hue = (rng.next() * 2 - 1) * amount * 0.35;
  return [c[0] * k * (1 + hue), c[1] * k, c[2] * k * (1 - hue)];
}

function mix3(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function dist2(a: Sample, b: Sample): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

/**
 * Place props on a terrain mesh.
 * @param maxInstances total budget across all prop kinds (quality dependent)
 */
export function placeProps(mesh: SurfaceMesh, p: PlanetParams, maxInstances: number): PropSet[] {
  const builders = new Map<PropKind, SetBuilder>(PROP_KINDS.map((k) => [k, new SetBuilder(k)]));
  const result = () => PROP_KINDS.map((k) => builders.get(k)!.build());
  if (p.trees + p.rocks + p.houses <= 0.001 || mesh.positions.length === 0) return result();

  const hasOcean = p.liquid !== 'none';
  const scale = propScale(p.size);
  // Enough candidates to fill dense forests at this prop size.
  const poolSize = Math.min(42000, Math.max(3000, Math.round((4 * Math.PI * 1.3) / (scale * scale))));
  const pool = samplePool(mesh, p, poolSize);
  for (const s of pool) derive(s, p, hasOcean);

  const colors = {
    taiga: hexToLinear(p.cTaiga),
    forest: hexToLinear(p.cForest),
    grass: hexToLinear(p.cGrass),
    jungle: hexToLinear(p.cJungle),
    savanna: hexToLinear(p.cSavanna),
    rock: hexToLinear(p.cRock),
    snow: hexToLinear(p.cSnow),
    roof: hexToLinear(p.cRoof),
  };

  const grid = new SpacingGrid(scale * 0.6);
  let budget = maxInstances;
  const isLand = (s: Sample, margin: number) => !hasOcean || s.elev > margin;

  // --- Villages: houses packed around a chapel, filled from the centre outwards -------------
  const villageR = scale * (2.6 + 2.4 * p.houses);
  const villages: Sample[] = [];
  if (p.houses > 0.001) {
    const wanted = Math.max(1, Math.round(p.houses * lerp(5, 14, p.size)));
    for (const s of pool) {
      if (villages.length >= wanted) break;
      if (!isLand(s, 0.03) || s.slope > 0.1 || s.rock > 0.35 || s.elev > 0.45) continue;
      if (villages.some((v) => dist2(v, s) < (villageR * 2.6) ** 2)) continue;
      villages.push(s);
    }
    const loc = locatorFor(mesh);
    const houses = builders.get('house')!;
    const towers = builders.get('tower')!;
    for (const v of villages) {
      const vr = new Rng(mixSeed(v.seed, 0x7111));
      const target = 5 + Math.round((6 + vr.next() * 10) * p.houses);
      if (target >= 8 && budget > 0) {
        const ts = scale * 1.05;
        grid.add(v.x, v.y, v.z, ts * 0.8);
        towers.push(v, 0.15, 0.04, ts, vary(colors.roof, vr, 0.08), vr.next() * Math.PI * 2);
        budget--;
      }
      // Candidates nearest the centre first; the jitter keeps the edge of town ragged.
      const cands: Array<{ s: Sample; d: number }> = [];
      for (let i = 0; i < 40 + target * 14; i++) {
        const [dx, dy, dz] = capDirection(vr, v, villageR);
        const jitter = 0.7 + 0.6 * vr.next();
        const seed = (vr.next() * 4294967296) >>> 0;
        const s = sampleAt(mesh, loc, dx, dy, dz);
        if (!s) continue;
        s.seed = seed;
        cands.push({ s: derive(s, p, hasOcean), d: Math.sqrt(dist2(s, v)) * jitter });
      }
      cands.sort((a, b) => a.d - b.d);
      let placed = 0;
      for (const { s } of cands) {
        if (placed >= target || budget <= 0) break;
        if (!isLand(s, 0.025) || s.slope > 0.16 || s.rock > 0.5) continue;
        const r = new Rng(s.seed);
        const hs = scale * (0.8 + r.next() * 0.35);
        if (!grid.isFree(s.x, s.y, s.z, hs * 0.9)) continue;
        grid.add(s.x, s.y, s.z, hs * 0.9);
        // Front doors face the village square.
        houses.push(s, 0.25, 0.04, hs, vary(colors.roof, r, 0.12), (r.next() - 0.5) * 0.8, v);
        placed++;
        budget--;
      }
    }
  }

  // --- Trees ---------------------------------------------------------------------------------
  if (p.trees > 0.001) {
    for (const s of pool) {
      if (budget <= 0) break;
      if (!isLand(s, 0.035)) continue;
      // Clearings around villages.
      if (villages.some((v) => dist2(v, s) < (villageR * 0.85) ** 2)) continue;
      const f = s.forest;
      const wet = smoothstep(0.1, 0.6, s.moist);
      let prob = smoothstep(0.02, 0.3, f + (s.moist - 0.45) * 0.7) * (0.2 + 0.8 * wet) * p.trees * 1.25;
      prob *= 1 - smoothstep(0.2, 0.36, s.slope);
      prob *= 1 - smoothstep(0.45, 0.85, s.rock);
      const snowy = s.temp < p.snowLine + 0.02;
      if (snowy) prob *= 0.45;
      let kind: PropKind;
      if (s.temp < 0.4 || (s.temp < 0.5 && f > 0.25)) kind = 'conifer';
      else if (s.temp > 0.74 && s.moist > 0.5) kind = 'jungle';
      else if (s.temp > 0.68 && s.moist < 0.24) {
        kind = 'cactus';
        prob = p.trees * 0.18 * (1 - smoothstep(0.24, 0.32, s.slope));
      } else kind = 'broadleaf';
      const rng = new Rng(s.seed);
      if (rng.next() > prob) continue;

      const sizeJitter = 0.75 + rng.next() * 0.5;
      const ts = scale * sizeJitter * (kind === 'jungle' ? 1.15 : kind === 'cactus' ? 0.75 : 1);
      const spacing = ts * (kind === 'cactus' ? 0.9 : 0.42);
      if (!grid.isFree(s.x, s.y, s.z, spacing)) continue;
      grid.add(s.x, s.y, s.z, spacing);

      let color: RGB;
      if (kind === 'conifer') color = vary(colors.taiga, rng, 0.14);
      else if (kind === 'jungle') color = vary(colors.jungle, rng, 0.14);
      else if (kind === 'cactus') color = vary(mix3(colors.grass, colors.savanna, 0.35), rng, 0.1);
      else color = vary(mix3(colors.forest, colors.grass, rng.next() * 0.25), rng, 0.16);
      if (snowy) color = mix3(color, colors.snow, 0.5);
      builders.get(kind)!.push(s, kind === 'cactus' ? 0.15 : 0.3, 0.06, ts, color, rng.next() * Math.PI * 2);
      budget--;
    }
  }

  // --- Rocks ---------------------------------------------------------------------------------
  if (p.rocks > 0.001) {
    const rocks = builders.get('rock')!;
    for (let i = pool.length - 1; i >= 0 && budget > 0; i--) {
      const s = pool[i];
      if (!isLand(s, -0.005)) continue;
      const rockRng = new Rng(mixSeed(s.seed, 0x50c4));
      const desert = (1 - smoothstep(0.1, 0.25, s.moist)) * smoothstep(0.55, 0.75, s.temp);
      const prob =
        p.rocks * (0.04 + 0.5 * smoothstep(0.3, 0.85, s.rock) + 0.4 * smoothstep(0.12, 0.3, s.slope) + 0.3 * desert);
      if (rockRng.next() > prob * 0.6) continue;
      const rs = scale * (0.35 + rockRng.next() * 0.55);
      if (!grid.isFree(s.x, s.y, s.z, rs * 0.7)) continue;
      grid.add(s.x, s.y, s.z, rs * 0.7);
      rocks.push(s, 0.7, 0.15, rs, vary(colors.rock, rockRng, 0.18), rockRng.next() * Math.PI * 2);
      budget--;
    }
  }

  return result();
}

/** Puffy cumulus clouds for the "puffs" cloud style: positions on the cloud shell. */
export function placePuffs(p: PlanetParams, cloudRadius: number): PropSet {
  const builder = new SetBuilder('rock');
  if (p.cloudCoverage <= 0.001) return builder.build();
  const rng = new Rng(mixSeed(p.seed, 0x9f0f));
  const noise = new Simplex3(new Rng(mixSeed(p.seed, 0x9f10)).next);
  const scale = propScale(p.size) * 2.5 * (0.7 + 0.3 * Math.min(2, p.cloudScale / 1.6));
  const target = Math.min(260, Math.round((p.cloudCoverage * 4 * Math.PI) / (scale * scale * 6)));
  const grid = new SpacingGrid(scale);
  const white: RGB = [1, 1, 1];
  for (let tries = 0; tries < target * 40 && builder.count < target; tries++) {
    const [x, y, z] = rng.unitVector();
    // Weather systems: clusters, with fewer clouds near the poles.
    const n = noise.fbm(x * 1.8, y * 1.8, z * 1.8, 2);
    if (n < 0.08 - (p.cloudCoverage - 0.5) * 0.7 + Math.abs(y) * 0.25) continue;
    const s = scale * (0.65 + rng.next() * 0.7);
    const px = x * cloudRadius;
    const py = y * cloudRadius;
    const pz = z * cloudRadius;
    if (!grid.isFree(px, py, pz, s * 0.9)) continue;
    grid.add(px, py, pz, s * 0.9);
    const sample: Sample = {
      x: px,
      y: py,
      z: pz,
      rx: x,
      ry: y,
      rz: z,
      nx: x,
      ny: y,
      nz: z,
      height: 0,
      baseTemp: 0,
      baseMoist: 0,
      rock: 0,
      slope: 0,
      forest: 0,
      seed: 0,
      elev: 0,
      temp: 0,
      moist: 0,
    };
    builder.push(sample, 0, 0, s, white, rng.next() * Math.PI * 2);
  }
  return builder.build();
}

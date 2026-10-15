/**
 * Deterministic planet terrain generator. Pure TypeScript with no DOM / Three.js dependency,
 * so it can run in a Web Worker, in Node, or inside a game at runtime.
 */
import { clamp, lerp, smoothMax, smoothMin, smoothstep } from '../core/math';
import { Simplex3 } from '../core/noise';
import { Rng, mixSeed } from '../core/rng';
import { buildIcosphere, buildNeighbors } from './icosphere';
import { terrainFrequency, type ShapeParams } from './params';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  /** Per vertex: x = height (terrain units), y = base temperature, z = moisture, w = rockiness. */
  data: Float32Array;
  /** null for non-indexed (flat shaded) meshes. */
  indices: Uint32Array | null;
}

export interface TerrainResult {
  mesh: MeshData;
  frequency: number;
  vertexCount: number;
  minHeight: number;
  maxHeight: number;
  landFraction: number;
}

export interface MoonResult {
  mesh: MeshData;
  /** Multiplier on the global moon size. */
  sizeFactor: number;
  /** 0..1 value used to spread orbit radii. */
  orbitFactor: number;
  inclination: number;
  node: number;
  phase: number;
  speedFactor: number;
}

/** Arc length of one icosphere edge at frequency 1. */
const ICO_EDGE_ARC = 1.1071487;

export function generateTerrain(s: ShapeParams, preview = false, frequencyOverride?: number): TerrainResult {
  let freq = frequencyOverride ?? terrainFrequency(s);
  if (preview && !s.lowPoly) freq = Math.min(freq, 56);
  const topo = buildIcosphere(freq);
  const V = topo.vertexCount;
  const dirs = topo.directions;

  const rng = new Rng(mixSeed(s.seed, 0x7e11a));
  const mk = () => new Simplex3(rng.next);
  const nWarpX = mk();
  const nWarpY = mk();
  const nWarpZ = mk();
  const nCont = mk();
  const nRidge = mk();
  const nMask = mk();
  const nHill = mk();
  const nTemp = mk();
  const nMoist = mk();

  const heights = new Float32Array(V);
  const rock = new Float32Array(V);

  const cf = s.continentScale;
  const warpAmt = s.warp * 0.45;
  const wf = 1.1 + cf * 0.6;
  const mf = s.mountainScale * 1.4;
  const hillAmt = 0.24 * s.roughness;

  for (let v = 0; v < V; v++) {
    const x = dirs[v * 3];
    const y = dirs[v * 3 + 1];
    const z = dirs[v * 3 + 2];

    // Domain warp gives continents organic, swirly coastlines.
    let qx = x;
    let qy = y;
    let qz = z;
    if (warpAmt > 0) {
      qx += warpAmt * nWarpX.fbm(x * wf, y * wf, z * wf, 2);
      qy += warpAmt * nWarpY.fbm(x * wf, y * wf, z * wf, 2);
      qz += warpAmt * nWarpZ.fbm(x * wf, y * wf, z * wf, 2);
    }

    // Continents (roughly normal distribution, std ≈ 0.48), with flattened abyssal plains.
    let c = nCont.fbm(qx * cf, qy * cf, qz * cf, 6, 2.0, 0.5) * 2.2;
    c = smoothMax(c, -0.85, 0.35);
    const land = c > 0 ? c * 0.6 : c;

    // Mountain ranges: ridged noise, localised by a low-frequency mask, only inland.
    const inland = smoothstep(-0.04, 0.32, c);
    let mtn = 0;
    if (inland > 0 && s.mountainHeight > 0) {
      const rangeMask = smoothstep(-0.25, 0.3, nMask.fbm(x * 1.3 + 3.1, y * 1.3 - 1.7, z * 1.3, 2));
      if (rangeMask > 0) {
        const r = nRidge.ridged(qx * mf, qy * mf, qz * mf, 5);
        mtn = Math.pow(r, 2.4) * 1.35 * rangeMask * inland * s.mountainHeight;
      }
    }

    // Hills and small-scale relief.
    const hills = hillAmt > 0 ? nHill.fbm(x * 7, y * 7, z * 7, 4, 2.1, 0.5) * hillAmt * (0.35 + 0.65 * inland) : 0;

    heights[v] = land + mtn + hills;
    rock[v] = clamp(mtn * 1.1, 0, 1);
  }

  if (s.craters > 0.001) applyCraters(dirs, V, heights, rock, s.craters, new Rng(mixSeed(s.seed, 0xc4a7e5)));

  if (s.terraces > 0.001) {
    const step = 0.12;
    for (let v = 0; v < V; v++) {
      const h = heights[v];
      const t = h / step;
      const fl = Math.floor(t);
      const stepped = (fl + smoothstep(0.38, 0.62, t - fl)) * step;
      heights[v] = lerp(h, stepped, s.terraces);
    }
  }

  // --- Climate --------------------------------------------------------------------------
  const temps = new Float32Array(V);
  const moist = new Float32Array(V);
  for (let v = 0; v < V; v++) {
    const x = dirs[v * 3];
    const y = dirs[v * 3 + 1];
    const z = dirs[v * 3 + 2];
    const lat = Math.asin(clamp(y, -1, 1));
    temps[v] = 1 - Math.pow(Math.abs(y), 1.6) + nTemp.fbm(x * 2.2, y * 2.2, z * 2.2, 2) * 0.14;
    // Wet equator, dry subtropics (~30°), wet mid-latitudes, dry poles (Hadley/Ferrel cells).
    moist[v] = 0.5 + nMoist.fbm(x * 1.7 + 11, y * 1.7, z * 1.7, 3) * 0.95 + 0.12 * Math.cos(6 * lat);
  }

  // Coast proximity → moisture (continental interiors are drier).
  const coast = coastDistance(V, topo.indices, heights, s.seaLevel, s.hasOcean, ICO_EDGE_ARC / freq);
  let landCount = 0;
  let minH = Infinity;
  let maxH = -Infinity;
  for (let v = 0; v < V; v++) {
    const near = s.hasOcean ? 1 - smoothstep(0, 0.42, coast[v]) : 0;
    moist[v] = clamp(moist[v] + 0.26 * near - 0.11, 0, 1);
    const h = heights[v];
    if (h > s.seaLevel || !s.hasOcean) landCount++;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }

  // --- Mesh -----------------------------------------------------------------------------
  const positions = new Float32Array(V * 3);
  const data = new Float32Array(V * 4);
  for (let v = 0; v < V; v++) {
    const r = 1 + heights[v] * s.heightScale;
    positions[v * 3] = dirs[v * 3] * r;
    positions[v * 3 + 1] = dirs[v * 3 + 1] * r;
    positions[v * 3 + 2] = dirs[v * 3 + 2] * r;
    data[v * 4] = heights[v];
    data[v * 4 + 1] = temps[v];
    data[v * 4 + 2] = moist[v];
    data[v * 4 + 3] = rock[v];
  }

  const mesh = s.lowPoly
    ? toFlatMesh(positions, data, topo.indices)
    : { positions, normals: computeNormals(positions, topo.indices, V), data, indices: topo.indices.slice() };

  return {
    mesh,
    frequency: freq,
    vertexCount: mesh.positions.length / 3,
    minHeight: minH,
    maxHeight: maxH,
    landFraction: landCount / V,
  };
}

function applyCraters(
  dirs: Float32Array,
  V: number,
  heights: Float32Array,
  rock: Float32Array,
  amount: number,
  rng: Rng,
): void {
  const count = Math.round(Math.pow(amount, 1.4) * 260) + 3;
  const cx = new Float32Array(count);
  const cy = new Float32Array(count);
  const cz = new Float32Array(count);
  const cr = new Float32Array(count);
  const cosMax = new Float32Array(count);
  const floor = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = rng.unitVector();
    cx[i] = x;
    cy[i] = y;
    cz[i] = z;
    // Many small craters, a few big ones.
    const r = 0.025 + Math.pow(rng.next(), 3.2) * 0.3;
    cr[i] = r;
    cosMax[i] = Math.cos(Math.min(r * 1.9, Math.PI));
    floor[i] = rng.range(-0.7, -0.35);
  }
  const rimWidth = 0.75;
  const rimSteep = 0.45;
  const k = 0.3;
  for (let v = 0; v < V; v++) {
    const x = dirs[v * 3];
    const y = dirs[v * 3 + 1];
    const z = dirs[v * 3 + 2];
    let dh = 0;
    let rk = 0;
    for (let i = 0; i < count; i++) {
      const d = x * cx[i] + y * cy[i] + z * cz[i];
      if (d < cosMax[i]) continue;
      const r = cr[i];
      const t = Math.sqrt(Math.max(0, 2 - 2 * d)) / r;
      const cavity = t * t - 1;
      const rimX = Math.min(t - 1 - rimWidth, 0);
      const rim = rimSteep * rimX * rimX;
      let shape = smoothMax(cavity, floor[i], k);
      shape = smoothMin(shape, rim, k);
      dh += shape * (0.12 + r * 1.6);
      rk = Math.max(rk, 1 - smoothstep(0.7, 1.35, t));
    }
    // Overlapping craters should not dig arbitrarily deep.
    heights[v] += smoothMax(dh, -0.9, 0.3);
    rock[v] = Math.max(rock[v], rk * 0.6);
  }
}

/** Geodesic-ish distance (radians) from each vertex to the nearest ocean vertex, via BFS. */
function coastDistance(
  V: number,
  indices: Uint32Array,
  heights: Float32Array,
  seaLevel: number,
  hasOcean: boolean,
  hop: number,
): Float32Array {
  const dist = new Float32Array(V).fill(1e6);
  if (!hasOcean) return dist;
  const nb = buildNeighbors(V, indices);
  const queue = new Int32Array(V);
  let head = 0;
  let tail = 0;
  for (let v = 0; v < V; v++) {
    if (heights[v] <= seaLevel) {
      dist[v] = 0;
      queue[tail++] = v;
    }
  }
  while (head < tail) {
    const v = queue[head++];
    const d = dist[v] + hop;
    for (let k = 0; k < 6; k++) {
      const n = nb[v * 6 + k];
      if (n < 0) break;
      if (dist[n] > d) {
        dist[n] = d;
        queue[tail++] = n;
      }
    }
  }
  return dist;
}

export function computeNormals(positions: Float32Array, indices: Uint32Array, V: number): Float32Array {
  const n = new Float32Array(V * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < V; i++) {
    const x = n[i * 3];
    const y = n[i * 3 + 1];
    const z = n[i * 3 + 2];
    const len = Math.hypot(x, y, z) || 1;
    n[i * 3] = x / len;
    n[i * 3 + 1] = y / len;
    n[i * 3 + 2] = z / len;
  }
  return n;
}

/** Convert an indexed mesh into a non-indexed, flat-shaded one with per-face attributes. */
function toFlatMesh(positions: Float32Array, data: Float32Array, indices: Uint32Array): MeshData {
  const T = indices.length / 3;
  const pos = new Float32Array(T * 9);
  const nor = new Float32Array(T * 9);
  const dat = new Float32Array(T * 12);
  for (let t = 0; t < T; t++) {
    const ia = indices[t * 3];
    const ib = indices[t * 3 + 1];
    const ic = indices[t * 3 + 2];
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const o = t * 9;
    pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az;
    pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz;
    pos[o + 6] = cx; pos[o + 7] = cy; pos[o + 8] = cz;
    for (let k = 0; k < 3; k++) {
      nor[o + k * 3] = nx;
      nor[o + k * 3 + 1] = ny;
      nor[o + k * 3 + 2] = nz;
    }
    for (let c = 0; c < 4; c++) {
      const avg = (data[ia * 4 + c] + data[ib * 4 + c] + data[ic * 4 + c]) / 3;
      dat[t * 12 + c] = avg;
      dat[t * 12 + 4 + c] = avg;
      dat[t * 12 + 8 + c] = avg;
    }
  }
  return { positions: pos, normals: nor, data: dat, indices: null };
}

// --- Moons --------------------------------------------------------------------------------

export function generateMoons(seed: number, count: number, lowPoly: boolean): MoonResult[] {
  const out: MoonResult[] = [];
  for (let i = 0; i < count; i++) out.push(generateMoon(seed, i, lowPoly));
  return out;
}

function generateMoon(seed: number, index: number, lowPoly: boolean): MoonResult {
  const rng = new Rng(mixSeed(seed, 0x300 + index * 7919));
  const freq = lowPoly ? 6 : 22;
  const topo = buildIcosphere(freq);
  const V = topo.vertexCount;
  const dirs = topo.directions;
  const nBase = new Simplex3(rng.next);
  const nMare = new Simplex3(rng.next);
  const heights = new Float32Array(V);
  const rock = new Float32Array(V);
  const bumpiness = rng.range(0.15, 0.4);
  for (let v = 0; v < V; v++) {
    const x = dirs[v * 3];
    const y = dirs[v * 3 + 1];
    const z = dirs[v * 3 + 2];
    heights[v] = nBase.fbm(x * 1.6, y * 1.6, z * 1.6, 4) * bumpiness;
  }
  applyCraters(dirs, V, heights, rock, rng.range(0.45, 0.85), rng);
  const positions = new Float32Array(V * 3);
  const data = new Float32Array(V * 4);
  const reliefScale = 0.09;
  for (let v = 0; v < V; v++) {
    const x = dirs[v * 3];
    const y = dirs[v * 3 + 1];
    const z = dirs[v * 3 + 2];
    const r = 1 + heights[v] * reliefScale;
    positions[v * 3] = x * r;
    positions[v * 3 + 1] = y * r;
    positions[v * 3 + 2] = z * r;
    data[v * 4] = heights[v];
    data[v * 4 + 1] = 0;
    data[v * 4 + 2] = smoothstep(-0.1, 0.35, nMare.fbm(x * 1.2, y * 1.2, z * 1.2, 3)); // dark "maria"
    data[v * 4 + 3] = rock[v];
  }
  const mesh = lowPoly
    ? toFlatMesh(positions, data, topo.indices)
    : { positions, normals: computeNormals(positions, topo.indices, V), data, indices: topo.indices.slice() };
  return {
    mesh,
    sizeFactor: rng.range(0.65, 1.25),
    orbitFactor: rng.next(),
    inclination: rng.range(-0.3, 0.3),
    node: rng.range(0, Math.PI * 2),
    phase: rng.range(0, Math.PI * 2),
    speedFactor: rng.range(0.8, 1.2) * (rng.chance(0.15) ? -1 : 1),
  };
}

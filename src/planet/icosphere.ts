/**
 * Geodesic icosphere with fully shared vertices (no seams), for any subdivision frequency.
 * Vertex count = 10·f² + 2, triangle count = 20·f².
 */
export interface SphereTopology {
  /** Unit-length vertex directions (xyz interleaved). */
  directions: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  frequency: number;
}

const T = (1 + Math.sqrt(5)) / 2;
const ICO_VERTS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0],
  [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T],
  [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
];
const ICO_FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

const cache = new Map<number, SphereTopology>();

export function buildIcosphere(frequency: number): SphereTopology {
  const f = Math.max(1, Math.round(frequency));
  const cached = cache.get(f);
  if (cached) return cached;

  const vertexCount = 10 * f * f + 2;
  const dirs = new Float32Array(vertexCount * 3);
  let next = 0;

  const corners: number[][] = ICO_VERTS.map((v) => {
    const len = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
  });

  const put = (x: number, y: number, z: number): number => {
    const len = Math.hypot(x, y, z);
    dirs[next * 3] = x / len;
    dirs[next * 3 + 1] = y / len;
    dirs[next * 3 + 2] = z / len;
    return next++;
  };

  // 12 corner vertices
  for (const c of corners) put(c[0], c[1], c[2]);

  // Edge vertices, allocated canonically from the lower to the higher corner index.
  const edgeStart = new Map<number, number>();
  const edgeKey = (a: number, b: number) => (a < b ? a * 16 + b : b * 16 + a);
  for (const [a, b, c] of ICO_FACES) {
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const key = edgeKey(u, v);
      if (edgeStart.has(key)) continue;
      const lo = Math.min(u, v);
      const hi = Math.max(u, v);
      edgeStart.set(key, next);
      const A = corners[lo];
      const B = corners[hi];
      for (let k = 1; k < f; k++) {
        const t = k / f;
        put(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
      }
    }
  }

  /** Global index of the point at fraction k/f along the edge from corner u to corner v. */
  const edgeVertex = (u: number, v: number, k: number): number => {
    if (k === 0) return u;
    if (k === f) return v;
    const start = edgeStart.get(edgeKey(u, v))!;
    return u < v ? start + (k - 1) : start + (f - k - 1);
  };

  const indices = new Uint32Array(20 * f * f * 3);
  let ip = 0;
  const grid = new Int32Array((f + 1) * (f + 1));
  const gi = (i: number, j: number) => j * (f + 1) + i;

  for (const [a, b, c] of ICO_FACES) {
    const A = corners[a];
    const B = corners[b];
    const C = corners[c];
    for (let j = 0; j <= f; j++) {
      for (let i = 0; i + j <= f; i++) {
        let idx: number;
        if (j === 0) idx = edgeVertex(a, b, i);
        else if (i === 0) idx = edgeVertex(a, c, j);
        else if (i + j === f) idx = edgeVertex(b, c, j);
        else {
          const s = i / f;
          const t = j / f;
          idx = put(
            A[0] + (B[0] - A[0]) * s + (C[0] - A[0]) * t,
            A[1] + (B[1] - A[1]) * s + (C[1] - A[1]) * t,
            A[2] + (B[2] - A[2]) * s + (C[2] - A[2]) * t,
          );
        }
        grid[gi(i, j)] = idx;
      }
    }
    for (let j = 0; j < f; j++) {
      for (let i = 0; i + j < f; i++) {
        const p00 = grid[gi(i, j)];
        const p10 = grid[gi(i + 1, j)];
        const p01 = grid[gi(i, j + 1)];
        indices[ip++] = p00;
        indices[ip++] = p10;
        indices[ip++] = p01;
        if (i + j < f - 1) {
          const p11 = grid[gi(i + 1, j + 1)];
          indices[ip++] = p10;
          indices[ip++] = p11;
          indices[ip++] = p01;
        }
      }
    }
  }

  if (next !== vertexCount) throw new Error(`icosphere: expected ${vertexCount} vertices, got ${next}`);

  // Make sure all triangles wind counter-clockwise when seen from outside.
  ensureOutwardWinding(dirs, indices);

  const topo: SphereTopology = { directions: dirs, indices, vertexCount, frequency: f };
  if (cache.size > 6) cache.clear();
  cache.set(f, topo);
  return topo;
}

function ensureOutwardWinding(p: Float32Array, idx: Uint32Array): void {
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * p[a] + ny * p[a + 1] + nz * p[a + 2] < 0) {
      const tmp = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = tmp;
    }
  }
}

/** Neighbour lists (max 6 per vertex, -1 = none) built from triangle indices. */
export function buildNeighbors(vertexCount: number, indices: Uint32Array): Int32Array {
  const nb = new Int32Array(vertexCount * 6).fill(-1);
  const add = (a: number, b: number) => {
    const base = a * 6;
    for (let k = 0; k < 6; k++) {
      const v = nb[base + k];
      if (v === b) return;
      if (v === -1) {
        nb[base + k] = b;
        return;
      }
    }
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    add(a, b); add(a, c);
    add(b, a); add(b, c);
    add(c, a); add(c, b);
  }
  return nb;
}

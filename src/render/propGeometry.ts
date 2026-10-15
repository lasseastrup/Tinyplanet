/**
 * Low-poly, flat-shaded prop models built procedurally. Object space: +Y is up, the base sits at
 * y = 0, the front faces +Z and a tree is roughly 1 unit tall (instances scale them).
 *
 * Vertex attributes besides position and normal:
 *   aPart  colour source (see PART)
 *   aAO    baked ambient occlusion, with a little per-facet variation for the low-poly look
 *   aSway  how far the vertex moves in the wind (0 = rigid)
 */
import * as THREE from 'three';
import { PROP_VARIANTS, type PropKind, type PropSet } from '../planet/props';

export const PART = {
  /** fixed wood colour: doors, window frames, coconuts */
  wood: 0,
  /** per-instance colour: foliage, roofs, shutters, rocks, cacti */
  tint: 1,
  /** per-instance secondary colour: house walls */
  wall: 2,
  /** glass; glows at night */
  window: 3,
  cloud: 4,
  /** per-instance secondary colour: tree trunks */
  trunk: 5,
  /** fixed stone colour: foundations, chimneys, steps */
  stone: 6,
  /** fixed accent colour: blossoms */
  accent: 7,
} as const;

/** Fixed colours of the untinted parts (sRGB hex). */
export const PROP_COLORS = {
  wood: '#6b4a33',
  wall: '#f1e4cb',
  window: '#2c3a4d',
  windowGlow: '#ffb85c',
  stone: '#8f8a82',
  accent: '#ff9db8',
} as const;

type V3 = [number, number, number];
type VertexFn = (p: V3) => number;
type Side = '+x' | '-x' | '+z' | '-z';

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

/** Small deterministic random generator for model jitter. */
function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Builder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly prt: number[] = [];
  private readonly occ: number[] = [];
  private readonly swy: number[] = [];
  private readonly facetRnd: () => number;
  /** Ambient occlusion as a function of (model-space) vertex position. */
  ao: VertexFn = () => 1;
  /** Wind sway as a function of vertex position. */
  sway: VertexFn = () => 0;
  /** Random brightness variation per facet (±). */
  facet = 0.05;
  /** Transform applied to every vertex (e.g. to build a part rotated). */
  xf: (p: V3) => V3 = (p) => p;
  /** Per-vertex normals for the next primitives (smooth shading); null = flat faces. */
  normalFn: ((p: V3) => V3) | null = null;

  constructor(seed: number) {
    this.facetRnd = rand(seed * 977 + 13);
  }

  tri(a: V3, b: V3, c: V3, part: number, twoSided = false, ao?: V3): void {
    this.emit(this.xf(a), this.xf(b), this.xf(c), part, ao);
    if (twoSided) this.emit(this.xf(a), this.xf(c), this.xf(b), part, ao && [ao[0], ao[2], ao[1]]);
  }

  private emit(a: V3, b: V3, c: V3, part: number, ao?: V3): void {
    const n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) return;
    const shade = 1 + (this.facetRnd() * 2 - 1) * this.facet;
    [a, b, c].forEach((v, k) => {
      this.pos.push(v[0], v[1], v[2]);
      const vn = this.normalFn ? this.normalFn(v) : mul(n, 1 / l);
      this.nor.push(vn[0], vn[1], vn[2]);
      this.prt.push(part);
      this.occ.push((ao ? ao[k] : this.ao(v)) * shade);
      this.swy.push(this.sway(v));
    });
  }

  quad(a: V3, b: V3, c: V3, d: V3, part: number, twoSided = false): void {
    this.tri(a, b, c, part, twoSided);
    this.tri(a, c, d, part, twoSided);
  }

  /** Frustum (a cone when r1 = 0) between two points, with outward-facing sides. */
  frustum(p0: V3, p1: V3, r0: number, r1: number, sides: number, part: number, phase = 0, caps = true): void {
    const axis = unit(sub(p1, p0));
    const t1 = unit(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const t2 = cross(t1, axis);
    const ring = (c: V3, r: number): V3[] =>
      Array.from({ length: sides }, (_, i) => {
        const a = phase + (i / sides) * Math.PI * 2;
        return add(c, add(mul(t1, Math.cos(a) * r), mul(t2, Math.sin(a) * r)));
      });
    const bottom = ring(p0, r0);
    const top = r1 > 1e-6 ? ring(p1, r1) : null;
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (top) this.quad(bottom[j], bottom[i], top[i], top[j], part);
      else this.tri(bottom[j], bottom[i], p1, part);
    }
    if (!caps) return;
    for (let i = 1; i < sides - 1; i++) this.tri(bottom[0], bottom[i + 1], bottom[i], part);
    if (top) for (let i = 1; i < sides - 1; i++) this.tri(top[0], top[i], top[i + 1], part);
  }

  /** Conifer tier: a star-shaped cone with drooping tips and a hollow underside. */
  tier(y: number, r: number, h: number, points: number, part: number, rnd: () => number, phase: number): void {
    const apex: V3 = [(rnd() - 0.5) * 0.03, y + h, (rnd() - 0.5) * 0.03];
    const rim: V3[] = [];
    const n = points * 2;
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      const tip = i % 2 === 0;
      const rr = r * (tip ? 0.95 + rnd() * 0.15 : 0.7 + rnd() * 0.08);
      rim.push([Math.cos(a) * rr, y + (tip ? -0.035 : 0.01) * (r / 0.4) + (rnd() - 0.5) * 0.02, Math.sin(a) * rr]);
    }
    const under: V3 = [0, y + h * 0.2, 0];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.tri(rim[j], rim[i], apex, part, false, [0.66, 0.66, 1]);
      this.tri(under, rim[j], rim[i], part, false, [0.3, 0.45, 0.45]);
    }
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, part: number): void {
    const p = (x: number, y: number, z: number): V3 => [x, y, z];
    this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), part); // +z
    this.quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), part); // -z
    this.quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), part); // +x
    this.quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), part); // -x
    this.quad(p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0), part); // top
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), part); // bottom
  }

  /** Flat rectangle `e` in front of an axis-aligned wall; `c` is its centre along the wall. */
  panel(side: Side, plane: number, c: number, hw: number, y0: number, y1: number, part: number, e = 0.006): void {
    const q = plane + e;
    switch (side) {
      case '+x':
        this.quad([q, y0, c + hw], [q, y0, c - hw], [q, y1, c - hw], [q, y1, c + hw], part);
        break;
      case '-x':
        this.quad([-q, y0, c - hw], [-q, y0, c + hw], [-q, y1, c + hw], [-q, y1, c - hw], part);
        break;
      case '+z':
        this.quad([c - hw, y0, q], [c + hw, y0, q], [c + hw, y1, q], [c - hw, y1, q], part);
        break;
      case '-z':
        this.quad([c + hw, y0, -q], [c - hw, y0, -q], [c - hw, y1, -q], [c + hw, y1, -q], part);
        break;
    }
  }

  /** Low-poly blob: an icosahedron with deterministic vertex jitter. */
  blob(c: V3, r: number, s: V3, jitter: number, seed: number, part: number, detail = 0): void {
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
      return [c[0] + x * r * s[0] * k, c[1] + y * r * s[1] * k, c[2] + z * r * s[2] * k];
    };
    for (let i = 0; i < pos.count; i += 3) this.tri(tf(i), tf(i + 1), tf(i + 2), part);
    ico.dispose();
  }

  /** Palm frond: a drooping, keeled leaf, visible from both sides. */
  frond(base: V3, angle: number, len: number, width: number, droop: number, rise: number, segs: number, part: number): void {
    const d: V3 = [Math.cos(angle), 0, Math.sin(angle)];
    const side: V3 = [-Math.sin(angle), 0, Math.cos(angle)];
    const center = (t: number): V3 => add(base, [d[0] * len * t, rise * t - droop * t * t, d[2] * len * t]);
    const edges = (t: number): [V3, V3] => {
      const w = width * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.9));
      const c = center(t);
      return [add(c, add(mul(side, w), [0, -w * 0.45, 0])), add(c, add(mul(side, -w), [0, -w * 0.45, 0]))];
    };
    let pc = center(0);
    let [pl, pr] = edges(0);
    for (let k = 1; k <= segs; k++) {
      const t = k / segs;
      const c = center(t);
      const [l, r] = edges(t);
      this.quad(pc, pl, l, c, part, true);
      this.quad(pc, c, r, pr, part, true);
      pc = c;
      pl = l;
      pr = r;
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.prt, 1));
    g.setAttribute('aAO', new THREE.Float32BufferAttribute(this.occ, 1));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.swy, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// --- shared helpers -------------------------------------------------------------------------

const heightAO = (y0: number, y1: number, low: number): VertexFn => (p) => low + (1 - low) * smooth(y0, y1, p[1]);
/** Trunks barely move; the sway grows with height and matches the crown where they meet. */
const trunkSway = (top: number): VertexFn => (p) => 0.3 * (Math.max(0, p[1]) / top) ** 2;
const crownSway = (y0: number, y1: number): VertexFn => (p) => 0.3 + 0.7 * smooth(y0, y1, p[1]);

/** Gable roof with thickness: ridge along x at `ridge`, eaves at ±oz, overhanging to ±ox. */
function gableRoof(b: Builder, ox: number, oz: number, eave: number, ridge: number, t: number): void {
  const e = eave;
  const r = ridge;
  const part = PART.tint;
  b.ao = () => 1;
  b.quad([-ox, e, oz], [ox, e, oz], [ox, r, 0], [-ox, r, 0], part);
  b.quad([ox, e, -oz], [-ox, e, -oz], [-ox, r, 0], [ox, r, 0], part);
  b.ao = () => 0.42;
  b.quad([-ox, r - t, 0], [ox, r - t, 0], [ox, e - t, oz], [-ox, e - t, oz], part);
  b.quad([ox, r - t, 0], [-ox, r - t, 0], [-ox, e - t, -oz], [ox, e - t, -oz], part);
  b.ao = () => 0.82;
  b.quad([-ox, e - t, oz], [ox, e - t, oz], [ox, e, oz], [-ox, e, oz], part);
  b.quad([ox, e - t, -oz], [-ox, e - t, -oz], [-ox, e, -oz], [ox, e, -oz], part);
  b.quad([ox, e - t, oz], [ox, r - t, 0], [ox, r, 0], [ox, e, oz], part);
  b.quad([ox, r - t, 0], [ox, e - t, -oz], [ox, e, -oz], [ox, r, 0], part);
  b.quad([-ox, r - t, 0], [-ox, e - t, oz], [-ox, e, oz], [-ox, r, 0], part);
  b.quad([-ox, e - t, -oz], [-ox, r - t, 0], [-ox, r, 0], [-ox, e, -oz], part);
  // Ridge cap.
  b.ao = () => 0.9;
  b.box(-ox - 0.006, ox + 0.006, r - 0.012, r + 0.018, -0.022, 0.022, part);
}

/** Window with glass, a wooden frame and muntins, optional shutters in the roof colour. */
function windowAt(b: Builder, side: Side, plane: number, c: number, y0: number, y1: number, hw: number, shutters: boolean): void {
  b.ao = () => 0.95;
  b.panel(side, plane, c, hw, y0, y1, PART.window, 0.006);
  const f = 0.016;
  b.panel(side, plane, c, hw + f, y1, y1 + f, PART.wood, 0.01);
  b.panel(side, plane, c, hw + f, y0 - f, y0, PART.wood, 0.01);
  b.panel(side, plane, c - hw - f / 2, f / 2, y0, y1, PART.wood, 0.01);
  b.panel(side, plane, c + hw + f / 2, f / 2, y0, y1, PART.wood, 0.01);
  b.panel(side, plane, c, 0.0055, y0, y1, PART.wood, 0.009);
  b.panel(side, plane, c, hw, (y0 + y1) / 2 - 0.0055, (y0 + y1) / 2 + 0.0055, PART.wood, 0.009);
  if (shutters) {
    const sw = hw * 0.5;
    b.ao = () => 0.9;
    b.panel(side, plane, c - hw - f - sw - 0.004, sw, y0 - 0.006, y1 + 0.006, PART.tint, 0.008);
    b.panel(side, plane, c + hw + f + sw + 0.004, sw, y0 - 0.006, y1 + 0.006, PART.tint, 0.008);
  }
}

interface HouseSpec {
  w: number;
  d: number;
  h: number;
  ridge: number;
  door: number;
  /** Window x positions per floor on the front (+z) and back walls. */
  front: number[][];
  back: number[][];
  sideWindows: boolean;
  chimney: [number, number] | null;
  shutters: boolean;
}

const FLOORS: Array<[number, number]> = [
  [0.17, 0.3],
  [0.48, 0.61],
];

function house(spec: HouseSpec, seed: number): THREE.BufferGeometry {
  const b = new Builder(seed);
  const { w, d, h, ridge } = spec;
  b.facet = 0.03;
  // Stone foundation and walls, darker towards the ground.
  b.ao = (p) => 0.62 + 0.38 * smooth(0, 0.2, p[1]);
  b.box(-w - 0.014, w + 0.014, 0, 0.07, -d - 0.014, d + 0.014, PART.stone);
  b.box(-w, w, 0.07, h, -d, d, PART.wall);
  b.ao = () => 0.97;
  b.tri([w, h, d], [w, h, -d], [w, ridge - 0.03, 0], PART.wall);
  b.tri([-w, h, -d], [-w, h, d], [-w, ridge - 0.03, 0], PART.wall);
  const ox = w + 0.07;
  const oz = d + 0.09;
  const eave = h - 0.045;
  gableRoof(b, ox, oz, eave, ridge, 0.035);
  if (spec.chimney) {
    const [cx, cz] = spec.chimney;
    const roofY = eave + (ridge - eave) * (1 - Math.abs(cz) / oz);
    b.ao = (p) => 0.72 + 0.28 * smooth(roofY, roofY + 0.2, p[1]);
    b.box(cx - 0.05, cx + 0.05, roofY - 0.08, ridge + 0.1, cz - 0.05, cz + 0.05, PART.stone);
    b.box(cx - 0.064, cx + 0.064, ridge + 0.1, ridge + 0.13, cz - 0.064, cz + 0.064, PART.stone);
  }
  // Door with a stone frame and step.
  b.ao = () => 0.92;
  b.panel('+z', d, spec.door, 0.066, 0.07, 0.31, PART.wood, 0.008);
  b.panel('+z', d, spec.door, 0.088, 0.31, 0.335, PART.stone, 0.011);
  b.panel('+z', d, spec.door - 0.077, 0.011, 0.07, 0.31, PART.stone, 0.011);
  b.panel('+z', d, spec.door + 0.077, 0.011, 0.07, 0.31, PART.stone, 0.011);
  b.ao = (p) => 0.7 + 0.3 * smooth(0, 0.07, p[1]);
  b.box(spec.door - 0.1, spec.door + 0.1, 0, 0.05, d, d + 0.065, PART.stone);
  spec.front.forEach((xs, floor) => {
    for (const x of xs) windowAt(b, '+z', d, x, FLOORS[floor][0], FLOORS[floor][1], 0.055, spec.shutters);
  });
  spec.back.forEach((xs, floor) => {
    for (const x of xs) windowAt(b, '-z', d, x, FLOORS[floor][0], FLOORS[floor][1], 0.055, spec.shutters);
  });
  if (spec.sideWindows) {
    for (let floor = 0; floor < spec.front.length; floor++) {
      windowAt(b, '+x', w, 0, FLOORS[floor][0], FLOORS[floor][1], 0.05, false);
      windowAt(b, '-x', w, 0, FLOORS[floor][0], FLOORS[floor][1], 0.05, false);
    }
  }
  return b.build();
}

// --- models ---------------------------------------------------------------------------------

function conifer(variant: number): THREE.BufferGeometry {
  const b = new Builder(101 + variant);
  const rnd = rand(7 + variant * 31);
  const tall = variant === 1;
  const trunkTop = tall ? 0.42 : 0.24;
  b.ao = heightAO(0, 0.3, 0.6);
  b.sway = trunkSway(trunkTop);
  b.frustum([0, 0, 0], [0, trunkTop + 0.06, 0], 0.07, 0.05, 6, PART.trunk);
  b.sway = crownSway(0.1, 1.15);
  const tiers: Array<[number, number, number]> = tall
    ? [
        [0.36, 0.42, 0.31],
        [0.57, 0.38, 0.24],
        [0.77, 0.36, 0.16],
      ]
    : [
        [0.13, 0.44, 0.46],
        [0.33, 0.4, 0.38],
        [0.53, 0.37, 0.29],
        [0.73, 0.35, 0.19],
      ];
  tiers.forEach(([y, h, r], i) => b.tier(y, r, h, 6, PART.tint, rnd, i * 0.55));
  return b.build();
}

function broadleaf(variant: number): THREE.BufferGeometry {
  const b = new Builder(201 + variant);
  if (variant === 0) {
    // Round, oak-like crown.
    b.ao = heightAO(0, 0.45, 0.55);
    b.sway = trunkSway(0.46);
    b.frustum([0, 0, 0], [0, 0.46, 0], 0.085, 0.058, 6, PART.trunk);
    b.frustum([0, 0.3, 0], [0.15, 0.5, 0.06], 0.034, 0.02, 5, PART.trunk, 0, false);
    b.frustum([0, 0.33, 0], [-0.13, 0.52, -0.08], 0.03, 0.018, 5, PART.trunk, 0, false);
    b.ao = heightAO(0.42, 1.0, 0.45);
    b.sway = crownSway(0.4, 1.0);
    b.blob([0, 0.72, 0], 0.33, [1, 0.88, 1], 0.1, 1, PART.tint, 1);
    b.blob([0.21, 0.58, 0.1], 0.21, [1, 0.9, 1], 0.14, 2, PART.tint);
    b.blob([-0.2, 0.6, -0.11], 0.22, [1, 0.9, 1], 0.14, 3, PART.tint);
    b.blob([0.02, 0.9, -0.05], 0.19, [1, 0.9, 1], 0.14, 4, PART.tint);
    b.blob([-0.06, 0.56, 0.2], 0.18, [1, 0.9, 1], 0.14, 5, PART.tint);
  } else if (variant === 1) {
    // Slender birch/poplar.
    b.ao = heightAO(0, 0.5, 0.6);
    b.sway = trunkSway(0.6);
    b.frustum([0, 0, 0], [0, 0.6, 0], 0.052, 0.034, 6, PART.trunk);
    b.ao = heightAO(0.45, 1.15, 0.45);
    b.sway = crownSway(0.45, 1.15);
    b.blob([0, 0.8, 0], 0.22, [1, 1.6, 1], 0.1, 6, PART.tint, 1);
    b.blob([0.08, 0.57, 0.05], 0.15, [1, 1.1, 1], 0.14, 7, PART.tint);
  } else {
    // Low, wide fruit tree.
    b.ao = heightAO(0, 0.3, 0.55);
    b.sway = trunkSway(0.3);
    b.frustum([0, 0, 0], [0, 0.3, 0], 0.075, 0.058, 6, PART.trunk);
    b.frustum([0, 0.22, 0], [0.17, 0.36, -0.04], 0.03, 0.02, 5, PART.trunk, 0, false);
    b.frustum([0, 0.24, 0], [-0.14, 0.37, 0.09], 0.03, 0.02, 5, PART.trunk, 0, false);
    b.ao = heightAO(0.3, 0.75, 0.45);
    b.sway = crownSway(0.3, 0.75);
    b.blob([0, 0.5, 0], 0.3, [1.2, 0.72, 1.2], 0.1, 8, PART.tint, 1);
    b.blob([0.21, 0.44, -0.12], 0.19, [1, 0.85, 1], 0.14, 9, PART.tint);
    b.blob([-0.18, 0.46, 0.14], 0.19, [1, 0.85, 1], 0.14, 10, PART.tint);
  }
  return b.build();
}

function jungle(variant: number): THREE.BufferGeometry {
  const b = new Builder(301 + variant);
  const top = variant === 0 ? 0.66 : 0.88;
  b.ao = heightAO(0, 0.5, 0.55);
  b.sway = trunkSway(top);
  b.frustum([0, 0, 0], [0, top, 0], 0.066, 0.045, 6, PART.trunk);
  // Buttress roots.
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.4;
    b.frustum([Math.cos(a) * 0.14, 0, Math.sin(a) * 0.14], [0, 0.22, 0], 0.03, 0.012, 4, PART.trunk, 0, false);
  }
  b.ao = heightAO(0.55, 1.0, 0.42);
  b.sway = crownSway(0.5, 1.0);
  if (variant === 0) {
    b.blob([0, 0.78, 0], 0.42, [1, 0.4, 1], 0.12, 11, PART.tint, 1);
    b.blob([0.1, 0.9, -0.05], 0.26, [1, 0.5, 1], 0.12, 12, PART.tint);
    b.blob([-0.2, 0.72, 0.12], 0.22, [1, 0.5, 1], 0.12, 13, PART.tint);
  } else {
    // Two canopy layers.
    b.frustum([0, 0.5, 0], [0.2, 0.62, 0.05], 0.03, 0.02, 5, PART.trunk, 0, false);
    b.blob([0.2, 0.64, 0.05], 0.24, [1, 0.42, 1], 0.12, 14, PART.tint);
    b.blob([0, 0.94, 0], 0.36, [1, 0.38, 1], 0.12, 15, PART.tint, 1);
  }
  return b.build();
}

function palm(variant: number): THREE.BufferGeometry {
  const b = new Builder(401 + variant);
  const rnd = rand(41 + variant);
  const lean = variant === 0 ? 0.22 : -0.16;
  const height = variant === 0 ? 0.92 : 1.02;
  const pt = (t: number): V3 => [lean * t * t, height * t, lean * 0.3 * t * t];
  const segs = 6;
  b.ao = heightAO(0, 0.4, 0.65);
  b.sway = (p) => 0.35 * (Math.max(0, p[1]) / height) ** 2;
  for (let k = 0; k < segs; k++) {
    const r0 = 0.06 - 0.022 * (k / segs);
    const r1 = 0.06 - 0.022 * ((k + 1) / segs);
    b.frustum(pt(k / segs), pt((k + 1) / segs), r0 * 1.12, r1 * 0.94, 6, PART.trunk);
  }
  const top = pt(1);
  b.sway = (p) => 0.35 + 1.5 * Math.hypot(p[0] - top[0], p[2] - top[2]);
  b.ao = (p) => 0.55 + 0.45 * smooth(top[1] - 0.3, top[1] + 0.05, p[1]);
  const fronds = variant === 0 ? 8 : 7;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + rnd() * 0.35;
    b.frond(add(top, [0, 0.012, 0]), a, 0.44 + rnd() * 0.1, 0.085, 0.36 + rnd() * 0.12, 0.13, 4, PART.tint);
  }
  b.ao = () => 0.8;
  b.sway = () => 0.35;
  for (let k = 0; k < 3; k++) {
    const a = k * 2.1 + 0.3;
    b.blob(add(top, [Math.cos(a) * 0.045, -0.05, Math.sin(a) * 0.045]), 0.04, [1, 1, 1], 0.05, 20 + k, PART.wood);
  }
  return b.build();
}

function cactus(variant: number): THREE.BufferGeometry {
  const b = new Builder(501 + variant);
  b.facet = 0.04;
  if (variant === 0) {
    // Saguaro.
    b.ao = heightAO(0, 0.3, 0.6);
    b.frustum([0, 0, 0], [0, 0.78, 0], 0.13, 0.12, 8, PART.tint);
    b.frustum([0, 0.78, 0], [0, 0.9, 0], 0.12, 0.05, 8, PART.tint);
    b.frustum([-0.1, 0.36, 0], [-0.28, 0.4, 0], 0.06, 0.06, 6, PART.tint);
    b.frustum([-0.28, 0.35, 0], [-0.28, 0.64, 0], 0.065, 0.055, 6, PART.tint);
    b.frustum([-0.28, 0.64, 0], [-0.28, 0.69, 0], 0.055, 0.025, 6, PART.tint);
    b.frustum([0.1, 0.48, 0], [0.25, 0.52, 0], 0.055, 0.055, 6, PART.tint);
    b.frustum([0.25, 0.47, 0], [0.25, 0.73, 0], 0.06, 0.05, 6, PART.tint);
    b.frustum([0.25, 0.73, 0], [0.25, 0.78, 0], 0.05, 0.022, 6, PART.tint);
  } else {
    // Barrel cactus with blossoms.
    b.ao = heightAO(0, 0.3, 0.55);
    b.blob([0, 0.22, 0], 0.26, [1, 0.95, 1], 0.06, 30, PART.tint, 1);
    b.ao = () => 1;
    b.blob([0.03, 0.47, 0], 0.065, [1, 0.6, 1], 0.1, 31, PART.accent);
    b.blob([-0.1, 0.43, 0.06], 0.05, [1, 0.6, 1], 0.1, 32, PART.accent);
  }
  return b.build();
}

function bush(variant: number): THREE.BufferGeometry {
  const b = new Builder(601 + variant);
  b.ao = heightAO(0, 0.38, 0.45);
  b.sway = (p) => 0.25 * smooth(0, 0.4, p[1]);
  if (variant === 0) {
    b.blob([0, 0.2, 0], 0.26, [1.15, 0.8, 1.15], 0.12, 40, PART.tint, 1);
    b.blob([0.19, 0.14, 0.08], 0.17, [1, 0.85, 1], 0.14, 41, PART.tint);
    b.blob([-0.17, 0.15, -0.07], 0.18, [1, 0.85, 1], 0.14, 42, PART.tint);
  } else {
    // Flowering bush.
    b.blob([0, 0.18, 0], 0.27, [1.25, 0.72, 1.25], 0.12, 43, PART.tint, 1);
    b.ao = () => 1;
    b.blob([0, 0.375, 0], 0.035, [1, 1, 1], 0.1, 50, PART.accent);
    for (let k = 0; k < 6; k++) {
      const a = k * 1.05 + 0.3;
      b.blob([Math.cos(a) * 0.17, 0.345, Math.sin(a) * 0.17], 0.033, [1, 1, 1], 0.1, 51 + k, PART.accent);
    }
  }
  return b.build();
}

function rock(variant: number): THREE.BufferGeometry {
  const b = new Builder(701 + variant);
  b.facet = 0.08;
  b.ao = heightAO(0, 0.3, 0.5);
  if (variant === 0) {
    b.blob([0, 0.2, 0], 0.5, [1, 0.62, 0.85], 0.2, 60, PART.tint, 1);
  } else if (variant === 1) {
    b.blob([0, 0.17, 0], 0.4, [1, 0.68, 0.9], 0.18, 61, PART.tint);
    b.blob([0.33, 0.1, 0.13], 0.22, [1, 0.75, 0.9], 0.2, 62, PART.tint);
    b.blob([-0.26, 0.08, -0.2], 0.18, [1, 0.8, 1], 0.2, 63, PART.tint);
  } else {
    b.ao = heightAO(0, 0.5, 0.5);
    b.blob([0, 0.36, 0], 0.3, [0.62, 1.45, 0.55], 0.15, 64, PART.tint);
  }
  return b.build();
}

function houseVariant(variant: number): THREE.BufferGeometry {
  switch (variant) {
    case 1:
      // Long house.
      return house(
        {
          w: 0.56,
          d: 0.27,
          h: 0.4,
          ridge: 0.75,
          door: -0.12,
          front: [[-0.38, 0.13, 0.41]],
          back: [[-0.3, 0, 0.3]],
          sideWindows: true,
          chimney: [0.4, 0.08],
          shutters: true,
        },
        811,
      );
    case 2:
      // Two-storey town house.
      return house(
        {
          w: 0.33,
          d: 0.3,
          h: 0.74,
          ridge: 1.12,
          door: 0,
          front: [
            [-0.19, 0.19],
            [-0.17, 0.17],
          ],
          back: [
            [-0.17, 0.17],
            [-0.17, 0.17],
          ],
          sideWindows: true,
          chimney: [-0.13, 0.1],
          shutters: false,
        },
        812,
      );
    default:
      // Cottage.
      return house(
        {
          w: 0.36,
          d: 0.27,
          h: 0.42,
          ridge: 0.78,
          door: -0.18,
          front: [[0.19]],
          back: [[-0.19, 0.19]],
          sideWindows: true,
          chimney: [0.17, -0.09],
          shutters: true,
        },
        810,
      );
  }
}

/** Village chapel: a nave with a gable roof and a front tower with a pointed spire. */
function tower(): THREE.BufferGeometry {
  const b = new Builder(901);
  b.facet = 0.03;
  const w = 0.24;
  const back = -0.55;
  const front = 0.1;
  const h = 0.46;
  const ridge = 0.82;
  b.ao = (p) => 0.62 + 0.38 * smooth(0, 0.2, p[1]);
  b.box(-w - 0.014, w + 0.014, 0, 0.07, back - 0.014, front, PART.stone);
  b.box(-w, w, 0.07, h, back, front, PART.wall);
  b.ao = () => 0.97;
  b.tri([w, h, back], [-w, h, back], [0, ridge - 0.03, back], PART.wall);
  // Nave roof: built with its ridge along x, then turned so it runs along z.
  const zc = (back + front) / 2;
  b.xf = (p) => [p[2], p[1], zc - p[0]];
  gableRoof(b, (front - back) / 2 + 0.03, w + 0.07, h - 0.045, ridge, 0.035);
  b.xf = (p) => p;
  for (const z of [-0.42, -0.2]) {
    windowAt(b, '+x', w, z, 0.17, 0.36, 0.04, false);
    windowAt(b, '-x', w, z, 0.17, 0.36, 0.04, false);
  }
  // Tower and spire.
  const tw = 0.19;
  const tz = 0.29;
  const top = 1.08;
  b.ao = (p) => 0.62 + 0.38 * smooth(0, 0.2, p[1]);
  b.box(-tw - 0.016, tw + 0.016, 0, 0.08, tz - tw - 0.016, tz + tw + 0.016, PART.stone);
  b.box(-tw, tw, 0.08, top, tz - tw, tz + tw, PART.wall);
  b.ao = () => 0.95;
  b.box(-tw - 0.02, tw + 0.02, top - 0.03, top + 0.01, tz - tw - 0.02, tz + tw + 0.02, PART.stone);
  b.frustum([0, top + 0.01, tz], [0, 1.76, tz], (tw + 0.04) * Math.SQRT2, 0, 4, PART.tint, Math.PI / 4);
  b.box(-0.008, 0.008, 1.74, 1.86, tz - 0.008, tz + 0.008, PART.wood);
  b.box(-0.03, 0.03, 1.8, 1.815, tz - 0.008, tz + 0.008, PART.wood);
  b.panel('+z', tz + tw, 0, 0.068, 0.08, 0.32, PART.wood, 0.008);
  b.panel('+z', tz + tw, 0, 0.09, 0.32, 0.345, PART.stone, 0.011);
  b.ao = (p) => 0.7 + 0.3 * smooth(0, 0.07, p[1]);
  b.box(-0.1, 0.1, 0, 0.05, tz + tw, tz + tw + 0.065, PART.stone);
  windowAt(b, '+z', tz + tw, 0, 0.78, 0.94, 0.045, false);
  windowAt(b, '+x', tw, tz, 0.78, 0.94, 0.045, false);
  windowAt(b, '-x', tw, tz, 0.78, 0.94, 0.045, false);
  return b.build();
}

/** A cumulus puff: overlapping, smooth-shaded blobs with a flatter base. Y is the planet's radial direction. */
export function cloudPuffGeometry(): THREE.BufferGeometry {
  const b = new Builder(1001);
  b.facet = 0;
  const lobes: Array<[V3, number, V3]> = [
    [[0, 0.02, 0], 0.42, [1, 0.66, 0.82]],
    [[0.42, -0.04, 0.08], 0.3, [1, 0.62, 0.86]],
    [[-0.4, -0.05, -0.06], 0.32, [1, 0.6, 0.8]],
    [[0.1, 0.14, -0.2], 0.26, [1, 0.66, 1]],
    [[-0.12, 0.12, 0.2], 0.22, [1, 0.7, 1]],
  ];
  lobes.forEach(([c, r, s], i) => {
    // Normals of the ellipsoid: soft, rounded shading on a low-poly silhouette.
    b.normalFn = (p) => unit([(p[0] - c[0]) / (s[0] * s[0]), (p[1] - c[1]) / (s[1] * s[1]), (p[2] - c[2]) / (s[2] * s[2])]);
    // Darker, flatter undersides.
    b.ao = (p) => 0.62 + 0.38 * smooth(-0.22, 0.2, p[1]);
    b.blob(c, r, s, 0.06, 11 + i, PART.cloud, 1);
  });
  b.normalFn = null;
  return b.build();
}

export function propGeometry(kind: PropKind, variant: number): THREE.BufferGeometry {
  const v = Math.max(0, Math.min(PROP_VARIANTS[kind] - 1, variant));
  switch (kind) {
    case 'conifer':
      return conifer(v);
    case 'broadleaf':
      return broadleaf(v);
    case 'jungle':
      return jungle(v);
    case 'palm':
      return palm(v);
    case 'cactus':
      return cactus(v);
    case 'bush':
      return bush(v);
    case 'rock':
      return rock(v);
    case 'house':
      return houseVariant(v);
    case 'tower':
      return tower();
  }
}

/** Footprint ellipse of each model variant for its contact shadow: x radius, z radius, z centre, ground height. */
const SHADOW_SHAPE: Record<PropKind, ReadonlyArray<readonly [number, number, number, number]>> = {
  conifer: [
    [0.46, 0.46, 0, 0.065],
    [0.34, 0.34, 0, 0.065],
  ],
  broadleaf: [
    [0.48, 0.48, 0, 0.065],
    [0.3, 0.3, 0, 0.065],
    [0.5, 0.5, 0, 0.065],
  ],
  jungle: [
    [0.5, 0.5, 0, 0.065],
    [0.45, 0.45, 0, 0.065],
  ],
  palm: [
    [0.42, 0.42, 0, 0.065],
    [0.42, 0.42, 0, 0.065],
  ],
  cactus: [
    [0.32, 0.3, 0, 0.065],
    [0.3, 0.3, 0, 0.065],
  ],
  bush: [
    [0.42, 0.4, 0, 0.065],
    [0.4, 0.4, 0, 0.065],
  ],
  rock: [
    [0.55, 0.45, 0, 0.155],
    [0.6, 0.45, 0, 0.155],
    [0.3, 0.28, 0, 0.155],
  ],
  house: [
    [0.62, 0.5, 0, 0.045],
    [0.82, 0.5, 0, 0.045],
    [0.55, 0.52, 0, 0.045],
  ],
  tower: [[0.42, 0.72, -0.06, 0.045]],
};

/** Soft disc on the ground under a prop (aShade: 1 in the middle, 0 at the rim). */
export function shadowGeometry(kind: PropKind, variant: number): THREE.BufferGeometry {
  const shapes = SHADOW_SHAPE[kind];
  const [rx, rz, cz, y] = shapes[Math.min(shapes.length - 1, variant)];
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

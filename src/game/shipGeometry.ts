/**
 * A small, toy-like spaceship in the props' low-poly style. Model space: +Z is the nose, +Y is
 * up and +X is the left (port) wing; the ship is about one unit long.
 */
import * as THREE from 'three';
import { Builder, type V3 } from '../render/propGeometry';

/** Colour sources of the model (aPart), interpreted by the ship material. */
export const SHIP_PART = {
  hull: 0,
  trim: 1,
  metal: 2,
  glass: 3,
  engine: 4,
  navLeft: 5,
  navRight: 6,
} as const;

/** Nose-to-tail length of the model. */
export const SHIP_LENGTH = 1.04;
/** Gun muzzles: left, right. */
export const SHIP_GUNS: readonly V3[] = [
  [0.2, -0.05, 0.38],
  [-0.2, -0.05, 0.38],
];
/** Engine nozzles (where the exhaust starts) and their radii. */
export const SHIP_NOZZLES: ReadonlyArray<{ p: V3; r: number }> = [
  { p: [0, 0.02, -0.475], r: 0.055 },
  { p: [0.3, -0.065, -0.445], r: 0.042 },
  { p: [-0.3, -0.065, -0.445], r: 0.042 },
];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const centroid = (pts: V3[]): V3 => mul(pts.reduce(add, [0, 0, 0]), 1 / pts.length);
const lerp3 = (a: V3, b: V3, t: number): V3 => add(a, mul(sub(b, a), t));
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Convex polygon, wound so that it faces `outward`. */
function poly(b: Builder, pts: V3[], outward: V3, part: number): void {
  const n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
  const p = dot(n, outward) < 0 ? [...pts].reverse() : pts;
  for (let i = 1; i + 1 < p.length; i++) b.tri(p[0], p[i], p[i + 1], part);
}

/** Elliptical ring of `sides` points around the z axis. */
function ring(z: number, w: number, h: number, y: number, sides: number, phase = 0): V3[] {
  return Array.from({ length: sides }, (_, k): V3 => {
    const a = phase + (k / sides) * Math.PI * 2;
    return [Math.cos(a) * w, y + Math.sin(a) * h, z];
  });
}

/**
 * Tapered slab (a wing or a fin) between a root and a tip section. Each section is given by its
 * leading and trailing edge on the mid surface; `n` is the thickness direction.
 */
function slab(
  b: Builder,
  root: [V3, V3],
  tip: [V3, V3],
  n: V3,
  thickness: [number, number],
  part: number,
  faces: { root?: boolean; tip?: boolean } = {},
): void {
  const off = (p: V3, t: number, s: number) => add(p, mul(n, (s * t) / 2));
  const top = [off(root[0], thickness[0], 1), off(tip[0], thickness[1], 1), off(tip[1], thickness[1], 1), off(root[1], thickness[0], 1)];
  const bot = [off(root[0], thickness[0], -1), off(tip[0], thickness[1], -1), off(tip[1], thickness[1], -1), off(root[1], thickness[0], -1)];
  const c = centroid([...top, ...bot]);
  const face = (pts: V3[]) => poly(b, pts, sub(centroid(pts), c), part);
  face(top);
  face(bot);
  face([top[0], top[1], bot[1], bot[0]]); // leading edge
  face([top[2], top[3], bot[3], bot[2]]); // trailing edge
  if (faces.tip !== false) face([top[1], top[2], bot[2], bot[1]]);
  if (faces.root) face([top[3], top[0], bot[0], bot[3]]);
}

export function shipGeometry(): THREE.BufferGeometry {
  const b = new Builder(4242);
  b.facet = 0.025;
  // Darker undersides, like the props.
  b.ao = (p) => 0.6 + 0.4 * smooth(-0.13, 0.1, p[1]);
  const P = SHIP_PART;

  // Fuselage: a lofted, slightly flattened body with a coloured nose cone.
  const SIDES = 10;
  const rings = [
    ring(-0.46, 0.1, 0.085, 0.02, SIDES),
    ring(-0.38, 0.132, 0.108, 0.02, SIDES),
    ring(-0.12, 0.15, 0.12, 0.02, SIDES),
    ring(0.12, 0.14, 0.112, 0.012, SIDES),
    ring(0.32, 0.1, 0.082, 0, SIDES),
    ring(0.46, 0.055, 0.046, -0.012, SIDES),
  ];
  const segmentPart = [P.metal, P.hull, P.hull, P.hull, P.trim];
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let k = 0; k < SIDES; k++) {
      const j = (k + 1) % SIDES;
      b.quad(rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k], segmentPart[i]);
    }
  }
  const noseTip: V3 = [0, -0.02, 0.58];
  const last = rings[rings.length - 1];
  for (let k = 0; k < SIDES; k++) b.tri(last[k], last[(k + 1) % SIDES], noseTip, P.trim);
  // Tail: a metal cap with the main engine's glowing nozzle.
  poly(b, rings[0], [0, 0, -1], P.metal);
  b.ao = () => 1;
  poly(b, ring(-0.466, 0.058, 0.052, 0.02, SIDES), [0, 0, -1], P.engine);

  // Canopy.
  b.ao = (p) => 0.75 + 0.25 * smooth(0.05, 0.16, p[1]);
  b.blob([0, 0.105, 0.1], 0.1, [0.72, 0.62, 1.5], 0, 7, P.glass, 1);

  // Wings: hull-coloured inner panels, coloured tips, a little dihedral.
  b.ao = (p) => 0.6 + 0.4 * smooth(-0.13, 0.1, p[1]);
  for (const s of [1, -1]) {
    const rootLE: V3 = [s * 0.1, -0.025, 0.1];
    const rootTE: V3 = [s * 0.1, -0.025, -0.28];
    const tipLE: V3 = [s * 0.58, 0.035, -0.13];
    const tipTE: V3 = [s * 0.58, 0.035, -0.3];
    const k = 0.55;
    const midLE = lerp3(rootLE, tipLE, k);
    const midTE = lerp3(rootTE, tipTE, k);
    slab(b, [rootLE, rootTE], [midLE, midTE], [0, 1, 0], [0.05, 0.034], P.hull, { tip: false });
    slab(b, [midLE, midTE], [tipLE, tipTE], [0, 1, 0], [0.034, 0.02], P.trim);

    // Engine pod under the wing, with an intake and a glowing nozzle.
    const x = s * 0.3;
    const y = -0.065;
    b.frustum([x, y, -0.38], [x, y, 0.08], 0.058, 0.058, 8, P.hull, Math.PI / 8, false);
    b.frustum([x, y, 0.08], [x, y, 0.15], 0.058, 0.034, 8, P.metal, Math.PI / 8);
    b.frustum([x, y, -0.38], [x, y, -0.44], 0.058, 0.05, 8, P.metal, Math.PI / 8, false);
    poly(b, ring(-0.44, 0.05, 0.05, y, 8, Math.PI / 8).map((p): V3 => [p[0] + x, p[1], p[2]]), [0, 0, -1], P.metal);
    b.ao = () => 1;
    poly(b, ring(-0.445, 0.04, 0.04, y, 8, Math.PI / 8).map((p): V3 => [p[0] + x, p[1], p[2]]), [0, 0, -1], P.engine);

    // Twin blasters under the wing roots.
    b.ao = () => 0.8;
    b.frustum([s * 0.2, -0.05, 0.0], [s * 0.2, -0.05, 0.38], 0.022, 0.016, 6, P.metal);

    // Navigation lights on the wing tips (red to port, green to starboard).
    b.ao = () => 1;
    b.blob([s * 0.59, 0.036, -0.21], 0.028, [1, 1, 1], 0, 20 + s, s > 0 ? P.navLeft : P.navRight);
    b.ao = (p) => 0.6 + 0.4 * smooth(-0.13, 0.1, p[1]);
  }

  // Tail fin.
  b.ao = (p) => 0.72 + 0.28 * smooth(0.08, 0.3, p[1]);
  slab(b, [[0, 0.1, -0.1], [0, 0.1, -0.42]], [[0, 0.31, -0.35], [0, 0.31, -0.47]], [1, 0, 0], [0.036, 0.018], P.trim);

  return b.build();
}

import * as THREE from 'three';
import type { Effects } from './Effects';
import { createBoltMaterial } from './materials';
import type { PropField } from './PropField';
import { advance, type Ship } from './Ship';
import { SHIP_GUNS } from './shipGeometry';
import type { Surface } from './Surface';

/** Blaster tuning; distances in units (typical prop height), like the flight tuning. */
export const BLASTER = {
  /** Shots per second, alternating between the two guns. */
  rate: 8,
  /** Muzzle speed on top of the ship's own speed. */
  speed: 22,
  /** Seconds before a bolt fizzles out. */
  life: 1.1,
  /** Bolts dip so they cross this height above flat ground… */
  aimHeight: 0.45,
  /** …this far ahead (plus a bit more when flying high). */
  aimDistance: 3.6,
  maxBolts: 48,
} as const;

export type HitKind = 'ground' | 'water' | 'prop';

export interface BoltHit {
  kind: HitKind;
  /** Planet-local impact point and surface normal. */
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** PropField index for prop hits. */
  prop: number;
}

interface Bolt {
  dir: THREE.Vector3;
  fwd: THREE.Vector3;
  radius: number;
  vr: number;
  speed: number;
  life: number;
}

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _v = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();

/** A slim, glowing double cone along +Z, one unit long. */
function boltGeometry(): THREE.BufferGeometry {
  const sides = 6;
  const pos: number[] = [];
  const ring = (k: number) => [Math.cos((k / sides) * Math.PI * 2) * 0.5, Math.sin((k / sides) * Math.PI * 2) * 0.5, 0.12];
  for (let k = 0; k < sides; k++) {
    const a = ring(k);
    const b = ring(k + 1);
    pos.push(...a, ...b, 0, 0, 0.5);
    pos.push(...b, ...a, 0, 0, -0.5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Twin blasters: bolts fly along the curvature, dipping gently so they strafe the ground ahead. */
export class Blasters {
  readonly mesh: THREE.InstancedMesh;
  private readonly bolts: Bolt[] = [];
  private live = 0;
  private cooldown = 0;
  private gun = 0;
  private readonly hit: BoltHit = { kind: 'ground', point: new THREE.Vector3(), normal: new THREE.Vector3(), prop: -1 };
  /** Called for every shot (gun 0 = left, 1 = right) with the planet-local muzzle position. */
  onShot: (gun: number, muzzle: THREE.Vector3) => void = () => {};
  /** Called when a bolt hits something. The hit object is reused; copy what you keep. */
  onHit: (hit: BoltHit) => void = () => {};

  constructor() {
    this.mesh = new THREE.InstancedMesh(boltGeometry(), createBoltMaterial(new THREE.Color(7, 1.6, 0.7)), BLASTER.maxBolts);
    this.mesh.name = 'Bolts';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    for (let i = 0; i < BLASTER.maxBolts; i++) {
      this.bolts.push({ dir: new THREE.Vector3(), fwd: new THREE.Vector3(), radius: 1, vr: 0, speed: 0, life: 0 });
    }
  }

  clear(): void {
    this.live = 0;
    this.mesh.count = 0;
    this.cooldown = 0;
  }

  update(dt: number, firing: boolean, ship: Ship, surface: Surface, props: PropField, effects: Effects): void {
    const u = ship.unit;
    this.cooldown -= dt;
    if (firing && this.cooldown <= 0) {
      this.fire(ship);
      this.cooldown += 1 / BLASTER.rate;
    }
    if (this.cooldown < 0) this.cooldown = 0;

    let i = 0;
    while (i < this.live) {
      const b = this.bolts[i];
      _v.copy(b.dir).multiplyScalar(b.radius);
      if (this.step(b, dt, u, surface, props)) {
        this.onHit(this.hit);
        this.kill(i);
        continue;
      }
      b.life -= dt;
      if (b.life <= 0) {
        effects.fizzle(_p.copy(b.dir).multiplyScalar(b.radius));
        this.kill(i);
        continue;
      }
      // A faint glowing streak behind the bolt.
      effects.trail(_v.add(_p.copy(b.dir).multiplyScalar(b.radius)).multiplyScalar(0.5));
      i++;
    }

    // Draw: each bolt stretched along its velocity.
    const w = u * 0.2;
    const len = u * 1.4;
    for (let k = 0; k < this.live; k++) {
      const b = this.bolts[k];
      _z.copy(b.fwd).multiplyScalar(b.speed).addScaledVector(b.dir, b.vr).normalize();
      _y.copy(b.dir).addScaledVector(_z, -b.dir.dot(_z)).normalize();
      _x.crossVectors(_y, _z);
      const m = this.mesh.instanceMatrix.array as Float32Array;
      const o = k * 16;
      m[o] = _x.x * w; m[o + 1] = _x.y * w; m[o + 2] = _x.z * w; m[o + 3] = 0;
      m[o + 4] = _y.x * w; m[o + 5] = _y.y * w; m[o + 6] = _y.z * w; m[o + 7] = 0;
      m[o + 8] = _z.x * len; m[o + 9] = _z.y * len; m[o + 10] = _z.z * len; m[o + 11] = 0;
      m[o + 12] = b.dir.x * b.radius; m[o + 13] = b.dir.y * b.radius; m[o + 14] = b.dir.z * b.radius; m[o + 15] = 1;
    }
    this.mesh.count = this.live;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private fire(ship: Ship): void {
    if (this.live >= this.bolts.length) return;
    const gun = this.gun;
    this.gun = (this.gun + 1) % SHIP_GUNS.length;
    const muzzle = ship.localPoint(SHIP_GUNS[gun], _q);
    this.launch(ship, muzzle, this.bolts[this.live++]);
    this.onShot(gun, muzzle);
  }

  /** Set up a bolt leaving `muzzle` (planet-local). */
  private launch(ship: Ship, muzzle: THREE.Vector3, b: Bolt): Bolt {
    const u = ship.unit;
    b.radius = muzzle.length();
    b.dir.copy(muzzle).divideScalar(b.radius);
    b.fwd.copy(ship.fwd).addScaledVector(b.dir, -ship.fwd.dot(b.dir)).normalize();
    b.speed = ship.speed + BLASTER.speed * u;
    const aimDistance = (BLASTER.aimDistance + ship.altitude * 0.7) * u;
    const slope = THREE.MathUtils.clamp((ship.clearance - BLASTER.aimHeight * u) / aimDistance, 0, 0.55);
    b.vr = ship.vr - slope * b.speed;
    b.life = BLASTER.life;
    return b;
  }

  /** Move a bolt; true (and this.hit filled in) if it hit something. */
  private step(b: Bolt, dt: number, u: number, surface: Surface, props: PropField): boolean {
    const dist = b.speed * dt;
    const steps = Math.max(1, Math.ceil(dist / (u * 0.3)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      advance(b.dir, b.fwd, (b.speed * h) / b.radius);
      b.radius += b.vr * h;
      const ground = surface.groundAt(b.dir);
      if (b.radius <= ground) {
        this.hit.kind = surface.water ? 'water' : 'ground';
        this.hit.point.copy(b.dir).multiplyScalar(ground);
        this.hit.normal.copy(surface.normal);
        this.hit.prop = -1;
        return true;
      }
      _p.copy(b.dir).multiplyScalar(b.radius);
      const prop = props.hitAt(_p.x, _p.y, _p.z, u * 0.06);
      if (prop >= 0) {
        this.hit.kind = 'prop';
        this.hit.point.copy(_p);
        this.hit.normal.copy(b.dir);
        this.hit.prop = prop;
        return true;
      }
    }
    return false;
  }

  private kill(i: number): void {
    this.live--;
    if (i !== this.live) {
      const tmp = this.bolts[i];
      this.bolts[i] = this.bolts[this.live];
      this.bolts[this.live] = tmp;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

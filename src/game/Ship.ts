import * as THREE from 'three';
import type { V3 } from '../render/propGeometry';
import type { SharedUniforms } from '../render/PlanetView';
import type { QualityDefines } from '../render/quality';
import { SHADOW_LAYER } from '../render/SunShadow';
import { createShipMaterial } from './materials';
import type { PropField } from './PropField';
import { SHIP_LENGTH, shipGeometry } from './shipGeometry';
import type { Surface } from './Surface';

export interface FlightInput {
  /** -1 (left) … 1 (right) */
  turn: number;
  /** -1 (down) … 1 (up) */
  climb: number;
  boost: boolean;
}

/**
 * Flight tuning. Distances and speeds are in "units": the height of a typical tree on the
 * current world (propScale), so the ship feels the same on tiny and large worlds.
 */
export const FLIGHT = {
  length: 0.85,
  cruise: 6,
  boost: 11.5,
  /** Fastest turn (rad/s). */
  yawRate: 1.9,
  climbRate: 2.6,
  minAltitude: 1.2,
  maxAltitude: 4.2,
  startAltitude: 1.8,
  /** Clearance kept above trees and houses. */
  propClearance: 0.42,
} as const;

const LOOK_AHEAD = [0, 0.9, 1.9, 3] as const;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _adv = new THREE.Vector3();

/** Move point `dir` (unit) a great-circle angle along tangent `fwd`; both are updated in place. */
export function advance(dir: THREE.Vector3, fwd: THREE.Vector3, angle: number): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  _adv.copy(dir).multiplyScalar(c).addScaledVector(fwd, s);
  fwd.multiplyScalar(c).addScaledVector(dir, -s);
  dir.copy(_adv).normalize();
  fwd.addScaledVector(dir, -fwd.dot(dir)).normalize();
}

/**
 * The player's ship. It flies in planet-local space (add `mesh` to PlanetView.spin), always
 * level with the planet below: moving forward follows a great circle, and the height above the
 * ground is held by a spring that looks ahead for hills, trees and houses.
 */
export class Ship {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  /** Unit vector from the planet centre to the ship. */
  readonly dir = new THREE.Vector3(0, 1, 0);
  /** Unit heading, tangent to the planet. */
  readonly fwd = new THREE.Vector3(0, 0, 1);
  radius = 1.1;
  /** Radial (climb) speed, planet radii per second. */
  vr = 0;
  /** Ground speed, planet radii per second. */
  speed = 0;
  yawRate = 0;
  /** Target height above the ground (units). */
  altitude: number = FLIGHT.startAltitude;
  /** Smoothed 0..1 while boosting. */
  boost = 0;
  /** Height above the ground or sea right below the ship (planet radii). */
  clearance = 0;
  bank = 0;
  pitch = 0;
  /** Typical prop height on this world (planet radii). */
  unit = 0.05;
  private bob = 0;
  private time = 0;
  private readonly engineColor = new THREE.Color('#66ccff');

  constructor(shared: SharedUniforms, quality: QualityDefines) {
    this.material = createShipMaterial(shared, quality, { hull: '#f2efe8', trim: '#ff6b3d', metal: '#4f5766', glass: '#173247' });
    this.mesh = new THREE.Mesh(shipGeometry(), this.material);
    this.mesh.name = 'Ship';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.enable(SHADOW_LAYER);
    this.mesh.visible = false;
  }

  /** World scale of the model. */
  get scale(): number {
    return (FLIGHT.length * this.unit) / SHIP_LENGTH;
  }

  /** Place the ship over `dir` heading along `fwd`, at its cruising height. */
  spawn(dir: THREE.Vector3, fwd: THREE.Vector3, surface: Surface, unit: number): void {
    this.unit = unit;
    this.dir.copy(dir).normalize();
    this.fwd.copy(fwd).addScaledVector(this.dir, -fwd.dot(this.dir)).normalize();
    this.altitude = FLIGHT.startAltitude;
    this.radius = surface.groundAt(this.dir) + this.altitude * unit;
    this.vr = 0;
    this.speed = FLIGHT.cruise * unit;
    this.yawRate = 0;
    this.boost = 0;
    this.bank = 0;
    this.pitch = 0;
    this.material.uniforms.uSelfShadow.value = SHIP_LENGTH * this.scale * 0.9;
    this.mesh.visible = true;
    this.updateMatrix();
  }

  update(dt: number, input: FlightInput, surface: Surface, props: PropField): void {
    const u = this.unit;
    this.time += dt;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);

    // Speed and boost.
    this.boost += ((input.boost ? 1 : 0) - this.boost) * k(3);
    const targetSpeed = (input.boost ? FLIGHT.boost : FLIGHT.cruise) * u;
    this.speed += (targetSpeed - this.speed) * k(input.boost ? 2.6 : 1.5);

    // Steering: turn the heading about the local vertical.
    this.yawRate += (-input.turn * FLIGHT.yawRate - this.yawRate) * k(7);
    _b.crossVectors(this.dir, this.fwd); // left
    const yaw = this.yawRate * dt;
    this.fwd.multiplyScalar(Math.cos(yaw)).addScaledVector(_b, Math.sin(yaw)).normalize();

    // Height above the ground.
    this.altitude = THREE.MathUtils.clamp(this.altitude + input.climb * FLIGHT.climbRate * dt, FLIGHT.minAltitude, FLIGHT.maxAltitude);

    // Fly along the great circle.
    advance(this.dir, this.fwd, (this.speed * dt) / this.radius);

    // Terrain following: hold the altitude over the highest ground a little ahead, and clear props.
    let target = -Infinity;
    let below = 0;
    for (const ahead of LOOK_AHEAD) {
      _a.copy(this.dir);
      _c.copy(this.fwd);
      if (ahead > 0) advance(_a, _c, (ahead * u) / this.radius);
      const ground = surface.groundAt(_a);
      if (ahead === 0) below = ground;
      _a.multiplyScalar(ground + u * 0.6);
      const top = props.topNear(_a.x, _a.y, _a.z, u * 0.55);
      const want = Math.max(ground + this.altitude * u, top + FLIGHT.propClearance * u);
      target = Math.max(target, want - ahead * u * 0.14);
    }
    // Critically damped spring, sub-stepped so long frames stay stable.
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    const h = dt / steps;
    const w = 8.5;
    for (let s = 0; s < steps; s++) {
      this.vr += (w * w * (target - this.radius) - 2 * w * this.vr) * h;
      this.radius += this.vr * h;
    }
    const floor = below + u * 0.38;
    if (this.radius < floor) {
      this.radius = floor;
      this.vr = Math.max(this.vr, 0);
    }
    this.clearance = this.radius - below;

    // Attitude (visual only): bank into turns, pitch with the climb, a gentle hover bob.
    this.bank += (THREE.MathUtils.clamp(-this.yawRate * 0.34, -0.6, 0.6) - this.bank) * k(6);
    const pitch = Math.atan2(this.vr, Math.max(this.speed, 1e-6));
    this.pitch += (THREE.MathUtils.clamp(pitch, -0.6, 0.6) - this.pitch) * k(8);
    this.bob = Math.sin(this.time * 2.3) * 0.035 * u;

    // Engine glow and blinking navigation lights.
    const uni = this.material.uniforms;
    const flicker = 0.92 + 0.08 * Math.sin(this.time * 61) * Math.sin(this.time * 23);
    (uni.uEngine.value as THREE.Color).copy(this.engineColor).multiplyScalar((3 + 4 * this.boost) * flicker);
    const blink = this.time % 1.4 < 0.12 ? 7 : 0.5;
    (uni.uNavLeft.value as THREE.Color).setRGB(1, 0.12, 0.1).multiplyScalar(blink);
    (uni.uNavRight.value as THREE.Color).setRGB(0.15, 1, 0.3).multiplyScalar(blink);

    this.updateMatrix();
  }

  private updateMatrix(): void {
    const up = _a.copy(this.dir);
    const fwd = _b.copy(this.fwd);
    const left = _c.crossVectors(up, fwd);
    // Pitch about the left axis (nose up for positive pitch), then bank about the nose.
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const f2x = fwd.x * cp + up.x * sp;
    const f2y = fwd.y * cp + up.y * sp;
    const f2z = fwd.z * cp + up.z * sp;
    up.multiplyScalar(cp).addScaledVector(fwd, -sp);
    fwd.set(f2x, f2y, f2z);
    const cb = Math.cos(this.bank);
    const sb = Math.sin(this.bank);
    const l2x = left.x * cb + up.x * sb;
    const l2y = left.y * cb + up.y * sb;
    const l2z = left.z * cb + up.z * sb;
    up.multiplyScalar(cb).addScaledVector(left, -sb);
    left.set(l2x, l2y, l2z);
    const s = this.scale;
    const r = this.radius + this.bob;
    this.mesh.matrix.makeBasis(left.multiplyScalar(s), up.multiplyScalar(s), fwd.multiplyScalar(s));
    this.mesh.matrix.setPosition(this.dir.x * r, this.dir.y * r, this.dir.z * r);
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  /** Planet-local position of a point given in model space. */
  localPoint(p: V3, out: THREE.Vector3): THREE.Vector3 {
    return out.set(p[0], p[1], p[2]).applyMatrix4(this.mesh.matrix);
  }

  /** Planet-local velocity of the ship. */
  velocity(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.fwd).multiplyScalar(this.speed).addScaledVector(this.dir, this.vr);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

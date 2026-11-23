import * as THREE from 'three';
import type { Ship } from './Ship';
import type { Surface } from './Surface';

/** Chase camera tuning; distances in units (typical prop height) like the flight tuning. */
export const CAMERA = {
  distance: 3.2,
  boostDistance: 0.7,
  height: 2.9,
  /**
   * Pitch down until the horizon sits this share of the half screen height above the centre (on
   * a tiny world the horizon dips far below level, so this is what shows the ground ahead)…
   */
  horizon: 0.3,
  /** …but keep the ship between these shares of the half height below the centre. */
  shipHigh: 0.12,
  shipLow: 0.55,
  /** How quickly the camera catches up (1/s); lower is floatier. */
  stiffness: 10,
  /** How quickly it swings round behind the ship after a turn (1/s). */
  swing: 4.5,
  /** Share of the ship's bank the camera rolls along with. */
  roll: 0.25,
  /** Vertical field of view (degrees)… */
  fov: 57,
  boostFov: 9,
  /** …widened on narrow (portrait) screens to show at least this much horizontally. */
  minHorizontalFov: 52,
};

export type CameraTuning = typeof CAMERA;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const ORBIT_FOV = 40;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Third-person camera in planet-local space. It trails the ship with its "up" along the planet's
 * radius, so the horizon stays level and curves away. An orbit pose (the whole planet in view)
 * can be blended in for arrivals and departures.
 */
export class ChaseCamera {
  /** Live tuning (a copy of CAMERA). */
  readonly tuning: CameraTuning = { ...CAMERA };
  private readonly pos = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly heading = new THREE.Vector3(0, 0, 1);
  private fov: number = CAMERA.fov;
  private near = 0.01;
  private pitch = 0.5;
  private aspect = 16 / 9;
  private settled = false;
  /** Orbit pose: direction from the planet centre, distance and up vector. */
  private readonly orbitDir = new THREE.Vector3(0, 0.3, 1).normalize();
  private orbitDistance = 3.6;
  private readonly orbitUp = new THREE.Vector3(0, 1, 0);
  /** 0 = orbit view, 1 = chase view (eased when applied). */
  blend = 0;

  /** Jump straight behind the ship on the next follow(). */
  reset(): void {
    this.settled = false;
  }

  /** Point the orbit view at the planet from direction `dir`, `distance` from its centre. */
  setOrbit(dir: THREE.Vector3, distance: number, up: THREE.Vector3): void {
    this.orbitDir.copy(dir).normalize();
    this.orbitDistance = distance;
    this.orbitUp.copy(up).addScaledVector(this.orbitDir, -up.dot(this.orbitDir)).normalize();
  }

  /** Slowly turn the orbit view about the planet's axis (for the loading screen). */
  turnOrbit(angle: number): void {
    this.orbitDir.applyAxisAngle(_a.set(0, 1, 0), angle);
    this.orbitUp.applyAxisAngle(_a, angle);
  }

  /** Update the chase pose behind the ship. */
  follow(dt: number, ship: Ship, surface: Surface): void {
    const k = this.tuning;
    const u = ship.unit;
    const s = ship.dir;
    // Keep the camera's heading tangent at the ship and swing it round towards the ship's.
    this.heading.addScaledVector(s, -this.heading.dot(s));
    if (!this.settled || this.heading.lengthSq() < 1e-10 || this.heading.dot(ship.fwd) < -0.95) this.heading.copy(ship.fwd);
    this.heading.normalize().lerp(ship.fwd, 1 - Math.exp(-dt * k.swing)).normalize();

    const dist = (k.distance + k.boostDistance * ship.boost) * u;
    const ship3 = _a.copy(s).multiplyScalar(ship.radius);
    const want = _b.copy(ship3).addScaledVector(this.heading, -dist).addScaledVector(s, k.height * u);
    if (!this.settled) this.pos.copy(want);
    else this.pos.lerp(want, 1 - Math.exp(-dt * k.stiffness));
    // Never dip into hills or the sea.
    const minR = surface.groundAt(this.pos) + u * 0.5;
    if (this.pos.length() < minR) this.pos.setLength(minR);

    // Look down past the horizon so the ground ahead is in view, with the ship in the lower half.
    const rc = this.pos.length();
    const camUp = _c.copy(this.pos).divideScalar(rc);
    const level = _d.copy(this.heading).addScaledVector(camUp, -this.heading.dot(camUp)).normalize();
    const half = THREE.MathUtils.degToRad(this.fovFor(this.aspect)) / 2;
    const ground = Math.min(ship.radius - ship.clearance, rc - 1e-6);
    const dip = Math.acos(THREE.MathUtils.clamp(ground / rc, -1, 1));
    const toShip = ship3.sub(this.pos);
    const shipAngle = Math.atan2(-toShip.dot(camUp), Math.max(1e-9, toShip.dot(level)));
    const pitch = THREE.MathUtils.clamp(dip + k.horizon * half, shipAngle - k.shipLow * half, shipAngle - k.shipHigh * half);
    if (!this.settled) this.pitch = pitch;
    else this.pitch += (pitch - this.pitch) * (1 - Math.exp(-dt * 6));
    this.target.copy(this.pos).addScaledVector(level, Math.cos(this.pitch) * u).addScaledVector(camUp, -Math.sin(this.pitch) * u);
    this.settled = true;

    // Level with the planet, rolled a little into the ship's turns.
    const left = _a.crossVectors(s, this.heading);
    this.up.copy(camUp).addScaledVector(left, -Math.sin(ship.bank) * k.roll).normalize();
    this.fov = k.fov + k.boostFov * ship.boost;
    this.near = u * 0.12;
  }

  /** Vertical FOV for this aspect ratio: wider on portrait screens, so the view isn't a slit. */
  private fovFor(aspect: number): number {
    const k = this.tuning;
    const fromWidth = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(k.minHorizontalFov) / 2) / aspect));
    return Math.max(this.fov, Math.min(fromWidth, 82));
  }

  /** Write the (blended) pose into a camera; `frame` maps planet-local to world space. */
  apply(camera: THREE.PerspectiveCamera, frame: THREE.Matrix4): void {
    const t = THREE.MathUtils.clamp(this.blend, 0, 1);
    this.aspect = camera.aspect;
    const chaseFov = this.fovFor(camera.aspect);
    let fov = chaseFov;
    let near = this.near;
    if (t >= 1) {
      camera.position.copy(this.pos).applyMatrix4(frame);
      camera.up.copy(this.up).transformDirection(frame);
      camera.lookAt(_b.copy(this.target).applyMatrix4(frame));
    } else {
      // Orbit orientation: looking at the planet centre.
      const orbitPos = _a.copy(this.orbitDir).multiplyScalar(this.orbitDistance).applyMatrix4(frame);
      const center = _b.set(0, 0, 0).applyMatrix4(frame);
      _c.copy(this.orbitUp).transformDirection(frame);
      _q.setFromRotationMatrix(_m.lookAt(orbitPos, center, _c));
      if (t <= 0) {
        camera.position.copy(orbitPos);
        fov = ORBIT_FOV;
        near = 0.05;
      } else {
        // Swoop down: turn the direction and close the distance (evenly in log space, so the
        // ground doesn't rush up at the end), while the view tilts from the planet to the horizon.
        const e = easeInOut(t);
        const r1 = this.pos.length();
        const dir = _a.copy(this.orbitDir).lerp(_d.copy(this.pos).divideScalar(r1), Math.min(1, e * 1.15)).normalize();
        dir.multiplyScalar(Math.exp(Math.log(this.orbitDistance) * (1 - e) + Math.log(r1) * e));
        camera.position.copy(dir).applyMatrix4(frame);
        const chasePos = _b.copy(this.pos).applyMatrix4(frame);
        _c.copy(this.up).transformDirection(frame);
        _q2.setFromRotationMatrix(_m.lookAt(chasePos, _d.copy(this.target).applyMatrix4(frame), _c));
        _q.slerp(_q2, easeInOut(Math.min(1, t * 1.05)));
        fov = ORBIT_FOV + (chaseFov - ORBIT_FOV) * e;
        near = 0.05 + (this.near - 0.05) * e;
      }
      camera.quaternion.copy(_q);
    }
    if (camera.fov !== fov || camera.near !== near) {
      camera.fov = fov;
      camera.near = near;
      camera.updateProjectionMatrix();
    }
  }
}

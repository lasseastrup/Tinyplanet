import * as THREE from 'three';
import type { App, CameraRig } from '../app/App';
import { hexToLinear } from '../core/math';
import { Rng, randomSeed } from '../core/rng';
import { propScale } from '../planet/params';
import type { PropKind, PropPlacement, VillageSite } from '../planet/props';
import { Blasters, type BoltHit } from './Blasters';
import { ChaseCamera } from './ChaseCamera';
import { Effects } from './Effects';
import type { Hud } from './Hud';
import type { Controls, Input } from './Input';
import { PropField } from './PropField';
import type { Sfx } from './Sfx';
import { advance, Ship } from './Ship';
import { SHIP_NOZZLES } from './shipGeometry';
import { Surface } from './Surface';
import { FAMILIES, makeWorld, type World } from './worlds';

type State = 'loading' | 'arriving' | 'flying' | 'leaving';

/** Seconds for the dive from orbit to the ship, and for pulling out when leaving. */
const ARRIVE_TIME = 2.6;
const LEAVE_TIME = 1.2;
/**
 * The sun keeps this elevation (and its direction relative to the ground) wherever the ship
 * flies: the planet rolls along under it, so it's always daytime where you are. It starts
 * behind the ship and a little to the left, so the view ahead is lit and shadows fall forwards.
 */
const SUN_ELEVATION = THREE.MathUtils.degToRad(40);
const SUN_AZIMUTH = THREE.MathUtils.degToRad(35);
const SUN_COLOR = new THREE.Color(1, 0.95, 0.88);
const IDLE: Controls = { turn: 0, climb: 0, boost: false, fire: false };

type RGB = [number, number, number];
const mix3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * Fly a little ship around a tiny planet and blast things. Implements the App's camera rig:
 * update() runs every frame after the planet has turned and before rendering. Everything the
 * game adds lives in planet-local space under PlanetView.spin.
 */
export class Game implements CameraRig {
  readonly ship: Ship;
  readonly blasters = new Blasters();
  readonly effects: Effects;
  readonly surface = new Surface();
  readonly props = new PropField();
  readonly camera = new ChaseCamera();
  private readonly root = new THREE.Group();
  private readonly reticle: THREE.Mesh;
  private readonly reticleMat: THREE.MeshBasicMaterial;
  private state: State = 'loading';
  private stateTime = 0;
  private world: World;
  private pending: World | null = null;
  private family: number;
  private villages: VillageSite[] = [];
  private terrainReady = false;
  private pops: Array<{ kind: PropKind; index: number; t: number }> = [];
  private exhaustDebt = 0;
  /** Direction to the sun, planet-local; carried along with the ship. */
  private readonly sun = new THREE.Vector3(1, 0, 0);
  private readonly sunWorld = new THREE.Vector3();
  private readonly lastDir = new THREE.Vector3(0, 1, 0);
  private readonly carry = new THREE.Quaternion();
  private dust: RGB = [0.5, 0.45, 0.4];
  private water: RGB = [0.7, 0.85, 0.95];
  private arrived = false;
  /** Called once, when the first world is ready to fly. */
  onFirstArrival: () => void = () => {};

  constructor(
    private readonly app: App,
    private readonly hud: Hud,
    private readonly input: Input,
    private readonly sfx: Sfx,
    world: World,
  ) {
    this.world = world;
    this.family = Math.max(0, FAMILIES.indexOf(world.params.preset as (typeof FAMILIES)[number]));
    this.ship = new Ship(app.planet.uniforms, app.quality.defines);
    this.effects = new Effects(app.planet.uniforms);
    this.reticleMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(), transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 40), this.reticleMat);
    this.reticle.matrixAutoUpdate = false;
    this.reticle.renderOrder = 10;
    this.reticle.visible = false;
    this.root.name = 'Game';
    this.root.add(this.ship.mesh, this.blasters.mesh, this.effects.group, this.reticle);
    app.planet.spin.add(this.root);

    this.blasters.onShot = (gun, muzzle) => {
      this.effects.muzzle(muzzle, this.ship.velocity(_v));
      this.sfx.shoot(gun === 0 ? -0.35 : 0.35);
    };
    this.blasters.onHit = (hit) => this.onBoltHit(hit);
    this.describe(world);
  }

  /** The world on screen. */
  get current(): World {
    return this.world;
  }

  /** Props were (re)placed on the planet: index them for collisions. */
  onProps(placement: PropPlacement): void {
    const unit = propScale(this.app.params.size);
    this.props.build(placement.sets, unit, unit * 0.8);
    this.villages = placement.villages;
    this.pops.length = 0;
  }

  /** New terrain arrived; the full-quality one (nothing left to generate) starts the flight. */
  onGenerated(): void {
    this.surface.sync(this.app.planet);
    if (!this.app.generating) this.terrainReady = true;
  }

  /** Pull out and fly to another world of the next family. */
  nextWorld(): void {
    if (this.state !== 'flying' && this.state !== 'arriving') return;
    this.family = (this.family + 1) % FAMILIES.length;
    this.pending = makeWorld(FAMILIES[this.family]);
    // Pull out to a view of the planet from above and behind the ship.
    this.camera.setOrbit(_v.copy(this.ship.dir).addScaledVector(this.ship.fwd, -0.55), 3.6, this.ship.fwd);
    this.setState('leaving');
    this.sfx.warp();
  }

  update(dt: number): void {
    const planet = this.app.planet;
    this.stateTime += dt;
    const controls = this.input.read();
    let flight = controls;

    switch (this.state) {
      case 'loading':
        this.camera.blend = 0;
        this.camera.turnOrbit(dt * 0.06);
        if (this.terrainReady && this.surface.ready) this.arrive();
        break;
      case 'arriving':
        this.camera.blend = Math.min(1, this.stateTime / ARRIVE_TIME);
        if (this.stateTime < ARRIVE_TIME * 0.5) flight = IDLE;
        if (this.stateTime >= ARRIVE_TIME) this.setState('flying');
        break;
      case 'leaving':
        flight = IDLE;
        this.camera.blend = 1 - Math.min(1, this.stateTime / LEAVE_TIME);
        if (this.stateTime > LEAVE_TIME * 0.4) this.hud.setFade(true, `Warping to ${this.pending?.params.name ?? 'a new world'}…`);
        if (this.stateTime >= LEAVE_TIME) this.load();
        break;
      case 'flying':
        break;
    }

    this.effects.step(dt, this.surface);
    const flyingShip = this.ship.mesh.visible;
    if (flyingShip) {
      this.ship.update(dt, flight, this.surface, this.props);
      this.carrySun();
      this.exhaust(dt);
      this.blasters.update(dt, flight.fire, this.ship, this.surface, this.props, this.effects);
      this.camera.follow(dt, this.ship, this.surface);
      // Puffy clouds hang low on tiny worlds: let the camera see through the ones close to it.
      planet.setCloudNearFade(this.ship.unit * 4);
      // Keep the ship inside the sun's shadow map (in steps, so the map doesn't shimmer).
      planet.shadowReach = Math.ceil((this.ship.radius + this.ship.unit * 1.5) * 20) / 20;
    } else {
      planet.shadowReach = 0;
    }
    this.updateReticle(flyingShip && this.state !== 'leaving');
    this.updatePops(dt);
    const cam = this.app.camera;
    const pxScale = this.app.renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    this.effects.upload(this.sun, pxScale);
    this.camera.apply(cam, planet.spin.matrixWorld);
    this.sfx.engine(flyingShip ? 1 : 0, this.ship.boost);
  }

  /** Rotate the sun along with the ship's motion over the planet, then light the scene with it. */
  private carrySun(): void {
    const dir = this.ship.dir;
    this.sun.applyQuaternion(this.carry.setFromUnitVectors(this.lastDir, dir));
    this.lastDir.copy(dir);
    // Pin the elevation exactly (rounding would make it drift over a long flight).
    const tangent = _w.copy(this.sun).addScaledVector(dir, -this.sun.dot(dir));
    if (tangent.lengthSq() > 1e-10) {
      tangent.normalize();
      this.sun.copy(dir).multiplyScalar(Math.sin(SUN_ELEVATION)).addScaledVector(tangent, Math.cos(SUN_ELEVATION));
    }
    this.applySun();
  }

  private applySun(): void {
    const planet = this.app.planet;
    this.sunWorld.copy(this.sun).transformDirection(planet.spin.matrixWorld);
    planet.uniforms.uSunDir.value.copy(this.sunWorld);
    this.app.space.setSun(this.sunWorld, SUN_COLOR, this.app.params.sunIntensity);
  }

  private setState(state: State): void {
    this.state = state;
    this.stateTime = 0;
    this.input.enabled = state !== 'leaving';
  }

  private describe(world: World): void {
    const p = world.params;
    this.hud.setWorld(p.name, world.label);
    this.dust = p.temperature < -0.2 ? (hexToLinear(p.cSnow).map((c) => c * 0.85) as RGB) : mix3(hexToLinear(p.cSand), hexToLinear(p.cRock), 0.45);
    this.water = mix3(hexToLinear(p.cShallow), [1, 1, 1], 0.5);
  }

  /** Swap in the pending world's planet; flight resumes when its terrain is ready. */
  private load(): void {
    const world = this.pending;
    if (!world) return;
    this.pending = null;
    this.world = world;
    this.terrainReady = false;
    this.ship.mesh.visible = false;
    this.blasters.clear();
    this.effects.clear();
    this.pops.length = 0;
    this.describe(world);
    this.app.setParams(world.params);
    this.setState('loading');
  }

  /** Place the ship near a village (or over land), light it from behind and dive in from orbit. */
  private arrive(): void {
    this.surface.sync(this.app.planet);
    const unit = propScale(this.app.params.size);
    this.effects.unit = unit;
    const { dir, fwd } = this.pickStart(unit);
    this.ship.spawn(dir, fwd, this.surface, unit);
    // Sun behind the ship, a little to the left.
    const left = _x.crossVectors(dir, fwd);
    this.sun
      .copy(fwd)
      .multiplyScalar(-Math.cos(SUN_AZIMUTH))
      .addScaledVector(left, Math.sin(SUN_AZIMUTH))
      .multiplyScalar(Math.cos(SUN_ELEVATION))
      .addScaledVector(dir, Math.sin(SUN_ELEVATION));
    this.lastDir.copy(dir);
    this.applySun();
    this.camera.reset();
    this.camera.follow(0, this.ship, this.surface);
    // Start high above and behind the ship, with its heading pointing up the screen.
    _v.copy(dir).addScaledVector(fwd, -0.55).normalize();
    this.camera.setOrbit(_v, 3.6, fwd);
    this.camera.blend = 0;
    this.setState('arriving');
    this.hud.setFade(false);
    if (!this.arrived) {
      this.arrived = true;
      this.onFirstArrival();
      this.hud.showHint(this.input.touch);
    }
  }

  /** Start a few units from a village (or somewhere on land), heading towards it. */
  private pickStart(unit: number): { dir: THREE.Vector3; fwd: THREE.Vector3 } {
    const rng = new Rng(randomSeed());
    const s = this.surface;
    const target = new THREE.Vector3();
    const isLand = (v: THREE.Vector3) => !s.hasOcean || s.terrain(v.x, v.y, v.z) > s.oceanRadius + unit * 0.2;
    if (this.villages.length > 0) {
      const v = rng.pick(this.villages);
      target.set(v.dir[0], v.dir[1], v.dir[2]);
    } else {
      target.set(...rng.unitVector());
      for (let i = 0; i < 200 && !isLand(target); i++) target.set(...rng.unitVector());
    }
    // Approach from a random side, preferring to start over land.
    let bestScore = -Infinity;
    const dir = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    for (let i = 0; i < 12; i++) {
      const a = rng.range(0, Math.PI * 2);
      _x.set(1, 0, 0);
      if (Math.abs(target.x) > 0.9) _x.set(0, 1, 0);
      _x.addScaledVector(target, -_x.dot(target)).normalize();
      _y.crossVectors(target, _x);
      _w.copy(_x).multiplyScalar(Math.cos(a)).addScaledVector(_y, Math.sin(a));
      _v.copy(target);
      advance(_v, _w, (7 * unit) / 1.05);
      const score = (isLand(_v) ? 1 : 0) + rng.next() * 0.5;
      if (score > bestScore) {
        bestScore = score;
        dir.copy(_v);
        fwd.copy(_w).negate();
      }
    }
    return { dir, fwd };
  }

  /** Glowing exhaust from the nozzles, spread along the path flown this frame. */
  private exhaust(dt: number): void {
    const ship = this.ship;
    const strength = ship.boost;
    this.exhaustDebt += dt * (36 + 44 * strength);
    const n = Math.floor(this.exhaustDebt);
    if (n <= 0) return;
    this.exhaustDebt -= n;
    const vel = ship.velocity(_v);
    const drift = _w.copy(vel).multiplyScalar(0.45).addScaledVector(ship.fwd, -1.6 * ship.unit);
    for (const nozzle of SHIP_NOZZLES) {
      ship.localPoint(nozzle.p, _c);
      const r = nozzle.r * ship.scale;
      for (let k = 0; k < n; k++) {
        _x.copy(_c).addScaledVector(vel, -dt * (k / n));
        this.effects.exhaust(_x, drift, r, strength);
      }
    }
  }

  /** A ring on the ground where the next bolt would land (around a prop if it would hit one). */
  private updateReticle(show: boolean): void {
    const hit = show ? this.blasters.predict(this.ship, this.surface, this.props) : null;
    if (!hit) {
      this.reticle.visible = false;
      return;
    }
    const u = this.ship.unit;
    const pulse = 1 + 0.08 * Math.sin(this.stateTime * 9);
    let size: number;
    const n = _y;
    if (hit.kind === 'prop') {
      const i = hit.prop;
      _c.set(this.props.base[i * 3], this.props.base[i * 3 + 1], this.props.base[i * 3 + 2]);
      n.set(this.props.up[i * 3], this.props.up[i * 3 + 1], this.props.up[i * 3 + 2]);
      size = (this.props.radius[i] * 1.5 + u * 0.15) * pulse;
      this.reticleMat.color.setRGB(5, 1.5, 0.7);
      this.reticleMat.opacity = 0.9;
    } else {
      _c.copy(hit.point);
      n.copy(hit.normal);
      size = u * 0.3 * pulse;
      this.reticleMat.color.setRGB(1.6, 2.1, 2.6);
      this.reticleMat.opacity = 0.55;
    }
    _c.addScaledVector(n, u * 0.06);
    // Ring lies in the plane perpendicular to n.
    _x.set(1, 0, 0);
    if (Math.abs(n.x) > 0.9) _x.set(0, 1, 0);
    _x.addScaledVector(n, -_x.dot(n)).normalize();
    _w.crossVectors(n, _x);
    this.reticle.matrix.makeBasis(_x.multiplyScalar(size), _w.multiplyScalar(size), _v.copy(n).multiplyScalar(size));
    this.reticle.matrix.setPosition(_c);
    this.reticle.matrixWorldNeedsUpdate = true;
    this.reticle.visible = true;
  }

  private onBoltHit(hit: BoltHit): void {
    if (hit.kind === 'prop') {
      this.blast(hit.prop);
    } else if (hit.kind === 'water') {
      this.effects.splash(hit.point, hit.normal, this.water);
      this.sfx.splash();
    } else {
      this.effects.impact(hit.point, hit.normal, this.dust);
      this.sfx.impact();
    }
  }

  /** Knock a prop over: it pops and bursts into pieces of its own colours. */
  private blast(i: number): void {
    const props = this.props;
    props.kill(i);
    this.pops.push({ kind: props.kinds[i], index: props.indices[i], t: 0 });
    const c = { x: 0, y: 0, z: 0 };
    props.center(i, c);
    _c.set(c.x, c.y, c.z);
    _y.set(props.up[i * 3], props.up[i * 3 + 1], props.up[i * 3 + 2]);
    this.effects.burst(_c, _y, props.height[i], props.color.subarray(i * 3, i * 3 + 3), props.color2.subarray(i * 3, i * 3 + 3), this.dust);
    this.hud.addScore();
    this.sfx.pop();
  }

  /** Popped props swell for a moment, then shrink away. */
  private updatePops(dt: number): void {
    for (let k = this.pops.length - 1; k >= 0; k--) {
      const p = this.pops[k];
      p.t += dt;
      const s = p.t < 0.06 ? 1 + 0.3 * (p.t / 0.06) : Math.max(0, 1.3 * (1 - (p.t - 0.06) / 0.1));
      this.app.planet.setPropScale(p.kind, p.index, s);
      if (s <= 0) this.pops.splice(k, 1);
    }
  }
}

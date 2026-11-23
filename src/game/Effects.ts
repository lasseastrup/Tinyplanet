import * as THREE from 'three';
import type { SharedUniforms } from '../render/PlanetView';
import { createDebrisMaterial, createParticleMaterial } from './materials';
import type { Surface } from './Surface';

export interface ParticleSpec {
  life: number;
  /** Diameter at birth and at death (planet radii). */
  size0: number;
  size1: number;
  /** Linear RGB (may exceed 1 for glow) and opacity. */
  r: number;
  g: number;
  b: number;
  a: number;
  /** Velocity damping per second. */
  drag?: number;
  /** Pull towards the planet centre (planet radii / s²). */
  gravity?: number;
}

/**
 * CPU-simulated point sprites in planet-local space. Glow particles add light (sparks, flashes,
 * exhaust); dust particles are alpha blended and dimmed on the night side.
 */
export class Particles {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly cap: number;
  private n = 0;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly col: Float32Array;
  private readonly phys: Float32Array;
  private readonly aPos: THREE.BufferAttribute;
  private readonly aColor: THREE.BufferAttribute;
  private readonly aSize: THREE.BufferAttribute;

  constructor(
    capacity: number,
    private readonly glow: boolean,
  ) {
    this.cap = capacity;
    this.p = new Float32Array(capacity * 3);
    this.v = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity * 2);
    this.col = new Float32Array(capacity * 4);
    this.phys = new Float32Array(capacity * 2);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aColor', this.aColor);
    g.setAttribute('aSize', this.aSize);
    g.setDrawRange(0, 0);
    this.material = createParticleMaterial(glow);
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = glow ? 12 : 11;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, s: ParticleSpec): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    const { p, v, col } = this;
    p[i * 3] = x;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = z;
    v[i * 3] = vx;
    v[i * 3 + 1] = vy;
    v[i * 3 + 2] = vz;
    this.life[i] = this.maxLife[i] = s.life;
    this.size[i * 2] = s.size0;
    this.size[i * 2 + 1] = s.size1;
    col[i * 4] = s.r;
    col[i * 4 + 1] = s.g;
    col[i * 4 + 2] = s.b;
    col[i * 4 + 3] = s.a;
    this.phys[i * 2] = s.drag ?? 0;
    this.phys[i * 2 + 1] = s.gravity ?? 0;
  }

  clear(): void {
    this.n = 0;
    this.points.geometry.setDrawRange(0, 0);
  }

  /** Age and move the particles (before this frame's new ones are spawned). */
  step(dt: number): void {
    const { p, v } = this;
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.n--;
        if (i !== this.n) this.move(this.n, i);
        continue;
      }
      const drag = Math.exp(-this.phys[i * 2] * dt);
      const grav = this.phys[i * 2 + 1] * dt;
      const len = Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) || 1;
      for (let c = 0; c < 3; c++) {
        v[i * 3 + c] = v[i * 3 + c] * drag - (p[i * 3 + c] / len) * grav;
        p[i * 3 + c] += v[i * 3 + c] * dt;
      }
      i++;
    }
  }

  /**
   * Hand the particles to the GPU.
   * @param sun planet-local direction to the sun (dust is dimmed on the night side)
   * @param pxScale drawing-buffer pixels per world unit at distance 1
   */
  upload(sun: THREE.Vector3, pxScale: number): void {
    const p = this.p;
    const pos = this.aPos.array as Float32Array;
    const color = this.aColor.array as Float32Array;
    const size = this.aSize.array as Float32Array;
    for (let k = 0; k < this.n; k++) {
      const t = 1 - this.life[k] / this.maxLife[k];
      pos[k * 3] = p[k * 3];
      pos[k * 3 + 1] = p[k * 3 + 1];
      pos[k * 3 + 2] = p[k * 3 + 2];
      size[k] = this.size[k * 2] + (this.size[k * 2 + 1] - this.size[k * 2]) * t;
      let light = 1;
      let fade: number;
      if (this.glow) {
        fade = (1 - t) * (1 - t);
      } else {
        const len = Math.hypot(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]) || 1;
        const d = (p[k * 3] * sun.x + p[k * 3 + 1] * sun.y + p[k * 3 + 2] * sun.z) / len;
        light = 0.12 + 0.88 * THREE.MathUtils.smoothstep(d, -0.12, 0.25);
        fade = Math.min(1, t * 12) * (1 - t) ** 1.5;
      }
      color[k * 4] = this.col[k * 4] * light;
      color[k * 4 + 1] = this.col[k * 4 + 1] * light;
      color[k * 4 + 2] = this.col[k * 4 + 2] * light;
      color[k * 4 + 3] = this.col[k * 4 + 3] * fade;
    }
    this.aPos.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.points.geometry.setDrawRange(0, this.n);
    this.material.uniforms.uScale.value = pxScale;
  }

  private move(from: number, to: number): void {
    this.p.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.v.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.size.copyWithin(to * 2, from * 2, from * 2 + 2);
    this.col.copyWithin(to * 4, from * 4, from * 4 + 4);
    this.phys.copyWithin(to * 2, from * 2, from * 2 + 2);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

/** Low-poly shards that tumble, bounce on the ground and shrink away. */
export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private readonly cap: number;
  private n = 0;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly axis: Float32Array;
  private readonly spin: Float32Array;
  private readonly size: Float32Array;
  private readonly life: Float32Array;
  private readonly col: Float32Array;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly ax = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(capacity: number, shared: SharedUniforms) {
    this.cap = capacity;
    this.p = new Float32Array(capacity * 3);
    this.v = new Float32Array(capacity * 3);
    this.axis = new Float32Array(capacity * 3);
    this.spin = new Float32Array(capacity * 2);
    this.size = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.col = new Float32Array(capacity * 3);
    const g = new THREE.OctahedronGeometry(0.5, 0);
    g.scale(1, 0.6, 1.35);
    g.computeVertexNormals();
    this.mesh = new THREE.InstancedMesh(g, createDebrisMaterial(shared), capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, this.c.setRGB(1, 1, 1));
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, rgb: ArrayLike<number>, life: number): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.p[i * 3] = x;
    this.p[i * 3 + 1] = y;
    this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx;
    this.v[i * 3 + 1] = vy;
    this.v[i * 3 + 2] = vz;
    const a = this.ax.randomDirection();
    this.axis[i * 3] = a.x;
    this.axis[i * 3 + 1] = a.y;
    this.axis[i * 3 + 2] = a.z;
    this.spin[i * 2] = Math.random() * Math.PI * 2;
    this.spin[i * 2 + 1] = (Math.random() - 0.5) * 22;
    this.size[i] = size;
    this.life[i] = life;
    this.col[i * 3] = rgb[0];
    this.col[i * 3 + 1] = rgb[1];
    this.col[i * 3 + 2] = rgb[2];
  }

  clear(): void {
    this.n = 0;
    this.mesh.count = 0;
  }

  /**
   * Age, move and bounce the shards (before this frame's new ones are spawned).
   * @param gravity pull towards the planet centre (planet radii / s²)
   */
  step(dt: number, surface: Surface, gravity: number): void {
    const { p, v } = this;
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.n--;
        if (i !== this.n) this.move(this.n, i);
        continue;
      }
      const len = Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) || 1;
      const drag = Math.exp(-0.6 * dt);
      for (let c = 0; c < 3; c++) {
        v[i * 3 + c] = v[i * 3 + c] * drag - (p[i * 3 + c] / len) * gravity * dt;
        p[i * 3 + c] += v[i * 3 + c] * dt;
      }
      // Bounce off the ground (or come to rest on the sea and sink).
      const r = Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      const ground = surface.ground(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) + this.size[i] * 0.25;
      if (r < ground) {
        const nx = p[i * 3] / r;
        const ny = p[i * 3 + 1] / r;
        const nz = p[i * 3 + 2] / r;
        for (let c = 0; c < 3; c++) p[i * 3 + c] *= ground / r;
        const vn = v[i * 3] * nx + v[i * 3 + 1] * ny + v[i * 3 + 2] * nz;
        const bounce = surface.water ? 0 : 0.35;
        if (vn < 0) {
          v[i * 3] = (v[i * 3] - nx * vn) * 0.55 - nx * vn * bounce;
          v[i * 3 + 1] = (v[i * 3 + 1] - ny * vn) * 0.55 - ny * vn * bounce;
          v[i * 3 + 2] = (v[i * 3 + 2] - nz * vn) * 0.55 - nz * vn * bounce;
          this.spin[i * 2 + 1] *= 0.6;
        }
        if (surface.water) this.life[i] = Math.min(this.life[i], 0.3);
      }
      this.spin[i * 2] += this.spin[i * 2 + 1] * dt;
      i++;
    }
  }

  /** Write the instance transforms and colours. */
  upload(): void {
    const p = this.p;
    for (let k = 0; k < this.n; k++) {
      this.ax.set(this.axis[k * 3], this.axis[k * 3 + 1], this.axis[k * 3 + 2]);
      this.q.setFromAxisAngle(this.ax, this.spin[k * 2]);
      this.pos.set(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]);
      this.scl.setScalar(this.size[k] * Math.min(1, this.life[k] / 0.4));
      this.mesh.setMatrixAt(k, this.m.compose(this.pos, this.q, this.scl));
      this.mesh.setColorAt(k, this.c.setRGB(this.col[k * 3], this.col[k * 3 + 1], this.col[k * 3 + 2]));
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private move(from: number, to: number): void {
    this.p.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.v.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.axis.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.spin.copyWithin(to * 2, from * 2, from * 2 + 2);
    this.size[to] = this.size[from];
    this.life[to] = this.life[from];
    this.col.copyWithin(to * 3, from * 3, from * 3 + 3);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Random unit vector in the hemisphere around n, biased towards n by `focus` (0 = uniform). */
function hemi(n: THREE.Vector3, focus: number, out: THREE.Vector3): THREE.Vector3 {
  out.randomDirection();
  if (out.dot(n) < 0) out.negate();
  return out.lerp(n, focus).normalize();
}

/** The game's visual effects: one glow layer, one dust layer and the debris shards. */
export class Effects {
  readonly group = new THREE.Group();
  readonly glow = new Particles(1400, true);
  readonly dust = new Particles(500, false);
  readonly debris: Debris;
  /** Typical prop height: effects are sized in these units. */
  unit = 0.05;

  constructor(shared: SharedUniforms) {
    this.debris = new Debris(220, shared);
    this.group.name = 'GameEffects';
    this.group.add(this.glow.points, this.dust.points, this.debris.mesh);
  }

  clear(): void {
    this.glow.clear();
    this.dust.clear();
    this.debris.clear();
  }

  /** Age and move everything; call before spawning this frame's effects. */
  step(dt: number, surface: Surface): void {
    this.glow.step(dt);
    this.dust.step(dt);
    this.debris.step(dt, surface, this.unit * 26);
  }

  /** Hand everything to the GPU; call after this frame's effects were spawned. */
  upload(sun: THREE.Vector3, pxScale: number): void {
    this.glow.upload(sun, pxScale);
    this.dust.upload(sun, pxScale);
    this.debris.upload();
  }

  /** Blaster muzzle flash. */
  muzzle(p: THREE.Vector3, vel: THREE.Vector3): void {
    const u = this.unit;
    this.glow.spawn(p.x, p.y, p.z, vel.x, vel.y, vel.z, { life: 0.08, size0: u * 0.9, size1: u * 0.35, r: 4.5, g: 2.4, b: 1.2, a: 1 });
  }

  /** Engine exhaust: a short-lived glowing puff left behind the nozzle. */
  exhaust(p: THREE.Vector3, vel: THREE.Vector3, nozzle: number, strength: number): void {
    const u = this.unit;
    const j = u * 0.15;
    this.glow.spawn(p.x, p.y, p.z, vel.x + rand(-j, j), vel.y + rand(-j, j), vel.z + rand(-j, j), {
      life: 0.16 + 0.22 * strength,
      size0: nozzle * (1.7 + strength),
      size1: nozzle * 0.25,
      r: 0.5 + 0.8 * strength,
      g: 1.3 + 0.9 * strength,
      b: 2.6 + 1.2 * strength,
      a: 0.55 + 0.3 * strength,
      drag: 3,
    });
  }

  /** A glowing streak point left behind a flying bolt. */
  trail(p: THREE.Vector3): void {
    const u = this.unit;
    this.glow.spawn(p.x, p.y, p.z, 0, 0, 0, { life: 0.12, size0: u * 0.34, size1: u * 0.05, r: 3, g: 0.6, b: 0.25, a: 0.45 });
  }

  /** Bolt fizzling out at the end of its range. */
  fizzle(p: THREE.Vector3): void {
    const u = this.unit;
    for (let k = 0; k < 4; k++) {
      _d.randomDirection().multiplyScalar(u * rand(0.5, 1.5));
      this.glow.spawn(p.x, p.y, p.z, _d.x, _d.y, _d.z, { life: rand(0.1, 0.2), size0: u * 0.25, size1: 0, r: 3, g: 1.2, b: 0.5, a: 1 });
    }
  }

  /** Bolt hitting the ground: flash, sparks and a puff of dust. */
  impact(p: THREE.Vector3, n: THREE.Vector3, dust: ArrayLike<number>): void {
    const u = this.unit;
    this.glow.spawn(p.x, p.y, p.z, 0, 0, 0, { life: 0.12, size0: u * 1.6, size1: u * 0.6, r: 5, g: 2.6, b: 1.1, a: 1 });
    for (let k = 0; k < 10; k++) {
      hemi(n, 0.35, _d).multiplyScalar(u * rand(3, 9));
      this.glow.spawn(p.x, p.y, p.z, _d.x, _d.y, _d.z, {
        life: rand(0.18, 0.4),
        size0: u * rand(0.14, 0.24),
        size1: 0,
        r: 4.5,
        g: 2.2,
        b: 0.7,
        a: 1,
        drag: 2.5,
        gravity: u * 30,
      });
    }
    for (let k = 0; k < 5; k++) {
      hemi(n, 0.6, _d).multiplyScalar(u * rand(0.5, 1.6));
      this.dust.spawn(p.x + _d.x * 0.1, p.y + _d.y * 0.1, p.z + _d.z * 0.1, _d.x, _d.y, _d.z, {
        life: rand(0.6, 1.0),
        size0: u * 0.45,
        size1: u * rand(1.3, 1.9),
        r: dust[0],
        g: dust[1],
        b: dust[2],
        a: 0.55,
        drag: 2.2,
      });
    }
  }

  /** Bolt hitting the sea: a splash of droplets and spray. */
  splash(p: THREE.Vector3, n: THREE.Vector3, water: ArrayLike<number>): void {
    const u = this.unit;
    this.glow.spawn(p.x, p.y, p.z, 0, 0, 0, { life: 0.1, size0: u * 1.1, size1: u * 0.4, r: 2.6, g: 2.4, b: 2.2, a: 0.8 });
    for (let k = 0; k < 14; k++) {
      hemi(n, 0.75, _d).multiplyScalar(u * rand(2.5, 6));
      this.dust.spawn(p.x, p.y, p.z, _d.x, _d.y, _d.z, {
        life: rand(0.45, 0.8),
        size0: u * rand(0.14, 0.26),
        size1: u * 0.08,
        r: 0.85,
        g: 0.95,
        b: 1,
        a: 0.9,
        drag: 0.8,
        gravity: u * 22,
      });
    }
    for (let k = 0; k < 4; k++) {
      hemi(n, 0.8, _d).multiplyScalar(u * rand(0.4, 1.1));
      this.dust.spawn(p.x, p.y, p.z, _d.x, _d.y, _d.z, {
        life: rand(0.5, 0.8),
        size0: u * 0.4,
        size1: u * 1.4,
        r: water[0],
        g: water[1],
        b: water[2],
        a: 0.45,
        drag: 2,
      });
    }
  }

  /**
   * A prop bursting apart: a flash, sparks, a cloud of dust and tumbling shards in its colours.
   * @param height height of the prop (planet radii)
   */
  burst(c: THREE.Vector3, up: THREE.Vector3, height: number, rgb: ArrayLike<number>, rgb2: ArrayLike<number>, dust: ArrayLike<number>): void {
    const u = this.unit;
    this.glow.spawn(c.x, c.y, c.z, 0, 0, 0, { life: 0.16, size0: height * 2.2, size1: height * 0.8, r: 5, g: 3, b: 1.4, a: 1 });
    for (let k = 0; k < 14; k++) {
      hemi(up, 0.25, _d).multiplyScalar(u * rand(4, 11));
      this.glow.spawn(c.x, c.y, c.z, _d.x, _d.y, _d.z, {
        life: rand(0.2, 0.5),
        size0: u * rand(0.15, 0.28),
        size1: 0,
        r: 5,
        g: 2.4,
        b: 0.8,
        a: 1,
        drag: 2,
        gravity: u * 30,
      });
    }
    const shards = Math.round(10 + 10 * Math.min(1.5, height / u));
    _t1.copy(up).multiplyScalar(-height * 0.35);
    for (let k = 0; k < shards; k++) {
      hemi(up, 0.3, _d).multiplyScalar(u * rand(2.5, 7));
      _t2.copy(c).addScaledVector(_t1, Math.random());
      const second = k % 3 === 2;
      const s = u * rand(0.1, 0.24) * (second ? 0.8 : 1);
      this.debris.spawn(_t2.x, _t2.y, _t2.z, _d.x, _d.y, _d.z, s, second ? rgb2 : rgb, rand(1.3, 2.2));
    }
    for (let k = 0; k < 7; k++) {
      hemi(up, 0.4, _d).multiplyScalar(u * rand(0.4, 1.4));
      this.dust.spawn(c.x, c.y, c.z, _d.x, _d.y, _d.z, {
        life: rand(0.8, 1.3),
        size0: u * 0.6,
        size1: u * rand(1.6, 2.4),
        r: dust[0],
        g: dust[1],
        b: dust[2],
        a: 0.5,
        drag: 2,
      });
    }
  }

  dispose(): void {
    this.glow.dispose();
    this.dust.dispose();
    this.debris.dispose();
  }
}

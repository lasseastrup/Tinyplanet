import * as THREE from 'three';
import { Rng, mixSeed } from '../core/rng';
import { NOISE_GLSL } from './shaders/noise';

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aPhase;
uniform float uTime;
uniform float uPixelRatio;
varying vec3 vColor;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio;
  float tw = 0.78 + 0.22 * sin(uTime * (0.7 + aPhase * 2.3) + aPhase * 37.0);
  vColor = aColor * tw;
}
`;

const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c);
  float core = exp(-d2 * 60.0);
  float halo = exp(-d2 * 14.0) * 0.22;
  gl_FragColor = vec4(vColor * (core + halo), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const NEBULA_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const NEBULA_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uOffset;
uniform vec3 uBandAxis;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float bandDot = dot(d, uBandAxis);
  float band = exp(-bandDot * bandDot * 9.0);
  vec3 q = d * 2.2 + uOffset;
  vec3 w = vec3(snoise(q), snoise(q + 5.2), snoise(q - 3.7));
  float n = fbm(q + w * 0.6, 6) * 0.5 + 0.5;
  float n2 = fbm(d * 5.5 + uOffset * 1.7 + w, 5) * 0.5 + 0.5;
  float neb = smoothstep(0.5, 0.95, n) * (0.35 + 0.65 * band);
  vec3 col = mix(uColA, uColB, smoothstep(0.3, 0.7, n2)) * neb * 0.035;
  col += vec3(0.010, 0.011, 0.016) * band * (0.5 + n2);
  gl_FragColor = vec4(col, 1.0);
}
`;

const SUN_VERT = /* glsl */ `
uniform vec3 uSunPos;
uniform float uSize;
varying vec2 vUv;
void main() {
  vec4 mv = viewMatrix * vec4(uSunPos, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
}
`;

const SUN_FRAG = /* glsl */ `
uniform vec3 uSunColor;
varying vec2 vUv;
void main() {
  float d = length(vUv);
  float disc = 1.0 - smoothstep(0.06, 0.075, d);
  float glow = exp(-d * 7.0) * 0.9 + exp(-d * 22.0) * 3.0;
  float rays = pow(max(0.0, 1.0 - abs(vUv.x * vUv.y) * 60.0), 8.0) * exp(-d * 9.0) * 0.6;
  vec3 col = uSunColor * (disc * 28.0 + glow + rays);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const STAR_RADIUS = 900;

/** Starfield, nebula sky (baked into a cube map), and a glowing sun billboard. */
export class SpaceBackground {
  readonly group = new THREE.Group();
  readonly sun: THREE.Mesh;
  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.ShaderMaterial;
  private readonly sunMaterial: THREE.ShaderMaterial;
  private cubeTarget: THREE.WebGLCubeRenderTarget | null = null;
  private lastSeed = -1;

  constructor(timeUniform: THREE.IUniform<number>) {
    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: timeUniform, uPixelRatio: { value: 1 } },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.stars = new THREE.Points(new THREE.BufferGeometry(), this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -10;
    this.group.add(this.stars);

    this.sunMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunPos: { value: new THREE.Vector3(0, 0, 800) },
        uSize: { value: 260 },
        uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
      },
      vertexShader: SUN_VERT,
      fragmentShader: SUN_FRAG,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.sunMaterial);
    this.sun.frustumCulled = false;
    this.sun.renderOrder = -9;
    this.group.add(this.sun);
  }

  dispose(): void {
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
    this.sun.geometry.dispose();
    this.sunMaterial.dispose();
    this.cubeTarget?.dispose();
  }

  setPixelRatio(pr: number): void {
    this.starMaterial.uniforms.uPixelRatio.value = pr;
  }

  setSun(dir: THREE.Vector3, color: THREE.Color, intensity: number): void {
    (this.sunMaterial.uniforms.uSunPos.value as THREE.Vector3).copy(dir).multiplyScalar(800);
    (this.sunMaterial.uniforms.uSunColor.value as THREE.Color).copy(color).multiplyScalar(intensity);
  }

  /** Regenerate stars + nebula for a seed (cheap; nebula is rendered once into a cube map). */
  build(renderer: THREE.WebGLRenderer, scene: THREE.Scene, seed: number, force = false): void {
    if (seed === this.lastSeed && !force) return;
    this.lastSeed = seed;
    const rng = new Rng(mixSeed(seed, 0x5ca1ab1e));

    // Galactic band orientation, shared by stars and nebula.
    const band = new THREE.Vector3(...rng.unitVector());

    const count = 5200;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      // 45% of stars concentrated near the galactic plane.
      let v: [number, number, number] = rng.unitVector();
      if (rng.chance(0.45)) {
        tmp.set(...v);
        const d = tmp.dot(band);
        tmp.addScaledVector(band, -d * (1 - Math.abs(rng.normal(0, 0.18)))).normalize();
        v = [tmp.x, tmp.y, tmp.z];
      }
      pos[i * 3] = v[0] * STAR_RADIUS;
      pos[i * 3 + 1] = v[1] * STAR_RADIUS;
      pos[i * 3 + 2] = v[2] * STAR_RADIUS;
      const mag = Math.pow(rng.next(), 7);
      size[i] = 1.4 + mag * 5.5;
      const temp = rng.next();
      const c = starColor(temp);
      const b = 0.25 + mag * 2.8;
      col[i * 3] = c[0] * b;
      col[i * 3 + 1] = c[1] * b;
      col[i * 3 + 2] = c[2] * b;
      phase[i] = rng.next();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.stars.geometry.dispose();
    this.stars.geometry = g;

    // Nebula colours from a seeded hue pair.
    const hue = rng.range(0, 360);
    const colA = new THREE.Color().setHSL(hue / 360, 0.65, 0.5);
    const colB = new THREE.Color().setHSL(((hue + rng.range(60, 160)) % 360) / 360, 0.7, 0.45);
    const nebulaMat = new THREE.ShaderMaterial({
      uniforms: {
        uColA: { value: colA },
        uColB: { value: colB },
        uOffset: { value: new THREE.Vector3(rng.range(-50, 50), rng.range(-50, 50), rng.range(-50, 50)) },
        uBandAxis: { value: band },
      },
      vertexShader: NEBULA_VERT,
      fragmentShader: NEBULA_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), nebulaMat);
    const bakeScene = new THREE.Scene();
    bakeScene.add(sphere);

    if (!this.cubeTarget) {
      this.cubeTarget = new THREE.WebGLCubeRenderTarget(256, {
        type: THREE.HalfFloatType,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    }
    const cubeCamera = new THREE.CubeCamera(0.1, 100, this.cubeTarget);
    const prevTarget = renderer.getRenderTarget();
    cubeCamera.update(renderer, bakeScene);
    renderer.setRenderTarget(prevTarget);
    sphere.geometry.dispose();
    nebulaMat.dispose();

    scene.background = this.cubeTarget.texture;
  }
}

/** Approximate star colours from cool red to hot blue. */
function starColor(t: number): [number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [1.0, 0.62, 0.42]],
    [0.25, [1.0, 0.83, 0.65]],
    [0.55, [1.0, 0.97, 0.92]],
    [0.8, [0.82, 0.9, 1.0]],
    [1.0, [0.62, 0.74, 1.0]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return stops[stops.length - 1][1];
}

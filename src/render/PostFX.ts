import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { SharedUniforms } from './PlanetView';
import type { QualitySettings } from './quality';

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Single-scattering Rayleigh + Mie atmosphere, ray marched per pixel and composited over the
 * scene using the depth buffer, so it correctly hazes the surface, glows at the limb and
 * reddens sunlight passing through it.
 */
const ATMO_FRAG = /* glsl */ `
#define PI 3.14159265359
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uPlanetCenter;
uniform float uAtmoOn;
uniform float uAtmoInner;
uniform float uAtmoOuter;
uniform vec3 uBetaR;
uniform vec3 uBetaM;
uniform float uScaleR;
uniform float uScaleM;
uniform float uMieG;
uniform float uIntensity;
uniform float uSurfaceHaze;
varying vec2 vUv;

vec2 raySphere(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float cc = dot(oc, oc) - r * r;
  float h = b * b - cc;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

void main() {
  vec4 scene = texture2D(tColor, vUv);
  if (uAtmoOn < 0.5) {
    gl_FragColor = scene;
    return;
  }
  float depth = texture2D(tDepth, vUv).x;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vp /= vp.w;
  vec3 rd = normalize(mat3(uCamWorld) * normalize(vp.xyz));
  vec3 ro = uCamPos;
  float sceneDist = depth >= 0.9999999 ? 1e9 : length(vp.xyz);

  vec2 ta = raySphere(ro, rd, uPlanetCenter, uAtmoOuter);
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, sceneDist);
  if (t1 <= t0) {
    gl_FragColor = scene;
    return;
  }

  float segLen = (t1 - t0) / float(ATMO_STEPS);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  float odR = 0.0;
  float odM = 0.0;
  float shadowR = uAtmoInner * 0.99;
  for (int i = 0; i < ATMO_STEPS; i++) {
    vec3 p = ro + rd * (t0 + segLen * (float(i) + 0.5));
    float h = max(length(p - uPlanetCenter) - uAtmoInner, 0.0);
    float dR = exp(-h / uScaleR) * segLen;
    float dM = exp(-h / uScaleM) * segLen;
    odR += dR;
    odM += dM;

    // Planet shadow on the atmosphere (soft terminator).
    vec3 oc = uPlanetCenter - p;
    float tca = dot(oc, uSunDir);
    float lit = 1.0;
    if (tca > 0.0) {
      float d = sqrt(max(dot(oc, oc) - tca * tca, 0.0));
      lit = smoothstep(shadowR - 0.025, shadowR + 0.025, d);
    }
    if (lit <= 0.0) continue;

    vec2 tl = raySphere(p, uSunDir, uPlanetCenter, uAtmoOuter);
    float lseg = max(tl.y, 0.0) / float(ATMO_LIGHT_STEPS);
    float lR = 0.0;
    float lM = 0.0;
    for (int j = 0; j < ATMO_LIGHT_STEPS; j++) {
      vec3 q = p + uSunDir * (lseg * (float(j) + 0.5));
      float hq = max(length(q - uPlanetCenter) - uAtmoInner, 0.0);
      lR += exp(-hq / uScaleR);
      lM += exp(-hq / uScaleM);
    }
    vec3 tau = uBetaR * (odR + lR * lseg) + uBetaM * 1.1 * (odM + lM * lseg);
    vec3 attn = exp(-tau) * lit;
    sumR += dR * attn;
    sumM += dM * attn;
  }

  float mu = dot(rd, uSunDir);
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = uMieG;
  float g2 = g * g;
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
  // Artistic control: less haze looking straight down at the surface, full glow at the limb.
  vec3 oc0 = uPlanetCenter - ro;
  float closest = sqrt(max(dot(oc0, oc0) - pow(max(dot(oc0, rd), 0.0), 2.0), 0.0));
  float hazeK = mix(uSurfaceHaze, 1.0, smoothstep(uAtmoInner * 0.55, uAtmoInner * 1.02, closest));
  vec3 inscatter = uSunColor * uIntensity * hazeK * (sumR * uBetaR * phaseR + sumM * uBetaM * phaseM);
  vec3 trans = exp(-(uBetaR * odR + uBetaM * 1.1 * odM) * hazeK);
  gl_FragColor = vec4(scene.rgb * trans + inscatter, 1.0);
}
`;

const FINAL_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uVignette;
uniform float uSaturation;
uniform float uContrast;
uniform vec2 uResolution;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  vec2 q = vUv - 0.5;
  q.x *= uResolution.x / max(uResolution.y, 1.0);
  col *= 1.0 - uVignette * smoothstep(0.45, 1.25, length(q));
  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <tonemapping_fragment>
  // Gentle grade after tone mapping: a little more colour, a soft S-curve.
  vec3 g = gl_FragColor.rgb;
  float luma = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = clamp(mix(vec3(luma), g, uSaturation), 0.0, 1.0);
  g = mix(g, g * g * (3.0 - 2.0 * g), uContrast);
  gl_FragColor.rgb = g;
  #include <colorspace_fragment>
  gl_FragColor.rgb += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
}
`;

export class PostFX {
  private sceneRT: THREE.WebGLRenderTarget;
  private hdrRT: THREE.WebGLRenderTarget;
  private readonly atmoMat: THREE.ShaderMaterial;
  private readonly atmoQuad: FullScreenQuad;
  private readonly finalMat: THREE.ShaderMaterial;
  private readonly finalQuad: FullScreenQuad;
  readonly bloom: UnrealBloomPass;
  private width = 1;
  private height = 1;
  private quality: QualitySettings;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    shared: SharedUniforms,
    quality: QualitySettings,
  ) {
    this.quality = quality;
    this.sceneRT = this.createSceneTarget(1, 1, quality.msaa);
    this.hdrRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });

    this.atmoMat = new THREE.ShaderMaterial({
      name: 'AtmospherePass',
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uPlanetCenter: shared.uPlanetCenter,
        uAtmoOn: shared.uAtmoOn,
        uAtmoInner: shared.uAtmoInner,
        uAtmoOuter: shared.uAtmoOuter,
        uBetaR: shared.uBetaR,
        uBetaM: shared.uBetaM,
        uScaleR: shared.uScaleR,
        uScaleM: shared.uScaleM,
        uMieG: { value: 0.76 },
        uIntensity: { value: 4.5 },
        uSurfaceHaze: { value: 0.6 },
      },
      defines: { ATMO_STEPS: quality.atmoSteps, ATMO_LIGHT_STEPS: quality.atmoLightSteps },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: ATMO_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.atmoQuad = new FullScreenQuad(this.atmoMat);

    this.finalMat = new THREE.ShaderMaterial({
      name: 'FinalPass',
      uniforms: {
        tDiffuse: { value: null },
        uVignette: { value: 0.35 },
        uSaturation: { value: 1.12 },
        uContrast: { value: 0.12 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FINAL_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.finalQuad = new FullScreenQuad(this.finalMat);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.4, 2.2);
  }

  private createSceneTarget(w: number, h: number, samples: number): THREE.WebGLRenderTarget {
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples,
      depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
    });
  }

  setQuality(q: QualitySettings): void {
    const msaaChanged = q.msaa !== this.quality.msaa;
    this.quality = q;
    this.atmoMat.defines.ATMO_STEPS = q.atmoSteps;
    this.atmoMat.defines.ATMO_LIGHT_STEPS = q.atmoLightSteps;
    this.atmoMat.needsUpdate = true;
    if (msaaChanged) {
      this.sceneRT.depthTexture?.dispose();
      this.sceneRT.dispose();
      this.sceneRT = this.createSceneTarget(this.width, this.height, q.msaa);
    }
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.sceneRT.setSize(this.width, this.height);
    this.hdrRT.setSize(this.width, this.height);
    const bloomScale = this.quality.level === 'high' ? 0.75 : 0.5;
    this.bloom.setSize(Math.max(1, Math.round(this.width * bloomScale)), Math.max(1, Math.round(this.height * bloomScale)));
    (this.finalMat.uniforms.uResolution.value as THREE.Vector2).set(this.width, this.height);
  }

  setLook(bloomStrength: number, atmosphereIntensity: number): void {
    this.bloom.strength = bloomStrength;
    this.bloom.enabled = bloomStrength > 0.001;
    this.atmoMat.uniforms.uIntensity.value = atmosphereIntensity;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, dt: number): void {
    const r = this.renderer;

    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, false);
    r.render(scene, camera);

    const au = this.atmoMat.uniforms;
    au.tColor.value = this.sceneRT.texture;
    au.tDepth.value = this.sceneRT.depthTexture;
    (au.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (au.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    (au.uCamPos.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    r.setRenderTarget(this.hdrRT);
    this.atmoQuad.render(r);

    if (this.bloom.enabled) this.bloom.render(r, this.hdrRT, this.hdrRT, dt, false);

    this.finalMat.uniforms.tDiffuse.value = this.hdrRT.texture;
    r.setRenderTarget(null);
    this.finalQuad.render(r);
  }

  dispose(): void {
    this.sceneRT.depthTexture?.dispose();
    this.sceneRT.dispose();
    this.hdrRT.dispose();
    this.atmoMat.dispose();
    this.finalMat.dispose();
    this.atmoQuad.dispose();
    this.finalQuad.dispose();
    this.bloom.dispose();
  }
}

import * as THREE from 'three';
import { COMMON_GLSL } from '../shaders/common';
import { NOISE_GLSL } from '../shaders/noise';
import type { QualityDefines } from '../quality';

const VERT = /* glsl */ `
uniform float uRingInner;
uniform float uRingOuter;
attribute float aT;
attribute float aAngle;
varying vec3 vWorldPos;
varying vec2 vLocal;

void main() {
  float r = mix(uRingInner - 0.02, uRingOuter + 0.02, aT);
  vec3 p = vec3(cos(aAngle) * r, 0.0, sin(aAngle) * r);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vLocal = p.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${NOISE_GLSL}
${COMMON_GLSL}

uniform float uFrontPass;

varying vec3 vWorldPos;
varying vec2 vLocal;

void main() {
  float r = length(vLocal);
  float u = (r - uRingInner) / (uRingOuter - uRingInner);
  if (u < 0.0 || u > 1.0) discard;

  // Split rendering into a back half (drawn before clouds) and a front half (after).
  float fragDist = length(vWorldPos - cameraPosition);
  float centerDist = length(uPlanetCenter - cameraPosition);
  bool isFront = fragDist < centerDist;
  if ((uFrontPass > 0.5) != isFront) discard;

  vec4 tex = texture2D(uRingTex, vec2(u, 0.5));
  float density = tex.a * uRingOpacity;
  if (density < 0.003) discard;

  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float shadow = sphereShadow(vWorldPos, uPlanetCenter, uPlanetRadius, 0.012) * moonShadow(vWorldPos);
  vec3 sunLight = uSunColor * sunTransmittance(vWorldPos) * shadow;

  float nl = dot(uRingNormal, L);
  float nv = dot(uRingNormal, V);
  float litSide = step(0.0, nl * nv);
  float incidence = 0.25 + 0.75 * sqrt(abs(nl));
  // Seen from the unlit side, light diffuses through thin parts of the rings.
  float through = mix(0.35 * (1.0 - density) + 0.1, 1.0, litSide);
  float forward = pow(max(dot(-V, L), 0.0), 8.0) * 2.0 * (1.0 - density);
  vec3 col = tex.rgb * (sunLight * (incidence * through + forward) + uAmbient * 0.35);
  float grain = 0.92 + 0.08 * snoise(vec3(vLocal * 60.0, 1.0));

  gl_FragColor = vec4(col * grain, density);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createRingMaterial(
  shared: Record<string, THREE.IUniform>,
  quality: QualityDefines,
  frontPass: boolean,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: frontPass ? 'RingFrontMaterial' : 'RingBackMaterial',
    uniforms: { ...shared, uFrontPass: { value: frontPass ? 1 : 0 } },
    defines: { ...quality },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Annulus with per-vertex (t, angle) attributes; radii are applied in the vertex shader. */
export function createRingGeometry(segments = 256): THREE.BufferGeometry {
  const count = (segments + 1) * 2;
  const t = new Float32Array(count);
  const angle = new Float32Array(count);
  const pos = new Float32Array(count * 3);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    for (let k = 0; k < 2; k++) {
      const idx = i * 2 + k;
      t[idx] = k;
      angle[idx] = a;
      const r = k === 0 ? 1 : 3;
      pos[idx * 3] = Math.cos(a) * r;
      pos[idx * 3 + 2] = Math.sin(a) * r;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    index.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.BufferAttribute(t, 1));
  g.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
  g.setIndex(index);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5);
  return g;
}

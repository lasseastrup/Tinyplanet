import * as THREE from 'three';
import { NOISE_GLSL } from '../shaders/noise';

const VERT = /* glsl */ `
attribute vec2 aUV;
varying vec2 vUV;
varying vec3 vWorldPos;

void main() {
  vUV = aUV;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${NOISE_GLSL}
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uPlanetCenter;
uniform float uAurora;
uniform vec3 uColorA;
uniform vec3 uColorB;

varying vec2 vUV;
varying vec3 vWorldPos;

void main() {
  float x = vUV.x * 90.0;
  float t = uTime;
  float rays = 0.65 + 0.35 * snoise(vec3(x * 0.3, t * 0.25, 0.0));
  rays *= 0.8 + 0.2 * snoise(vec3(x * 1.4, t * 0.6, 4.0));
  float curtain = smoothstep(-0.3, 0.7, snoise(vec3(vUV.x * 7.0, t * 0.08, 9.0)));
  float v = vUV.y;
  float fall = pow(1.0 - v, 2.0) * smoothstep(0.0, 0.12, v);
  vec3 up = normalize(vWorldPos - uPlanetCenter);
  float night = 1.0 - smoothstep(-0.4, -0.05, dot(up, uSunDir));
  vec3 col = mix(uColorA, uColorB, smoothstep(0.25, 0.9, v));
  float a = rays * curtain * fall * night * uAurora * 1.3;
  gl_FragColor = vec4(col * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createAuroraMaterial(shared: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'AuroraMaterial',
    uniforms: {
      uTime: shared.uTime,
      uSunDir: shared.uSunDir,
      uPlanetCenter: shared.uPlanetCenter,
      uAurora: { value: 0 },
      uColorA: { value: new THREE.Color() },
      uColorB: { value: new THREE.Color() },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** Two wavy curtain loops around the poles. */
export function createAuroraGeometry(seed: number, segments = 160): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const bottom = 1.03;
  const top = 1.2;
  let base = 0;
  for (const pole of [1, -1]) {
    const ph = seed * 0.0001 + pole;
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const phi = u * Math.PI * 2;
      const colat = 0.33 + 0.05 * Math.sin(3 * phi + ph * 7) + 0.025 * Math.sin(7 * phi + ph * 3);
      const dx = Math.sin(colat) * Math.cos(phi);
      const dy = Math.cos(colat) * pole;
      const dz = Math.sin(colat) * Math.sin(phi);
      positions.push(dx * bottom, dy * bottom, dz * bottom, dx * top, dy * top, dz * top);
      uvs.push(u, 0, u, 1);
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    base += (segments + 1) * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  return g;
}

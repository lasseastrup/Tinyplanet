import * as THREE from 'three';
import { COMMON_GLSL } from '../shaders/common';
import { NOISE_GLSL } from '../shaders/noise';
import type { QualityDefines } from '../quality';

const VERT = /* glsl */ `
uniform float uRadius;
varying vec3 vWorldPos;
varying vec3 vLocalDir;

void main() {
  vec3 dir = normalize(position);
  vec4 wp = modelMatrix * vec4(dir * uRadius, 1.0);
  vWorldPos = wp.xyz;
  vLocalDir = dir;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${NOISE_GLSL}
${COMMON_GLSL}

uniform vec3 uCloudColor;
uniform float uCirrus;
uniform float uLayerOpacity;

varying vec3 vWorldPos;
varying vec3 vLocalDir;

void main() {
  vec3 dir = normalize(vLocalDir);
#ifdef CIRRUS
  // Sparse, high streaks stretched along the wind (east-west), only in some regions.
  vec3 q = dir * uCloudScale * 0.8 + uCloudOffset * 1.3;
  vec3 w = vec3(snoise(q * 1.1 + vec3(uCloudTime * 0.5, 0.0, 0.0)), snoise(q * 1.1 + 7.0), snoise(q * 1.1 - 3.0));
  float region = smoothstep(0.1, 0.6, snoise(q * 0.5 + 31.0) * 0.5 + 0.5 + (uCirrus - 0.5) * 0.6);
  float n = fbm((q + w * 0.35) * vec3(1.4, 6.0, 1.4), 4);
  float lat = abs(dir.y);
  float d = smoothstep(0.58, 0.85, n * 0.5 + 0.5 + uCirrus * 0.12) * region * (1.0 - smoothstep(0.6, 0.98, lat));
  d *= 0.4 + 0.6 * uCirrus;
  float dSmooth = d;
#else
  vec2 dd = cloudFieldDual(dir, CLOUD_OCTAVES);
  float d = dd.x;
  float dSmooth = dd.y;
#endif
  if (d < 0.004) discard;

  vec3 up = normalize(vWorldPos - uPlanetCenter);
  // Thin wisps are lit almost flat (light diffuses through them); thick clouds get relief.
  float thickness = smoothstep(0.15, 0.85, d);
  vec3 N = up;
#ifndef CIRRUS
  N = normalize(mix(up, perturbNormal(vWorldPos, up, dSmooth * 0.016), thickness));
#endif
  vec3 L = uSunDir;
  float sunDot = dot(up, L);
  float dayMask = smoothstep(-0.2, 0.1, sunDot);
  vec3 sunLight = uSunColor * sunTransmittance(vWorldPos) * dayMask * ringShadow(vWorldPos) * moonShadow(vWorldPos);
  float wrap = smoothstep(-0.2, 0.6, sunDot);
  float diff = mix(0.55, 0.25, thickness) * wrap + max(dot(N, L), 0.0) * mix(0.45, 0.75, thickness);
  float thick = mix(1.0, 0.78, smoothstep(0.6, 1.0, d));
  vec3 ambient = uAmbient * (0.15 + 0.85 * smoothstep(-0.3, 0.5, sunDot));
  vec3 col = uCloudColor * 0.82 * (sunLight * diff * thick + ambient * 0.6);

  // Bright edges when the clouds are backlit by the sun.
  vec3 V = normalize(cameraPosition - vWorldPos);
  float fwd = pow(max(dot(-V, L), 0.0), 6.0) * (1.0 - d * 0.7);
  col += sunLight * fwd * 0.8;

  gl_FragColor = vec4(col, clamp(d * uCloudOpacity * uLayerOpacity, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createCloudMaterial(
  shared: Record<string, THREE.IUniform>,
  quality: QualityDefines,
  opts: { cirrus: boolean },
): THREE.ShaderMaterial {
  const defines: Record<string, string | number | boolean> = { ...quality };
  if (opts.cirrus) defines.CIRRUS = '';
  return new THREE.ShaderMaterial({
    name: opts.cirrus ? 'CirrusMaterial' : 'CloudMaterial',
    uniforms: {
      ...shared,
      uRadius: { value: 1.07 },
      uCloudColor: { value: new THREE.Color(1, 1, 1) },
      uCirrus: { value: 0.3 },
      uLayerOpacity: { value: 1 },
    },
    defines,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
  });
}

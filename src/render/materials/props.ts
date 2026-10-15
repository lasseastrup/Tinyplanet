import * as THREE from 'three';
import { COMMON_GLSL } from '../shaders/common';
import { NOISE_GLSL } from '../shaders/noise';
import { PROP_COLORS } from '../propGeometry';
import type { QualityDefines } from '../quality';

const VERT = /* glsl */ `
attribute float aPart;
attribute float aAO;
attribute float aSway;
#ifndef PUFF
attribute vec3 aTint2;
#endif
uniform float uTime;
uniform float uWind;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vPart;
varying float vAO;
varying float vHeight;
varying float vFoliage;
varying vec3 vTint;
varying vec3 vTint2;

void main() {
  vec3 pos = position;
  // Wind: each instance sways with its own phase; tips move more than trunks (aSway).
  vec3 ip = instanceMatrix[3].xyz;
  float phase = dot(ip, vec3(31.7, 17.9, 23.3)) * 9.0;
  float t = uTime;
  vec2 gust = vec2(sin(t * 1.7 + phase) + 0.4 * sin(t * 3.3 + phase * 1.7), cos(t * 1.3 + phase * 0.8));
  gust *= 0.6 + 0.4 * sin(t * 0.35 + phase * 0.1);
  pos.xz += gust * aSway * uWind;

  vec4 wp = modelMatrix * instanceMatrix * vec4(pos, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vPart = aPart;
  vAO = aAO;
  vHeight = position.y;
  vFoliage = step(0.5, aPart) * step(aPart, 1.5) * step(0.01, aSway);
#ifdef USE_INSTANCING_COLOR
  vTint = instanceColor;
#else
  vTint = vec3(1.0);
#endif
#ifdef PUFF
  vTint2 = vec3(1.0);
#else
  vTint2 = aTint2;
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${NOISE_GLSL}
${COMMON_GLSL}

uniform vec3 uWoodColor;
uniform vec3 uWindowColor;
uniform vec3 uWindowGlow;
uniform vec3 uStoneColor;
uniform vec3 uAccentColor;
uniform vec3 uPuffColor;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vPart;
varying float vAO;
varying float vHeight;
varying float vFoliage;
varying vec3 vTint;
varying vec3 vTint2;

void main() {
  vec3 N = normalize(vNormal);
  vec3 up = normalize(vWorldPos - uPlanetCenter);
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float sunDot = dot(up, L);
  vec3 ambient = uAmbient * (0.15 + 0.85 * smoothstep(-0.25, 0.5, sunDot));
  // Sky light: bright from above, dimmer bounce from below.
  vec3 sky = skyLight(N, up, sunDot);

#ifdef PUFF
  // Puffy clouds: bright, softly wrapped light, lit a little past the terminator.
  float dayMask = smoothstep(-0.1, 0.12, sunDot);
  vec3 sunLight = uSunColor * sunTransmittance(vWorldPos) * dayMask * ringShadow(vWorldPos) * moonShadow(vWorldPos);
  sunLight *= mix(0.35, 1.0, sunShadowMap(vWorldPos, N));
  float wrap = max(dot(N, L), 0.0) * 0.6 + 0.4 * smoothstep(-0.4, 0.8, dot(N, L));
  // Shading fades out towards the terminator so twilight puffs stay soft.
  float diff = mix(0.45, wrap, smoothstep(0.0, 0.3, sunDot));
  float ao = vAO;
  vec3 col = uPuffColor * 0.88 * (sunLight * diff * mix(0.75, 1.0, ao) + (sky * 1.1 + ambient * 1.4) * ao);
  // Silver lining where the sun shines through the edges.
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += uPuffColor * sunLight * rim * (0.12 + 0.6 * pow(max(dot(-V, L), 0.0), 2.0));
#else
  float dayMask = smoothstep(-0.07, 0.12, sunDot);
  float shadow = ringShadow(vWorldPos) * moonShadow(vWorldPos) * cloudShadow(vWorldPos) * sunShadowMap(vWorldPos, N);
  vec3 sunLight = uSunColor * sunTransmittance(vWorldPos) * dayMask * shadow;

  int part = int(vPart + 0.5);
  vec3 base;
  if (part == 0) base = uWoodColor;
  else if (part == 1) base = vTint;
  else if (part == 2 || part == 5) base = vTint2;
  else if (part == 3) base = uWindowColor;
  else if (part == 6) base = uStoneColor;
  else base = uAccentColor;

  float ao = vAO * mix(0.62, 1.0, smoothstep(0.0, 0.3, vHeight));
  float NdotL = dot(N, L);
  float diff = max(NdotL, 0.0);
  // Foliage scatters light around the crown: softer wrap and light shining through the leaves.
  if (vFoliage > 0.5) diff = diff * 0.8 + 0.2 * smoothstep(-0.5, 0.5, NdotL);
  vec3 col = base * (sunLight * diff * mix(0.7, 1.0, ao) + (sky + ambient) * ao);
  vec3 H = normalize(L + V);
  if (vFoliage > 0.5) {
    float through = pow(max(dot(-V, L), 0.0), 3.0) * 0.5 + 0.1 * smoothstep(-0.2, 0.5, -NdotL);
    col += base * base * 1.6 * sunLight * through * ao;
  } else if (part == 1) {
    // A faint sheen on roofs, rocks and cacti.
    col += sunLight * pow(max(dot(N, H), 0.0), 24.0) * 0.05;
  }
  if (part == 0 || part == 2 || part == 6) {
    // Walls catch a little warm light from the windows at night.
    float dusk = 1.0 - smoothstep(-0.18, 0.04, sunDot);
    col += base * vec3(1.0, 0.58, 0.26) * dusk * 0.06;
  }
  if (part == 3) {
    // Glass reflects the sky and catches the sun; it glows warm at night.
    float fres = 0.06 + 0.94 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
    col = mix(col, sky * 1.3 + ambient, fres * 0.8);
    col += sunLight * pow(max(dot(N, H), 0.0), 140.0) * 0.9;
    float night = 1.0 - smoothstep(-0.18, 0.04, sunDot);
    col = mix(col, uWindowGlow * 2.6, night);
  }
#endif

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SHADOW_VERT = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uPlanetCenter;
uniform float uOffset;
attribute float aShade;
varying float vShade;
varying float vDay;

void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec3 base = (m * vec4(0.0, position.y, 0.0, 1.0)).xyz;
  vec4 wp = m * vec4(position, 1.0);
  vec3 up = normalize(base - uPlanetCenter);
  float sunDot = dot(up, uSunDir);
  // The shadow falls away from the sun, further when the sun is low.
  float s = length(m[0].xyz);
  wp.xyz -= (uSunDir - up * sunDot) * s * uOffset;
  vDay = smoothstep(-0.02, 0.3, sunDot);
  vShade = aShade;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHADOW_FRAG = /* glsl */ `
uniform float uStrength;
varying float vShade;
varying float vDay;

void main() {
  gl_FragColor = vec4(0.0, 0.0, 0.0, smoothstep(0.0, 0.4, vShade) * uStrength * (0.35 + 0.65 * vDay));
}
`;

/**
 * Contact shadows under props: soft dark discs, nudged away from the sun. With a sun shadow map
 * they only add a little ambient occlusion where props meet the ground.
 */
export function createPropShadowMaterial(shared: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'PropShadowMaterial',
    uniforms: {
      uSunDir: shared.uSunDir,
      uPlanetCenter: shared.uPlanetCenter,
      uStrength: { value: 0.75 },
      uOffset: { value: 0.35 },
    },
    vertexShader: SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
}

export function createPropMaterial(
  shared: Record<string, THREE.IUniform>,
  quality: QualityDefines,
  opts: { puff: boolean },
): THREE.ShaderMaterial {
  const defines: Record<string, string | number | boolean> = { ...quality };
  if (opts.puff) defines.PUFF = '';
  return new THREE.ShaderMaterial({
    name: opts.puff ? 'CloudPuffMaterial' : 'PropMaterial',
    uniforms: {
      ...shared,
      uWind: { value: 0.02 },
      uWoodColor: { value: new THREE.Color(PROP_COLORS.wood) },
      uWindowColor: { value: new THREE.Color(PROP_COLORS.window) },
      uWindowGlow: { value: new THREE.Color(PROP_COLORS.windowGlow) },
      uStoneColor: { value: new THREE.Color(PROP_COLORS.stone) },
      uAccentColor: { value: new THREE.Color(PROP_COLORS.accent) },
      uPuffColor: { value: new THREE.Color('#ffffff') },
    },
    defines,
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}

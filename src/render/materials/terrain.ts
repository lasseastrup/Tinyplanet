import * as THREE from 'three';
import { COMMON_GLSL } from '../shaders/common';
import { NOISE_GLSL } from '../shaders/noise';
import type { QualityDefines } from '../quality';

const VERT = /* glsl */ `
attribute vec4 aData;
attribute float aAO;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocalPos;
varying vec4 vData;
varying float vAO;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vLocalPos = position;
  vData = aData;
  vAO = aAO;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${NOISE_GLSL}
${COMMON_GLSL}

uniform sampler2D uBiomeLUT;
uniform float uLapse;
uniform vec3 uSnowColor;
uniform vec3 uRockColor;
uniform vec3 uSandColor;
uniform vec3 uSeabedColor;
uniform float uDetailBump;
uniform float uCityLights;
uniform vec3 uCityColor;
uniform float uLava;
uniform vec3 uLavaColor;
uniform vec3 uMoonColor;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocalPos;
varying vec4 vData;
varying float vAO;

void main() {
  vec3 up = normalize(vWorldPos - uPlanetCenter);
  vec3 dir = normalize(vLocalPos);

#ifdef FLAT_SHADED
  vec3 N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  if (dot(N, up) < 0.0) N = -N;
  float n1 = 0.0;
  float n2 = 0.0;
#else
  vec3 N = normalize(vWorldNormal);
  vec3 np = vLocalPos * 21.0;
  float n1 = snoise(np);
  float n2 = snoise(np * 2.9 + 13.0);
  // Extra micro detail when the camera is close.
  if (uDetailBoost > 0.5) n2 = n2 * 0.7 + snoise(np * 8.1 - 3.0) * 0.45;
#endif
  float nd = n1 * 0.65 + n2 * 0.35;
  float slope = 1.0 - max(dot(N, up), 0.0);

  vec3 albedo;
  float snow = 0.0;
  float rockAmt = 0.0;
  bool underwater = false;
  float temp = 0.0;
  float moist = 0.0;
  float elev = 0.0;

#ifdef MOON
  float mare = vData.z;
  albedo = uMoonColor * mix(1.0, 0.58, mare) * (0.9 + 0.2 * (n2 * 0.5 + 0.5));
  albedo *= 1.0 + vData.w * 0.35;
#else
  float h = vData.x;
  elev = h - uSeaLevel;
  underwater = uHasOcean > 0.5 && elev < 0.0;
  temp = vData.y + uTempOffset - max(elev, 0.0) * uLapse;
  moist = clamp(vData.z + uHumidOffset, 0.0, 1.0);

  vec2 lutUV = vec2(clamp(moist + nd * 0.06, 0.01, 0.99), clamp(temp + nd * 0.04, 0.01, 0.99));
  albedo = texture2D(uBiomeLUT, lutUV).rgb;
  albedo *= 0.9 + 0.2 * (n2 * 0.5 + 0.5);

  // Bare rock on steep slopes and mountain ridges.
  rockAmt = max(smoothstep(0.09, 0.2, slope + nd * 0.03), smoothstep(0.35, 0.85, vData.w + nd * 0.12));
  albedo = mix(albedo, uRockColor * (0.85 + 0.3 * (n1 * 0.5 + 0.5)), rockAmt);

  if (uHasOcean > 0.5) {
#ifdef FLAT_SHADED
    float beach = 1.0 - smoothstep(0.0, 0.02, elev);
#else
    float beach = 1.0 - smoothstep(0.012, 0.045, elev + nd * 0.012);
#endif
    albedo = mix(albedo, uSandColor, beach * (1.0 - rockAmt * 0.7));
  }

  snow = 1.0 - smoothstep(uSnowLine - 0.025, uSnowLine + 0.025, temp + nd * 0.04);
  snow *= 1.0 - smoothstep(0.22, 0.5, slope) * 0.8;

  if (underwater) {
    albedo = mix(uSandColor * 0.9, uSeabedColor, smoothstep(0.0, 0.3, -elev));
    snow = 0.0;
  }
  albedo = mix(albedo, uSnowColor, snow);
#endif

#ifndef FLAT_SHADED
  float bump = (n1 * 0.6 + n2 * 0.4) * uDetailBump * (underwater ? 0.3 : 1.0) * (1.0 - snow * 0.5);
  N = perturbNormal(vWorldPos, N, bump);
#endif

  // --- lighting ---
  vec3 L = uSunDir;
  float sunDot = dot(up, L);
  float dayMask = smoothstep(-0.07, 0.12, sunDot);
  float shadow = ringShadow(vWorldPos) * moonShadow(vWorldPos);
#ifdef MOON
  shadow *= sphereShadow(vWorldPos, uPlanetCenter, uPlanetRadius, 0.01);
  dayMask = smoothstep(-0.02, 0.06, sunDot);
#elif !defined(FLAT_SHADED)
  shadow *= cloudShadow(vWorldPos);
#endif
  vec3 sunLight = uSunColor * sunTransmittance(vWorldPos) * dayMask * shadow;
  float diff = max(dot(N, L), 0.0);
  vec3 ambient = uAmbient * (0.12 + 0.88 * smoothstep(-0.25, 0.5, sunDot));
#ifdef MOON
  // Planetshine: faint light reflected from the planet onto the moon's night side.
  vec3 toPlanet = normalize(uPlanetCenter - vWorldPos);
  ambient = uAmbient * 0.25 + vec3(0.03, 0.045, 0.07) * max(dot(N, toPlanet), 0.0);
#endif
  // Baked cavity occlusion: darker valleys, slightly brighter ridges.
  vec3 col = albedo * (sunLight * diff * mix(1.0, vAO, 0.45) + ambient * vAO);

  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 40.0) * (0.22 * snow + 0.03);
  col += sunLight * spec;

#ifndef MOON
  float night = 1.0 - smoothstep(-0.16, 0.05, sunDot);
  if (uCityLights > 0.001 && !underwater && night > 0.001) {
    float habit = smoothstep(0.3, 0.46, temp) * (1.0 - smoothstep(0.92, 1.05, temp))
      * smoothstep(0.14, 0.34, moist) * (1.0 - snow) * (1.0 - rockAmt * 0.85)
      * (1.0 - smoothstep(0.08, 0.5, elev));
    if (habit > 0.01) {
      float cluster = smoothstep(0.0, 0.6, snoise(dir * 4.5 + 3.7) * 0.6 + snoise(dir * 11.0 + 1.3) * 0.4 + uCityLights * 0.35 - 0.15);
      float dots = pow(max(snoise(dir * 90.0), 0.0), 2.2) + 0.6 * pow(max(snoise(dir * 230.0 + 5.0), 0.0), 2.5);
      col += uCityColor * habit * cluster * dots * night * uCityLights * 9.0;
    }
  }
  if (uLava > 0.001) {
    float nearLava = 1.0 - smoothstep(0.0, 0.22, elev);
    float crack = 1.0 - abs(snoise(dir * 34.0 + vec3(0.0, uTime * 0.01, 0.0)));
    float glow = smoothstep(0.9, 0.995, crack) * nearLava;
    col += uLavaColor * glow * uLava * 1.4;
  }
#endif

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createTerrainMaterial(
  shared: Record<string, THREE.IUniform>,
  quality: QualityDefines,
  opts: { flat: boolean; moon: boolean },
): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    ...shared,
    uBiomeLUT: { value: null },
    uLapse: { value: 0.45 },
    uSnowColor: { value: new THREE.Color() },
    uRockColor: { value: new THREE.Color() },
    uSandColor: { value: new THREE.Color() },
    uSeabedColor: { value: new THREE.Color() },
    uDetailBump: { value: 0.0025 },
    uCityLights: { value: 0 },
    uCityColor: { value: new THREE.Color() },
    uLava: { value: 0 },
    uLavaColor: { value: new THREE.Color() },
    uMoonColor: { value: new THREE.Color() },
  };
  const defines: Record<string, string | number | boolean> = { ...quality };
  if (opts.flat) defines.FLAT_SHADED = '';
  if (opts.moon) defines.MOON = '';
  return new THREE.ShaderMaterial({
    name: opts.moon ? 'MoonMaterial' : 'TerrainMaterial',
    uniforms,
    defines,
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}

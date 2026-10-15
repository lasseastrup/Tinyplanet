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
uniform float uDetailFreq;
uniform float uCityLights;
uniform vec3 uCityColor;
uniform float uLava;
uniform vec3 uLavaColor;
uniform vec3 uMoonColor;
uniform vec4 uVillages[16];
uniform int uVillageCount;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocalPos;
varying vec4 vData;
varying float vAO;

#ifndef MOON
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// Village squares (packed earth) and the patchwork of fields around them.
// Returns the blend weight; ground receives the colour.
float villageGround(vec3 dir, vec3 grass, float nd, out vec3 ground) {
  float best = 0.0;
  ground = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= uVillageCount) break;
    vec4 v = uVillages[i];
    float R = v.w;
    float d = length(dir - v.xyz);
    if (d > R * 1.9) continue;
    vec3 t1 = normalize(cross(v.xyz, abs(v.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(v.xyz, t1);
    float a = float(i) * 1.7;
    vec2 uv = mat2(cos(a), -sin(a), sin(a), cos(a)) * vec2(dot(dir, t1), dot(dir, t2)) / R;
    float dn = d / R + nd * 0.25;
    float plaza = 1.0 - smoothstep(0.42, 0.62, dn);
    vec2 g = uv * vec2(2.3, 3.2);
    vec2 cell = floor(g);
    vec2 f = fract(g);
    float r = hash13(vec3(cell, float(i) * 7.3 + 1.0));
    float ring = smoothstep(0.85, 1.0, dn) * (1.0 - smoothstep(1.3 + r * 0.25, 1.5 + r * 0.25, dn));
    float field = ring * step(0.2, r);
    vec3 crop;
    if (r < 0.46) crop = mix(grass, vec3(0.62, 0.5, 0.17), 0.8);
    else if (r < 0.66) crop = mix(grass, vec3(0.3, 0.55, 0.12), 0.6);
    else if (r < 0.86) crop = vec3(0.3, 0.21, 0.13);
    else crop = vec3(0.78, 0.66, 0.08);
    // Furrows and hedgerows fade out before they get too small to see.
    vec2 fw = fwidth(g);
    float px = max(max(fw.x, fw.y), 1e-5);
    float furrow = sin((r > 0.55 ? f.x : f.y) * 42.0) * 0.09 * clamp(1.0 - px * 30.0, 0.0, 1.0);
    float edgeDist = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    float hedge = (1.0 - smoothstep(0.025, 0.055, edgeDist)) * clamp(1.0 - px * 8.0, 0.0, 1.0);
    crop = mix(crop * (1.0 + furrow), grass * 0.55, hedge * 0.75);
    vec3 earth = vec3(0.42, 0.33, 0.22) * (0.92 + 0.16 * nd);
    float w = max(field, plaza);
    if (w > best) {
      best = w;
      ground = mix(crop, earth, plaza);
    }
  }
  return best;
}

// Warm light from the windows falling on the ground around each village (0..1).
float villageGlow(vec3 dir) {
  float g = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uVillageCount) break;
    float d = length(dir - uVillages[i].xyz) / uVillages[i].w;
    g = max(g, 1.0 - smoothstep(0.1, 0.75, d));
  }
  return g;
}
#endif

void main() {
  vec3 up = normalize(vWorldPos - uPlanetCenter);
  vec3 dir = normalize(vLocalPos);

#ifdef FLAT_SHADED
  // Low-poly meshes carry per-face normals already.
  vec3 N = normalize(vWorldNormal);
  float n1 = 0.0;
  float n2 = 0.0;
#else
  vec3 N = normalize(vWorldNormal);
#ifdef MOON
  // Moons are small on screen: much lower detail frequency to avoid aliasing.
  vec3 np = vLocalPos * 5.0;
#else
  vec3 np = vLocalPos * uDetailFreq;
#endif
  float n1 = snoise(np);
  float n2 = snoise(np * 2.9 + 13.0);
  // Extra micro detail fades in as the camera gets close.
  float boost = clamp(uDetailBoost, 0.0, 1.0);
  if (boost > 0.0) n2 = mix(n2, n2 * 0.7 + snoise(np * 8.1 - 3.0) * 0.45, boost);
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
  float wet = 0.0;
  float caustic = 0.0;

#ifdef MOON
  float mare = vData.z;
  albedo = uMoonColor * 0.62 * mix(1.0, 0.45, mare) * (0.85 + 0.3 * (n1 * 0.5 + 0.5));
  albedo *= 1.0 + vData.w * 0.4;
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

  if (uVillageCount > 0 && elev > 0.0) {
    vec3 ground;
    float vg = villageGround(dir, albedo, nd, ground);
    // Fields need farmland: not too dry, cold or steep.
    vg *= smoothstep(0.08, 0.16, moist) * smoothstep(0.2, 0.3, temp) * (1.0 - smoothstep(0.12, 0.22, slope));
    albedo = mix(albedo, ground, vg * (1.0 - rockAmt));
  }
  albedo = mix(albedo, uRockColor * (0.85 + 0.3 * (n1 * 0.5 + 0.5)), rockAmt);

  if (uHasOcean > 0.5) {
#ifdef FLAT_SHADED
    float beach = 1.0 - smoothstep(0.0, 0.02, elev);
#else
    float beach = 1.0 - smoothstep(0.012, 0.045, elev + nd * 0.012);
#endif
    albedo = mix(albedo, uSandColor, beach * (1.0 - rockAmt * 0.7));
    // Wet, darker sand just above the waterline.
    wet = (1.0 - smoothstep(0.0, 0.014, elev + nd * 0.004)) * step(0.0, elev) * (1.0 - rockAmt);
    albedo *= 1.0 - 0.3 * wet;
  }

  snow = 1.0 - smoothstep(uSnowLine - 0.025, uSnowLine + 0.025, temp + nd * 0.04);
  snow *= 1.0 - smoothstep(0.22, 0.5, slope) * 0.8;

  if (underwater) {
    albedo = mix(uSandColor * 0.9, uSeabedColor, smoothstep(0.0, 0.3, -elev));
    snow = 0.0;
#ifndef FLAT_SHADED
    // Caustics: sunlight focused by the waves dances over the shallow seabed.
    vec3 cp = vLocalPos * 70.0;
    float t = uTime * 0.5;
    float c1 = 1.0 - abs(snoise(cp + vec3(t * 0.31, -t * 0.22, t * 0.17)));
    float c2 = 1.0 - abs(snoise(cp * 1.31 + vec3(-t * 0.27, t * 0.33, -t * 0.12) + 7.1));
    float visible = clamp(2.0 - length(fwidth(cp)) * 2.5, 0.0, 1.0);
    caustic = pow(c1 * c2, 3.0) * exp(elev * 16.0) * visible;
#endif
  }
  albedo = mix(albedo, uSnowColor, snow);
#endif

#ifndef FLAT_SHADED
#ifdef MOON
  // Moons are small on screen: low-frequency bump only, to avoid aliasing.
  float bump = n1 * uDetailBump;
#else
  float bump = (n1 * 0.6 + n2 * 0.4) * uDetailBump * (underwater ? 0.3 : 1.0) * (1.0 - snow * 0.5);
#endif
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
#else
  shadow *= sunShadowMap(vWorldPos, normalize(vWorldNormal));
#ifndef FLAT_SHADED
  shadow *= cloudShadow(vWorldPos);
#endif
#endif
  vec3 sunLight = uSunColor * sunTransmittance(vWorldPos) * dayMask * shadow;
  float diff = max(dot(N, L), 0.0);
  vec3 ambient = uAmbient * (0.12 + 0.88 * smoothstep(-0.25, 0.5, sunDot));
#ifdef MOON
  // Planetshine: faint light reflected from the planet onto the moon's night side.
  vec3 toPlanet = normalize(uPlanetCenter - vWorldPos);
  ambient = uAmbient * 0.25 + vec3(0.03, 0.045, 0.07) * max(dot(N, toPlanet), 0.0);
#endif
#ifdef MOON
  vec3 sky = vec3(0.0);
#else
  vec3 sky = skyLight(N, up, sunDot);
#endif
  // Baked cavity occlusion: darker valleys, slightly brighter ridges.
  vec3 col = albedo * (sunLight * diff * mix(1.0, vAO, 0.45) + (ambient + sky) * vAO);

  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 40.0) * (0.22 * snow + 0.03) + pow(max(dot(N, H), 0.0), 90.0) * wet * 0.5;
  col += sunLight * spec;
  col += albedo * sunLight * caustic * 1.6;

#ifndef MOON
  // Snow glitters when you get close.
  if (snow > 0.5 && uDetailBoost > 0.0) {
    float g = step(0.9975, hash13(floor(vLocalPos * 1400.0)));
    col += sunLight * g * (snow - 0.5) * 2.0 * min(uDetailBoost, 1.0) * (0.5 + pow(max(dot(N, H), 0.0), 8.0) * 2.0);
  }
  float night = 1.0 - smoothstep(-0.16, 0.05, sunDot);
  if (uVillageCount > 0 && night > 0.001 && !underwater) {
    float glow = villageGlow(dir);
    col += albedo * vec3(1.0, 0.58, 0.26) * glow * glow * night * 0.09;
  }
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
    uDetailFreq: { value: 21 },
    uCityLights: { value: 0 },
    uCityColor: { value: new THREE.Color() },
    uLava: { value: 0 },
    uLavaColor: { value: new THREE.Color() },
    uMoonColor: { value: new THREE.Color() },
    uVillages: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
    uVillageCount: { value: 0 },
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

import * as THREE from 'three';
import { COMMON_GLSL } from '../shaders/common';
import { NOISE_GLSL } from '../shaders/noise';
import type { QualityDefines } from '../quality';

const VERT = /* glsl */ `
attribute vec4 aData;
uniform float uOceanRadius;
varying vec3 vWorldPos;
varying vec3 vLocalDir;
varying vec4 vData;

void main() {
  vec3 dir = normalize(position);
  vec4 wp = modelMatrix * vec4(dir * uOceanRadius, 1.0);
  vWorldPos = wp.xyz;
  vLocalDir = dir;
  vData = aData;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${NOISE_GLSL}
${COMMON_GLSL}

uniform vec3 uShallow;
uniform vec3 uDeep;
uniform float uClarity;
uniform float uFoam;
uniform float uWaves;
uniform float uGlow;
uniform float uLava;
uniform vec3 uIceColor;
uniform vec3 uSkyTint;

varying vec3 vWorldPos;
varying vec3 vLocalDir;
varying vec4 vData;

void main() {
  float depth = uSeaLevel - vData.x;
  if (depth < -0.004) discard;
  float dz = max(depth, 0.0);

  vec3 dir = normalize(vLocalDir);
  vec3 up = normalize(vWorldPos - uPlanetCenter);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = uSunDir;
  float sunDot = dot(up, L);
  float dayMask = smoothstep(-0.07, 0.12, sunDot);
  float shadow = cloudShadow(vWorldPos) * ringShadow(vWorldPos) * moonShadow(vWorldPos);
  vec3 sunLight = uSunColor * sunTransmittance(vWorldPos) * dayMask * shadow;
  vec3 ambient = uAmbient * (0.12 + 0.88 * smoothstep(-0.25, 0.5, sunDot));
  float NdotL = max(sunDot, 0.0);

  if (uLava > 0.5) {
    float t = uTime * 0.02;
    vec3 q = dir * 4.5 + vec3(t, -t * 0.6, t * 0.3);
    float plates = fbm(q, 4);
    float n2 = snoise(dir * 30.0 - vec3(0.0, t * 3.0, 0.0));
    float cracks = pow(1.0 - abs(snoise(dir * 15.0 + vec3(0.0, t * 2.0, 0.0))), 12.0);
    float shore = 1.0 - smoothstep(0.0, 0.05, dz);
    float f = plates + n2 * 0.04 - shore * 0.3;
    // Dark crust plates; molten pools glow orange at their edges and yellow in the core.
    float crust = smoothstep(-0.14, -0.03, f);
    float core = 1.0 - smoothstep(-0.38, -0.05, f);
    float heat = clamp((1.0 - crust) * (0.45 + 0.55 * core) + cracks * crust * 0.6, 0.0, 1.0);
    vec3 molten = mix(uDeep * 0.7, uDeep, smoothstep(0.0, 0.45, heat));
    molten = mix(molten, uShallow, smoothstep(0.55, 1.0, heat + n2 * 0.08));
    vec3 crustCol = vec3(0.04, 0.03, 0.028) * (sunLight * NdotL + ambient);
    vec3 H = normalize(L + V);
    crustCol += sunLight * pow(max(dot(up, H), 0.0), 60.0) * 0.06;
    vec3 col = mix(crustCol, molten * (0.5 + 1.3 * heat), max(heat, 1.0 - crust));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }

#ifdef FLAT_SHADED
  vec3 N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  if (dot(N, up) < 0.0) N = -N;
#else
  vec3 N = up;
  if (uWaves > 0.001) {
    float t = uTime * 0.5;
    vec3 wp = dir * 64.0;
    vec3 g = vec3(snoise(wp + vec3(t, 0.0, 0.0)), snoise(wp + vec3(0.0, t, 31.0)), snoise(wp + vec3(57.0, 0.0, t)));
#if CLOUD_OCTAVES > 4
    vec3 wp2 = dir * 150.0;
    g += 0.5 * vec3(snoise(wp2 - vec3(t, 0.0, 9.0)), snoise(wp2 + vec3(4.0, -t, 0.0)), snoise(wp2 + vec3(0.0, 17.0, -t)));
#endif
    N = normalize(up + (g - up * dot(g, up)) * 0.03 * uWaves);
  }
#endif

  // Water body colour: absorption with depth.
  float deepT = 1.0 - exp(-dz * 7.0);
  vec3 water = mix(uShallow, uDeep, deepT);
  vec3 col = water * (sunLight * (0.3 + 0.7 * NdotL) + ambient);

  // Fresnel reflection of the sky.
  float NdotV = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(up, V), 0.0), 5.0);
  col = mix(col, uSkyTint * (dayMask * 0.6 + 0.02), fres * 0.55);

  // Sun glint (GGX distribution, Schlick Fresnel).
  vec3 H = normalize(L + V);
  float NdotH = max(dot(N, H), 0.0);
  float rough = mix(0.07, 0.2, uWaves);
  float a2 = rough * rough * rough * rough;
  float dd = NdotH * NdotH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  float spec = D * F / (4.0 * max(NdotV, 0.2)) * max(dot(N, L), 0.0);
  col += sunLight * min(spec, 60.0);

  // Shoreline foam.
  float alpha = 1.0 - exp(-dz * mix(42.0, 5.0, uClarity));
  alpha = max(alpha, fres * 0.9);
  if (uFoam > 0.001) {
    float zone = 1.0 - smoothstep(0.0, 0.02, dz);
    if (zone > 0.0) {
      float fn = snoise(dir * 140.0 + vec3(0.0, uTime * 0.25, 0.0));
      float bands = sin(dz * 260.0 - uTime * 1.8 + fn * 2.2) * 0.5 + 0.5;
      float foam = smoothstep(0.6, 0.95, bands * zone + fn * 0.2) * zone;
      foam = max(foam, smoothstep(0.75, 1.0, zone) * (0.6 + 0.4 * fn));
      foam *= uFoam;
      col = mix(col, vec3(0.95) * (sunLight * (0.4 + 0.6 * NdotL) + ambient), foam);
      alpha = max(alpha, foam);
    }
  }

  // Sea ice where it is cold.
  float temp = vData.y + uTempOffset;
  float ice = 0.0;
  if (temp < uSnowLine + 0.03) {
    float iceN = snoise(dir * 26.0) * 0.6 + snoise(dir * 70.0) * 0.4;
    ice = 1.0 - smoothstep(uSnowLine - 0.06, uSnowLine - 0.01, temp + iceN * 0.035);
  }
  if (ice > 0.0) {
    float cracks = smoothstep(0.92, 1.0, 1.0 - abs(snoise(dir * 45.0)));
    vec3 iceAlb = mix(uIceColor, uIceColor * vec3(0.6, 0.78, 0.95), cracks * 0.6);
    vec3 iceCol = iceAlb * (sunLight * (0.25 + 0.75 * max(dot(up, L), 0.0)) + ambient);
    iceCol += sunLight * pow(NdotH, 80.0) * 0.25;
    col = mix(col, iceCol, ice);
    alpha = mix(alpha, 1.0, ice);
  }

  // Optional bioluminescence (alien oceans).
  if (uGlow > 0.001) {
    float night = 1.0 - smoothstep(-0.2, 0.1, sunDot);
    float pulse = 0.75 + 0.25 * sin(uTime * 0.8 + snoise(dir * 9.0) * 4.0);
    col += uShallow * uGlow * (0.15 + night * 0.85) * (1.2 - deepT) * pulse * 1.2;
  }

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createOceanMaterial(
  shared: Record<string, THREE.IUniform>,
  quality: QualityDefines,
  opts: { flat: boolean },
): THREE.ShaderMaterial {
  const defines: Record<string, string | number | boolean> = { ...quality };
  if (opts.flat) defines.FLAT_SHADED = '';
  return new THREE.ShaderMaterial({
    name: 'OceanMaterial',
    uniforms: {
      ...shared,
      uOceanRadius: { value: 1 },
      uShallow: { value: new THREE.Color() },
      uDeep: { value: new THREE.Color() },
      uClarity: { value: 0.6 },
      uFoam: { value: 0.6 },
      uWaves: { value: 0.5 },
      uGlow: { value: 0 },
      uLava: { value: 0 },
      uIceColor: { value: new THREE.Color(0.85, 0.92, 1.0) },
      uSkyTint: { value: new THREE.Color() },
    },
    defines,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: true,
  });
}

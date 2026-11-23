import * as THREE from 'three';
import type { SharedUniforms } from '../render/PlanetView';
import type { QualityDefines } from '../render/quality';
import { COMMON_GLSL } from '../render/shaders/common';
import { NOISE_GLSL } from '../render/shaders/noise';

// --- Ship ---------------------------------------------------------------------------------

const SHIP_VERT = /* glsl */ `
attribute float aPart;
attribute float aAO;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vPart;
varying float vAO;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vPart = aPart;
  vAO = aAO;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHIP_FRAG = /* glsl */ `
${NOISE_GLSL}
${COMMON_GLSL}

uniform vec3 uHull;
uniform vec3 uTrim;
uniform vec3 uMetal;
uniform vec3 uGlass;
uniform vec3 uEngine;
uniform vec3 uNavLeft;
uniform vec3 uNavRight;
/** Shadow-map lookups start this far towards the sun, so the ship doesn't shadow itself. */
uniform float uSelfShadow;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vPart;
varying float vAO;

void main() {
  int part = int(vPart + 0.5);
  vec3 col;
  if (part == 4) {
    col = uEngine;
  } else if (part == 5) {
    col = uNavLeft;
  } else if (part == 6) {
    col = uNavRight;
  } else {
    vec3 N = normalize(vNormal);
    vec3 up = normalize(vWorldPos - uPlanetCenter);
    vec3 L = uSunDir;
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(L + V);
    float sunDot = dot(up, L);
    vec3 ambient = uAmbient * (0.15 + 0.85 * smoothstep(-0.25, 0.5, sunDot));
    vec3 sky = skyLight(N, up, sunDot);
    float dayMask = smoothstep(-0.07, 0.12, sunDot);
    float shadow = ringShadow(vWorldPos) * moonShadow(vWorldPos) * cloudShadow(vWorldPos)
      * sunShadowMap(vWorldPos + L * uSelfShadow, N);
    vec3 sunLight = uSunColor * sunTransmittance(vWorldPos) * dayMask * shadow;

    vec3 base = part == 0 ? uHull : part == 1 ? uTrim : part == 2 ? uMetal : uGlass;
    float ao = vAO;
    float NdotL = dot(N, L);
    col = base * (sunLight * max(NdotL, 0.0) * mix(0.7, 1.0, ao) + (sky + ambient) * ao);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    float night = 1.0 - smoothstep(-0.2, 0.08, sunDot);
    if (part == 3) {
      // Glass: sky reflection, a sharp sun glint and softly lit instruments.
      col = mix(col, sky * 1.4 + ambient, 0.2 + 0.7 * fres);
      col += sunLight * pow(max(dot(N, H), 0.0), 220.0) * 1.5 * step(0.0, NdotL);
      col += vec3(0.2, 0.5, 0.75) * (0.035 + 0.12 * night);
    } else {
      // Glossy paint, shinier metal, and a little sky on the rim so the silhouette reads.
      float shine = part == 2 ? 0.3 : 0.14;
      col += sunLight * pow(max(dot(N, H), 0.0), part == 2 ? 70.0 : 36.0) * shine * step(0.0, NdotL);
      col += sky * fres * 0.4 * ao;
      // Running lights keep the hull readable on the night side.
      col += base * vec3(0.55, 0.65, 0.9) * 0.07 * night * ao;
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface ShipColors {
  hull: string;
  trim: string;
  metal: string;
  glass: string;
}

export function createShipMaterial(shared: SharedUniforms, quality: QualityDefines, colors: ShipColors): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'ShipMaterial',
    uniforms: {
      ...shared,
      uHull: { value: new THREE.Color(colors.hull) },
      uTrim: { value: new THREE.Color(colors.trim) },
      uMetal: { value: new THREE.Color(colors.metal) },
      uGlass: { value: new THREE.Color(colors.glass) },
      uEngine: { value: new THREE.Color() },
      uNavLeft: { value: new THREE.Color() },
      uNavRight: { value: new THREE.Color() },
      uSelfShadow: { value: 0.05 },
    },
    defines: { ...quality },
    vertexShader: SHIP_VERT,
    fragmentShader: SHIP_FRAG,
  });
}

// --- Debris chunks (instanced, flat shaded, lit by the sun and the sky) -----------------------

const DEBRIS_VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;

void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
#ifdef USE_INSTANCING_COLOR
  vColor = instanceColor;
#else
  vColor = vec3(1.0);
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const DEBRIS_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyLight;
uniform vec3 uAmbient;
uniform vec3 uPlanetCenter;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;

void main() {
  vec3 N = normalize(vNormal);
  vec3 up = normalize(vWorldPos - uPlanetCenter);
  float sunDot = dot(up, uSunDir);
  float day = smoothstep(-0.07, 0.12, sunDot);
  vec3 sky = uSkyLight * smoothstep(-0.18, 0.3, sunDot) * (0.55 + 0.45 * dot(N, up));
  vec3 col = vColor * (uSunColor * max(dot(N, uSunDir), 0.0) * day * 0.9 + sky + uAmbient);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createDebrisMaterial(shared: SharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'DebrisMaterial',
    uniforms: {
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uSkyLight: shared.uSkyLight,
      uAmbient: shared.uAmbient,
      uPlanetCenter: shared.uPlanetCenter,
    },
    vertexShader: DEBRIS_VERT,
    fragmentShader: DEBRIS_FRAG,
  });
}

// --- Particles (round point sprites; additive glow or alpha-blended dust) --------------------

const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
/** Pixels per world unit at distance 1 (drawing-buffer height / (2 tan(fov / 2))). */
uniform float uScale;
varying vec4 vColor;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 1e-5), 1.0, 256.0);
  vColor = aColor;
}
`;

const PARTICLE_FRAG = /* glsl */ `
varying vec4 vColor;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  if (d2 > 1.0) discard;
#ifdef GLOW
  float f = exp(-d2 * 3.2) - 0.04;
  gl_FragColor = vec4(vColor.rgb, vColor.a * max(f, 0.0));
#else
  float f = 1.0 - smoothstep(0.45, 1.0, d2);
  gl_FragColor = vec4(vColor.rgb, vColor.a * f);
#endif
}
`;

export function createParticleMaterial(glow: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: glow ? 'GlowParticles' : 'DustParticles',
    uniforms: { uScale: { value: 500 } },
    defines: glow ? { GLOW: '' } : {},
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

/** Blaster bolts: unlit, bright enough (HDR) to bloom. */
export function createBoltMaterial(color: THREE.Color): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color });
}

import * as THREE from 'three';
import { COMMON_GLSL } from '../shaders/common';
import { NOISE_GLSL } from '../shaders/noise';
import { PROP_COLORS } from '../propGeometry';
import type { QualityDefines } from '../quality';

const VERT = /* glsl */ `
attribute float aPart;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vPart;
varying float vHeight;
varying vec3 vTint;

void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vPart = aPart;
  vHeight = position.y;
#ifdef USE_INSTANCING_COLOR
  vTint = instanceColor;
#else
  vTint = vec3(1.0);
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${NOISE_GLSL}
${COMMON_GLSL}

uniform vec3 uWoodColor;
uniform vec3 uWallColor;
uniform vec3 uWindowColor;
uniform vec3 uWindowGlow;
uniform vec3 uPuffColor;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vPart;
varying float vHeight;
varying vec3 vTint;

void main() {
  vec3 N = normalize(vNormal);
  vec3 up = normalize(vWorldPos - uPlanetCenter);
  vec3 L = uSunDir;
  float sunDot = dot(up, L);
  vec3 ambient = uAmbient * (0.15 + 0.85 * smoothstep(-0.25, 0.5, sunDot));

#ifdef PUFF
  // Puffy clouds: bright, softly wrapped light, lit a little past the terminator.
  float dayMask = smoothstep(-0.1, 0.12, sunDot);
  vec3 sunLight = uSunColor * sunTransmittance(vWorldPos) * dayMask * ringShadow(vWorldPos) * moonShadow(vWorldPos);
  float facets = max(dot(N, L), 0.0) * 0.55 + 0.45 * smoothstep(-0.1, 0.6, sunDot);
  // Facets fade out towards the terminator so twilight puffs stay soft.
  float diff = mix(0.45, facets, smoothstep(0.0, 0.3, sunDot));
  vec3 col = uPuffColor * 0.85 * (sunLight * diff + ambient * 1.4);
#else
  float dayMask = smoothstep(-0.07, 0.12, sunDot);
  float shadow = ringShadow(vWorldPos) * moonShadow(vWorldPos) * cloudShadow(vWorldPos);
  vec3 sunLight = uSunColor * sunTransmittance(vWorldPos) * dayMask * shadow;

  vec3 base;
  if (vPart < 0.5) base = uWoodColor;
  else if (vPart < 1.5) base = vTint;
  else if (vPart < 2.5) base = uWallColor;
  else base = uWindowColor;

  // Foliage scatters some light around; everything darkens towards the ground.
  float wrap = (vPart > 0.5 && vPart < 1.5) ? 0.12 : 0.06;
  float diff = max(dot(N, L), 0.0) * (1.0 - wrap) + wrap * smoothstep(-0.2, 0.6, sunDot);
  float ao = mix(0.4, 1.0, smoothstep(0.0, 0.55, vHeight));
  // Sky light from above: tops are lighter than undersides.
  float sky = 0.55 + 0.45 * max(dot(N, up), 0.0);
  vec3 col = base * (sunLight * diff + ambient * 0.9 * sky) * ao;

  // Warm windows on the night side.
  if (vPart > 2.5) {
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
  wp.xyz -= (uSunDir - up * sunDot) * s * 0.35;
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

/** Contact shadows under props: soft dark discs, nudged away from the sun. */
export function createPropShadowMaterial(shared: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'PropShadowMaterial',
    uniforms: {
      uSunDir: shared.uSunDir,
      uPlanetCenter: shared.uPlanetCenter,
      uStrength: { value: 0.75 },
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
      uWoodColor: { value: new THREE.Color(PROP_COLORS.wood) },
      uWallColor: { value: new THREE.Color(PROP_COLORS.wall) },
      uWindowColor: { value: new THREE.Color(PROP_COLORS.window) },
      uWindowGlow: { value: new THREE.Color(PROP_COLORS.windowGlow) },
      uPuffColor: { value: new THREE.Color('#ffffff') },
    },
    defines,
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}

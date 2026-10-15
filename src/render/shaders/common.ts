/**
 * Shared GLSL: uniforms common to all planet materials plus helpers for atmospheric
 * transmittance, cloud density, and shadows from clouds, rings, moons and the planet.
 * Requires NOISE_GLSL to be included first.
 */
export const COMMON_GLSL = /* glsl */ `
#define PI 3.14159265359

uniform float uTime;
uniform float uDetailBoost;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;

// atmosphere
uniform float uAtmoOn;
uniform float uAtmoInner;
uniform float uAtmoOuter;
uniform vec3 uBetaR;
uniform vec3 uBetaM;
uniform float uScaleR;
uniform float uScaleM;

// climate
uniform float uSeaLevel;
uniform float uHasOcean;
uniform float uTempOffset;
uniform float uHumidOffset;
uniform float uSnowLine;

// clouds
uniform float uCloudRadius;
uniform mat4 uCloudInvMatrix;
uniform float uCloudCoverage;
uniform float uCloudScale;
uniform float uCloudTime;
uniform float uCloudOpacity;
uniform float uCloudShadow;
uniform vec3 uCloudOffset;
uniform vec4 uStorms[4];

// rings
uniform float uRingOn;
uniform vec3 uRingNormal;
uniform float uRingInner;
uniform float uRingOuter;
uniform float uRingOpacity;
uniform sampler2D uRingTex;

// moons (xyz = world position, w = radius)
uniform int uMoonCount;
uniform vec4 uMoons[4];

vec2 raySphere(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float cc = dot(oc, oc) - r * r;
  float h = b * b - cc;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Sunlight colour filter after travelling through the atmosphere to point p.
vec3 sunTransmittance(vec3 p) {
  if (uAtmoOn < 0.5) return vec3(1.0);
  vec2 t = raySphere(p, uSunDir, uPlanetCenter, uAtmoOuter);
  float t0 = max(t.x, 0.0);
  float t1 = t.y;
  if (t1 <= t0) return vec3(1.0);
  float stepLen = (t1 - t0) / float(SUN_STEPS);
  float odR = 0.0;
  float odM = 0.0;
  for (int i = 0; i < SUN_STEPS; i++) {
    vec3 s = p + uSunDir * (t0 + stepLen * (float(i) + 0.5));
    float h = max(length(s - uPlanetCenter) - uAtmoInner, 0.0);
    odR += exp(-h / uScaleR);
    odM += exp(-h / uScaleM);
  }
  return exp(-(uBetaR * odR + uBetaM * 1.1 * odM) * stepLen);
}

// Soft shadow from a sphere (c, r) for a point p lit along uSunDir.
float sphereShadow(vec3 p, vec3 c, float r, float softness) {
  vec3 oc = c - p;
  float tca = dot(oc, uSunDir);
  if (tca <= 0.0) return 1.0;
  float d = sqrt(max(dot(oc, oc) - tca * tca, 0.0));
  float pen = softness + tca * 0.012;
  return smoothstep(r - pen, r + pen, d);
}

float moonShadow(vec3 p) {
  float s = 1.0;
  for (int i = 0; i < 4; i++) {
    if (i >= uMoonCount) break;
    s *= mix(0.08, 1.0, sphereShadow(p, uMoons[i].xyz, uMoons[i].w, 0.004));
  }
  return s;
}

float ringShadow(vec3 p) {
  if (uRingOn < 0.5) return 1.0;
  float denom = dot(uSunDir, uRingNormal);
  if (abs(denom) < 1e-4) return 1.0;
  float t = dot(uPlanetCenter - p, uRingNormal) / denom;
  if (t <= 0.0) return 1.0;
  vec3 hit = p + uSunDir * t;
  float u = (length(hit - uPlanetCenter) - uRingInner) / (uRingOuter - uRingInner);
  if (u < 0.0 || u > 1.0) return 1.0;
  return 1.0 - texture2D(uRingTex, vec2(u, 0.5)).a * uRingOpacity * 0.85;
}

vec3 rotateAxis(vec3 p, vec3 axis, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
}

// Cloud density in [0,1] for a unit direction in cloud-local space.
// x = full detail density, y = smooth (2-octave) density used for lighting normals.
vec2 cloudFieldDual(vec3 p, int octaves) {
  float eye = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 st = uStorms[i];
    float d = 1.0 - dot(p, st.xyz);
    float k = exp(-d * 42.0);
    p = rotateAxis(p, st.xyz, st.w * k * 2.2);
    eye += abs(st.w) * (k - exp(-d * 900.0)) * 0.35;
  }
  vec3 q = p * uCloudScale + uCloudOffset;
  vec3 w = vec3(
    snoise(q * 0.6 + vec3(0.0, uCloudTime, 0.0)),
    snoise(q * 0.6 + vec3(19.1, -uCloudTime, 7.3)),
    snoise(q * 0.6 + vec3(-5.7, 3.1, uCloudTime + 11.0)));
  q += w * 0.33;
  // Large weather systems modulate where clouds can form.
  float systems = snoise(q * 0.42 + vec3(3.3, uCloudTime * 0.5, -1.7));
  // Un-normalised fBm: dropping octaves (e.g. for shadows) just removes detail, not coverage.
  vec3 fp = q * vec3(1.35, 2.0, 1.35);
  float n = 0.0;
  float nSmooth = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    n += amp * snoise(fp);
    if (i == 1) nSmooth = n;
    fp = fp * 2.03 + vec3(17.3, -9.1, 4.7);
    amp *= 0.5;
  }
  if (octaves < 2) nSmooth = n;
  n /= 0.96875;
  nSmooth /= 0.96875;
  float lat = asin(clamp(p.y, -1.0, 1.0));
  float base = 0.5 + systems * 0.16 + 0.08 * cos(lat * 6.0) + eye + (uCloudCoverage - 0.5) * 0.85 - 0.045;
  return vec2(smoothstep(0.55, 0.67, n * 0.5 + base), smoothstep(0.5, 0.72, nSmooth * 0.5 + base));
}

float cloudField(vec3 p, int octaves) {
  return cloudFieldDual(p, octaves).x;
}

float cloudShadow(vec3 p) {
#if CLOUD_SHADOWS == 0
  return 1.0;
#else
  if (uCloudShadow <= 0.001 || uCloudCoverage <= 0.001) return 1.0;
  vec2 t = raySphere(p, uSunDir, uPlanetCenter, uCloudRadius);
  if (t.y <= 0.0) return 1.0;
  vec3 hit = p + uSunDir * t.y;
  vec3 local = normalize((uCloudInvMatrix * vec4(hit, 1.0)).xyz);
  return 1.0 - cloudField(local, SHADOW_OCTAVES) * uCloudShadow * uCloudOpacity;
#endif
}

// Bump mapping without tangents (Mikkelsen 2010), height in world units.
vec3 perturbNormal(vec3 pos, vec3 n, float height) {
  vec3 dpdx = dFdx(pos);
  vec3 dpdy = dFdy(pos);
  vec3 r1 = cross(dpdy, n);
  vec3 r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  float dhx = dFdx(height);
  float dhy = dFdy(height);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * n - grad);
}
`;

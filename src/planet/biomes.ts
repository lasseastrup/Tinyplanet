/**
 * Biome palette → lookup table. The LUT is indexed by (moisture, temperature) and blends the
 * biome colours with a soft Voronoi-style weighting (a Whittaker diagram, simplified).
 * The same function is used on the CPU for baking vertex colours on export.
 */
import { hexToSrgb, srgbToLinear } from '../core/math';
import type { PlanetParams } from './params';

export const LUT_SIZE = 64;

type BiomeKey = 'cTundra' | 'cTaiga' | 'cGrass' | 'cForest' | 'cDesert' | 'cSavanna' | 'cJungle';

/** Anchor points in (temperature, moisture) space. */
const ANCHORS: ReadonlyArray<{ t: number; m: number; key: BiomeKey }> = [
  { t: 0.2, m: 0.25, key: 'cTundra' },
  { t: 0.3, m: 0.78, key: 'cTaiga' },
  { t: 0.42, m: 0.05, key: 'cTundra' },
  { t: 0.55, m: 0.32, key: 'cGrass' },
  { t: 0.56, m: 0.72, key: 'cForest' },
  { t: 0.72, m: 0.55, key: 'cForest' },
  { t: 0.88, m: 0.06, key: 'cDesert' },
  { t: 0.68, m: 0.1, key: 'cDesert' },
  { t: 0.83, m: 0.36, key: 'cSavanna' },
  { t: 0.9, m: 0.84, key: 'cJungle' },
];

const SHARPNESS = 38;

/** sRGB biome colour (0..1 floats) for a temperature/moisture pair. */
export function biomeColorSrgb(p: PlanetParams, temp: number, moist: number, out: number[] = [0, 0, 0]): number[] {
  let r = 0;
  let g = 0;
  let b = 0;
  let wsum = 0;
  for (const a of ANCHORS) {
    const dt = temp - a.t;
    const dm = (moist - a.m) * 0.85;
    const w = Math.exp(-SHARPNESS * (dt * dt + dm * dm));
    const c = hexToSrgb(p[a.key]);
    // Blend in linear space for nicer gradients.
    r += srgbToLinear(c[0]) * w;
    g += srgbToLinear(c[1]) * w;
    b += srgbToLinear(c[2]) * w;
    wsum += w;
  }
  const inv = 1 / Math.max(wsum, 1e-12);
  out[0] = linToSrgb(r * inv);
  out[1] = linToSrgb(g * inv);
  out[2] = linToSrgb(b * inv);
  return out;
}

function linToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** RGBA8 sRGB pixel data for the biome LUT texture (x = moisture, y = temperature). */
export function buildBiomeLut(p: PlanetParams): Uint8Array {
  const data = new Uint8Array(LUT_SIZE * LUT_SIZE * 4);
  const tmp = [0, 0, 0];
  for (let y = 0; y < LUT_SIZE; y++) {
    const temp = (y + 0.5) / LUT_SIZE;
    for (let x = 0; x < LUT_SIZE; x++) {
      const moist = (x + 0.5) / LUT_SIZE;
      biomeColorSrgb(p, temp, moist, tmp);
      const o = (y * LUT_SIZE + x) * 4;
      data[o] = Math.round(tmp[0] * 255);
      data[o + 1] = Math.round(tmp[1] * 255);
      data[o + 2] = Math.round(tmp[2] * 255);
      data[o + 3] = 255;
    }
  }
  return data;
}

/** Key that changes whenever the LUT needs rebuilding. */
export function biomeLutKey(p: PlanetParams): string {
  return ANCHORS.map((a) => p[a.key]).join(',');
}

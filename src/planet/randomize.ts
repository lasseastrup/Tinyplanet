import { clamp, hexToSrgb, hslToHex } from '../core/math';
import { Rng, randomSeed } from '../core/rng';
import { planetName } from './names';
import { sanitizeParams, type PlanetParams } from './params';
import { getPreset, PRESETS, type Preset } from './presets';

const WEIGHTS: Record<string, number> = {
  terra: 4,
  oceania: 2,
  dune: 1.4,
  rust: 1,
  glacia: 1.4,
  inferno: 1,
  xeno: 1.2,
  candy: 1,
  luna: 0.5,
  toybox: 0.5,
};

const BIOME_KEYS = ['cTundra', 'cTaiga', 'cGrass', 'cForest', 'cDesert', 'cSavanna', 'cJungle', 'cRock', 'cSand'] as const;
const COLOR_KEYS = [...BIOME_KEYS, 'cShallow', 'cDeep', 'cSnow'] as const;

function weightedPreset(rng: Rng): Preset {
  const total = PRESETS.reduce((s, p) => s + (WEIGHTS[p.id] ?? 1), 0);
  let r = rng.next() * total;
  for (const p of PRESETS) {
    r -= WEIGHTS[p.id] ?? 1;
    if (r <= 0) return p;
  }
  return PRESETS[0];
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToSrgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function shiftHue(hex: string, degrees: number, satMul = 1): string {
  const [h, s, l] = toHsl(hex);
  return hslToHex(h + degrees, clamp(s * satMul, 0, 1), l);
}

/** A harmonious but unusual palette for alien worlds. */
function alienPalette(rng: Rng, p: PlanetParams): void {
  const h = rng.range(0, 360);
  const s = rng.range(0.35, 0.7);
  p.cJungle = hslToHex(h, s, 0.24);
  p.cForest = hslToHex(h + 10, s, 0.32);
  p.cGrass = hslToHex(h + 24, s, 0.5);
  p.cTaiga = hslToHex(h - 18, s * 0.8, 0.27);
  p.cTundra = hslToHex(h - 35, s * 0.4, 0.55);
  p.cSavanna = hslToHex(h + 45, s * 0.9, 0.55);
  p.cDesert = hslToHex(h + 62, s * 0.7, 0.68);
  p.cSand = hslToHex(h + 70, s * 0.5, 0.82);
  p.cRock = hslToHex(h + 180, 0.15, 0.38);
  const oh = h + rng.range(120, 240);
  p.cShallow = hslToHex(oh, 0.75, 0.55);
  p.cDeep = hslToHex(oh + 12, 0.8, 0.18);
  p.cSky = hslToHex(rng.range(0, 360), 0.85, 0.62);
  p.cCity = hslToHex(rng.range(0, 360), 0.9, 0.65);
  p.cAurora = hslToHex(rng.range(0, 360), 0.95, 0.6);
}

/** Generate a random but good-looking planet, optionally based on a specific preset. */
export function randomPlanet(presetId?: string, seed = randomSeed()): PlanetParams {
  const rng = new Rng(seed);
  const base = (presetId && getPreset(presetId)) || weightedPreset(rng);
  const p: PlanetParams = { ...base.params };
  p.seed = seed;
  p.name = planetName(seed);
  p.preset = base.id;

  const jitter = (v: number, spread: number) => v * (1 + rng.range(-spread, spread));
  p.continentScale = jitter(p.continentScale, 0.3);
  p.mountainHeight = jitter(p.mountainHeight, 0.3);
  p.mountainScale = jitter(p.mountainScale, 0.3);
  p.roughness = jitter(p.roughness, 0.25);
  p.warp = jitter(p.warp, 0.35);
  p.seaLevel += rng.normal(0, 0.06);
  p.temperature += rng.normal(0, 0.06);
  p.humidity += rng.normal(0, 0.08);
  if (p.cloudCoverage > 0) p.cloudCoverage = clamp(p.cloudCoverage + rng.normal(0, 0.07), 0.03, 0.8);
  p.cloudStorms = rng.range(0.15, 0.9);
  p.cloudScale = jitter(p.cloudScale, 0.2);
  p.axialTilt = rng.range(4, 32);
  p.sunAzimuth = rng.range(52, 78);
  p.sunElevation = rng.range(4, 22);

  const wild = base.id !== 'luna' && base.id !== 'inferno' && rng.chance(0.16);
  if (wild) {
    alienPalette(rng, p);
  } else {
    const shift = rng.normal(0, 7);
    for (const k of COLOR_KEYS) p[k] = shiftHue(p[k], shift);
  }

  const m = rng.next();
  p.moons = m < 0.25 ? 0 : m < 0.65 ? 1 : m < 0.9 ? 2 : 3;
  if (base.id === 'luna') p.moons = Math.min(p.moons, 1);
  p.moonSize = rng.range(0.1, 0.24);

  if (p.rings < 0.001 && base.id !== 'luna' && rng.chance(0.22)) {
    p.rings = rng.range(0.5, 0.9);
    p.ringInner = rng.range(1.35, 1.7);
    p.ringOuter = p.ringInner + rng.range(0.5, 1.2);
    p.cRing1 = shiftHue(p.cSand, rng.range(-20, 20), 0.6);
    p.cRing2 = shiftHue(p.cRock, rng.range(-30, 30), 0.8);
  } else if (p.rings > 0.001 && rng.chance(0.3)) {
    p.rings = 0;
  }
  return sanitizeParams(p);
}

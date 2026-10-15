/**
 * Planet parameters. A flat object so it's easy to bind to UI, serialise to URLs and
 * reuse from game code. Colours are sRGB hex strings.
 */
export type Liquid = 'water' | 'lava' | 'none';
export type CloudStyle = 'layer' | 'puffs';

export interface PlanetParams {
  // identity
  name: string;
  seed: number;
  preset: string;

  // shape — changing these regenerates the mesh (in a worker)
  /** 0 = tiny diorama world (huge features, 3D props are big), 1 = large planet. */
  size: number;
  lowPoly: boolean;
  detail: number;
  heightScale: number;
  continentScale: number;
  mountainHeight: number;
  mountainScale: number;
  roughness: number;
  warp: number;
  terraces: number;
  craters: number;

  // climate
  seaLevel: number;
  temperature: number;
  humidity: number;
  snowLine: number;

  // surface palette
  cSnow: string;
  cTundra: string;
  cTaiga: string;
  cForest: string;
  cGrass: string;
  cDesert: string;
  cSavanna: string;
  cJungle: string;
  cRock: string;
  cSand: string;

  // liquid
  liquid: Liquid;
  cShallow: string;
  cDeep: string;
  oceanClarity: number;
  foam: number;
  waves: number;
  oceanGlow: number;

  // atmosphere
  atmoDensity: number;
  atmoHeight: number;
  cSky: string;
  haze: number;
  cHaze: string;

  // clouds
  cloudCoverage: number;
  cloudOpacity: number;
  cloudScale: number;
  cloudSpeed: number;
  cloudStorms: number;
  cloudAltitude: number;
  cloudShadows: number;
  cirrus: number;
  cCloud: string;
  cloudStyle: CloudStyle;

  // life: instanced 3D props on the surface
  trees: number;
  rocks: number;
  houses: number;
  cRoof: string;

  // night side & extras
  cityLights: number;
  cCity: string;
  aurora: number;
  cAurora: string;

  // rings
  rings: number;
  ringInner: number;
  ringOuter: number;
  cRing1: string;
  cRing2: string;

  // moons
  moons: number;
  moonSize: number;
  cMoon: string;

  // scene
  axialTilt: number;
  spinSpeed: number;
  sunAzimuth: number;
  sunElevation: number;
  sunIntensity: number;
  bloom: number;
  exposure: number;
}

export type ParamKey = keyof PlanetParams;

/** Keys that require the terrain mesh to be regenerated. */
export const SHAPE_KEYS: ReadonlySet<ParamKey> = new Set<ParamKey>([
  'seed',
  'size',
  'lowPoly',
  'detail',
  'heightScale',
  'continentScale',
  'mountainHeight',
  'mountainScale',
  'roughness',
  'warp',
  'terraces',
  'craters',
  'moons',
]);

/** Keys that are applied instantly but refine the generated climate shortly after (debounced). */
export const SOFT_REGEN_KEYS: ReadonlySet<ParamKey> = new Set<ParamKey>(['seaLevel', 'liquid']);

/** Keys that change where/how surface props (trees, rocks, houses) are placed or coloured. */
export const PROP_KEYS: ReadonlySet<ParamKey> = new Set<ParamKey>([
  'trees',
  'rocks',
  'houses',
  'cRoof',
  'seaLevel',
  'liquid',
  'temperature',
  'humidity',
  'snowLine',
  'cForest',
  'cTaiga',
  'cJungle',
  'cGrass',
  'cSavanna',
  'cDesert',
  'cRock',
  'cSnow',
]);

export const DEFAULT_PARAMS: PlanetParams = {
  name: 'Terra Nova',
  seed: 1337,
  preset: 'terra',

  size: 1,
  lowPoly: false,
  detail: 0.55,
  heightScale: 0.042,
  continentScale: 1.1,
  mountainHeight: 0.8,
  mountainScale: 1.6,
  roughness: 0.5,
  warp: 0.6,
  terraces: 0,
  craters: 0,

  seaLevel: 0.05,
  temperature: 0,
  humidity: 0,
  snowLine: 0.12,

  cSnow: '#f2f6ff',
  cTundra: '#8c9a78',
  cTaiga: '#2f5e46',
  cForest: '#3f7f34',
  cGrass: '#86b84a',
  cDesert: '#e0b872',
  cSavanna: '#b7ab52',
  cJungle: '#1f6b2c',
  cRock: '#7a6a5e',
  cSand: '#e8d6a0',

  liquid: 'water',
  cShallow: '#1fb8c9',
  cDeep: '#0a2a6b',
  oceanClarity: 0.6,
  foam: 0.6,
  waves: 0.5,
  oceanGlow: 0,

  atmoDensity: 1,
  atmoHeight: 0.22,
  cSky: '#4a86ff',
  haze: 0.3,
  cHaze: '#ffffff',

  cloudCoverage: 0.5,
  cloudOpacity: 0.9,
  cloudScale: 1.6,
  cloudSpeed: 0.5,
  cloudStorms: 0.5,
  cloudAltitude: 0.07,
  cloudShadows: 0.35,
  cirrus: 0.2,
  cCloud: '#ffffff',
  cloudStyle: 'layer',

  trees: 0,
  rocks: 0,
  houses: 0,
  cRoof: '#c8573c',

  cityLights: 0.5,
  cCity: '#ffb04f',
  aurora: 0.3,
  cAurora: '#36ffa0',

  rings: 0,
  ringInner: 1.5,
  ringOuter: 2.4,
  cRing1: '#d9c7a3',
  cRing2: '#8c7a66',

  moons: 1,
  moonSize: 0.16,
  cMoon: '#b9b3aa',

  axialTilt: 18,
  spinSpeed: 0.25,
  sunAzimuth: 66,
  sunElevation: 12,
  sunIntensity: 1.2,
  bloom: 0.6,
  exposure: 1,
};

type NumericKeys = { [K in ParamKey]: PlanetParams[K] extends number ? K : never }[ParamKey];

/** Valid ranges for numeric parameters (used for sanitising and by the UI). */
export const RANGES: Record<NumericKeys, [number, number]> = {
  seed: [0, 4294967295],
  size: [0, 1],
  detail: [0, 1],
  heightScale: [0, 0.2],
  continentScale: [0.3, 3],
  mountainHeight: [0, 1.6],
  mountainScale: [0.4, 4],
  roughness: [0, 1],
  warp: [0, 1.5],
  terraces: [0, 1],
  craters: [0, 1],
  seaLevel: [-0.8, 1],
  temperature: [-0.7, 0.7],
  humidity: [-0.7, 0.7],
  snowLine: [0, 0.5],
  oceanClarity: [0, 1],
  foam: [0, 1],
  waves: [0, 1],
  oceanGlow: [0, 1],
  atmoDensity: [0, 3],
  atmoHeight: [0.05, 0.5],
  haze: [0, 1],
  cloudCoverage: [0, 1],
  cloudOpacity: [0, 1],
  cloudScale: [0.4, 4],
  cloudSpeed: [0, 2],
  cloudStorms: [0, 1],
  cloudAltitude: [0.02, 0.2],
  cloudShadows: [0, 1],
  cirrus: [0, 1],
  trees: [0, 1],
  rocks: [0, 1],
  houses: [0, 1],
  cityLights: [0, 1],
  aurora: [0, 1],
  rings: [0, 1],
  ringInner: [1.15, 2.5],
  ringOuter: [1.4, 4],
  moons: [0, 4],
  moonSize: [0.06, 0.4],
  axialTilt: [0, 90],
  spinSpeed: [0, 2],
  sunAzimuth: [-180, 180],
  sunElevation: [-60, 60],
  sunIntensity: [0.3, 3],
  bloom: [0, 2],
  exposure: [0.3, 2.5],
};

const HEX = /^#[0-9a-f]{6}$/i;

/** Merge arbitrary (possibly untrusted, e.g. from a URL) input onto defaults, clamping everything. */
export function sanitizeParams(raw: object, base: PlanetParams = DEFAULT_PARAMS): PlanetParams {
  const input = raw as Partial<Record<string, unknown>>;
  const out: PlanetParams = { ...base };
  const target = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(base) as ParamKey[]) {
    const value = input[key];
    if (value === undefined) continue;
    const def = base[key];
    if (typeof def === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      const range = (RANGES as Record<string, [number, number] | undefined>)[key];
      target[key] = range ? Math.min(range[1], Math.max(range[0], value)) : value;
    } else if (typeof def === 'boolean' && typeof value === 'boolean') {
      target[key] = value;
    } else if (typeof def === 'string' && typeof value === 'string') {
      if (key.startsWith('c') && key.length > 1 && key[1] === key[1].toUpperCase()) {
        if (HEX.test(value)) target[key] = value.toLowerCase();
      } else if (key === 'liquid') {
        if (value === 'water' || value === 'lava' || value === 'none') target[key] = value;
      } else if (key === 'cloudStyle') {
        if (value === 'layer' || value === 'puffs') target[key] = value;
      } else {
        target[key] = value.slice(0, 40);
      }
    }
  }
  out.seed = Math.floor(out.seed) >>> 0;
  out.moons = Math.round(out.moons);
  if (out.ringOuter < out.ringInner + 0.1) out.ringOuter = Math.min(4, out.ringInner + 0.1);
  return out;
}

/** Parameters the terrain generator needs. */
export interface ShapeParams {
  seed: number;
  size: number;
  lowPoly: boolean;
  detail: number;
  heightScale: number;
  continentScale: number;
  mountainHeight: number;
  mountainScale: number;
  roughness: number;
  warp: number;
  terraces: number;
  craters: number;
  seaLevel: number;
  hasOcean: boolean;
  moons: number;
  /** Upper bound on the mesh frequency, set by the quality level. */
  maxFrequency: number;
}

export function shapeParamsOf(p: PlanetParams, maxFrequency: number): ShapeParams {
  return {
    seed: p.seed,
    size: p.size,
    lowPoly: p.lowPoly,
    detail: p.detail,
    heightScale: p.heightScale,
    continentScale: p.continentScale,
    mountainHeight: p.mountainHeight,
    mountainScale: p.mountainScale,
    roughness: p.roughness,
    warp: p.warp,
    terraces: p.terraces,
    craters: p.craters,
    seaLevel: p.seaLevel,
    hasOcean: p.liquid !== 'none',
    moons: p.moons,
    maxFrequency,
  };
}

/** Feature-frequency multiplier: tiny worlds have fewer, bigger continents, hills and craters. */
export function sizeFrequencyFactor(size: number): number {
  return 0.42 + 0.58 * size;
}

/** Relief actually applied to the mesh (tiny worlds are chunkier). */
export function effectiveHeightScale(s: Pick<ShapeParams, 'heightScale' | 'size'>): number {
  return s.heightScale * (1.6 - 0.6 * s.size);
}

/** Height of a typical tree, in planet radii (props are big on tiny worlds). */
export function propScale(size: number): number {
  return 0.058 - 0.042 * size;
}

/** Icosphere frequency used for the terrain mesh. */
export function terrainFrequency(s: Pick<ShapeParams, 'lowPoly' | 'detail' | 'maxFrequency'>): number {
  const f = s.lowPoly ? 10 + s.detail * 38 : 40 + s.detail * 150;
  return Math.max(8, Math.round(Math.min(f, s.lowPoly ? 64 : s.maxFrequency)));
}

/**
 * Worlds to fly around: the Pocket, Isle and Snowglobe diorama presets with fresh seeds, a few
 * hand-tuned environments per family, and world sizes from tiny to large.
 */
import { Rng, mixSeed, randomSeed } from '../core/rng';
import { sanitizeParams, type PlanetParams } from '../planet/params';
import { getPreset } from '../planet/presets';
import { randomPlanet } from '../planet/randomize';

export type WorldFamily = 'pocket' | 'isle' | 'snowglobe';
export const FAMILIES: readonly WorldFamily[] = ['pocket', 'isle', 'snowglobe'];

export interface World {
  /** The planet as flown (it doesn't spin: the game moves the sun instead). */
  params: PlanetParams;
  /** One line for the HUD, e.g. "Autumn pocket world · large". */
  label: string;
  /** The planet to open in the editor. */
  editorParams: PlanetParams;
}

interface Environment {
  label: string;
  apply(p: PlanetParams, rng: Rng): void;
}

const NOUN: Record<WorldFamily, string> = {
  pocket: 'pocket world',
  isle: 'island world',
  snowglobe: 'winter world',
};

const ENVIRONMENTS: Record<WorldFamily, readonly Environment[]> = {
  pocket: [
    { label: 'Meadow', apply: () => {} },
    {
      label: 'Autumn',
      apply: (p) => {
        p.cForest = '#d9862e';
        p.cJungle = '#b84a2a';
        p.cGrass = '#b3b45a';
        p.cSavanna = '#d1a64e';
        p.cTundra = '#a8a27e';
        p.cTaiga = '#36664a';
        p.temperature -= 0.04;
        p.cloudCoverage = Math.min(0.6, p.cloudCoverage + 0.08);
      },
    },
    {
      label: 'Highland',
      apply: (p, rng) => {
        p.mountainHeight = rng.range(0.9, 1.15);
        p.mountainScale = rng.range(1.5, 2.1);
        p.seaLevel -= 0.08;
        p.temperature -= 0.05;
        p.rocks = 0.6;
      },
    },
  ],
  isle: [
    { label: 'Lagoon', apply: () => {} },
    {
      label: 'Archipelago',
      apply: (p) => {
        p.seaLevel += 0.07;
        p.continentScale *= 1.35;
        p.houses = 0.25;
      },
    },
    {
      label: 'Volcanic',
      apply: (p, rng) => {
        p.mountainHeight = rng.range(0.8, 1.0);
        p.mountainScale = rng.range(1.8, 2.4);
        p.cRock = '#5d5250';
        p.cSand = '#e8d9b0';
        p.rocks = 0.5;
      },
    },
  ],
  snowglobe: [
    { label: 'Winter', apply: () => {} },
    {
      label: 'Frozen sea',
      apply: (p) => {
        p.temperature = -0.48;
        p.seaLevel += 0.06;
        p.trees = 0.7;
        p.aurora = 1;
      },
    },
    {
      label: 'Thaw',
      apply: (p) => {
        p.temperature = -0.12;
        p.snowLine = 0.2;
        p.humidity = 0.3;
        p.cGrass = '#9cc28a';
        p.cTundra = '#b9c9b0';
        p.cForest = '#4a7a52';
      },
    },
  ],
};

const SIZES = [
  { label: 'tiny', min: 0, max: 0.1, weight: 0.45 },
  { label: 'small', min: 0.22, max: 0.42, weight: 0.3 },
  { label: 'large', min: 0.58, max: 0.88, weight: 0.25 },
] as const;

/** The game moves the sun with the ship (see Game), so the planet's own spin only turns the sky. */
const GAME_SPIN = 0;

/** A random world of the given family; `tiny` forces the smallest world size. */
export function makeWorld(family: WorldFamily, tiny = false, seed = randomSeed()): World {
  const rng = new Rng(mixSeed(seed, 0x9a3e));
  const p = { ...randomPlanet(family, seed) };
  const env = rng.pick(ENVIRONMENTS[family]);
  env.apply(p, rng);

  let size: (typeof SIZES)[number] = SIZES[0];
  if (!tiny) {
    let r = rng.next();
    for (const s of SIZES) {
      size = s;
      r -= s.weight;
      if (r <= 0) break;
    }
  }
  p.size = rng.range(size.min, size.max);
  // Fewer, bigger moons look odd from low orbit on large worlds; keep the sky readable.
  p.moonSize = Math.min(p.moonSize, 0.18);
  const base = getPreset(family)!.params;
  const editorParams = sanitizeParams(p, base);
  return {
    params: { ...editorParams, spinSpeed: GAME_SPIN },
    label: `${env.label} ${NOUN[family]} · ${size.label}`,
    editorParams,
  };
}

/** A planet handed over from the editor (share-link params): flown as it is. */
export function customWorld(params: PlanetParams): World {
  return { params: { ...params, spinSpeed: GAME_SPIN }, label: 'Your planet', editorParams: params };
}

import type { PlanetParams } from '../planet/params';
import type { IconName } from './icons';

type KeysOfType<T> = { [K in keyof PlanetParams]: PlanetParams[K] extends T ? K : never }[keyof PlanetParams];
export type NumKey = KeysOfType<number>;
export type ColorKey = Extract<KeysOfType<string>, `c${string}`>;

export type Control =
  | { kind: 'heading'; label: string; hint?: string }
  | { kind: 'slider'; key: NumKey; label: string; min: number; max: number; step: number; fmt?: (v: number) => string }
  | { kind: 'color'; key: ColorKey; label: string }
  | { kind: 'swatches'; items: Array<[ColorKey, string]> }
  | {
      kind: 'segmented';
      key: 'liquid' | 'lowPoly' | 'quality' | 'exportDetail';
      label: string;
      options: Array<{ value: string; label: string }>;
    }
  | { kind: 'seed' }
  | { kind: 'actions'; items: Array<{ id: string; label: string; icon: IconName }> };

export interface Tab {
  id: string;
  label: string;
  icon: IconName;
  controls: Control[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const deg = (v: number) => `${Math.round(v)}°`;
const signed = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
const fixed = (d: number) => (v: number) => v.toFixed(d);
const int = (v: number) => String(Math.round(v));

export const TABS: Tab[] = [
  {
    id: 'terrain',
    label: 'Terrain',
    icon: 'mountain',
    controls: [
      { kind: 'seed' },
      {
        kind: 'segmented',
        key: 'lowPoly',
        label: 'Style',
        options: [
          { value: 'false', label: 'Smooth' },
          { value: 'true', label: 'Low-poly' },
        ],
      },
      { kind: 'slider', key: 'detail', label: 'Mesh detail', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'heightScale', label: 'Relief', min: 0, max: 0.15, step: 0.001, fmt: (v) => `${(v * 100).toFixed(1)}%` },
      { kind: 'slider', key: 'continentScale', label: 'Continent frequency', min: 0.3, max: 3, step: 0.01, fmt: fixed(2) },
      { kind: 'slider', key: 'warp', label: 'Coastline swirl', min: 0, max: 1.5, step: 0.01, fmt: fixed(2) },
      { kind: 'slider', key: 'mountainHeight', label: 'Mountains', min: 0, max: 1.6, step: 0.01, fmt: fixed(2) },
      { kind: 'slider', key: 'mountainScale', label: 'Ridge frequency', min: 0.4, max: 4, step: 0.01, fmt: fixed(2) },
      { kind: 'slider', key: 'roughness', label: 'Hills', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'terraces', label: 'Terraces', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'craters', label: 'Craters', min: 0, max: 1, step: 0.01, fmt: pct },
    ],
  },
  {
    id: 'climate',
    label: 'Climate',
    icon: 'thermo',
    controls: [
      { kind: 'slider', key: 'seaLevel', label: 'Sea level', min: -0.8, max: 1, step: 0.005, fmt: signed },
      { kind: 'slider', key: 'temperature', label: 'Temperature', min: -0.7, max: 0.7, step: 0.01, fmt: signed },
      { kind: 'slider', key: 'humidity', label: 'Humidity', min: -0.7, max: 0.7, step: 0.01, fmt: signed },
      { kind: 'slider', key: 'snowLine', label: 'Ice & snow', min: 0, max: 0.5, step: 0.005, fmt: pct },
      { kind: 'heading', label: 'Biome colours', hint: 'Cold → hot, dry → wet' },
      {
        kind: 'swatches',
        items: [
          ['cSnow', 'Snow'],
          ['cTundra', 'Tundra'],
          ['cTaiga', 'Taiga'],
          ['cGrass', 'Grass'],
          ['cForest', 'Forest'],
          ['cJungle', 'Jungle'],
          ['cSavanna', 'Savanna'],
          ['cDesert', 'Desert'],
          ['cSand', 'Beach'],
          ['cRock', 'Rock'],
        ],
      },
    ],
  },
  {
    id: 'water',
    label: 'Ocean',
    icon: 'drop',
    controls: [
      {
        kind: 'segmented',
        key: 'liquid',
        label: 'Liquid',
        options: [
          { value: 'water', label: 'Water' },
          { value: 'lava', label: 'Lava' },
          { value: 'none', label: 'None' },
        ],
      },
      { kind: 'swatches', items: [['cShallow', 'Shallow'], ['cDeep', 'Deep']] },
      { kind: 'slider', key: 'oceanClarity', label: 'Clarity', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'foam', label: 'Surf', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'waves', label: 'Waves & glint', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'oceanGlow', label: 'Bioluminescence', min: 0, max: 1, step: 0.01, fmt: pct },
    ],
  },
  {
    id: 'sky',
    label: 'Sky',
    icon: 'cloud',
    controls: [
      { kind: 'heading', label: 'Atmosphere' },
      { kind: 'slider', key: 'atmoDensity', label: 'Density', min: 0, max: 3, step: 0.01, fmt: fixed(2) },
      { kind: 'slider', key: 'atmoHeight', label: 'Thickness', min: 0.05, max: 0.5, step: 0.005, fmt: fixed(2) },
      { kind: 'slider', key: 'haze', label: 'Haze', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'swatches', items: [['cSky', 'Scatter'], ['cHaze', 'Haze']] },
      { kind: 'heading', label: 'Clouds' },
      { kind: 'slider', key: 'cloudCoverage', label: 'Coverage', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'cloudOpacity', label: 'Opacity', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'cloudScale', label: 'Size', min: 0.4, max: 4, step: 0.01, fmt: fixed(2) },
      { kind: 'slider', key: 'cloudStorms', label: 'Storms', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'cloudSpeed', label: 'Wind', min: 0, max: 2, step: 0.01, fmt: fixed(2) },
      { kind: 'slider', key: 'cloudAltitude', label: 'Altitude', min: 0.02, max: 0.2, step: 0.001, fmt: fixed(3) },
      { kind: 'slider', key: 'cloudShadows', label: 'Shadows', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'cirrus', label: 'High cirrus', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'swatches', items: [['cCloud', 'Clouds']] },
    ],
  },
  {
    id: 'extras',
    label: 'Extras',
    icon: 'ring',
    controls: [
      { kind: 'heading', label: 'Night side' },
      { kind: 'slider', key: 'cityLights', label: 'City lights', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'aurora', label: 'Aurora', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'swatches', items: [['cCity', 'Cities'], ['cAurora', 'Aurora']] },
      { kind: 'heading', label: 'Rings' },
      { kind: 'slider', key: 'rings', label: 'Ring density', min: 0, max: 1, step: 0.01, fmt: pct },
      { kind: 'slider', key: 'ringInner', label: 'Inner radius', min: 1.15, max: 2.5, step: 0.01, fmt: fixed(2) },
      { kind: 'slider', key: 'ringOuter', label: 'Outer radius', min: 1.4, max: 4, step: 0.01, fmt: fixed(2) },
      { kind: 'swatches', items: [['cRing1', 'Inner'], ['cRing2', 'Outer']] },
      { kind: 'heading', label: 'Moons' },
      { kind: 'slider', key: 'moons', label: 'Moons', min: 0, max: 4, step: 1, fmt: int },
      { kind: 'slider', key: 'moonSize', label: 'Moon size', min: 0.06, max: 0.4, step: 0.005, fmt: fixed(2) },
      { kind: 'swatches', items: [['cMoon', 'Moon']] },
    ],
  },
  {
    id: 'scene',
    label: 'Scene',
    icon: 'sun',
    controls: [
      { kind: 'slider', key: 'sunAzimuth', label: 'Sun direction', min: -180, max: 180, step: 1, fmt: deg },
      { kind: 'slider', key: 'sunElevation', label: 'Sun height', min: -60, max: 60, step: 1, fmt: deg },
      { kind: 'slider', key: 'sunIntensity', label: 'Sunlight', min: 0.3, max: 3, step: 0.01, fmt: fixed(2) },
      { kind: 'slider', key: 'axialTilt', label: 'Axial tilt', min: 0, max: 90, step: 1, fmt: deg },
      { kind: 'slider', key: 'spinSpeed', label: 'Spin', min: 0, max: 2, step: 0.01, fmt: fixed(2) },
      { kind: 'slider', key: 'exposure', label: 'Exposure', min: 0.3, max: 2.5, step: 0.01, fmt: fixed(2) },
      { kind: 'slider', key: 'bloom', label: 'Bloom', min: 0, max: 2, step: 0.01, fmt: fixed(2) },
      {
        kind: 'segmented',
        key: 'quality',
        label: 'Quality',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
      { kind: 'heading', label: 'Use it in a game' },
      {
        kind: 'segmented',
        key: 'exportDetail',
        label: 'Export detail',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
      {
        kind: 'actions',
        items: [
          { id: 'export-glb', label: 'Export .glb', icon: 'cube' },
          { id: 'export-json', label: 'Export settings', icon: 'file' },
          { id: 'copy-link', label: 'Copy link', icon: 'link' },
          { id: 'hide-ui', label: 'Hide interface', icon: 'eye' },
        ],
      },
    ],
  },
];

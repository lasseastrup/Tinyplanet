import { DEFAULT_PARAMS, sanitizeParams, type ParamKey, type PlanetParams } from './params';
import { getPreset } from './presets';

/**
 * Parameter order for share links. APPEND-ONLY: never reorder or remove entries, because
 * links store values by position. Unknown/missing trailing values fall back to defaults.
 */
const SHARE_KEYS: readonly ParamKey[] = [
  'name', 'seed', 'preset', 'lowPoly', 'detail', 'heightScale', 'continentScale', 'mountainHeight',
  'mountainScale', 'roughness', 'warp', 'terraces', 'craters', 'seaLevel', 'temperature', 'humidity',
  'snowLine', 'cSnow', 'cTundra', 'cTaiga', 'cForest', 'cGrass', 'cDesert', 'cSavanna', 'cJungle',
  'cRock', 'cSand', 'liquid', 'cShallow', 'cDeep', 'oceanClarity', 'foam', 'waves', 'oceanGlow',
  'atmoDensity', 'atmoHeight', 'cSky', 'haze', 'cHaze', 'cloudCoverage', 'cloudOpacity', 'cloudScale',
  'cloudSpeed', 'cloudStorms', 'cloudAltitude', 'cloudShadows', 'cirrus', 'cCloud', 'cityLights',
  'cCity', 'aurora', 'cAurora', 'rings', 'ringInner', 'ringOuter', 'cRing1', 'cRing2', 'moons',
  'moonSize', 'cMoon', 'axialTilt', 'spinSpeed', 'sunAzimuth', 'sunElevation', 'sunIntensity', 'bloom',
  'exposure',
  // v1.1: tiny worlds
  'size', 'trees', 'rocks', 'houses', 'cRoof', 'cloudStyle',
];

const FORMAT = '1.';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const isColorKey = (k: string) => /^c[A-Z]/.test(k);

/** Compact, URL-safe and release-stable encoding of every parameter. */
export function encodeParams(p: PlanetParams): string {
  const values = SHARE_KEYS.map((k) => {
    const v = p[k] as unknown;
    if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 10000) / 10000;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string' && isColorKey(k)) return v.replace('#', '');
    return v;
  });
  return FORMAT + toBase64Url(JSON.stringify(values));
}

export function decodeParams(encoded: string): PlanetParams | null {
  try {
    if (encoded.startsWith(FORMAT)) {
      const values = JSON.parse(fromBase64Url(encoded.slice(FORMAT.length))) as unknown[];
      if (!Array.isArray(values)) return null;
      const obj: Record<string, unknown> = {};
      SHARE_KEYS.forEach((k, i) => {
        if (i >= values.length) return;
        let v = values[i];
        if (typeof DEFAULT_PARAMS[k] === 'boolean' && typeof v === 'number') v = v !== 0;
        if (typeof v === 'string' && isColorKey(k)) v = `#${v}`;
        obj[k] = v;
      });
      const base = (typeof obj.preset === 'string' && getPreset(obj.preset)?.params) || DEFAULT_PARAMS;
      return sanitizeParams(obj, base);
    }
    // Legacy links: only the differences from the preset they were made from.
    const obj = JSON.parse(fromBase64Url(encoded)) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return null;
    const base = (typeof obj.preset === 'string' && getPreset(obj.preset)?.params) || DEFAULT_PARAMS;
    return sanitizeParams(obj, base);
  } catch {
    return null;
  }
}

/** Read `#p=...` from a location hash. */
export function paramsFromHash(hash: string): PlanetParams | null {
  const m = /[#&]p=([A-Za-z0-9_.-]+)/.exec(hash);
  return m ? decodeParams(m[1]) : null;
}

export function shareUrl(p: PlanetParams): string {
  const url = new URL(window.location.href);
  url.hash = `p=${encodeParams(p)}`;
  url.search = '';
  return url.toString();
}

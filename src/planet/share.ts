import { DEFAULT_PARAMS, sanitizeParams, type ParamKey, type PlanetParams } from './params';
import { getPreset } from './presets';

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

/** Compact, URL-safe encoding: only parameters that differ from the base preset are stored. */
export function encodeParams(p: PlanetParams): string {
  const base = getPreset(p.preset)?.params ?? DEFAULT_PARAMS;
  const diff: Record<string, unknown> = { preset: p.preset };
  for (const k of Object.keys(p) as ParamKey[]) {
    const v = p[k];
    if (v === base[k]) continue;
    diff[k] = typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10000) / 10000 : v;
  }
  return toBase64Url(JSON.stringify(diff));
}

export function decodeParams(encoded: string): PlanetParams | null {
  try {
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
  const m = /[#&]p=([A-Za-z0-9_-]+)/.exec(hash);
  return m ? decodeParams(m[1]) : null;
}

export function shareUrl(p: PlanetParams): string {
  const url = new URL(window.location.href);
  url.hash = `p=${encodeParams(p)}`;
  url.search = '';
  return url.toString();
}

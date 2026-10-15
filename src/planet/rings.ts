/** Procedural ring profile: banded density with gaps, coloured between two tints. */
import { hexToSrgb, smoothstep } from '../core/math';
import { Simplex3 } from '../core/noise';
import { Rng, mixSeed } from '../core/rng';

export const RING_TEX_SIZE = 512;

/** RGBA8 sRGB pixels; alpha = density. */
export function buildRingProfile(seed: number, color1: string, color2: string): Uint8Array {
  const rng = new Rng(mixSeed(seed, 0x41a65));
  const noise = new Simplex3(rng.next);
  const c1 = hexToSrgb(color1);
  const c2 = hexToSrgb(color2);
  const out = new Uint8Array(RING_TEX_SIZE * 4);

  const gapCount = rng.int(1, 2);
  const gaps = Array.from({ length: gapCount }, () => ({ at: rng.range(0.3, 0.8), width: rng.range(0.012, 0.035) }));
  const bandFreq = rng.range(14, 26);
  const fade = rng.range(0.6, 0.85);

  for (let i = 0; i < RING_TEX_SIZE; i++) {
    const u = i / (RING_TEX_SIZE - 1);
    // Broad ring structure, then ringlets of decreasing amplitude.
    let d = 0.5 + 0.5 * noise.fbm(u * 2.4, 0.5, 0.0, 2);
    d *= 0.72 + 0.28 * noise.noise(u * bandFreq, 2.5, 0.0);
    d *= 0.88 + 0.12 * noise.noise(u * bandFreq * 4.1, 7.5, 0.0);
    // Outer rings are usually fainter.
    d *= 1 - (1 - fade) * smoothstep(0.4, 1.0, u);
    d = Math.max(0, Math.min(1, d * 1.15));
    for (const g of gaps) d *= 0.08 + 0.92 * smoothstep(g.width * 0.3, g.width, Math.abs(u - g.at));
    // Soft fade at the inner and outer edges.
    d *= smoothstep(0.0, 0.08, u) * (1 - smoothstep(0.86, 1.0, u));
    const tint = Math.max(0, Math.min(1, 0.5 + 0.6 * noise.fbm(u * 3.5, 9.1, 0.0, 2) + 0.25 * (u - 0.5)));
    const shade = 0.9 + 0.1 * noise.noise(u * 60, 3.3, 0.0);
    const o = i * 4;
    out[o] = Math.round(Math.min(1, (c1[0] + (c2[0] - c1[0]) * tint) * shade) * 255);
    out[o + 1] = Math.round(Math.min(1, (c1[1] + (c2[1] - c1[1]) * tint) * shade) * 255);
    out[o + 2] = Math.round(Math.min(1, (c1[2] + (c2[2] - c1[2]) * tint) * shade) * 255);
    out[o + 3] = Math.round(d * 255);
  }
  return out;
}

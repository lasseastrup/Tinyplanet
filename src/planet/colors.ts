/**
 * CPU version of the terrain shader's albedo logic, used to bake vertex colours for export
 * (so exported meshes look like the planet in the generator, minus lighting effects).
 * Returns linear RGB.
 */
import { hexToLinear, lerp, smoothstep, srgbToLinear } from '../core/math';
import { biomeColorSrgb } from './biomes';
import type { PlanetParams } from './params';

const LAPSE = 0.45;

export interface ColorContext {
  p: PlanetParams;
  snow: [number, number, number];
  rock: [number, number, number];
  sand: [number, number, number];
  seabed: [number, number, number];
}

export function colorContext(p: PlanetParams): ColorContext {
  const sand = hexToLinear(p.cSand);
  const deep = hexToLinear(p.cDeep);
  const seabed: [number, number, number] = [
    lerp(sand[0] * 0.35, deep[0], 0.45),
    lerp(sand[1] * 0.35, deep[1], 0.45),
    lerp(sand[2] * 0.35, deep[2], 0.45),
  ];
  return { p, snow: hexToLinear(p.cSnow), rock: hexToLinear(p.cRock), sand, seabed };
}

const tmp = [0, 0, 0];

/**
 * @param data   vertex data (height, base temperature, moisture, rockiness)
 * @param slope  1 - dot(normal, up)
 */
export function terrainAlbedo(
  ctx: ColorContext,
  h: number,
  baseTemp: number,
  baseMoist: number,
  rockiness: number,
  slope: number,
  out: number[],
): number[] {
  const p = ctx.p;
  const hasOcean = p.liquid !== 'none';
  const elev = h - p.seaLevel;
  const underwater = hasOcean && elev < 0;
  const temp = baseTemp + p.temperature - Math.max(elev, 0) * LAPSE;
  const moist = Math.min(1, Math.max(0, baseMoist + p.humidity));

  biomeColorSrgb(p, Math.min(0.99, Math.max(0.01, temp)), Math.min(0.99, Math.max(0.01, moist)), tmp);
  let r = srgbToLinear(tmp[0]);
  let g = srgbToLinear(tmp[1]);
  let b = srgbToLinear(tmp[2]);

  const rockAmt = Math.max(smoothstep(0.09, 0.2, slope), smoothstep(0.35, 0.85, rockiness));
  r = lerp(r, ctx.rock[0], rockAmt);
  g = lerp(g, ctx.rock[1], rockAmt);
  b = lerp(b, ctx.rock[2], rockAmt);

  if (hasOcean) {
    const beach = (1 - smoothstep(0.012, 0.045, elev)) * (1 - rockAmt * 0.7);
    r = lerp(r, ctx.sand[0], beach);
    g = lerp(g, ctx.sand[1], beach);
    b = lerp(b, ctx.sand[2], beach);
  }

  let snow = (1 - smoothstep(p.snowLine - 0.025, p.snowLine + 0.025, temp)) * (1 - smoothstep(0.22, 0.5, slope) * 0.8);
  if (underwater) {
    const t = smoothstep(0, 0.3, -elev);
    r = lerp(ctx.sand[0] * 0.9, ctx.seabed[0], t);
    g = lerp(ctx.sand[1] * 0.9, ctx.seabed[1], t);
    b = lerp(ctx.sand[2] * 0.9, ctx.seabed[2], t);
    snow = 0;
  }
  out[0] = lerp(r, ctx.snow[0], snow);
  out[1] = lerp(g, ctx.snow[1], snow);
  out[2] = lerp(b, ctx.snow[2], snow);
  return out;
}

/** Linear RGBA colour of the water surface for a given depth below sea level. */
export function waterColor(p: PlanetParams, depth: number, out: number[]): number[] {
  const shallow = hexToLinear(p.cShallow);
  const deep = hexToLinear(p.cDeep);
  const dz = Math.max(depth, 0);
  const t = 1 - Math.exp(-dz * 7);
  out[0] = lerp(shallow[0], deep[0], t);
  out[1] = lerp(shallow[1], deep[1], t);
  out[2] = lerp(shallow[2], deep[2], t);
  out[3] = Math.min(1, 1 - Math.exp(-dz * lerp(42, 5, p.oceanClarity)) + 0.15);
  return out;
}

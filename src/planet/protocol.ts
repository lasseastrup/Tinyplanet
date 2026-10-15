import type { MoonResult, TerrainResult } from './generator';
import type { ShapeParams } from './params';

export interface GenRequest {
  id: number;
  shape: ShapeParams;
  terrain: boolean;
  moons: boolean;
  preview: boolean;
}

export interface GenResponse {
  id: number;
  ok: boolean;
  preview: boolean;
  ms: number;
  error?: string;
  terrain?: TerrainResult;
  moons?: MoonResult[];
}

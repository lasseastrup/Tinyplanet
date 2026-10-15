import { generateMoons, generateTerrain, type MeshData } from './generator';
import type { GenRequest, GenResponse } from './protocol';

/** Minimal typing for the dedicated worker scope (avoids pulling in the WebWorker lib next to DOM). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<GenRequest>) => void) | null;
  postMessage(message: GenResponse, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerScope;

function transferablesOf(mesh: MeshData, out: Transferable[]): void {
  out.push(mesh.positions.buffer, mesh.normals.buffer, mesh.data.buffer, mesh.ao.buffer);
  if (mesh.indices) out.push(mesh.indices.buffer);
}

ctx.onmessage = (event: MessageEvent<GenRequest>) => {
  const req = event.data;
  const t0 = performance.now();
  try {
    const response: GenResponse = { id: req.id, ok: true, preview: req.preview, ms: 0 };
    const transfer: Transferable[] = [];
    if (req.terrain) {
      response.terrain = generateTerrain(req.shape, req.preview);
      transferablesOf(response.terrain.mesh, transfer);
    }
    if (req.moons) {
      response.moons = generateMoons(req.shape.seed, req.shape.moons, req.shape.lowPoly);
      for (const m of response.moons) transferablesOf(m.mesh, transfer);
    }
    response.ms = performance.now() - t0;
    ctx.postMessage(response, transfer);
  } catch (err) {
    const response: GenResponse = { id: req.id, ok: false, preview: req.preview, ms: 0, error: String(err) };
    ctx.postMessage(response);
  }
};

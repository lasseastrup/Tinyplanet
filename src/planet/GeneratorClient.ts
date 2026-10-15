import type { ShapeParams } from './params';
import type { GenRequest, GenResponse } from './protocol';

export type GenerationListener = (response: GenResponse, request: GenRequest) => void;

/**
 * Runs terrain generation in a Web Worker. At most one request is in flight; newer requests
 * replace any queued one, so rapid slider changes never pile up stale work.
 */
export class GeneratorClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private inFlight: GenRequest | null = null;
  private queued: GenRequest | null = null;
  private listener: GenerationListener = () => {};
  private busyListener: (busy: boolean) => void = () => {};

  constructor() {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<GenResponse>) => this.handle(e.data);
      this.worker.onerror = (e) => {
        console.warn('Generator worker failed, falling back to main thread', e);
        this.worker?.terminate();
        this.worker = null;
        const pending = this.inFlight;
        this.inFlight = null;
        if (pending) this.send(pending);
      };
    } catch (err) {
      console.warn('Web Workers unavailable, generating on the main thread', err);
      this.worker = null;
    }
  }

  onResult(listener: GenerationListener): void {
    this.listener = listener;
  }

  onBusy(listener: (busy: boolean) => void): void {
    this.busyListener = listener;
  }

  get busy(): boolean {
    return this.inFlight !== null;
  }

  request(shape: ShapeParams, what: { terrain: boolean; moons: boolean }, preview: boolean): void {
    if (!what.terrain && !what.moons) return;
    const req: GenRequest = { id: this.nextId++, shape: { ...shape }, terrain: what.terrain, moons: what.moons, preview };
    if (this.inFlight) {
      if (this.queued) {
        req.terrain = req.terrain || this.queued.terrain;
        req.moons = req.moons || this.queued.moons;
      }
      this.queued = req;
      return;
    }
    this.send(req);
  }

  private send(req: GenRequest): void {
    this.inFlight = req;
    this.busyListener(true);
    if (this.worker) {
      this.worker.postMessage(req);
    } else {
      // Fallback: generate on the main thread (lazy-loaded so the worker path stays lean).
      void import('./generator').then(({ generateTerrain, generateMoons }) => {
        const t0 = performance.now();
        const res: GenResponse = { id: req.id, ok: true, preview: req.preview, ms: 0 };
        try {
          if (req.terrain) res.terrain = generateTerrain(req.shape, req.preview);
          if (req.moons) res.moons = generateMoons(req.shape.seed, req.shape.moons, req.shape.lowPoly);
        } catch (err) {
          res.ok = false;
          res.error = String(err);
        }
        res.ms = performance.now() - t0;
        this.handle(res);
      });
    }
  }

  private handle(res: GenResponse): void {
    const req = this.inFlight;
    this.inFlight = null;
    const next = this.queued;
    this.queued = null;
    if (next) this.send(next);
    else this.busyListener(false);
    if (!req || req.id !== res.id) return;
    if (!res.ok) {
      console.error('Planet generation failed:', res.error);
      return;
    }
    this.listener(res, req);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

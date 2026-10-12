/** Client for the compute worker, with a main-thread fallback. */
import type { ComputeRequest, ComputeResponse } from './computeCore';

export type { ComputeRequest, ComputeResponse, ComputeOk, GroundReference } from './computeCore';

export interface ComputeClientOptions {
  /** Never use a Web Worker (tests, unsupported environments). */
  forceMainThread?: boolean;
}

interface Pending {
  req: ComputeRequest;
  resolve: (r: ComputeResponse) => void;
}

export class ComputeClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private latest = 0;
  private workerBroken: boolean;

  constructor(opts: ComputeClientOptions = {}) {
    this.workerBroken = !!opts.forceMainThread || typeof Worker === 'undefined';
  }

  private ensureWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    try {
      const w = new Worker(new URL('./compute.worker.ts', import.meta.url), { type: 'module' });
      w.addEventListener('message', (ev: MessageEvent<{ id: number; res: ComputeResponse }>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        p.resolve(ev.data.res);
      });
      w.addEventListener('error', () => {
        // The worker failed to start or crashed: finish all pending requests on the main thread.
        this.workerBroken = true;
        try {
          w.terminate();
        } catch {
          /* ignore */
        }
        this.worker = null;
        const jobs = Array.from(this.pending.values());
        this.pending.clear();
        for (const j of jobs) void this.runMain(j.req).then(j.resolve);
      });
      this.worker = w;
      return w;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  private async runMain(req: ComputeRequest): Promise<ComputeResponse> {
    const { runCompute } = await import('./computeCore');
    return runCompute(req);
  }

  /**
   * Run a computation. A newer call supersedes older ones: the older promise resolves with
   * `{ ok: false, error: 'superseded' }` so callers can ignore it.
   */
  run(req: ComputeRequest): Promise<ComputeResponse> {
    const id = this.nextId++;
    this.latest = id;
    const worker = this.ensureWorker();
    const finish = (res: ComputeResponse): ComputeResponse =>
      id === this.latest ? res : { ok: false, error: 'superseded' };
    if (!worker) return this.runMain(req).then(finish);
    return new Promise<ComputeResponse>((resolve) => {
      this.pending.set(id, { req, resolve: (r) => resolve(finish(r)) });
      try {
        worker.postMessage({ id, req });
      } catch {
        this.pending.delete(id);
        void this.runMain(req).then((r) => resolve(finish(r)));
      }
    });
  }

  dispose(): void {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.pending.clear();
  }
}

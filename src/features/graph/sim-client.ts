// Page side of the force simulation. One client per graph tab, with its own
// worker. `dispose()` stops the worker. When a worker cannot start, the same
// simulation runs on the main thread in small steps.

import { Sim } from './sim-core';
import type { SimInit, SimParams } from './sim-core';
import type { SimRequest, SimResponse } from './sim-worker';

export type TickHandler = (pos: Float32Array, alpha: number, done: boolean) => void;

export class SimClient {
  private worker: Worker | null = null;
  private broken = false;
  private disposed = false;
  private gen = 0;
  private local: Sim | null = null;
  private localTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private onTick: TickHandler) {}

  /** Starts a new simulation. The arrays are moved to the worker, so do not use them afterwards. */
  init(init: SimInit): void {
    if (this.disposed) return;
    this.gen++;
    this.stopLocal();
    const worker = this.ensureWorker();
    if (worker) {
      const transfer = [init.edges.buffer, init.edgeKind.buffer, init.group.buffer, init.folderParent.buffer, init.radius.buffer, init.pos.buffer] as Transferable[];
      worker.postMessage({ type: 'init', gen: this.gen, init } satisfies SimRequest, transfer);
      return;
    }
    this.local = new Sim(init);
    this.emitLocal(false);
    this.scheduleLocal();
  }

  setParams(params: SimParams, reheat: number): void {
    this.send({ type: 'params', gen: this.gen, params, reheat });
    if (this.local) {
      this.local.setParams(params);
      this.local.reheat(reheat);
      this.scheduleLocal();
    }
  }

  setRadius(radius: Float32Array): void {
    this.send({ type: 'radius', gen: this.gen, radius });
    this.local?.setRadius(radius);
  }

  reheat(alpha: number): void {
    this.send({ type: 'reheat', gen: this.gen, alpha });
    if (this.local) {
      this.local.reheat(alpha);
      this.scheduleLocal();
    }
  }

  pin(index: number, x: number, y: number): void {
    this.send({ type: 'pin', gen: this.gen, index, x, y });
    if (this.local) {
      this.local.pin(index, x, y);
      this.scheduleLocal();
    }
  }

  unpin(index: number): void {
    this.send({ type: 'unpin', gen: this.gen, index });
    if (this.local) {
      this.local.unpin(index);
      this.scheduleLocal();
    }
  }

  /** Stops the simulation (for the tree layouts). Answers of the old run are ignored. */
  stop(): void {
    this.gen++;
    this.send({ type: 'stop', gen: this.gen - 1 });
    this.stopLocal();
  }

  dispose(): void {
    this.disposed = true;
    this.stopLocal();
    this.worker?.terminate();
    this.worker = null;
  }

  private send(msg: SimRequest): void {
    this.worker?.postMessage(msg);
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (this.broken) return null;
    try {
      const worker = new Worker(new URL('./sim-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<SimResponse>) => {
        const m = e.data;
        if (m.gen !== this.gen || this.disposed) return;
        this.onTick(m.pos, m.alpha, m.type === 'end');
      };
      worker.onerror = () => {
        // Start again on the main thread. The page asks for a new `init` when it needs one.
        this.broken = true;
        this.worker?.terminate();
        this.worker = null;
      };
      this.worker = worker;
    } catch {
      this.broken = true;
    }
    return this.worker;
  }

  private emitLocal(done: boolean): void {
    if (this.local) this.onTick(this.local.positions(), this.local.alpha, done);
  }

  private scheduleLocal(): void {
    if (this.localTimer !== undefined || !this.local) return;
    this.localTimer = setTimeout(() => {
      this.localTimer = undefined;
      const sim = this.local;
      if (!sim || this.disposed) return;
      sim.tick();
      const active = sim.active();
      this.emitLocal(!active);
      if (active) this.scheduleLocal();
    }, 16);
  }

  private stopLocal(): void {
    if (this.localTimer !== undefined) clearTimeout(this.localTimer);
    this.localTimer = undefined;
    this.local = null;
  }
}

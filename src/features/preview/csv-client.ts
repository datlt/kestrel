// Parses CSV text. Small texts parse on the main thread. Big texts go to a
// module Web Worker. Each preview has its own client and its own worker, and
// `dispose()` stops the worker.

import { detectDelimiter, parseCsv, type CsvTable, type Delimiter } from './csv-parse';
import type { CsvRequest, CsvResponse } from './csv-worker';

/** Texts shorter than this parse on the main thread. */
const INLINE_LIMIT = 200_000;

interface Pending {
  resolve: (t: CsvTable | null) => void;
  text: string;
  delimiter: Delimiter | 'auto';
  hint?: Delimiter;
}

export class CsvClient {
  private worker: Worker | null = null;
  private workerBroken = false;
  private disposed = false;
  private seq = 0;
  private pending = new Map<number, Pending>();

  /**
   * Resolves with the table, or with null when a newer `parse` call replaced
   * this one (or after `dispose`). The caller must ignore null.
   */
  parse(text: string, delimiter: Delimiter | 'auto', hint?: Delimiter): Promise<CsvTable | null> {
    if (this.disposed) return Promise.resolve(null);
    const id = ++this.seq;
    // A newer request makes the older ones useless.
    for (const [old, p] of this.pending) {
      p.resolve(null);
      this.pending.delete(old);
    }
    if (text.length < INLINE_LIMIT || this.workerBroken) return Promise.resolve(this.parseInline(text, delimiter, hint));
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(this.parseInline(text, delimiter, hint));
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, text, delimiter, hint });
      const msg: CsvRequest = { id, text, delimiter, hint };
      worker.postMessage(msg);
    });
  }

  dispose(): void {
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.disposed = true;
  }

  private parseInline(text: string, delimiter: Delimiter | 'auto', hint?: Delimiter): CsvTable {
    return parseCsv(text, delimiter === 'auto' ? detectDelimiter(text, hint) : delimiter);
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(new URL('./csv-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<CsvResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        p.resolve(e.data.table ?? this.parseInline(p.text, p.delimiter, p.hint));
      };
      worker.onerror = () => this.failWorker();
      this.worker = worker;
    } catch {
      this.workerBroken = true;
    }
    return this.worker;
  }

  /** The worker could not start. Later texts parse on the main thread. */
  private failWorker(): void {
    this.workerBroken = true;
    this.worker?.terminate();
    this.worker = null;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.resolve(this.parseInline(p.text, p.delimiter, p.hint));
  }
}

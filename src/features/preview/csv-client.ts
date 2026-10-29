// Parses and sorts CSV text. Small texts run on the main thread. Big texts go to a
// module Web Worker. Each preview has its own client and its own worker, and
// `dispose()` stops the worker.

import { detectDelimiter, parseCsv, type CsvTable, type Delimiter } from './csv-parse';
import { sortRows } from './csv-sort';
import type { CsvParseRequest, CsvRequest, CsvResponse, CsvSortRequest } from './csv-worker';

/** Texts shorter than this parse on the main thread. */
const INLINE_LIMIT = 200_000;

/** Callbacks while a big text is still parsing. Both are optional. */
export interface ParseProgress {
  /** The first rows of the table. Later calls and the result are longer tables with the same first rows. */
  onPartial?(table: CsvTable): void;
  /** Number of rows read so far. */
  onRows?(rows: number): void;
}

interface Pending {
  resolve: (t: CsvTable | null) => void;
  text: string;
  delimiter: Delimiter | 'auto';
  hint?: Delimiter;
  progress?: ParseProgress;
}

export class CsvClient {
  private worker: Worker | null = null;
  private workerBroken = false;
  private disposed = false;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private sorts = new Map<number, (order: Uint32Array | null) => void>();
  /** Id of the last parse that finished in the worker, and its table here. */
  private held: { id: number; table: CsvTable } | null = null;

  /**
   * Resolves with the table, or with null when a newer `parse` call replaced
   * this one (or after `dispose`). The caller must ignore null.
   */
  parse(text: string, delimiter: Delimiter | 'auto', hint?: Delimiter, progress?: ParseProgress): Promise<CsvTable | null> {
    if (this.disposed) return Promise.resolve(null);
    const id = ++this.seq;
    // A newer request makes the older ones useless.
    for (const [old, p] of this.pending) {
      p.resolve(null);
      this.pending.delete(old);
    }
    this.held = null;
    this.cancelSorts();
    if (text.length < INLINE_LIMIT || this.workerBroken) return Promise.resolve(this.parseInline(text, delimiter, hint));
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(this.parseInline(text, delimiter, hint));
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, text, delimiter, hint, progress });
      const msg: CsvParseRequest = { type: 'parse', id, text, delimiter, hint, partial: !!progress };
      worker.postMessage(msg);
    });
  }

  /**
   * Row numbers `first` up to the end, sorted by `col` (see `sortRows`). Big tables
   * sort in the worker, so the page does not freeze. Resolves with null when a
   * newer parse or sort replaced this one.
   */
  sort(table: CsvTable, text: string, first: number, col: number, desc: boolean): Promise<Uint32Array | null> {
    if (this.disposed) return Promise.resolve(null);
    const held = this.held;
    if (!this.worker || !held || held.table !== table) return Promise.resolve(sortRows(table, text, first, col, desc));
    this.cancelSorts();
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.sorts.set(id, resolve);
      const msg: CsvSortRequest = { type: 'sort', id, tableId: held.id, first, col, desc };
      this.worker!.postMessage(msg);
    });
  }

  dispose(): void {
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
    this.cancelSorts();
    this.worker?.terminate();
    this.worker = null;
    this.held = null;
    this.disposed = true;
  }

  private cancelSorts(): void {
    for (const resolve of this.sorts.values()) resolve(null);
    this.sorts.clear();
  }

  private parseInline(text: string, delimiter: Delimiter | 'auto', hint?: Delimiter): CsvTable {
    return parseCsv(text, delimiter === 'auto' ? detectDelimiter(text, hint) : delimiter);
  }

  private onMessage(msg: CsvResponse): void {
    if (msg.kind === 'sorted') {
      const resolve = this.sorts.get(msg.id);
      this.sorts.delete(msg.id);
      resolve?.(msg.order);
      return;
    }
    if (msg.kind === 'error' && this.sorts.has(msg.id)) {
      const resolve = this.sorts.get(msg.id);
      this.sorts.delete(msg.id);
      resolve?.(null);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.kind === 'partial') {
      p.progress?.onPartial?.(msg.table);
    } else if (msg.kind === 'progress') {
      p.progress?.onRows?.(msg.rows);
    } else if (msg.kind === 'done') {
      this.pending.delete(msg.id);
      this.held = { id: msg.id, table: msg.table };
      p.resolve(msg.table);
    } else {
      this.pending.delete(msg.id);
      p.resolve(this.parseInline(p.text, p.delimiter, p.hint));
    }
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(new URL('./csv-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<CsvResponse>) => this.onMessage(e.data);
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
    this.held = null;
    this.cancelSorts();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.resolve(this.parseInline(p.text, p.delimiter, p.hint));
  }
}

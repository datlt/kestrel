// Web Worker: parses and sorts a big CSV text off the main thread.
//
// Parse: the worker reads the text in steps of whole rows. When the client asked
// for it, it posts the first rows as a partial table soon, then progress (row
// count), then the full table. It looks for a newer request between the steps and
// stops the old parse. Typed arrays move without copying.
//
// The worker keeps the text and the table of the last finished parse, so a sort
// request only needs the column.

import { CsvParser, detectDelimiter, type CsvTable, type Delimiter } from './csv-parse';
import { sortRows } from './csv-sort';

export interface CsvParseRequest {
  type: 'parse';
  id: number;
  text: string;
  delimiter: Delimiter | 'auto';
  hint?: Delimiter;
  /** Post the first rows early, and progress messages. */
  partial: boolean;
}

export interface CsvSortRequest {
  type: 'sort';
  id: number;
  /** Id of the parse whose table to sort. */
  tableId: number;
  first: number;
  col: number;
  desc: boolean;
}

export type CsvRequest = CsvParseRequest | CsvSortRequest;

export type CsvResponse =
  | { kind: 'partial'; id: number; table: CsvTable }
  | { kind: 'progress'; id: number; rows: number }
  | { kind: 'done'; id: number; table: CsvTable }
  | { kind: 'sorted'; id: number; order: Uint32Array | null }
  | { kind: 'error'; id: number; error: string };

/** Characters per step. */
export const STEP_CHARS = 2_000_000;
/** The first partial table is posted after this many characters. */
export const FIRST_PARTIAL_CHARS = 1_000_000;
const PROGRESS_MS = 80;

export function tableBuffers(t: CsvTable): ArrayBuffer[] {
  return [t.rowFirst.buffer, t.fieldStart.buffer, t.fieldEnd.buffer, t.quoted.buffer] as ArrayBuffer[];
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<CsvRequest>) => void) | null;
  postMessage(message: CsvResponse, transfer?: Transferable[]): void;
};

let latestParse = 0;
let held: { id: number; text: string; table: CsvTable } | null = null;

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function parse(req: CsvParseRequest): Promise<void> {
  const { id, text, hint } = req;
  held = null;
  try {
    const d = req.delimiter === 'auto' ? detectDelimiter(text, hint) : req.delimiter;
    const parser = new CsvParser(text, d);
    let postedPartial = false;
    let lastPost = performance.now();
    while (!parser.done) {
      parser.run(parser.position + STEP_CHARS);
      if (parser.done) break;
      // A newer request came in while we waited: this parse is useless.
      await nextTurn();
      if (latestParse !== id) return;
      if (!req.partial) continue;
      if (!postedPartial && parser.position >= FIRST_PARTIAL_CHARS) {
        postedPartial = true;
        const table = parser.snapshot();
        scope.postMessage({ kind: 'partial', id, table }, tableBuffers(table));
        lastPost = performance.now();
      } else if (performance.now() - lastPost >= PROGRESS_MS) {
        scope.postMessage({ kind: 'progress', id, rows: parser.rows });
        lastPost = performance.now();
      }
    }
    const table = parser.snapshot();
    // The worker keeps its own copy for sorting. The main thread gets the original arrays.
    held = { id, text, table: copyTable(table) };
    scope.postMessage({ kind: 'done', id, table }, tableBuffers(table));
  } catch (err) {
    scope.postMessage({ kind: 'error', id, error: err instanceof Error ? err.message : String(err) });
  }
}

function copyTable(t: CsvTable): CsvTable {
  return { ...t, rowFirst: t.rowFirst.slice(), fieldStart: t.fieldStart.slice(), fieldEnd: t.fieldEnd.slice(), quoted: t.quoted.slice() };
}

scope.onmessage = (e) => {
  const req = e.data;
  if (req.type === 'parse') {
    latestParse = req.id;
    void parse(req);
    return;
  }
  const h = held;
  if (!h || h.id !== req.tableId) {
    scope.postMessage({ kind: 'sorted', id: req.id, order: null });
    return;
  }
  try {
    const order = sortRows(h.table, h.text, req.first, req.col, req.desc);
    scope.postMessage({ kind: 'sorted', id: req.id, order }, [order.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ kind: 'error', id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
};

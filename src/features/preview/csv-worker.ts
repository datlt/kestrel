// Web Worker: parses a big CSV text off the main thread.
// Message in: { id, text, delimiter ('auto' or a delimiter), hint }.
// Message out: { id, table }. The typed arrays move without copying.

import { detectDelimiter, parseCsv, type CsvTable, type Delimiter } from './csv-parse';

export interface CsvRequest {
  id: number;
  text: string;
  delimiter: Delimiter | 'auto';
  hint?: Delimiter;
}

export interface CsvResponse {
  id: number;
  table?: CsvTable;
  error?: string;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<CsvRequest>) => void) | null;
  postMessage(message: CsvResponse, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const { id, text, delimiter, hint } = e.data;
  try {
    const d = delimiter === 'auto' ? detectDelimiter(text, hint) : delimiter;
    const table = parseCsv(text, d);
    scope.postMessage({ id, table }, [
      table.rowFirst.buffer,
      table.fieldStart.buffer,
      table.fieldEnd.buffer,
      table.quoted.buffer,
    ]);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};

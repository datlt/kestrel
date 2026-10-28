// What a console (or the bottom panel) shows after statements ran: result
// tables and the Messages list. No DOM code, so tests can import it.

import type { DbExportResult, DbResult } from '../../ipc/db';
import { formatDuration, plural, rowCountNote } from './grid-data';
import { oneLine } from './split';

/**
 * What a result needs to write ALL rows of its statement to a CSV file. The
 * runner that produced the result provides it. It uses the session of that runner.
 */
export interface ResultExporter {
  /** Runs `sql` again and writes every row to `path`. Rejects with code `cancelled` after `cancel()`. */
  exportAll(sql: string, path: string): Promise<DbExportResult>;
  /** Stops a running `exportAll`. */
  cancel(): void;
  /** The session is busy, so a new export cannot start now. */
  busy(): boolean;
}

export interface ResultEntry {
  id: number;
  title: string;
  sql: string;
  result: DbResult;
  /** Set when the result came from a runner. Without it, only the rows in memory can be saved. */
  exporter?: ResultExporter;
}

export type MessageLevel = 'ok' | 'info' | 'warn' | 'error';

export interface MessageEntry {
  id: number;
  /** ms since 1970. */
  time: number;
  /** The statement (one line), or null for general messages. */
  sql: string | null;
  /** Where the statement starts: `line 12`. */
  where: string | null;
  level: MessageLevel;
  /** Rows, affected rows or the error text. */
  text: string;
  elapsedMs: number | null;
}

const MAX_MESSAGES = 500;
export const MAX_RESULT_TABS = 50;

export class ResultsStore {
  results: ResultEntry[] = [];
  messages: MessageEntry[] = [];
  /** Which tab to show after the last change. */
  focus: 'results' | 'messages' = 'messages';
  /** Increases at each `beginRun`, so a pane knows that old grids can go. */
  runId = 0;
  /** Increases when a run ends, so a pane knows it should pick a tab. */
  focusSeq = 0;
  /** A short label for the panel header, for example the connection name. */
  title = '';
  private nextId = 1;
  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of [...this.listeners]) fn();
  }

  /** A new run starts: old result tables go, messages stay. */
  beginRun(title?: string) {
    this.results = [];
    this.runId++;
    if (title !== undefined) this.title = title;
    this.emit();
  }

  addResult(sql: string, result: DbResult, exporter?: ResultExporter): boolean {
    if (this.results.length >= MAX_RESULT_TABS) return false;
    const n = this.results.length + 1;
    this.results.push({ id: this.nextId++, title: `Result ${n}`, sql, result, exporter });
    this.emit();
    return true;
  }

  addMessage(m: Omit<MessageEntry, 'id' | 'time'> & { time?: number }) {
    this.messages.push({ ...m, id: this.nextId++, time: m.time ?? Date.now() });
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.emit();
  }

  /** Call after a run: shows the first result table, or Messages when there is none or an error happened. */
  finishRun(hadError: boolean) {
    this.focus = !hadError && this.results.length > 0 ? 'results' : 'messages';
    this.focusSeq++;
    this.emit();
  }

  clearMessages() {
    this.messages = [];
    this.emit();
  }
}

/** Text for the Messages tab after one result of a statement. */
export function resultMessage(r: DbResult): { level: MessageLevel; text: string } {
  const parts: string[] = [];
  if (r.kind === 'rows') {
    parts.push(rowCountNote(r.rows.length, r.truncated));
  } else {
    parts.push(`${plural(r.affectedRows, 'row')} affected`);
    if (r.lastInsertId) parts.push(`last insert id ${r.lastInsertId}`);
    if (r.info) parts.push(r.info.trim());
  }
  if (r.warnings > 0) parts.push(plural(r.warnings, 'warning'));
  return { level: r.warnings > 0 ? 'warn' : 'ok', text: parts.join(', ') };
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function messageSql(sql: string | null): string {
  return sql ? oneLine(sql, 120) : '';
}

export { formatDuration };

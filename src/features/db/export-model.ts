// Pure helpers for "Download CSV". No DOM and no IPC code, so tests can import it.

import type { DbColumn } from '../../ipc/db';
import { singleTable } from './grid-data';
import { classify } from './split';

/** Characters that no common file system accepts in a file name. */
const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Makes a text safe for a file name. Dots at the start go too, so the file is not hidden. */
export function safeFileName(text: string): string {
  const t = text.replace(BAD_NAME_CHARS, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80);
  return t;
}

/** The first part of the file name: the table of the result, or "query" when there is no single table. */
export function exportBaseName(columns: readonly DbColumn[]): string {
  const table = singleTable(columns);
  return (table && safeFileName(table)) || 'query';
}

/** `<base>-YYYYMMDD-HHMMSS.csv` in local time. */
export function csvFileName(base: string, now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${safeFileName(base) || 'query'}-${stamp}.csv`;
}

/**
 * "All rows" runs the statement again on the server. It is allowed only when the
 * result was cut off and the statement only reads data (SELECT, SHOW, ...).
 * A statement that writes must never run a second time.
 */
export function canExportAll(sql: string, truncated: boolean): boolean {
  return truncated && classify(sql).kind === 'read';
}

export const ALL_ROWS_LABEL = 'All rows (runs the query again)';

export const shownRowsLabel = (n: number) => `Rows shown (${n.toLocaleString('en-US')})`;

/** The Windows, macOS or Linux name of "show this file in the file manager". */
export function revealLabel(platform: 'macos' | 'windows' | 'linux' | string): string {
  if (platform === 'macos') return 'Reveal in Finder';
  if (platform === 'windows') return 'Reveal in Explorer';
  return 'Show in Folder';
}

/** Last part of a path, with `/` or `\` as the separator. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}

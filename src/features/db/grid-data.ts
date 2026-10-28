// Pure helpers for result grids: sorting, copy formats, CSV text, sizes.
// No DOM code, so tests can import it.

import type { DbColumn, DbValue } from '../../ipc/db';

// --- Sorting ---------------------------------------------------------------

const INT_TEXT = /^-?\d+$/;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Compares two numbers given as text. Big integers keep full precision. */
export function compareNumberText(a: string, b: string): number {
  if (INT_TEXT.test(a) && INT_TEXT.test(b) && (a.length > 15 || b.length > 15)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = Number(a);
  const y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return collator.compare(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const NUMBER_LIKE = /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/;

/** NULL sorts first (ascending). Numbers compare as numbers, other text by natural order. */
export function compareValues(a: DbValue, b: DbValue, numeric: boolean): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  if (numeric || (NUMBER_LIKE.test(a) && NUMBER_LIKE.test(b))) return compareNumberText(a, b);
  return collator.compare(a, b);
}

/**
 * Row order for sorting by one column. The sort is stable: equal values keep
 * their original order, also when `desc` is true.
 */
export function sortOrder(rows: readonly DbValue[][], col: number, numeric: boolean, desc: boolean): Uint32Array {
  const idx = Array.from({ length: rows.length }, (_, i) => i);
  const dir = desc ? -1 : 1;
  idx.sort((x, y) => {
    const c = compareValues(rows[x][col], rows[y][col], numeric) * dir;
    return c !== 0 ? c : x - y;
  });
  return Uint32Array.from(idx);
}

// --- Display -----------------------------------------------------------------

export const MAX_CELL_CHARS = 300;

/** Text of a cell in the grid (cut when long). NULL is shown by the grid itself. */
export function cellText(v: DbValue): string {
  if (v === null) return 'NULL';
  return v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) + '…' : v;
}

export function columnTooltip(c: DbColumn): string {
  const parts = [c.name, `${c.type}${c.nullable ? '' : ' NOT NULL'}`];
  if (c.table) parts.push(`from ${c.table}`);
  return parts.join('\n');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "1,000 rows" or "1,000 rows (truncated at 1,000)". */
export function rowCountNote(rows: number, truncated: boolean): string {
  return truncated ? `${plural(rows, 'row')} (truncated at ${rows.toLocaleString('en-US')})` : plural(rows, 'row');
}

/**
 * Widths from a sample of the first rows. `measure` returns the pixel width of
 * a text (the grid passes a canvas measure function).
 */
export function autoWidths(
  columns: readonly DbColumn[],
  rows: readonly DbValue[][],
  measure: (text: string) => number,
  opts: { min?: number; max?: number; sample?: number; pad?: number } = {},
): number[] {
  const { min = 60, max = 360, sample = 100, pad = 22 } = opts;
  const n = Math.min(rows.length, sample);
  return columns.map((c, ci) => {
    let w = measure(c.name) + 20;
    for (let r = 0; r < n; r++) {
      const v = rows[r][ci];
      const text = v === null ? 'NULL' : v.length > 80 ? v.slice(0, 80) : v;
      w = Math.max(w, measure(text.replace(/[\r\n\t]+/g, ' ')));
    }
    return Math.min(max, Math.max(min, Math.ceil(w + pad)));
  });
}

// --- Copy formats ----------------------------------------------------------------

function tsvField(v: DbValue): string {
  if (v === null) return '';
  return /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toTsv(columns: readonly DbColumn[], rows: readonly DbValue[][], withHeader = false): string {
  const lines: string[] = [];
  if (withHeader) lines.push(columns.map((c) => tsvField(c.name)).join('\t'));
  for (const r of rows) lines.push(r.map(tsvField).join('\t'));
  return lines.join('\n');
}

/** Column names that are unique: the second `id` becomes `id_2`. */
export function uniqueNames(columns: readonly DbColumn[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    return n === 1 ? c.name : `${c.name}_${n}`;
  });
}

const PLAIN_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function jsonValue(v: DbValue, c: DbColumn): unknown {
  if (v === null) return null;
  if (c.numeric && PLAIN_NUMBER.test(v)) {
    const n = Number(v);
    // Keep text when a number would lose digits.
    if (Number.isFinite(n) && String(n) === v.replace(/^(-?)0+(?=\d)/, '$1')) return n;
    if (Number.isSafeInteger(n) && INT_TEXT.test(v)) return n;
    return v;
  }
  if (c.type.toUpperCase() === 'JSON') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

export function toJson(columns: readonly DbColumn[], rows: readonly DbValue[][]): string {
  const names = uniqueNames(columns);
  const list = rows.map((r) => {
    const o: Record<string, unknown> = {};
    names.forEach((name, i) => {
      o[name] = jsonValue(r[i], columns[i]);
    });
    return o;
  });
  return JSON.stringify(list, null, 2);
}

export function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

export function quoteString(s: string): string {
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case "'": out += "''"; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\0': out += '\\0'; break;
      case '\x1a': out += '\\Z'; break;
      default: out += ch;
    }
  }
  return `'${out}'`;
}

const SQL_NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const HEX_BLOB = /^0x[0-9a-fA-F]*$/;

function sqlLiteral(v: DbValue, c: DbColumn): string {
  if (v === null) return 'NULL';
  if (c.binary) return HEX_BLOB.test(v) ? (v === '0x' ? "''" : v) : 'NULL /* binary value was cut */';
  if (c.numeric && SQL_NUMBER.test(v)) return v;
  return quoteString(v);
}

/** The table that all columns come from, or null. */
export function singleTable(columns: readonly DbColumn[]): string | null {
  const t = columns[0]?.table ?? null;
  return t && columns.every((c) => c.table === t) ? t : null;
}

/** One INSERT statement for each row. */
export function toInsert(table: string | null, columns: readonly DbColumn[], rows: readonly DbValue[][]): string {
  const target = quoteIdent(table ?? 'table_name');
  const names = columns.map((c) => quoteIdent(c.name)).join(', ');
  return rows
    .map((r) => `INSERT INTO ${target} (${names}) VALUES (${r.map((v, i) => sqlLiteral(v, columns[i])).join(', ')});`)
    .join('\n');
}

// --- CSV --------------------------------------------------------------------------

function csvField(v: DbValue): string {
  if (v === null) return '';
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV text with `\n` line breaks (the writer converts them to the file line ending). */
export function toCsv(columns: readonly DbColumn[], rows: readonly DbValue[][]): string {
  const lines: string[] = [columns.map((c) => csvField(c.name)).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return lines.join('\n') + '\n';
}

// --- Value viewer -------------------------------------------------------------------

/** Pretty JSON text, or null when the text is not a JSON object or array. */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

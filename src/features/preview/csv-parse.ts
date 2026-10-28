// CSV parser (RFC 4180) and delimiter detection. No DOM code: it also runs in a
// Web Worker and in tests.
//
// The table does not copy every cell into a string. It keeps the start and end
// position of each field in the source text, in typed arrays. This is fast for
// files with millions of cells, and the arrays move between threads without copying.

export type Delimiter = ',' | ';' | '\t' | '|';
export const DELIMITERS: Delimiter[] = [',', ';', '\t', '|'];

export interface CsvTable {
  delimiter: Delimiter;
  rows: number;
  /** Widest row. Shorter rows have empty cells at the end. */
  cols: number;
  /** The fields of row `r` are the numbers `rowFirst[r]` up to `rowFirst[r + 1] - 1`. Length is `rows + 1`. */
  rowFirst: Uint32Array;
  /** Position of each field in the text (UTF-16 index). A quoted field includes its quotes. */
  fieldStart: Uint32Array;
  fieldEnd: Uint32Array;
  /** 1 when the field starts with a quote. Then `unquote` must run on the text. */
  quoted: Uint8Array;
}

/** Delimiter that a file extension suggests, or undefined. */
export function delimiterForPath(path: string): Delimiter | undefined {
  const m = /\.([^./\\]+)$/.exec(path);
  const ext = m ? m[1].toLowerCase() : '';
  if (ext === 'tsv' || ext === 'tab') return '\t';
  if (ext === 'psv') return '|';
  if (ext === 'csv') return ',';
  return undefined;
}

class Grow {
  data: Uint32Array;
  length = 0;
  constructor(initial: number) {
    this.data = new Uint32Array(initial);
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  done(): Uint32Array {
    return this.data.slice(0, this.length);
  }
}

const QUOTE = 34;
const LF = 10;
const CR = 13;

/**
 * Parses `text`. Handles quotes, `""` escapes, newlines inside quotes, CRLF, LF and CR
 * line ends, and a BOM at the start. Empty lines are skipped.
 * `maxRows` stops early (used for delimiter detection).
 */
export function parseCsv(text: string, delimiter: Delimiter, maxRows: number = Infinity): CsvTable {
  const n = text.length;
  const d = delimiter.charCodeAt(0);
  const guess = Math.min(1 << 16, Math.max(64, n >> 3));
  const starts = new Grow(guess);
  const ends = new Grow(guess);
  const rowFirst = new Grow(Math.max(16, guess >> 3));
  let flagBuf = new Uint8Array(guess);
  let fieldCount = 0;
  let rows = 0;
  let cols = 0;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const addField = (s: number, e: number, q: number): void => {
    starts.push(s);
    ends.push(e);
    if (fieldCount === flagBuf.length) {
      const next = new Uint8Array(flagBuf.length * 2);
      next.set(flagBuf);
      flagBuf = next;
    }
    flagBuf[fieldCount++] = q;
  };

  while (i < n && rows < maxRows) {
    let c = text.charCodeAt(i);
    if (c === LF || c === CR) {
      i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
      continue;
    }
    rowFirst.push(fieldCount);
    const first = fieldCount;
    for (;;) {
      const start = i;
      let q = 0;
      if (text.charCodeAt(i) === QUOTE) {
        q = 1;
        i++;
        for (;;) {
          const close = text.indexOf('"', i);
          if (close < 0) {
            i = n;
            break;
          }
          if (text.charCodeAt(close + 1) === QUOTE) {
            i = close + 2;
            continue;
          }
          i = close + 1;
          break;
        }
        // Text after the closing quote is not valid CSV. Keep it as part of the field.
        while (i < n) {
          c = text.charCodeAt(i);
          if (c === d || c === LF || c === CR) break;
          i++;
        }
      } else {
        while (i < n) {
          c = text.charCodeAt(i);
          if (c === d || c === LF || c === CR) break;
          i++;
        }
      }
      addField(start, i, q);
      if (i >= n) break;
      c = text.charCodeAt(i);
      if (c === d) {
        i++;
        if (i >= n) {
          // The file ends with a delimiter: one more empty field.
          addField(i, i, 0);
          break;
        }
        continue;
      }
      i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
      break;
    }
    rows++;
    if (fieldCount - first > cols) cols = fieldCount - first;
  }
  rowFirst.push(fieldCount);
  return {
    delimiter,
    rows,
    cols,
    rowFirst: rowFirst.done(),
    fieldStart: starts.done(),
    fieldEnd: ends.done(),
    quoted: flagBuf.slice(0, fieldCount),
  };
}

/** Removes the quotes of a field and turns `""` into `"`. */
export function unquote(raw: string): string {
  let out = '';
  let inQuote = false;
  for (let k = 0; k < raw.length; k++) {
    const ch = raw[k];
    if (ch === '"') {
      if (inQuote && raw[k + 1] === '"') {
        out += '"';
        k++;
      } else {
        inQuote = !inQuote;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/** Number of fields in row `r`. */
export function rowWidth(t: CsvTable, r: number): number {
  return t.rowFirst[r + 1] - t.rowFirst[r];
}

/** Text of one cell. Empty when the row is shorter than `col`. */
export function cellText(t: CsvTable, text: string, r: number, col: number): string {
  const f = t.rowFirst[r] + col;
  if (col >= rowWidth(t, r)) return '';
  const raw = text.slice(t.fieldStart[f], t.fieldEnd[f]);
  return t.quoted[f] ? unquote(raw) : raw;
}

/** All cells of one row. */
export function rowCells(t: CsvTable, text: string, r: number): string[] {
  const out: string[] = [];
  for (let c = 0; c < rowWidth(t, r); c++) out.push(cellText(t, text, r, c));
  return out;
}

/**
 * Looks at the first lines and picks the delimiter that gives the same number
 * of columns (at least 2) in most rows. `hint` (from the file extension) wins
 * when it fits almost as well. Returns `hint` or a comma when nothing fits.
 */
export function detectDelimiter(text: string, hint?: Delimiter): Delimiter {
  const cut = text.length > 100_000;
  const sample = cut ? text.slice(0, 100_000) : text;
  let best: Delimiter = hint ?? ',';
  let bestKey = -1;
  for (const d of DELIMITERS) {
    const t = parseCsv(sample, d, 30);
    // The last row of a cut sample may be incomplete.
    const rows = cut && t.rows > 1 ? t.rows - 1 : t.rows;
    if (rows === 0) continue;
    const freq = new Map<number, number>();
    for (let r = 0; r < rows; r++) {
      const w = rowWidth(t, r);
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    let width = 0;
    let count = 0;
    for (const [w, k] of freq) {
      if (w >= 2 && (k > count || (k === count && w > width))) {
        width = w;
        count = k;
      }
    }
    if (width < 2) continue;
    // A quoted field that does not end with a quote means this delimiter is probably wrong.
    let bad = 0;
    for (let f = 0; f < t.quoted.length; f++) {
      if (t.quoted[f] && (t.fieldEnd[f] - t.fieldStart[f] < 2 || sample[t.fieldEnd[f] - 1] !== '"')) bad++;
    }
    const key = Math.round((Math.max(0, count - bad) / rows) * 100) * 1000 + Math.min(width, 999) + (d === hint ? 5000 : 0);
    if (key > bestKey) {
      bestKey = key;
      best = d;
    }
  }
  return best;
}

/** Spreadsheet name of a column: 0 gives `A`, 25 gives `Z`, 26 gives `AA`. */
export function columnLabel(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

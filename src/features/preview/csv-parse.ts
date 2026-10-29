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
 * Parses a text in steps. `run` parses whole rows only: it checks the limit at
 * the start of a row, so a quoted field with a newline never splits at a step
 * border. `snapshot` copies what is parsed so far into a table. Rows never change
 * after they are parsed, so a snapshot is the first rows of the final table.
 */
export class CsvParser {
  private readonly text: string;
  private readonly delimiter: Delimiter;
  private readonly n: number;
  private readonly d: number;
  private readonly starts: Grow;
  private readonly ends: Grow;
  private readonly rowFirst: Grow;
  private flagBuf: Uint8Array;
  private fieldCount = 0;
  private rowCount = 0;
  private colCount = 0;
  private i: number;

  constructor(text: string, delimiter: Delimiter) {
    this.text = text;
    this.delimiter = delimiter;
    this.n = text.length;
    this.d = delimiter.charCodeAt(0);
    const guess = Math.min(1 << 16, Math.max(64, this.n >> 3));
    this.starts = new Grow(guess);
    this.ends = new Grow(guess);
    this.rowFirst = new Grow(Math.max(16, guess >> 3));
    this.flagBuf = new Uint8Array(guess);
    this.i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  }

  get rows(): number {
    return this.rowCount;
  }

  /** Position in the text where the next row starts. */
  get position(): number {
    return this.i;
  }

  get done(): boolean {
    return this.i >= this.n;
  }

  private addField(s: number, e: number, q: number): void {
    this.starts.push(s);
    this.ends.push(e);
    if (this.fieldCount === this.flagBuf.length) {
      const next = new Uint8Array(this.flagBuf.length * 2);
      next.set(this.flagBuf);
      this.flagBuf = next;
    }
    this.flagBuf[this.fieldCount++] = q;
  }

  /**
   * Parses rows until the position reaches `until` (checked at the start of each
   * row), the text ends, or `rows` reaches `maxRows`.
   */
  run(until: number = Infinity, maxRows: number = Infinity): void {
    const { text, n, d } = this;
    let i = this.i;
    while (i < n && i < until && this.rowCount < maxRows) {
      let c = text.charCodeAt(i);
      if (c === LF || c === CR) {
        i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
        continue;
      }
      this.rowFirst.push(this.fieldCount);
      const first = this.fieldCount;
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
        this.addField(start, i, q);
        if (i >= n) break;
        c = text.charCodeAt(i);
        if (c === d) {
          i++;
          if (i >= n) {
            // The file ends with a delimiter: one more empty field.
            this.addField(i, i, 0);
            break;
          }
          continue;
        }
        i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
        break;
      }
      this.rowCount++;
      if (this.fieldCount - first > this.colCount) this.colCount = this.fieldCount - first;
    }
    this.i = i;
  }

  /** The rows parsed so far as a table. It copies the arrays, so parsing can go on. */
  snapshot(): CsvTable {
    const rowFirst = new Uint32Array(this.rowFirst.length + 1);
    rowFirst.set(this.rowFirst.data.subarray(0, this.rowFirst.length));
    rowFirst[this.rowFirst.length] = this.fieldCount;
    return {
      delimiter: this.delimiter,
      rows: this.rowCount,
      cols: this.colCount,
      rowFirst,
      fieldStart: this.starts.done(),
      fieldEnd: this.ends.done(),
      quoted: this.flagBuf.slice(0, this.fieldCount),
    };
  }
}

/**
 * Parses `text`. Handles quotes, `""` escapes, newlines inside quotes, CRLF, LF and CR
 * line ends, and a BOM at the start. Empty lines are skipped.
 * `maxRows` stops early (used for delimiter detection).
 */
export function parseCsv(text: string, delimiter: Delimiter, maxRows: number = Infinity): CsvTable {
  const parser = new CsvParser(text, delimiter);
  parser.run(Infinity, maxRows);
  return parser.snapshot();
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

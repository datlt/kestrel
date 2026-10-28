// Small pure helpers for the search feature.

export interface GotoQuery {
  /** The text before `:line`. */
  name: string;
  line?: number;
  column?: number;
}

/** Splits `name:120` or `name:120:5` into name, line and column. */
export function parseGoto(query: string): GotoQuery {
  const m = /^(.*?):(\d+)(?::(\d+))?\s*$/.exec(query);
  if (m) {
    return {
      name: m[1].trim(),
      line: Math.max(1, Number(m[2])),
      column: m[3] ? Math.max(1, Number(m[3])) : undefined,
    };
  }
  // A trailing colon is a line number that the user did not type yet.
  return { name: query.replace(/:\s*$/, '').trim() };
}

/** Splits `*.ts, src/{a,b}` at commas that are not inside braces. */
export function splitGlobs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Cuts `text` into plain and highlighted parts. Ranges are `[start, end)` and sorted. */
export function highlightSegments(text: string, ranges: [number, number][]): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    const start = Math.max(s, pos);
    const end = Math.min(e, text.length);
    if (start >= end) continue;
    if (start > pos) out.push({ text: text.slice(pos, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    pos = end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

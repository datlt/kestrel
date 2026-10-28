// Plans and applies a replace on one text.
//
// The search result tells us where a match was (line and column). The text
// may have changed since then, so we find every match again in the current
// text and only replace matches that are still there. A match that moved to
// another line (lines were added above it) is found again by its text.

import { matchesInLine, replacementFor, type ReplaceOptions } from './pattern';

/** One match from the search result. */
export interface Target {
  /** 1-based line. */
  line: number;
  /** 0-based column in the line (UTF-16 units). */
  col: number;
  /** The matched text, as the search saw it. */
  text: string;
  /** The line text of the result row. Used to find a moved match. */
  lineText?: string;
  /** Excluded matches are not replaced. */
  excluded: boolean;
}

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

export interface Plan {
  edits: Edit[];
  /** Included targets that are not in the text any more. */
  missed: number;
}

/** How far (in lines) we look for a match that moved. */
export const MOVE_RANGE = 200;

interface LineInfo {
  start: number;
  text: string;
  matches: RegExpExecArray[];
  used: Set<number>;
}

export function planEdits(doc: string, targets: readonly Target[], re: RegExp, opts: ReplaceOptions): Plan {
  const lines = doc.split('\n');
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const cache = new Map<number, LineInfo>();
  const info = (line: number): LineInfo | null => {
    if (line < 1 || line > lines.length) return null;
    let li = cache.get(line);
    if (!li) {
      const text = lines[line - 1];
      li = { start: starts[line - 1], text, matches: matchesInLine(text, re), used: new Set() };
      cache.set(line, li);
    }
    return li;
  };

  /** Finds the current match for a target and marks it as used. */
  const resolve = (t: Target): { li: LineInfo; index: number } | null => {
    const same = info(t.line);
    if (same) {
      // 1. The match is where the search saw it.
      let i = same.matches.findIndex((m, k) => !same.used.has(k) && m.index === t.col && m[0] === t.text);
      if (i >= 0) return { li: same, index: i };
      // 2. The same text is somewhere else in that line. Take the nearest.
      let best = -1;
      same.matches.forEach((m, k) => {
        if (same.used.has(k) || m[0] !== t.text) return;
        if (best < 0 || Math.abs(m.index - t.col) < Math.abs(same.matches[best].index - t.col)) best = k;
      });
      i = best;
      if (i >= 0) return { li: same, index: i };
    }
    // 3. The line moved. Look at the lines around it for the same line text.
    const want = t.lineText?.trim();
    if (!want) return null;
    for (let d = 1; d <= MOVE_RANGE; d++) {
      for (const line of [t.line + d, t.line - d]) {
        const li = info(line);
        if (!li || !li.text.includes(want)) continue;
        const k = li.matches.findIndex((m, idx) => !li.used.has(idx) && m[0] === t.text);
        if (k >= 0) return { li, index: k };
      }
    }
    return null;
  };

  const edits: Edit[] = [];
  let missed = 0;
  // Targets are in file order, so a moved match claims the first free one.
  for (const t of targets) {
    const hit = resolve(t);
    if (!hit) {
      if (!t.excluded) missed++;
      continue;
    }
    hit.li.used.add(hit.index);
    if (t.excluded) continue;
    const m = hit.li.matches[hit.index];
    const from = hit.li.start + m.index;
    edits.push({ from, to: from + m[0].length, insert: replacementFor(m, opts) });
  }
  edits.sort((a, b) => a.from - b.from);
  return { edits, missed };
}

/** Applies edits that do not overlap. Positions refer to `doc`. */
export function applyEdits(doc: string, edits: readonly Edit[]): string {
  let out = '';
  let pos = 0;
  for (const e of [...edits].sort((a, b) => a.from - b.from)) {
    if (e.from < pos) continue;
    out += doc.slice(pos, e.from) + e.insert;
    pos = e.to;
  }
  return out + doc.slice(pos);
}

/**
 * The new text for each range of a result row, for the "old struck, new
 * shown" display. `text` is the line text of the row. When the regex finds no
 * match at the range, the matched text alone is replaced.
 */
export function previewReplacements(
  text: string,
  ranges: readonly [number, number][],
  re: RegExp,
  opts: ReplaceOptions,
): string[] {
  const found = matchesInLine(text, re);
  return ranges.map(([s, e]) => {
    const m = found.find((x) => x.index === s && x[0].length === e - s);
    if (m) return replacementFor(m, opts);
    const alone = matchesInLine(text.slice(s, e), re)[0];
    return alone ? replacementFor(alone, opts) : text.slice(s, e);
  });
}

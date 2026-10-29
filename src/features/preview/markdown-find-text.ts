// Text logic of the find bar in the Markdown preview. No DOM here, so tests run in node.
// The DOM part (text nodes, ranges, highlights) is in markdown-find.ts.

/** Stop after this many matches. A short query in a big file would give too many ranges. */
export const MAX_MATCHES = 10_000;

/** One text node. `block` is the same value for all text nodes of one block element (a paragraph, a list item, a cell). */
export interface Segment {
  text: string;
  block: unknown;
}

/** All segments as one string. `starts[i]` and `lengths[i]` tell where segment `i` sits in `text`. */
export interface Haystack {
  text: string;
  starts: number[];
  lengths: number[];
}

/** A match: `[start, end)` in the string of the haystack. */
export interface Match {
  start: number;
  end: number;
}

/** A place in a segment. */
export interface Place {
  segment: number;
  offset: number;
}

/** Joins the segments. A new line goes between two segments of different blocks, so a match never joins two blocks. */
export function buildHaystack(segments: Segment[]): Haystack {
  const parts: string[] = [];
  const starts: number[] = [];
  const lengths: number[] = [];
  let size = 0;
  let prev: unknown;
  segments.forEach((seg, i) => {
    if (i > 0 && seg.block !== prev) {
      parts.push('\n');
      size += 1;
    }
    prev = seg.block;
    starts.push(size);
    lengths.push(seg.text.length);
    parts.push(seg.text);
    size += seg.text.length;
  });
  return { text: parts.join(''), starts, lengths };
}

/** Lower case that keeps every index. A few characters change their length when lowered, and those stay as they are. */
function foldCase(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const lower = s[i].toLowerCase();
    out += lower.length === 1 ? lower : s[i];
  }
  return out;
}

/** Plain text search (no regex). Matches do not overlap. An empty query gives no match. */
export function findMatches(text: string, query: string, matchCase: boolean, limit = MAX_MATCHES): Match[] {
  if (!query) return [];
  const hay = matchCase ? text : foldCase(text);
  const needle = matchCase ? query : foldCase(query);
  const found: Match[] = [];
  let from = 0;
  while (found.length < limit) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    found.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return found;
}

/** Index of the last segment that starts at or before `pos`, or -1. */
function segmentAt(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= pos) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The segment and offset of the start of a match. If the match starts on a
 * separator (a new line between blocks), the place is the start of the next segment.
 */
export function startPlace(hay: Haystack, pos: number): Place | null {
  let i = segmentAt(hay.starts, pos);
  if (i < 0) return null;
  if (pos >= hay.starts[i] + hay.lengths[i]) i += 1;
  if (i >= hay.starts.length) return null;
  return { segment: i, offset: Math.max(0, pos - hay.starts[i]) };
}

/** The segment and offset of the end of a match (`pos` is the end index, so the last character is `pos - 1`). */
export function endPlace(hay: Haystack, pos: number): Place | null {
  const i = segmentAt(hay.starts, pos - 1);
  if (i < 0) return null;
  return { segment: i, offset: Math.min(hay.lengths[i], pos - hay.starts[i]) };
}

/** Keeps the old index when it still exists, else the last match. Gives -1 when there is no match. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(Math.max(0, index), count - 1);
}

/** The text of the counter: "3 of 12", "No results", or nothing for an empty query. */
export function countLabel(index: number, count: number, query: string): string {
  if (!query) return '';
  if (count === 0) return 'No results';
  const total = count >= MAX_MATCHES ? `${MAX_MATCHES}+` : String(count);
  return `${index + 1} of ${total}`;
}

export type FindKeyAction = 'next' | 'previous' | 'close';

interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * What a key press does in the find bar. `inInput` is true for the text field,
 * where Enter and Shift-Enter also move. Gives null for any other key.
 */
export function findKeyAction(e: KeyLike, inInput: boolean): FindKeyAction | null {
  const mod = e.metaKey || e.ctrlKey;
  if (e.altKey) return null;
  if (e.key === 'Escape' && !mod) return 'close';
  if (e.key === 'F3' && !mod) return e.shiftKey ? 'previous' : 'next';
  if (mod && e.key.toLowerCase() === 'g') return e.shiftKey ? 'previous' : 'next';
  if (inInput && e.key === 'Enter' && !mod) return e.shiftKey ? 'previous' : 'next';
  return null;
}

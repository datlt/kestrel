// Drafts: files in the app drafts folder `<dataDir>/drafts/`.
// This file has the pure helpers (names, numbers, path check). The code that
// touches the disk is in draft-ops.ts.

import { basename, isInside } from '../core/util';

/** Extension of a new draft before the user picks a language. */
export const DEFAULT_DRAFT_EXT = 'txt';

/** `draft-12.py` or `draft-12`. Group 1 is the number. */
const DRAFT_NAME = /^draft-(\d+)(?:\.[^./\\]*)?$/i;

/** True when `path` is a file inside the drafts folder `dir`. `dir` is null while it is not known. */
export function isDraftPath(path: string, dir: string | null): boolean {
  if (!dir) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm(path).toLowerCase() === norm(dir).toLowerCase()) return false;
  return isInside(path, dir);
}

/** The number in a draft file name, or null when the name does not look like a draft name. */
export function draftNumber(fileName: string): number | null {
  const m = DRAFT_NAME.exec(fileName);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The lowest number (starting at 1) that no file name in `names` uses. */
export function nextDraftNumber(names: Iterable<string>): number {
  const used = new Set<number>();
  for (const name of names) {
    const n = draftNumber(name);
    if (n !== null) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** File name of a draft: `draft-3.txt`. */
export function draftFileName(n: number, ext: string = DEFAULT_DRAFT_EXT): string {
  return `draft-${n}.${ext.replace(/^\./, '')}`;
}

/** Tab title of a draft: `Draft 3`. A file with another name keeps its name. */
export function draftTitle(path: string): string {
  const name = basename(path);
  const n = draftNumber(name);
  return n === null ? name : `Draft ${n}`;
}

/** First line that is not blank, cut to `max` characters. Empty string when the text is blank. */
export function firstLine(text: string, max = 120): string {
  for (const line of text.split(/\r\n|\r|\n/, 50)) {
    const t = line.trim();
    if (t) return t.length > max ? `${t.slice(0, max)}...` : t;
  }
  return '';
}

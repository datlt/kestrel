// The result model of the popup, and the flat list for the virtual list.

import type { FileMatches, LineMatch } from '../../ipc/search';
import { relPath } from './scope';
import type { Target } from './apply';

export interface ResultFile {
  /** Absolute path. */
  path: string;
  /** Path below the project folder, with `/`. */
  rel: string;
  name: string;
  /** Folder part of `rel`. */
  dir: string;
  matches: LineMatch[];
}

export function toResultFile(root: string, f: FileMatches): ResultFile {
  const rel = relPath(root, f.path);
  const i = Math.max(f.path.lastIndexOf('/'), f.path.lastIndexOf('\\'));
  const j = rel.lastIndexOf('/');
  return { path: f.path, rel, name: f.path.slice(i + 1), dir: j < 0 ? '' : rel.slice(0, j), matches: f.matches };
}

export function sortFiles(files: ResultFile[]): void {
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export type ListRow =
  | { kind: 'file'; file: ResultFile; collapsed: boolean }
  | { kind: 'match'; file: ResultFile; match: LineMatch; grouped: boolean };

/**
 * The rows of the list. Flat: one row per matching line, in file order.
 * Grouped: a header row for each file, then its lines (none when the file is collapsed).
 */
export function flattenResults(files: readonly ResultFile[], grouped: boolean, collapsed: ReadonlySet<string>): ListRow[] {
  const rows: ListRow[] = [];
  for (const file of files) {
    if (grouped) {
      const isCollapsed = collapsed.has(file.path);
      rows.push({ kind: 'file', file, collapsed: isCollapsed });
      if (isCollapsed) continue;
    }
    for (const match of file.matches) rows.push({ kind: 'match', file, match, grouped });
  }
  return rows;
}

/** Index of the row for this file and line, or -1. */
export function findRow(rows: readonly ListRow[], path: string, line: number): number {
  return rows.findIndex((r) => r.kind === 'match' && r.file.path === path && r.match.line === line);
}

// --- Exclusions (Replace mode) ------------------------------------------------

export interface Exclusions {
  files: Set<string>;
  /** Keys made by `matchKey`. */
  matches: Set<string>;
}

export const newExclusions = (): Exclusions => ({ files: new Set(), matches: new Set() });

export const matchKey = (path: string, line: number): string => `${path}\u0000${line}`;

export function isExcluded(ex: Exclusions, path: string, line: number): boolean {
  return ex.files.has(path) || ex.matches.has(matchKey(path, line));
}

export interface Counts {
  matches: number;
  files: number;
}

/** Counts matching lines and files, without the excluded ones when `ex` is given. */
export function countResults(files: readonly ResultFile[], ex?: Exclusions): Counts {
  let matches = 0;
  let count = 0;
  for (const f of files) {
    const n = ex ? f.matches.filter((m) => !isExcluded(ex, f.path, m.line)).length : f.matches.length;
    if (n > 0) {
      matches += n;
      count++;
    }
  }
  return { matches, files: count };
}

/** The matches of one file as targets for `planEdits`. */
export function targetsOf(file: ResultFile, ex: Exclusions): Target[] {
  const out: Target[] = [];
  for (const m of file.matches) {
    const excluded = isExcluded(ex, file.path, m.line);
    for (const [s, e] of m.ranges) {
      out.push({ line: m.line, col: m.offset + s, text: m.text.slice(s, e), lineText: m.text, excluded });
    }
  }
  return out;
}

/** Text for the header: `1,234 matches in 87 files`, with `+` when the limit cut the results. */
export function countsText(c: Counts, truncated: boolean): string {
  const plus = truncated ? '+' : '';
  return `${c.matches.toLocaleString('en-US')}${plus} ${c.matches === 1 && !truncated ? 'match' : 'matches'} in ${c.files.toLocaleString('en-US')}${plus} ${c.files === 1 && !truncated ? 'file' : 'files'}`;
}

import { describe, expect, it } from 'vitest';
import type { FileMatches } from '../../ipc/search';
import {
  countResults,
  countsText,
  findRow,
  flattenResults,
  isExcluded,
  matchKey,
  newExclusions,
  sortFiles,
  targetsOf,
  toResultFile,
} from './results';

const lm = (line: number, text: string, ranges: [number, number][], offset = 0) => ({ line, text, ranges, offset });
const fm = (path: string, ...matches: ReturnType<typeof lm>[]): FileMatches => ({ path, matches });

const files = [
  toResultFile('/r', fm('/r/src/B.kt', lm(3, 'foo()', [[0, 3]]), lm(9, 'x foo foo', [[2, 5], [6, 9]], 4))),
  toResultFile('/r', fm('/r/A.kt', lm(1, 'foo', [[0, 3]]))),
];

describe('toResultFile and sortFiles', () => {
  it('fills name, dir and rel', () => {
    expect(files[0]).toMatchObject({ rel: 'src/B.kt', name: 'B.kt', dir: 'src' });
    expect(files[1]).toMatchObject({ rel: 'A.kt', name: 'A.kt', dir: '' });
  });
  it('sorts by path', () => {
    const copy = [...files];
    sortFiles(copy);
    expect(copy.map((f) => f.rel)).toEqual(['A.kt', 'src/B.kt']);
  });
});

describe('flattenResults', () => {
  it('flat: one row per matching line', () => {
    const rows = flattenResults(files, false, new Set());
    expect(rows.map((r) => r.kind)).toEqual(['match', 'match', 'match']);
  });
  it('grouped: a header per file, collapsed files hide their lines', () => {
    const rows = flattenResults(files, true, new Set());
    expect(rows.map((r) => r.kind)).toEqual(['file', 'match', 'match', 'file', 'match']);
    const collapsed = flattenResults(files, true, new Set(['/r/src/B.kt']));
    expect(collapsed.map((r) => r.kind)).toEqual(['file', 'file', 'match']);
  });
  it('findRow finds a line', () => {
    expect(findRow(flattenResults(files, true, new Set()), '/r/src/B.kt', 9)).toBe(2);
    expect(findRow(flattenResults(files, true, new Set()), '/r/none', 1)).toBe(-1);
  });
});

describe('exclusions and counts', () => {
  it('excludes a match or a whole file', () => {
    const ex = newExclusions();
    ex.matches.add(matchKey('/r/src/B.kt', 3));
    expect(isExcluded(ex, '/r/src/B.kt', 3)).toBe(true);
    expect(isExcluded(ex, '/r/src/B.kt', 9)).toBe(false);
    expect(countResults(files, ex)).toEqual({ matches: 2, files: 2 });
    ex.files.add('/r/A.kt');
    expect(countResults(files, ex)).toEqual({ matches: 1, files: 1 });
    expect(countResults(files)).toEqual({ matches: 3, files: 2 });
  });
  it('makes targets with columns that include the offset', () => {
    const ex = newExclusions();
    ex.matches.add(matchKey('/r/src/B.kt', 3));
    const t = targetsOf(files[0], ex);
    expect(t).toEqual([
      { line: 3, col: 0, text: 'foo', lineText: 'foo()', excluded: true },
      { line: 9, col: 6, text: 'foo', lineText: 'x foo foo', excluded: false },
      { line: 9, col: 10, text: 'foo', lineText: 'x foo foo', excluded: false },
    ]);
  });
  it('writes the header text', () => {
    expect(countsText({ matches: 1234, files: 87 }, false)).toBe('1,234 matches in 87 files');
    expect(countsText({ matches: 1, files: 1 }, false)).toBe('1 match in 1 file');
    expect(countsText({ matches: 20000, files: 300 }, true)).toBe('20,000+ matches in 300+ files');
  });
});

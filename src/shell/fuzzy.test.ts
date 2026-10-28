import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches an empty query', () => {
    expect(fuzzyMatch('', 'abc')).toEqual({ score: 0, indexes: [] });
  });

  it('returns null when letters are missing or out of order', () => {
    expect(fuzzyMatch('xyz', 'abc')).toBeNull();
    expect(fuzzyMatch('ba', 'ab')).toBeNull();
    expect(fuzzyMatch('abcd', 'abc')).toBeNull();
  });

  it('ignores case', () => {
    const r = fuzzyMatch('SAVE', 'save file');
    expect(r?.indexes).toEqual([0, 1, 2, 3]);
  });

  it('returns ascending indexes of the matched letters', () => {
    const r = fuzzyMatch('sf', 'Save File')!;
    expect(r.indexes).toEqual([0, 5]);
  });

  it('scores an exact match highest', () => {
    const exact = fuzzyMatch('save', 'save')!;
    const partial = fuzzyMatch('save', 'save all')!;
    expect(exact.score).toBeGreaterThan(partial.score);
  });

  it('prefers consecutive letters', () => {
    const a = fuzzyMatch('abc', 'xabcx')!;
    const b = fuzzyMatch('abc', 'xaxbxcx')!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('prefers word starts', () => {
    const a = fuzzyMatch('fb', 'foo-bar')!;
    const b = fuzzyMatch('fb', 'fxxbxx')!;
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.indexes).toEqual([0, 4]);
  });

  it('prefers camelCase humps', () => {
    const a = fuzzyMatch('gl', 'goToLine')!;
    const b = fuzzyMatch('gl', 'golfball')!;
    expect(a.indexes).toEqual([0, 4]);
    expect(a.score).toBeGreaterThan(b.score - 1);
  });

  it('prefers a match after a path separator', () => {
    const a = fuzzyMatch('ind', 'src/index.ts')!;
    expect(a.indexes).toEqual([4, 5, 6]);
  });

  it('works with long text and long queries', () => {
    const text = 'a'.repeat(400) + 'needle';
    const r = fuzzyMatch('needle', text)!;
    expect(r).not.toBeNull();
    expect(r.indexes[r.indexes.length - 1]).toBe(text.length - 1);
    const long = 'x'.repeat(100);
    expect(fuzzyMatch(long, long)).not.toBeNull();
  });

  it('handles non-ASCII text', () => {
    const r = fuzzyMatch('ほん', '日本語のほんだな')!;
    expect(r.indexes).toEqual([4, 5]);
    expect(fuzzyMatch('é', 'CAFÉ')?.indexes).toEqual([3]);
  });
});

describe('fuzzyFilter', () => {
  const items = [
    { label: 'Open File', description: 'workspace' },
    { label: 'Save File', description: 'file menu' },
    { label: 'Save All', description: '' },
    { label: 'Toggle Sidebar', description: 'view' },
  ];
  const run = (q: string) =>
    fuzzyFilter(items, q, (i) => i.label, (i) => i.description).map((r) => r.item.label);

  it('keeps order for an empty query', () => {
    expect(run('')).toEqual(items.map((i) => i.label));
  });

  it('filters and ranks', () => {
    expect(run('save')).toEqual(['Save All', 'Save File']);
    expect(run('sidebar')).toEqual(['Toggle Sidebar']);
  });

  it('keeps original order for equal scores', () => {
    const same = [{ label: 'Zeta one' }, { label: 'Zeta two' }, { label: 'Zeta tre' }];
    const r = fuzzyFilter(same, 'zeta', (i) => i.label).map((x) => x.item.label);
    expect(r).toEqual(['Zeta one', 'Zeta two', 'Zeta tre']);
  });

  it('puts shorter texts first when the match is the same', () => {
    expect(run('sa').slice(0, 2)).toEqual(['Save All', 'Save File']);
  });

  it('falls back to the description with a lower rank', () => {
    const r = fuzzyFilter(items, 'workspace', (i) => i.label, (i) => i.description);
    expect(r).toHaveLength(1);
    expect(r[0].labelIndexes).toEqual([]);
    expect(r[0].descriptionIndexes.length).toBe(9);
  });

  it('returns highlight indexes for labels', () => {
    const r = fuzzyFilter(items, 'tsb', (i) => i.label);
    expect(r[0].labelIndexes).toHaveLength(3);
  });
});

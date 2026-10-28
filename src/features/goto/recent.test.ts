import { describe, expect, it } from 'vitest';
import { addRecent, applyRecentBonus, classKey, readRecent, recentBonus, recentRanks, type RecentClass, type RecentEntry } from './recent';

const cls = (name: string): RecentClass => ({
  type: 'class',
  key: classKey(`/p/${name}.kt`, name),
  name,
  container: 'a.b',
  kind: 'class',
  lang: 'kotlin',
  path: `/p/${name}.kt`,
  line: 3,
  column: 7,
  test: false,
});
const file = (key: string): RecentEntry => ({ type: 'file', key });

describe('recent list', () => {
  it('puts the newest entry first and removes the older copy', () => {
    let l: RecentEntry[] = [];
    l = addRecent(l, file('a.kt'));
    l = addRecent(l, file('b.kt'));
    l = addRecent(l, file('a.kt'));
    expect(l.map((e) => e.key)).toEqual(['a.kt', 'b.kt']);
  });

  it('keeps a class and a file with the same key apart', () => {
    const l = addRecent(addRecent([], file('x')), { ...cls('x'), key: 'x' });
    expect(l).toHaveLength(2);
  });

  it('keeps at most 50 entries', () => {
    let l: RecentEntry[] = [];
    for (let i = 0; i < 80; i++) l = addRecent(l, file(`f${i}`));
    expect(l).toHaveLength(50);
    expect(l[0].key).toBe('f79');
  });

  it('reads saved data and drops entries that look wrong', () => {
    expect(readRecent(null)).toEqual([]);
    expect(readRecent([file('a'), { type: 'class' }, 5, { type: 'file' }, cls('A')])).toHaveLength(2);
  });

  it('ranks the keys of one type', () => {
    const l = [file('a'), cls('B'), file('c')];
    const ranks = recentRanks(l, 'file');
    expect(ranks.get('a')).toBe(0);
    expect(ranks.get('c')).toBe(1);
    expect(recentRanks(l, 'class').get(classKey('/p/B.kt', 'B'))).toBe(0);
  });
});

describe('recent bonus', () => {
  it('gives newer entries a bigger bonus', () => {
    expect(recentBonus(0)).toBeGreaterThan(recentBonus(10));
    expect(recentBonus(10)).toBeGreaterThan(recentBonus(40));
  });

  it('moves a recent row up a few places and keeps the others in order', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const out = applyRecentBonus(rows, (r) => r, new Map([['g', 0]]));
    expect(out).toEqual(['a', 'b', 'c', 'g', 'd', 'e', 'f', 'h']);
  });

  it('does not move a recent row over the best match when it is far down', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `r${i}`);
    const out = applyRecentBonus(rows, (r) => r, new Map([['r19', 0]]));
    expect(out.indexOf('r19')).toBe(16);
    expect(out[0]).toBe('r0');
  });

  it('keeps the order when there is no recent entry', () => {
    expect(applyRecentBonus(['a', 'b'], (r) => r, new Map())).toEqual(['a', 'b']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildHaystack,
  clampIndex,
  countLabel,
  endPlace,
  findKeyAction,
  findMatches,
  MAX_MATCHES,
  startPlace,
} from './markdown-find-text';

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('buildHaystack', () => {
  it('joins segments of one block without a separator', () => {
    const hay = buildHaystack([
      { text: 'ab', block: 1 },
      { text: 'cd', block: 1 },
    ]);
    expect(hay.text).toBe('abcd');
    expect(hay.starts).toEqual([0, 2]);
  });
  it('puts a new line between blocks', () => {
    const hay = buildHaystack([
      { text: 'ab', block: 1 },
      { text: 'cd', block: 2 },
    ]);
    expect(hay.text).toBe('ab\ncd');
    expect(hay.starts).toEqual([0, 3]);
    expect(hay.lengths).toEqual([2, 2]);
  });
  it('handles no segments', () => {
    expect(buildHaystack([]).text).toBe('');
  });
});

describe('findMatches', () => {
  it('ignores case by default', () => {
    expect(findMatches('Foo foo FOO', 'foo', false)).toHaveLength(3);
  });
  it('respects case when asked', () => {
    expect(findMatches('Foo foo FOO', 'foo', true)).toEqual([{ start: 4, end: 7 }]);
  });
  it('treats the query as plain text', () => {
    expect(findMatches('a.c abc', 'a.c', false)).toEqual([{ start: 0, end: 3 }]);
  });
  it('gives nothing for an empty query', () => {
    expect(findMatches('abc', '', false)).toEqual([]);
  });
  it('does not overlap matches', () => {
    expect(findMatches('aaaa', 'aa', false)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
  it('keeps indexes when lowering changes the length', () => {
    // "İ" becomes two characters when lowered. The match must still sit at the right place.
    expect(findMatches('İx x', 'x', false)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
  });
  it('stops at the limit', () => {
    expect(findMatches('a'.repeat(50), 'a', false, 10)).toHaveLength(10);
    expect(findMatches('a'.repeat(MAX_MATCHES + 5), 'a', false)).toHaveLength(MAX_MATCHES);
  });
  it('does not match across blocks', () => {
    const hay = buildHaystack([
      { text: 'foo', block: 1 },
      { text: 'bar', block: 2 },
    ]);
    expect(findMatches(hay.text, 'foobar', false)).toEqual([]);
  });
});

describe('places', () => {
  const hay = buildHaystack([
    { text: 'he', block: 1 },
    { text: 'llo', block: 1 },
    { text: 'world', block: 2 },
  ]);
  it('finds a match inside several segments', () => {
    const [m] = findMatches(hay.text, 'ello', false);
    expect(startPlace(hay, m.start)).toEqual({ segment: 0, offset: 1 });
    expect(endPlace(hay, m.end)).toEqual({ segment: 1, offset: 3 });
  });
  it('ends at the end of a segment', () => {
    expect(endPlace(hay, 2)).toEqual({ segment: 0, offset: 2 });
  });
  it('moves a start on a separator to the next segment', () => {
    expect(startPlace(hay, 5)).toEqual({ segment: 2, offset: 0 });
  });
  it('gives null when there is no text', () => {
    expect(startPlace(buildHaystack([]), 0)).toBeNull();
    expect(endPlace(buildHaystack([]), 1)).toBeNull();
  });
});

describe('clampIndex and countLabel', () => {
  it('clamps', () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(1, 3)).toBe(1);
    expect(clampIndex(-2, 3)).toBe(0);
    expect(clampIndex(0, 0)).toBe(-1);
  });
  it('labels', () => {
    expect(countLabel(2, 12, 'x')).toBe('3 of 12');
    expect(countLabel(-1, 0, 'x')).toBe('No results');
    expect(countLabel(0, 0, '')).toBe('');
    expect(countLabel(0, MAX_MATCHES, 'x')).toBe(`1 of ${MAX_MATCHES}+`);
  });
});

describe('findKeyAction', () => {
  it('handles Escape and the next and previous keys', () => {
    expect(findKeyAction(key('Escape'), false)).toBe('close');
    expect(findKeyAction(key('g', { metaKey: true }), false)).toBe('next');
    expect(findKeyAction(key('G', { ctrlKey: true, shiftKey: true }), false)).toBe('previous');
    expect(findKeyAction(key('F3'), false)).toBe('next');
    expect(findKeyAction(key('F3', { shiftKey: true }), false)).toBe('previous');
  });
  it('handles Enter only in the input', () => {
    expect(findKeyAction(key('Enter'), true)).toBe('next');
    expect(findKeyAction(key('Enter', { shiftKey: true }), true)).toBe('previous');
    expect(findKeyAction(key('Enter'), false)).toBeNull();
  });
  it('leaves other keys alone', () => {
    expect(findKeyAction(key('f', { metaKey: true }), true)).toBeNull();
    expect(findKeyAction(key('g', { metaKey: true, altKey: true }), true)).toBeNull();
    expect(findKeyAction(key('a'), true)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { highlightSegments, parseGoto, splitGlobs } from './query';

describe('parseGoto', () => {
  it('splits name and line', () => {
    expect(parseGoto('main:120')).toEqual({ name: 'main', line: 120, column: undefined });
    expect(parseGoto('main:12:5')).toEqual({ name: 'main', line: 12, column: 5 });
    expect(parseGoto(':7')).toEqual({ name: '', line: 7, column: undefined });
  });
  it('keeps plain names and drops a trailing colon', () => {
    expect(parseGoto('main')).toEqual({ name: 'main' });
    expect(parseGoto('main:')).toEqual({ name: 'main' });
  });
});

describe('splitGlobs', () => {
  it('splits at commas outside braces', () => {
    expect(splitGlobs('*.ts, src/{a,b}/**,  ')).toEqual(['*.ts', 'src/{a,b}/**']);
    expect(splitGlobs('')).toEqual([]);
  });
});

describe('highlightSegments', () => {
  it('cuts text at the ranges', () => {
    expect(highlightSegments('a foo b foo', [[2, 5], [8, 11]])).toEqual([
      { text: 'a ', hit: false },
      { text: 'foo', hit: true },
      { text: ' b ', hit: false },
      { text: 'foo', hit: true },
    ]);
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', hit: false }]);
    expect(highlightSegments('abc', [[1, 99]])).toEqual([
      { text: 'a', hit: false },
      { text: 'bc', hit: true },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { colorSpans } from './csv-colors';

describe('colorSpans', () => {
  it('gives each field a column number and marks delimiters', () => {
    expect(colorSpans('ab,c,,d', ',')).toEqual([
      { from: 0, to: 2, col: 0 },
      { from: 2, to: 3, col: -1 },
      { from: 3, to: 4, col: 1 },
      { from: 4, to: 5, col: -1 },
      { from: 5, to: 6, col: -1 },
      { from: 6, to: 7, col: 3 },
    ]);
  });
  it('keeps a delimiter inside quotes in one field', () => {
    const spans = colorSpans('"a,b",c', ',');
    expect(spans.filter((s) => s.col >= 0).map((s) => s.col)).toEqual([0, 1]);
  });
});

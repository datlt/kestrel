import { describe, expect, it } from 'vitest';
import { cellText, columnLabel, detectDelimiter, delimiterForPath, parseCsv, rowCells, unquote } from './csv-parse';
import { parseNumber, sortRows } from './csv-sort';

function grid(text: string, d: ',' | ';' | '\t' | '|' = ','): string[][] {
  const t = parseCsv(text, d);
  return Array.from({ length: t.rows }, (_, r) => rowCells(t, text, r));
}

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(grid('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });
  it('handles CRLF, CR and a missing final newline', () => {
    expect(grid('a,b\r\n1,2\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(grid('a,b\r1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('handles quotes, escaped quotes and delimiters inside quotes', () => {
    expect(grid('"a,b","say ""hi""",x\n')).toEqual([['a,b', 'say "hi"', 'x']]);
  });
  it('handles newlines inside quotes', () => {
    expect(grid('"line1\nline2",b\r\n"c\r\nd",e\n')).toEqual([['line1\nline2', 'b'], ['c\r\nd', 'e']]);
  });
  it('keeps empty cells, also at the start and the end', () => {
    expect(grid(',a,,\n,,\n')).toEqual([['', 'a', '', ''], ['', '', '']]);
    expect(grid('a,b,')).toEqual([['a', 'b', '']]);
    expect(grid('"",x')).toEqual([['', 'x']]);
  });
  it('skips empty lines', () => {
    expect(grid('a\n\n\nb\n')).toEqual([['a'], ['b']]);
    expect(grid('')).toEqual([]);
  });
  it('strips a BOM', () => {
    expect(grid('﻿a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('reports the widest row and gives empty text for missing cells', () => {
    const text = 'a,b,c\n1\n1,2,3,4\n';
    const t = parseCsv(text, ',');
    expect(t.rows).toBe(3);
    expect(t.cols).toBe(4);
    expect(cellText(t, text, 1, 3)).toBe('');
  });
  it('keeps an unterminated quote until the end', () => {
    expect(grid('a,"b\nc')).toEqual([['a', 'b\nc']]);
  });
  it('treats a quote inside an unquoted field as normal text', () => {
    expect(grid('5" pipe,x')).toEqual([['5" pipe', 'x']]);
  });
  it('works with other delimiters', () => {
    expect(grid('a\tb\n"x\ty"\tz', '\t')).toEqual([['a', 'b'], ['x\ty', 'z']]);
    expect(grid('a;b|c', ';')).toEqual([['a', 'b|c']]);
  });
  it('stops at maxRows', () => {
    expect(parseCsv('a\nb\nc\n', ',', 2).rows).toBe(2);
  });
  it('is fast enough for 200k rows', () => {
    const line = 'abc,123,"x ""y"" z",2024-01-01\n';
    const text = line.repeat(200_000);
    const t0 = performance.now();
    const t = parseCsv(text, ',');
    expect(t.rows).toBe(200_000);
    expect(t.cols).toBe(4);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('unquote', () => {
  it('removes quotes and unescapes', () => {
    expect(unquote('"a""b"')).toBe('a"b');
    expect(unquote('"ab"cd')).toBe('abcd');
  });
});

describe('detectDelimiter', () => {
  it('detects the four delimiters', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n4,5,6')).toBe(',');
    expect(detectDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a|b|c\n1|2|3')).toBe('|');
  });
  it('prefers the delimiter with the same width in every row', () => {
    expect(detectDelimiter('name;price\nfoo;1,5\nbar;2,5\nbaz;3,5')).toBe(';');
  });
  it('ignores delimiters inside quotes', () => {
    expect(detectDelimiter('"a,b";"c,d"\n"e,f";"g,h"\n"i,j";"k,l"')).toBe(';');
  });
  it('uses the hint on a tie and falls back to comma', () => {
    expect(detectDelimiter('a\nb\nc')).toBe(',');
    expect(detectDelimiter('a\nb\nc', '\t')).toBe('\t');
    expect(detectDelimiter('a,b\tc\n1,2\t3', '\t')).toBe('\t');
  });
  it('maps extensions', () => {
    expect(delimiterForPath('/x/a.TSV')).toBe('\t');
    expect(delimiterForPath('/x/a.psv')).toBe('|');
    expect(delimiterForPath('/x/a.txt')).toBeUndefined();
  });
});

describe('sortRows', () => {
  const text = 'name,n\nb,10\na,9\nc,\nd,100\ne,9\n';
  const t = parseCsv(text, ',');
  const names = (order: Uint32Array) => Array.from(order, (r) => cellText(t, text, r, 0)).join('');
  it('sorts numbers as numbers, empty cells last, equal keeps file order', () => {
    expect(names(sortRows(t, text, 1, 1, false))).toBe('aebdc');
    expect(names(sortRows(t, text, 1, 1, true))).toBe('dbaec');
  });
  it('sorts text', () => {
    expect(names(sortRows(t, text, 1, 0, false))).toBe('abcde');
    expect(names(sortRows(t, text, 1, 0, true))).toBe('edcba');
  });
  it('parses numbers', () => {
    expect(parseNumber(' -3.5 ')).toBe(-3.5);
    expect(parseNumber('45%')).toBe(45);
    expect(parseNumber('$20')).toBe(20);
    expect(parseNumber('1e3')).toBe(1000);
    expect(Number.isNaN(parseNumber('12abc'))).toBe(true);
  });
});

describe('columnLabel', () => {
  it('counts like a spreadsheet', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLabel)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

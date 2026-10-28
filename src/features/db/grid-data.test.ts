import { describe, expect, it } from 'vitest';
import type { DbColumn } from '../../ipc/db';
import {
  autoWidths,
  cellText,
  columnTooltip,
  compareValues,
  formatDuration,
  prettyJson,
  quoteString,
  rowCountNote,
  singleTable,
  sortOrder,
  toCsv,
  toInsert,
  toJson,
  toTsv,
  uniqueNames,
} from './grid-data';

const col = (name: string, type = 'VARCHAR', extra: Partial<DbColumn> = {}): DbColumn => ({
  name,
  type,
  table: 'users',
  nullable: true,
  numeric: false,
  binary: false,
  ...extra,
});

describe('sorting', () => {
  it('puts NULL first', () => {
    expect(compareValues(null, '1', true)).toBeLessThan(0);
    expect(compareValues('1', null, true)).toBeGreaterThan(0);
    expect(compareValues(null, null, false)).toBe(0);
  });

  it('compares numbers as numbers', () => {
    expect(compareValues('9', '10', true)).toBeLessThan(0);
    expect(compareValues('-5', '3', true)).toBeLessThan(0);
    expect(compareValues('1.5', '1.25', true)).toBeGreaterThan(0);
  });

  it('keeps precision of big integers', () => {
    expect(compareValues('9007199254740993', '9007199254740992', true)).toBeGreaterThan(0);
    expect(compareValues('18446744073709551615', '18446744073709551614', true)).toBeGreaterThan(0);
  });

  it('treats text that looks like numbers as numbers', () => {
    expect(compareValues('9', '10', false)).toBeLessThan(0);
  });

  it('uses natural order for other text', () => {
    expect(compareValues('file2', 'file10', false)).toBeLessThan(0);
    expect(compareValues('apple', 'Banana', false)).toBeLessThan(0);
  });

  it('sorts rows and stays stable in both directions', () => {
    const rows = [['b', '2'], ['a', '10'], ['c', null], ['d', '2']];
    expect(Array.from(sortOrder(rows, 1, true, false))).toEqual([2, 0, 3, 1]);
    expect(Array.from(sortOrder(rows, 1, true, true))).toEqual([1, 0, 3, 2]);
    expect(Array.from(sortOrder(rows, 0, false, false))).toEqual([1, 0, 2, 3]);
  });

  it('sorts 50k rows fast enough', () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => [String((i * 7919) % 50_000)]);
    const t = Date.now();
    const order = sortOrder(rows, 0, true, false);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(rows[order[0]][0]).toBe('0');
    expect(rows[order[49_999]][0]).toBe('49999');
  });
});

describe('display', () => {
  it('shows NULL and cuts long text', () => {
    expect(cellText(null)).toBe('NULL');
    expect(cellText('abc')).toBe('abc');
    expect(cellText('x'.repeat(500)).length).toBe(301);
  });

  it('builds a column tooltip', () => {
    expect(columnTooltip(col('id', 'BIGINT', { nullable: false }))).toBe('id\nBIGINT NOT NULL\nfrom users');
    expect(columnTooltip(col('x', 'INT', { table: null }))).toBe('x\nINT');
  });

  it('formats durations and row counts', () => {
    expect(formatDuration(12.4)).toBe('12 ms');
    expect(formatDuration(1234)).toBe('1.23 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
    expect(rowCountNote(1, false)).toBe('1 row');
    expect(rowCountNote(1000, true)).toBe('1,000 rows (truncated at 1,000)');
  });

  it('computes widths from a sample inside the limits', () => {
    const measure = (s: string) => s.length * 7;
    const w = autoWidths([col('id'), col('name'), col('bio')], [['1', 'Anna', 'x'.repeat(200)], ['22', 'Bo', 'y']], measure);
    expect(w[0]).toBe(60);
    expect(w[1]).toBeGreaterThanOrEqual(60);
    expect(w[2]).toBe(360);
  });
});

describe('copy formats', () => {
  const cols = [col('id', 'INT', { numeric: true }), col('name'), col('data', 'BLOB', { binary: true })];
  const rows = [['1', "O'Neil\nJr", '0xdeadbeef'], ['2', null, '0x']];

  it('writes TSV with quoting', () => {
    expect(toTsv(cols, [['1', 'a\tb', null]])).toBe('1\t"a\tb"\t');
    expect(toTsv(cols, rows, true).split('\n')[0]).toBe('id\tname\tdata');
    expect(toTsv(cols, [['1', 'say "hi"', 'x']])).toBe('1\t"say ""hi"""\tx');
  });

  it('writes JSON with numbers, nulls and parsed JSON columns', () => {
    const j = JSON.parse(
      toJson([col('id', 'BIGINT', { numeric: true }), col('big', 'BIGINT', { numeric: true }), col('doc', 'JSON'), col('s')], [['1', '9007199254740993', '{"a":1}', null]]),
    );
    expect(j).toEqual([{ id: 1, big: '9007199254740993', doc: { a: 1 }, s: null }]);
  });

  it('keeps decimals that would change as numbers', () => {
    const j = JSON.parse(toJson([col('d', 'DECIMAL', { numeric: true })], [['1.10'], ['0.5'], ['007']]));
    expect(j.map((x: { d: unknown }) => x.d)).toEqual(['1.10', 0.5, '007']);
  });

  it('makes duplicate column names unique', () => {
    expect(uniqueNames([col('id'), col('id'), col('x'), col('id')])).toEqual(['id', 'id_2', 'x', 'id_3']);
  });

  it('quotes strings for MySQL', () => {
    expect(quoteString("a'b\\c\n\0")).toBe("'a''b\\\\c\\n\\0'");
  });

  it('writes INSERT statements', () => {
    expect(toInsert('users', cols, rows)).toBe(
      [
        "INSERT INTO `users` (`id`, `name`, `data`) VALUES (1, 'O''Neil\\nJr', 0xdeadbeef);",
        "INSERT INTO `users` (`id`, `name`, `data`) VALUES (2, NULL, '');",
      ].join('\n'),
    );
  });

  it('quotes backticks in names and uses a placeholder table', () => {
    expect(toInsert(null, [col('a`b')], [['x']])).toBe("INSERT INTO `table_name` (`a``b`) VALUES ('x');");
  });

  it('marks cut binary values', () => {
    const out = toInsert('t', [col('b', 'BLOB', { binary: true })], [['0xaa (3000 bytes)']]);
    expect(out).toContain('NULL /* binary value was cut */');
  });

  it('writes a number column that holds text as a string', () => {
    expect(toInsert('t', [col('n', 'INT', { numeric: true })], [['abc']])).toContain("'abc'");
  });

  it('finds the single source table', () => {
    expect(singleTable([col('a'), col('b')])).toBe('users');
    expect(singleTable([col('a'), col('b', 'X', { table: 'other' })])).toBeNull();
    expect(singleTable([col('a', 'X', { table: null })])).toBeNull();
  });
});

describe('csv', () => {
  it('quotes commas, quotes and line breaks; NULL is empty', () => {
    const cols = [col('a'), col('b,c')];
    expect(toCsv(cols, [['x,y', 'say "hi"'], [null, 'l1\nl2']])).toBe('a,"b,c"\n"x,y","say ""hi"""\n,"l1\nl2"\n');
  });
});

describe('prettyJson', () => {
  it('formats objects and arrays only', () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson('[1]')).toBe('[\n  1\n]');
    expect(prettyJson('123')).toBeNull();
    expect(prettyJson('{bad')).toBeNull();
    expect(prettyJson('hello')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { DbColumn } from '../../ipc/db';
import { baseName, canExportAll, csvFileName, exportBaseName, revealLabel, safeFileName, shownRowsLabel } from './export-model';

const col = (name: string, table: string | null): DbColumn => ({ name, type: 'INT', table, nullable: true, numeric: true, binary: false });

describe('csvFileName', () => {
  it('uses the table name and a local time stamp', () => {
    expect(csvFileName('orders', new Date(2026, 9, 28, 9, 5, 7))).toBe('orders-20261028-090507.csv');
  });
  it('pads small numbers', () => {
    expect(csvFileName('t', new Date(2026, 0, 2, 3, 4, 5))).toBe('t-20260102-030405.csv');
  });
  it('removes characters that a file name cannot have', () => {
    expect(csvFileName('a/b:c*d', new Date(2026, 0, 2, 3, 4, 5))).toBe('a_b_c_d-20260102-030405.csv');
  });
  it('falls back to query for an empty name', () => {
    expect(csvFileName('', new Date(2026, 0, 2, 3, 4, 5))).toBe('query-20260102-030405.csv');
    expect(safeFileName('...')).toBe('');
  });
  it('keeps unicode', () => {
    expect(csvFileName('注文', new Date(2026, 0, 2, 3, 4, 5))).toBe('注文-20260102-030405.csv');
  });
});

describe('exportBaseName', () => {
  it('uses the table when all columns come from one table', () => {
    expect(exportBaseName([col('a', 'orders'), col('b', 'orders')])).toBe('orders');
  });
  it('uses "query" for joins, expressions and no columns', () => {
    expect(exportBaseName([col('a', 'orders'), col('b', 'users')])).toBe('query');
    expect(exportBaseName([col('a', null)])).toBe('query');
    expect(exportBaseName([])).toBe('query');
  });
});

describe('canExportAll', () => {
  it('needs a cut-off result', () => {
    expect(canExportAll('SELECT * FROM t', false)).toBe(false);
    expect(canExportAll('SELECT * FROM t', true)).toBe(true);
  });
  it('allows statements that only read', () => {
    for (const q of ['select 1', 'SHOW TABLES', 'DESCRIBE t', 'EXPLAIN SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x', '-- c\nSELECT 1'])
      expect(canExportAll(q, true), q).toBe(true);
  });
  it('never runs a statement that writes again', () => {
    for (const q of ['DELETE FROM t', 'UPDATE t SET a = 1', 'INSERT INTO t VALUES (1)', 'CALL p()', 'WITH x AS (SELECT 1) DELETE FROM t', 'EXPLAIN ANALYZE DELETE FROM t', 'USE d', ''])
      expect(canExportAll(q, true), q).toBe(false);
  });
});

describe('labels', () => {
  it('names the rows shown', () => {
    expect(shownRowsLabel(1000)).toBe('Rows shown (1,000)');
  });
  it('names the file manager by system', () => {
    expect(revealLabel('macos')).toBe('Reveal in Finder');
    expect(revealLabel('windows')).toBe('Reveal in Explorer');
    expect(revealLabel('linux')).toBe('Show in Folder');
  });
  it('reads the last part of a path', () => {
    expect(baseName('/Users/a/Downloads/x.csv')).toBe('x.csv');
    expect(baseName('C:\\Users\\a\\x.csv')).toBe('x.csv');
  });
});

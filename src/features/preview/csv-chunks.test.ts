import { describe, expect, it } from 'vitest';
import { CsvParser, parseCsv, type CsvTable } from './csv-parse';
import { sortRows } from './csv-sort';

function sample(rows: number): string {
  let s = '"id","名前","comment"\n';
  for (let i = 0; i < rows; i++) {
    const comment = i % 7 === 0 ? `"line one,\nline ""two"" ${i}"` : i % 5 === 0 ? '""' : `text${i}`;
    s += `${i},${i % 3 === 0 ? `"作品, ${i}"` : `作品${i}`},${comment}${i % 4 === 0 ? '\r\n' : '\n'}`;
  }
  return s;
}

function chunked(text: string, step: number): CsvTable {
  const p = new CsvParser(text, ',');
  while (!p.done) p.run(p.position + step);
  return p.snapshot();
}

function same(a: CsvTable, b: CsvTable): void {
  expect(a.rows).toBe(b.rows);
  expect(a.cols).toBe(b.cols);
  expect(Array.from(a.rowFirst)).toEqual(Array.from(b.rowFirst));
  expect(Array.from(a.fieldStart)).toEqual(Array.from(b.fieldStart));
  expect(Array.from(a.fieldEnd)).toEqual(Array.from(b.fieldEnd));
  expect(Array.from(a.quoted)).toEqual(Array.from(b.quoted));
}

describe('CsvParser', () => {
  const text = sample(300);
  const full = parseCsv(text, ',');

  it('gives the same table as a full parse for any step size', () => {
    for (const step of [1, 2, 7, 50, 333, 1000, 100_000]) same(chunked(text, step), full);
  });

  it('never splits a quoted field with a newline at a step border', () => {
    // A step border inside the quoted comment must not cut the row.
    const t = 'a,"x\ny",b\nc,d,e\n';
    for (let step = 1; step < t.length; step++) same(chunked(t, step), parseCsv(t, ','));
    const p = new CsvParser(t, ',');
    p.run(5); // position 5 is inside the quoted field of row 1
    expect(p.rows).toBe(1);
    expect(p.position).toBe(t.indexOf('c,d'));
  });

  it('handles a text that ends inside a quote and a final delimiter', () => {
    for (const t of ['a,"unclosed\nrow', 'a,b,', '﻿a,b\n1,2']) {
      for (const step of [1, 3, 100]) same(chunked(t, step), parseCsv(t, ','));
    }
  });

  it('snapshots are the first rows of the final table', () => {
    const p = new CsvParser(text, ',');
    p.run(2000);
    const part = p.snapshot();
    expect(part.rows).toBeGreaterThan(0);
    expect(part.rows).toBeLessThan(full.rows);
    expect(Array.from(part.rowFirst.subarray(0, part.rows))).toEqual(Array.from(full.rowFirst.subarray(0, part.rows)));
    expect(part.rowFirst[part.rows]).toBe(full.rowFirst[part.rows]);
    // The parser goes on after a snapshot and the snapshot does not change.
    const before = Array.from(part.fieldEnd);
    while (!p.done) p.run(p.position + 500);
    same(p.snapshot(), full);
    expect(Array.from(part.fieldEnd)).toEqual(before);
  });

  it('maxRows stops early', () => {
    expect(parseCsv(text, ',', 5).rows).toBe(5);
  });

  it('sorts a partial table by the rows it has', () => {
    const p = new CsvParser(text, ',');
    p.run(2000);
    const part = p.snapshot();
    const order = sortRows(part, text, 1, 0, true);
    expect(order.length).toBe(part.rows - 1);
    expect(order[0]).toBe(part.rows - 1);
  });
});

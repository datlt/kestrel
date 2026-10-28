import { describe, expect, it, vi } from 'vitest';
import type { DbResult } from '../../ipc/db';
import { MAX_RESULT_TABS, ResultsStore, formatTime, resultMessage } from './results-store';

const rows = (n: number, extra: Partial<DbResult> = {}): DbResult => ({
  kind: 'rows', columns: [], rows: Array.from({ length: n }, () => []), truncated: false, affectedRows: 0,
  lastInsertId: null, warnings: 0, info: null, elapsedMs: 1, ...extra,
});

describe('ResultsStore exporter', () => {
  it('keeps the exporter of a result', () => {
    const s = new ResultsStore();
    const exporter = { exportAll: async () => ({ rows: 1, bytes: 1, elapsedMs: 1 }), cancel() {}, busy: () => false };
    s.addResult('select 1', rows(1), exporter);
    s.addResult('select 2', rows(1));
    expect(s.results[0].exporter).toBe(exporter);
    expect(s.results[1].exporter).toBeUndefined();
  });
});

describe('ResultsStore', () => {
  it('keeps messages and drops results at a new run', () => {
    const s = new ResultsStore();
    s.addResult('select 1', rows(1));
    s.addMessage({ sql: 'select 1', where: null, level: 'ok', text: '1 row', elapsedMs: 1 });
    s.beginRun();
    expect(s.results).toHaveLength(0);
    expect(s.messages).toHaveLength(1);
  });

  it('numbers result tabs and stops at the limit', () => {
    const s = new ResultsStore();
    for (let i = 0; i < MAX_RESULT_TABS; i++) expect(s.addResult('x', rows(0))).toBe(true);
    expect(s.addResult('x', rows(0))).toBe(false);
    expect(s.results[2].title).toBe('Result 3');
  });

  it('shows Messages after an error or when there are no result tables', () => {
    const s = new ResultsStore();
    s.finishRun(false);
    expect(s.focus).toBe('messages');
    s.addResult('x', rows(1));
    s.finishRun(false);
    expect(s.focus).toBe('results');
    s.finishRun(true);
    expect(s.focus).toBe('messages');
  });

  it('limits the message list', () => {
    const s = new ResultsStore();
    for (let i = 0; i < 520; i++) s.addMessage({ sql: null, where: null, level: 'info', text: String(i), elapsedMs: null });
    expect(s.messages).toHaveLength(500);
    expect(s.messages[0].text).toBe('20');
  });

  it('tells listeners and lets them stop', () => {
    const s = new ResultsStore();
    const fn = vi.fn();
    const off = s.onChange(fn);
    s.addMessage({ sql: null, where: null, level: 'info', text: 'a', elapsedMs: null });
    off();
    s.addMessage({ sql: null, where: null, level: 'info', text: 'b', elapsedMs: null });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('resultMessage', () => {
  it('describes row results', () => {
    expect(resultMessage(rows(3))).toEqual({ level: 'ok', text: '3 rows' });
    expect(resultMessage(rows(2, { truncated: true })).text).toBe('2 rows (truncated at 2)');
  });
  it('describes affected rows, insert id, info and warnings', () => {
    const r = resultMessage(rows(0, { kind: 'affected', affectedRows: 1, lastInsertId: '42', info: 'Rows matched: 1  Changed: 1  Warnings: 0', warnings: 2 }));
    expect(r.level).toBe('warn');
    expect(r.text).toBe('1 row affected, last insert id 42, Rows matched: 1  Changed: 1  Warnings: 0, 2 warnings');
  });
  it('formats the time', () => {
    expect(formatTime(new Date(2026, 0, 1, 9, 5, 7).getTime())).toBe('09:05:07');
  });
});

import { describe, expect, it } from 'vitest';
import { READY_MAX_MS, READY_QUIET_MS, parseRunArgs, readyDelay } from './run';

describe('parseRunArgs', () => {
  it('takes command, title and cwd', () => {
    expect(parseRunArgs({ command: 'npm test', title: 'Tests', cwd: '/work' })).toEqual({
      ok: true,
      value: { command: 'npm test', title: 'Tests', cwd: '/work' },
    });
  });

  it('accepts a plain string and a command alone', () => {
    expect(parseRunArgs('ls -la')).toEqual({ ok: true, value: { command: 'ls -la' } });
    expect(parseRunArgs({ command: 'ls' })).toEqual({ ok: true, value: { command: 'ls' } });
  });

  it('removes a final new line, because Kestrel presses Enter itself', () => {
    expect(parseRunArgs({ command: 'make\n' })).toEqual({ ok: true, value: { command: 'make' } });
    expect(parseRunArgs({ command: 'make\r\n' })).toEqual({ ok: true, value: { command: 'make' } });
  });

  it('keeps UTF-8 text', () => {
    expect(parseRunArgs({ command: 'echo "Tiếng Việt 日本語"', title: '日本語' })).toEqual({
      ok: true,
      value: { command: 'echo "Tiếng Việt 日本語"', title: '日本語' },
    });
  });

  it('drops empty title and cwd', () => {
    expect(parseRunArgs({ command: 'ls', title: '  ', cwd: '' })).toEqual({ ok: true, value: { command: 'ls' } });
    expect(parseRunArgs({ command: 'ls', title: null })).toEqual({ ok: true, value: { command: 'ls' } });
  });

  it('rejects missing or wrong arguments with a message', () => {
    for (const bad of [undefined, null, 42, [], {}, { command: '' }, { command: '  ' }, { command: 5 }, { title: 'x' }]) {
      const r = parseRunArgs(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.error).toContain('terminal.run');
    }
    const r = parseRunArgs({ command: 'ls', cwd: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cwd');
  });
});

describe('readyDelay', () => {
  it('waits for the first output, at most 1 second', () => {
    expect(readyDelay(0, null, null, 0)).toBe(READY_MAX_MS);
    expect(readyDelay(0, null, null, 400)).toBe(READY_MAX_MS - 400);
    expect(readyDelay(0, null, null, 1500)).toBe(0);
  });

  it('waits for a quiet moment after the first output', () => {
    expect(readyDelay(0, 200, 200, 210)).toBe(READY_QUIET_MS - 10);
    expect(readyDelay(0, 200, 250, 300)).toBe(READY_QUIET_MS - 50);
    expect(readyDelay(0, 200, 200, 400)).toBe(0);
  });

  it('never waits longer than the deadline, also when output keeps coming', () => {
    expect(readyDelay(0, 100, 950, 960)).toBe(READY_MAX_MS - 960);
    expect(readyDelay(0, 100, 990, 1100)).toBe(0);
  });
});

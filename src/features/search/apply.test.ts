import { describe, expect, it } from 'vitest';
import { applyEdits, planEdits, previewReplacements, type Target } from './apply';
import { compilePattern } from './pattern';

const re = (query: string, regex = false) => {
  const c = compilePattern({ query, regex, matchCase: true, wholeWord: false });
  if (!c.ok) throw new Error(c.error);
  return c.re;
};
const opts = (template: string, regex = false) => ({ template, regex, preserveCase: false });
const t = (line: number, col: number, text: string, extra: Partial<Target> = {}): Target => ({ line, col, text, excluded: false, ...extra });

describe('planEdits and applyEdits', () => {
  const doc = 'foo bar foo\nnothing\nfoo\n';
  it('replaces every target', () => {
    const plan = planEdits(doc, [t(1, 0, 'foo'), t(1, 8, 'foo'), t(3, 0, 'foo')], re('foo'), opts('X'));
    expect(plan.missed).toBe(0);
    expect(applyEdits(doc, plan.edits)).toBe('X bar X\nnothing\nX\n');
  });
  it('keeps excluded matches', () => {
    const plan = planEdits(doc, [t(1, 0, 'foo', { excluded: true }), t(1, 8, 'foo'), t(3, 0, 'foo', { excluded: true })], re('foo'), opts('X'));
    expect(applyEdits(doc, plan.edits)).toBe('foo bar X\nnothing\nfoo\n');
  });
  it('skips a match that is gone', () => {
    const plan = planEdits('foo\nbar\n', [t(1, 0, 'foo'), t(2, 0, 'foo')], re('foo'), opts('X'));
    expect(plan.missed).toBe(1);
    expect(applyEdits('foo\nbar\n', plan.edits)).toBe('X\nbar\n');
  });
  it('finds a match that moved inside its line', () => {
    const plan = planEdits('  foo', [t(1, 0, 'foo')], re('foo'), opts('X'));
    expect(applyEdits('  foo', plan.edits)).toBe('  X');
  });
  it('finds a match when lines were added above it', () => {
    const moved = 'new line\nnew line 2\nfoo bar\n';
    const plan = planEdits(moved, [t(1, 0, 'foo', { lineText: 'foo bar' })], re('foo'), opts('X'));
    expect(plan.missed).toBe(0);
    expect(applyEdits(moved, plan.edits)).toBe('new line\nnew line 2\nX bar\n');
  });
  it('does not use one match twice', () => {
    const plan = planEdits('foo\n', [t(1, 0, 'foo'), t(1, 0, 'foo')], re('foo'), opts('X'));
    expect(plan.edits.length).toBe(1);
    expect(plan.missed).toBe(1);
  });
  it('uses regex groups from the current text', () => {
    const d = 'a=1\nb=22\n';
    const plan = planEdits(d, [t(1, 0, 'a=1'), t(2, 0, 'b=22')], re('(\\w)=(\\d+)', true), opts('$2:$1', true));
    expect(applyEdits(d, plan.edits)).toBe('1:a\n22:b\n');
  });
  it('handles non-BMP text and CJK in the line', () => {
    const d = '😀 foo 日本 foo\n';
    const plan = planEdits(d, [t(1, 3, 'foo'), t(1, 10, 'foo')], re('foo'), opts('bar'));
    expect(applyEdits(d, plan.edits)).toBe('😀 bar 日本 bar\n');
  });
  it('replaces with text that has a new line', () => {
    const regexMode = planEdits('a,b\n', [t(1, 1, ',')], re(','), opts('\\n', true));
    expect(applyEdits('a,b\n', regexMode.edits)).toBe('a\nb\n');
    const plain = planEdits('a,b\n', [t(1, 1, ',')], re(','), opts('\\n', false));
    expect(applyEdits('a,b\n', plain.edits)).toBe('a\\nb\n');
  });
});

describe('previewReplacements', () => {
  it('computes the new text of each range', () => {
    expect(previewReplacements('foo and foo', [[0, 3], [8, 11]], re('foo'), opts('X'))).toEqual(['X', 'X']);
  });
  it('falls back to the matched text alone', () => {
    expect(previewReplacements('xx foo', [[3, 6]], re('foo'), opts('Y'))).toEqual(['Y']);
  });
});

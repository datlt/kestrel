import { describe, expect, it } from 'vitest';
import { activeMask, defaultForm, formToChoice, loadForm } from './state';
import { cleanHistory, pushHistory } from './history';

describe('loadForm', () => {
  it('uses defaults for bad data', () => {
    expect(loadForm(null)).toEqual(defaultForm());
    expect(loadForm({ context: 'nope', tab: 5, options: 'x', recursive: 'yes' })).toEqual(defaultForm());
  });
  it('keeps good fields', () => {
    const f = loadForm({ query: 'x', options: { regex: true }, context: 'inComments', tab: 'scope', scopeFiles: 'tests', grouped: true });
    expect(f).toMatchObject({ query: 'x', context: 'inComments', tab: 'scope', scopeFiles: 'tests', grouped: true });
    expect(f.options).toEqual({ matchCase: false, wholeWord: false, regex: true });
  });
});

describe('formToChoice', () => {
  it('uses the folder of the active file when the directory is empty', () => {
    const f = { ...defaultForm(), tab: 'directory' as const };
    expect(formToChoice(f, '/a/b')).toEqual({ kind: 'directory', path: '/a/b', recursive: true });
    expect(formToChoice({ ...f, directory: ' /x ', recursive: false }, '/a/b')).toEqual({ kind: 'directory', path: '/x', recursive: false });
  });
  it('maps the other tabs', () => {
    expect(formToChoice({ ...defaultForm(), tab: 'scope', scopeFiles: 'openFiles' }, null)).toEqual({ kind: 'files', which: 'openFiles' });
    expect(formToChoice(defaultForm(), null)).toEqual({ kind: 'project' });
  });
});

describe('activeMask', () => {
  it('is empty when the check box is off', () => {
    expect(activeMask({ ...defaultForm(), mask: '*.kt' })).toBe('');
    expect(activeMask({ ...defaultForm(), mask: '*.kt', maskOn: true })).toBe('*.kt');
  });
});

describe('history', () => {
  it('puts new entries first, removes copies and keeps 30', () => {
    expect(pushHistory(['b', 'a'], 'a')).toEqual(['a', 'b']);
    expect(pushHistory(['a'], '  ')).toEqual(['a']);
    const long = Array.from({ length: 30 }, (_, i) => `q${i}`);
    const next = pushHistory(long, 'new');
    expect(next.length).toBe(30);
    expect(next[0]).toBe('new');
    expect(next).not.toContain('q29');
  });
  it('cleans saved data', () => {
    expect(cleanHistory(['a', 3, '', 'b'])).toEqual(['a', 'b']);
    expect(cleanHistory('x')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  defaultFilter,
  indexAllowed,
  indexRequestOptions,
  isFilterActive,
  langPasses,
  lspAllowed,
  passesFilter,
  readFilter,
  toggleIn,
} from './filter';

describe('filter state', () => {
  it('reads a broken value as the default filter', () => {
    expect(readFilter(undefined)).toEqual(defaultFilter());
    expect(readFilter('x')).toEqual(defaultFilter());
    expect(readFilter({ classKinds: 5, hideTests: 'yes' })).toEqual(defaultFilter());
  });

  it('keeps only known kinds and languages', () => {
    const f = readFilter({ classKinds: ['class', 'nope'], symbolKinds: ['method'], langs: ['kotlin', 'cobol'], hideTests: true });
    expect(f).toEqual({ classKinds: ['class'], symbolKinds: ['method'], langs: ['kotlin'], hideTests: true });
  });

  it('toggles a value in a list without changing the old list', () => {
    const a = ['x'];
    expect(toggleIn(a, 'y')).toEqual(['x', 'y']);
    expect(toggleIn(a, 'x')).toEqual([]);
    expect(a).toEqual(['x']);
  });

  it('tells when a filter is on for a tab', () => {
    expect(isFilterActive(defaultFilter(), 'classes')).toBe(false);
    expect(isFilterActive({ ...defaultFilter(), classKinds: ['enum'] }, 'classes')).toBe(true);
    expect(isFilterActive({ ...defaultFilter(), classKinds: ['enum'] }, 'symbols')).toBe(false);
    expect(isFilterActive({ ...defaultFilter(), hideTests: true }, 'symbols')).toBe(true);
  });
});

describe('filter use', () => {
  it('runs the index and the language servers when no language is chosen', () => {
    const f = defaultFilter();
    expect(indexAllowed(f)).toBe(true);
    expect(lspAllowed(f)).toBe(true);
  });

  it('skips the language servers when only index languages are chosen', () => {
    const f = { ...defaultFilter(), langs: ['kotlin'] };
    expect(indexAllowed(f)).toBe(true);
    expect(lspAllowed(f)).toBe(false);
    expect(indexRequestOptions(f)).toEqual({ langs: ['kotlin'] });
  });

  it('skips the index when only other languages are chosen', () => {
    const f = { ...defaultFilter(), langs: ['typescript'] };
    expect(indexAllowed(f)).toBe(false);
    expect(lspAllowed(f)).toBe(true);
    expect(indexRequestOptions(f)).toEqual({});
  });

  it('sends excludeTests to the index', () => {
    expect(indexRequestOptions({ ...defaultFilter(), hideTests: true })).toEqual({ excludeTests: true });
  });

  it('filters rows by kind, test and language', () => {
    const row = { kind: 'enum', lang: 'kotlin', test: false };
    expect(passesFilter(defaultFilter(), 'classes', row)).toBe(true);
    expect(passesFilter({ ...defaultFilter(), classKinds: ['class'] }, 'classes', row)).toBe(false);
    expect(passesFilter({ ...defaultFilter(), classKinds: ['enum'] }, 'classes', row)).toBe(true);
    expect(passesFilter({ ...defaultFilter(), hideTests: true }, 'classes', { ...row, test: true })).toBe(false);
    expect(passesFilter({ ...defaultFilter(), langs: ['java'] }, 'classes', row)).toBe(false);
  });

  it('uses "Other" for languages without an entry', () => {
    const f = { ...defaultFilter(), langs: ['other'] };
    expect(langPasses(f, 'dart')).toBe(true);
    expect(langPasses(f, 'kotlin')).toBe(false);
  });
});

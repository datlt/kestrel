import { describe, expect, it } from 'vitest';
import { TEST_GLOBS } from './globs';
import { buildSearchRequest, changedFilesOf, passesPostFilter, relPath, scopeSpec, type ScopeEnv } from './scope';

const env: ScopeEnv = {
  root: '/work/app',
  openFiles: ['/work/app/a.kt', '/work/app/src/b.kt'],
  changedFiles: ['/work/app/c.kt'],
  currentFile: '/work/app/src/b.kt',
};
const noMask = { include: [], exclude: [] };

describe('relPath', () => {
  it('cuts the root', () => {
    expect(relPath('/work/app', '/work/app/src/a.kt')).toBe('src/a.kt');
    expect(relPath('C:\\work\\app', 'C:\\work\\app\\src\\a.kt')).toBe('src/a.kt');
    expect(relPath('/work/app', '/work/app')).toBe('');
  });
  it('gives a path outside the root without a leading slash', () => {
    expect(relPath('/work/app', '/other/x.kt')).toBe('other/x.kt');
  });
});

describe('scopeSpec and buildSearchRequest', () => {
  it('project', () => {
    expect(buildSearchRequest(scopeSpec({ kind: 'project' }, env), noMask)).toEqual({ root: '/work/app', include: [], exclude: [] });
  });
  it('module uses the module folder as root', () => {
    const s = scopeSpec({ kind: 'module', path: '/work/app/core', name: 'core' }, env);
    expect(s.label).toBe('Module core');
    expect(buildSearchRequest(s, { include: ['*.kt'], exclude: ['*Test.kt'] })).toEqual({
      root: '/work/app/core',
      include: ['*.kt'],
      exclude: ['*Test.kt'],
    });
  });
  it('a module without a path searches the project', () => {
    expect(scopeSpec({ kind: 'module', path: null }, env).root).toBe('/work/app');
  });
  it('directory, recursive and not', () => {
    const rec = scopeSpec({ kind: 'directory', path: '/work/app/src', recursive: true }, env);
    expect(rec.root).toBe('/work/app/src');
    expect(rec.exclude).toEqual([]);
    expect(rec.label).toBe('Directory src');
    const flat = scopeSpec({ kind: 'directory', path: '/work/app/src', recursive: false }, env);
    expect(flat.exclude).toEqual(['/*/**']);
    expect(passesPostFilter(flat.postFilter, '/work/app/src/a.kt', env.root)).toBe(true);
    expect(passesPostFilter(flat.postFilter, '/work/app/src/deep/a.kt', env.root)).toBe(false);
  });
  it('file lists give paths', () => {
    expect(buildSearchRequest(scopeSpec({ kind: 'files', which: 'openFiles' }, env), noMask).paths).toEqual(env.openFiles);
    expect(scopeSpec({ kind: 'files', which: 'currentFile' }, env).paths).toEqual(['/work/app/src/b.kt']);
    expect(scopeSpec({ kind: 'files', which: 'changedFiles' }, env).paths).toEqual(['/work/app/c.kt']);
  });
  it('an empty file list says why', () => {
    const s = scopeSpec({ kind: 'files', which: 'openFiles' }, { ...env, openFiles: [] });
    expect(s.empty).toMatch(/No files/);
    expect(scopeSpec({ kind: 'files', which: 'currentFile' }, { ...env, currentFile: null }).empty).toBeTruthy();
  });
  it('production excludes test globs and keeps mask excludes', () => {
    const r = buildSearchRequest(scopeSpec({ kind: 'files', which: 'production' }, env), { include: [], exclude: ['*.md'] });
    expect(r.exclude).toEqual([...TEST_GLOBS, '*.md']);
  });
  it('tests include the test globs, or the mask with a post filter', () => {
    const s = scopeSpec({ kind: 'files', which: 'tests' }, env);
    expect(buildSearchRequest(s, noMask).include).toEqual(TEST_GLOBS);
    expect(buildSearchRequest(s, { include: ['*.kt'], exclude: [] }).include).toEqual(['*.kt']);
    expect(passesPostFilter(s.postFilter, '/work/app/src/test/A.kt', env.root)).toBe(true);
    expect(passesPostFilter(s.postFilter, '/work/app/src/main/A.kt', env.root)).toBe(false);
  });
});

describe('changedFilesOf', () => {
  it('drops deleted files and sorts', () => {
    expect(changedFilesOf({ '/b': 'modified', '/a': 'untracked', '/c': 'deleted' })).toEqual(['/a', '/b']);
  });
});

import { describe, expect, it } from 'vitest';
import type { SymbolHit, TypeHit } from '../../ipc/code';
import { isIndexedPath, isTestPath, langBadge, langOfPath, lspClassKind, lspSymbolKind } from './lsp-map';
import {
  absolutePath,
  classRowFromHit,
  classRowFromRecent,
  fileRowFromHit,
  lspClassRows,
  lspSymbolRows,
  matchActions,
  recentFromClassRow,
  symbolRowFromHit,
  textRowsFromFiles,
} from './rows';

describe('rows from the index', () => {
  const hit: TypeHit = {
    name: 'BookService',
    qualified: 'jp.x.BookService',
    container: 'jp.x',
    kind: 'class',
    lang: 'kotlin',
    path: '/p/src/BookService.kt',
    line: 12,
    column: 7,
    nameMatches: [0, 4],
    containerMatches: [],
    test: false,
  };

  it('builds a class row', () => {
    const r = classRowFromHit(hit, '/p');
    expect(r).toMatchObject({ type: 'class', name: 'BookService', container: 'jp.x', kind: 'class', lang: 'kotlin', line: 12, nameMatches: [0, 4], lsp: false });
  });

  it('joins a relative path to the root', () => {
    expect(classRowFromHit({ ...hit, path: 'src/BookService.kt' }, '/p/').path).toBe('/p/src/BookService.kt');
    expect(absolutePath('/p', 'C:\\x\\a.kt')).toBe('C:\\x\\a.kt');
  });

  it('builds a symbol row with the owner name', () => {
    const s: SymbolHit = {
      name: 'find',
      kind: 'method',
      owner: 'jp.x.Repo',
      ownerName: 'Repo',
      params: 'id: Long',
      type: 'Book?',
      visibility: 'public',
      lang: 'kotlin',
      path: '/p/Repo.kt',
      line: 5,
      column: 9,
      nameMatches: [0],
      test: true,
    };
    expect(symbolRowFromHit(s, '/p')).toMatchObject({ name: 'find', owner: 'Repo', params: 'id: Long', valueType: 'Book?', test: true });
  });

  it('turns a recent class into a row and back', () => {
    const row = classRowFromHit(hit, '/p');
    expect(classRowFromRecent(recentFromClassRow(row))).toEqual({ ...row, nameMatches: [], containerMatches: [] });
  });

  it('splits the file indexes into name and folder', () => {
    const r = fileRowFromHit({ path: 'src/main/App.kt', indices: [1, 9, 10] });
    expect(r).toMatchObject({ name: 'App.kt', folder: 'src/main', folderMatches: [1], nameMatches: [0, 1] });
    expect(fileRowFromHit({ path: 'README.md', indices: [0] })).toMatchObject({ name: 'README.md', folder: '', nameMatches: [0] });
  });
});

describe('language server results', () => {
  const hits = [
    { name: 'BookService', kind: 5, containerName: 'services', path: '/p/src/book.ts', line: 3, column: 14 },
    { name: 'Repo', kind: 11, path: '/p/src/repo.ts', line: 1, column: 1 },
    { name: 'load', kind: 6, containerName: 'BookService', path: '/p/src/book.ts', line: 8, column: 3 },
    { name: 'str', kind: 15, path: '/p/src/book.ts', line: 9, column: 1 },
  ];

  it('keeps class-like kinds for the Classes tab', () => {
    const rows = lspClassRows(hits, 'book');
    expect(rows.map((r) => [r.name, r.kind])).toEqual([
      ['BookService', 'class'],
      ['Repo', 'interface'],
    ]);
    expect(rows[0]).toMatchObject({ lang: 'typescript', lsp: true, container: 'services' });
    expect(rows[0].nameMatches).toEqual([0, 1, 2, 3]);
  });

  it('keeps members for the Symbols tab and drops other kinds', () => {
    const rows = lspSymbolRows(hits, 'load');
    expect(rows.map((r) => r.name)).toEqual(['load']);
    expect(rows[0]).toMatchObject({ kind: 'method', owner: 'BookService', lsp: true });
  });

  it('maps the kinds', () => {
    expect(lspClassKind(5)).toBe('class');
    expect(lspClassKind(23)).toBe('struct');
    expect(lspClassKind(6)).toBeNull();
    expect(lspSymbolKind(12)).toBe('function');
    expect(lspSymbolKind(22)).toBe('enumCase');
    expect(lspSymbolKind(5)).toBeNull();
  });

  it('knows which files the index reads', () => {
    for (const p of ['/a/A.kt', '/a/b.kts', '/a/B.java', '/a/C.swift']) expect(isIndexedPath(p)).toBe(true);
    for (const p of ['/a/a.ts', '/a/b.py', '/a/Kt.txt']) expect(isIndexedPath(p)).toBe(false);
  });

  it('finds the language of a path', () => {
    expect(langOfPath('/a/b.tsx')).toBe('typescript');
    expect(langOfPath('/a/b.py')).toBe('python');
    expect(langOfPath('/a/Makefile')).toBe('other');
    expect(langOfPath('/a/b.dart')).toBe('dart');
    expect(langBadge('typescript')).toBe('TS');
    expect(langBadge('dart')).toBe('DART');
  });

  it('recognizes test files', () => {
    for (const p of ['/p/src/test/Foo.kt', '/p/a/__tests__/x.ts', '/p/a/x.test.ts', '/p/a/x.spec.js', '/p/a/FooTest.java', '/p/a/foo_test.go', '/p/a/test_foo.py']) {
      expect(isTestPath(p)).toBe(true);
    }
    for (const p of ['/p/src/main/Foo.kt', '/p/a/latest.ts', '/p/contest/a.ts']) expect(isTestPath(p)).toBe(false);
  });
});

describe('matchActions', () => {
  const actions = [
    { id: 'file.save', title: 'Save', category: 'File', keyLabel: '⌘S' },
    { id: 'file.saveAs', title: 'Save As...', category: 'File' },
    { id: 'git.refresh', title: 'Refresh', category: 'Git' },
  ];

  it('lists all actions by title for an empty query, recent ones first', () => {
    expect(matchActions(actions, '').map((a) => a.id)).toEqual(['git.refresh', 'file.save', 'file.saveAs']);
    expect(matchActions(actions, '', ['file.saveAs']).map((a) => a.id)[0]).toBe('file.saveAs');
  });

  it('matches the title, with the matched letters', () => {
    const rows = matchActions(actions, 'sav');
    expect(rows.map((a) => a.id)).toEqual(['file.save', 'file.saveAs']);
    expect(rows[0].nameMatches).toEqual([0, 1, 2]);
    expect(rows[0].keyLabel).toBe('⌘S');
  });

  it('matches the category when the title does not match', () => {
    expect(matchActions(actions, 'git').map((a) => a.id)).toEqual(['git.refresh']);
  });

  it('gives a recent action a small push', () => {
    const rows = matchActions(actions, 'sa', ['file.saveAs']);
    expect(rows[0].id).toBe('file.saveAs');
  });
});

describe('textRowsFromFiles', () => {
  const files = [
    {
      path: '/p/src/A.kt',
      matches: [
        { line: 42, text: 'val x = foo()', ranges: [[8, 11]] as [number, number][], offset: 4 },
        { line: 50, text: 'foo()', ranges: [[0, 3]] as [number, number][], offset: 0 },
      ],
    },
  ];
  it('makes one row per line with the real column', () => {
    const rows = textRowsFromFiles(files, (p) => p.replace('/p/', ''), 100);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ rel: 'src/A.kt', line: 42, column: 13, text: 'val x = foo()' });
    expect(rows[1].column).toBe(1);
  });
  it('stops at the maximum', () => {
    expect(textRowsFromFiles(files, (p) => p, 1)).toHaveLength(1);
  });
});

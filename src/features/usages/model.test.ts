import { describe, expect, it } from 'vitest';
import type { UsageFile, UsageKind, UsageMatch } from '../../ipc/code';
import {
  Expansion,
  KIND_ORDER,
  buildTree,
  countUsages,
  cutLine,
  describeSymbol,
  filterFiles,
  flatten,
  lspToResult,
  matchesFilter,
  nameColumn,
  parentIndex,
  pushHistory,
  segments,
  stepMatch,
  summaryText,
  wordAt,
  withTimeout,
} from './model';

const rel = (p: string) => p.replace('/work/', '');

function m(line: number, kind: UsageKind, text = `use ${line}`, column = 5): UsageMatch {
  return { line, column, text, range: [0, 3], kind };
}

function file(path: string, likely: boolean, matches: UsageMatch[]): UsageFile {
  return { path, likely, matches };
}

const FILES: UsageFile[] = [
  file('/work/b/Bar.kt', true, [m(9, 'call'), m(3, 'import'), m(5, 'type')]),
  file('/work/a/Foo.kt', true, [m(1, 'declaration'), m(20, 'call')]),
  file('/work/c/Other.kt', false, [m(7, 'reference')]),
];

describe('buildTree by kind', () => {
  const tree = buildTree(FILES, { groupBy: 'kind', filter: '', rel });
  it('orders groups by kind and hides empty ones', () => {
    const labels = tree.roots.map((r) => (r.type === 'group' ? r.label : ''));
    expect(labels).toEqual(['Declaration', 'Imports', 'Type uses', 'Calls', 'Same name, maybe other symbols (1)']);
    expect(KIND_ORDER.map((k) => k.label)).toEqual([
      'Declaration', 'Imports', 'Supertypes', 'New instances', 'Type uses', 'Calls', 'Other uses',
    ]);
  });
  it('sorts files by relative path and matches by line inside a group', () => {
    const calls = tree.roots[3]!;
    expect(calls.type).toBe('group');
    if (calls.type !== 'group') return;
    expect(calls.children.map((f) => f.rel)).toEqual(['a/Foo.kt', 'b/Bar.kt']);
    expect(calls.count).toBe(2);
    expect(calls.children[0]!.dir).toBe('a');
    expect(calls.children[0]!.name).toBe('Foo.kt');
  });
  it('puts files that are not likely in the last group', () => {
    const last = tree.roots[tree.roots.length - 1]!;
    expect(last.type === 'group' && last.maybe).toBe(true);
  });
  it('lists every match once, in tree order', () => {
    expect(tree.leaves.map((l) => `${rel(l.path)}:${l.match.line}`)).toEqual([
      'a/Foo.kt:1', 'b/Bar.kt:3', 'b/Bar.kt:5', 'a/Foo.kt:20', 'b/Bar.kt:9', 'c/Other.kt:7',
    ]);
    expect(new Set(tree.leaves.map((l) => l.id)).size).toBe(6);
  });
});

describe('buildTree by file', () => {
  const tree = buildTree(FILES, { groupBy: 'file', filter: '', rel });
  it('has files at the top and the maybe group last', () => {
    expect(tree.roots.map((r) => (r.type === 'file' ? r.rel : r.label))).toEqual([
      'a/Foo.kt', 'b/Bar.kt', 'Same name, maybe other symbols (1)',
    ]);
  });
  it('sorts the matches of a file by line', () => {
    const bar = tree.roots[1]!;
    expect(bar.type === 'file' && bar.children.map((c) => c.match.line)).toEqual([3, 5, 9]);
  });
  it('knows the parent of each node', () => {
    const leaf = tree.leaves[0]!;
    expect(tree.parent.get(leaf.id)).toBe(tree.roots[0]!.id);
    expect(tree.parent.get(tree.roots[0]!.id)).toBeUndefined();
  });
});

describe('filter', () => {
  it('matches words in the path or the line text', () => {
    expect(matchesFilter('a/Foo.kt', 'val x = save()', 'foo save')).toBe(true);
    expect(matchesFilter('a/Foo.kt', 'val x = save()', 'bar')).toBe(false);
    expect(matchesFilter('a/Foo.kt', 'x', '  ')).toBe(true);
  });
  it('keeps only the matching matches and drops empty files', () => {
    const files = [
      file('/work/a/Foo.kt', true, [m(1, 'call', 'alpha'), m(2, 'call', 'beta')]),
      file('/work/b/Bar.kt', true, [m(1, 'call', 'gamma')]),
    ];
    const out = filterFiles(files, 'beta', rel);
    expect(out).toHaveLength(1);
    expect(out[0]!.matches.map((x) => x.line)).toEqual([2]);
    expect(filterFiles(files, 'bar', rel)[0]!.matches).toHaveLength(1);
    expect(filterFiles(files, '', rel)).toBe(files);
  });
  it('is applied by buildTree', () => {
    const tree = buildTree(FILES, { groupBy: 'file', filter: 'other', rel });
    expect(tree.leaves).toHaveLength(1);
    expect(tree.roots).toHaveLength(1);
  });
});

describe('Expansion and flatten', () => {
  const tree = buildTree(FILES, { groupBy: 'kind', filter: '', rel });
  it('opens groups and files, and closes the maybe group at first', () => {
    const rows = flatten(tree, new Expansion());
    // 4 groups, 5 files and 5 matches in the open groups, then the closed maybe group
    expect(rows.map((r) => r.node.type[0]).join('')).toBe('gfmgfmgfmgfmfmg');
    expect(rows.filter((r) => r.node.type === 'match')).toHaveLength(5);
    expect(rows[rows.length - 1]!.open).toBe(false);
    expect(rows[0]!.depth).toBe(0);
    expect(rows[1]!.depth).toBe(1);
    expect(rows[2]!.depth).toBe(2);
  });
  it('opens the maybe group while a filter is active', () => {
    expect(flatten(tree, new Expansion(true)).filter((r) => r.node.type === 'match')).toHaveLength(6);
  });
  it('collapse all and expand all', () => {
    const ex = new Expansion();
    ex.collapseAll(tree);
    expect(flatten(tree, ex)).toHaveLength(tree.roots.length);
    ex.expandAll(tree);
    expect(flatten(tree, ex).filter((r) => r.node.type === 'match')).toHaveLength(6);
  });
  it('toggles one node', () => {
    const ex = new Expansion();
    ex.toggle(tree.roots[0]!);
    expect(flatten(tree, ex).some((r) => r.node.type === 'match' && r.node.match.line === 1)).toBe(false);
    ex.toggle(tree.roots[0]!);
    expect(flatten(tree, ex).some((r) => r.node.type === 'match' && r.node.match.line === 1)).toBe(true);
  });
  it('reveals a match inside a closed group', () => {
    const ex = new Expansion();
    const leaf = tree.leaves[tree.leaves.length - 1]!;
    expect(flatten(tree, ex).some((r) => r.node.id === leaf.id)).toBe(false);
    expect(ex.reveal(tree, leaf.id)).toBe(true);
    const rows = flatten(tree, ex);
    const i = rows.findIndex((r) => r.node.id === leaf.id);
    expect(i).toBeGreaterThan(0);
    expect(rows[parentIndex(rows, tree, i)]!.node.type).toBe('file');
    expect(ex.reveal(tree, leaf.id)).toBe(false);
  });
  it('handles 5000 matches', () => {
    const big = [file('/work/Big.kt', true, Array.from({ length: 5000 }, (_, i) => m(i + 1, 'call')))];
    const t = buildTree(big, { groupBy: 'kind', filter: '', rel });
    expect(flatten(t, new Expansion())).toHaveLength(5002);
  });
});

describe('stepMatch', () => {
  const tree = buildTree(FILES, { groupBy: 'kind', filter: '', rel });
  const order = tree.leaves;
  it('starts at the first or the last match', () => {
    expect(stepMatch(order, null, 1)).toBe(order[0]);
    expect(stepMatch(order, null, -1)).toBe(order[order.length - 1]);
  });
  it('moves and wraps', () => {
    expect(stepMatch(order, order[0]!.id, 1)).toBe(order[1]);
    expect(stepMatch(order, order[1]!.id, -1)).toBe(order[0]);
    expect(stepMatch(order, order[0]!.id, -1)).toBe(order[order.length - 1]);
    expect(stepMatch(order, order[order.length - 1]!.id, 1)).toBe(order[0]);
  });
  it('handles an unknown id and an empty list', () => {
    expect(stepMatch(order, 'nope', 1)).toBe(order[0]);
    expect(stepMatch([], null, 1)).toBeNull();
  });
});

describe('text helpers', () => {
  it('splits a line around the name', () => {
    expect(segments('val foo = 1', [4, 7])).toEqual([
      { text: 'val ', hit: false },
      { text: 'foo', hit: true },
      { text: ' = 1', hit: false },
    ]);
    expect(segments('foo', [0, 3])).toEqual([{ text: 'foo', hit: true }]);
    expect(segments('foo', [5, 9])).toEqual([{ text: 'foo', hit: false }]);
    expect(segments('', [0, 0])).toEqual([{ text: '', hit: false }]);
  });
  it('counts and describes', () => {
    expect(countUsages(FILES)).toEqual({ matches: 6, files: 3 });
    expect(summaryText(FILES, false)).toBe('6 usages in 3 files');
    expect(summaryText([file('/a', true, [m(1, 'call')])], true)).toBe('1 usage in 1 file (limit reached)');
    expect(summaryText([], false)).toBe('No usages found');
  });
  it('describes the symbol', () => {
    expect(describeSymbol({ name: 'save', kind: 'member', owner: 'a.Foo', lang: 'kotlin' }, 'x')).toEqual({
      kind: 'member', name: 'save', owner: 'a.Foo',
    });
    expect(describeSymbol({ name: 'Foo', kind: 'type', owner: 'a.Foo', lang: 'java' }, 'x')).toEqual({
      kind: 'type', name: 'Foo', owner: '',
    });
    expect(describeSymbol(null, 'x')).toEqual({ kind: '', name: 'x', owner: '' });
    expect(describeSymbol({ name: 'Foo', kind: 'type', detail: 'class', lang: 'kotlin' }, 'x').kind).toBe('class');
    expect(describeSymbol({ name: 'save', kind: 'member', detail: 'method', owner: 'a.Foo', lang: 'kotlin' }, 'x')).toEqual({
      kind: 'method', name: 'save', owner: 'a.Foo',
    });
    expect(describeSymbol({ name: 'A', kind: 'type', detail: 'typeAlias', lang: 'swift' }, 'x').kind).toBe('type alias');
  });
  it('finds the name at a column', () => {
    expect(wordAt('val fooBar = 1', 5)).toEqual({ from: 4, to: 10 });
    expect(wordAt('val fooBar = 1', 10)).toEqual({ from: 4, to: 10 });
    expect(wordAt('a + b', 1)).toEqual({ from: 0, to: 1 });
    expect(wordAt('a + b', 2)).toBeNull();
    expect(wordAt('(  )', 1)).toBeNull();
    expect(wordAt('', 0)).toBeNull();
  });
  it('moves a column after a name into the name', () => {
    expect(nameColumn('val fooBar = 1', 11)).toBe(10);
    expect(nameColumn('val fooBar = 1', 7)).toBe(7);
    expect(nameColumn('foo()', 5)).toBe(5);
  });
  it('cuts long lines around the name', () => {
    const text = 'x'.repeat(300) + 'NAME' + 'y'.repeat(300);
    const cut = cutLine(text, 300, 304);
    expect(cut.text.length).toBeLessThan(260);
    expect(cut.text.slice(cut.range[0], cut.range[1])).toBe('NAME');
    expect(cutLine('short', 1, 3)).toEqual({ text: 'short', range: [1, 3] });
    const near = cutLine('NAME' + 'y'.repeat(400), 0, 4);
    expect(near.text.slice(near.range[0], near.range[1])).toBe('NAME');
  });
});

describe('history', () => {
  const e = (key: string) => ({ key, label: key, data: key });
  it('puts the newest first and removes duplicates', () => {
    let list = pushHistory([], e('a'));
    list = pushHistory(list, e('b'));
    list = pushHistory(list, e('a'));
    expect(list.map((x) => x.key)).toEqual(['a', 'b']);
  });
  it('keeps 10 entries', () => {
    let list: ReturnType<typeof pushHistory<string>> = [];
    for (let i = 0; i < 15; i++) list = pushHistory(list, e(String(i)));
    expect(list).toHaveLength(10);
    expect(list[0]!.key).toBe('14');
    expect(list[9]!.key).toBe('5');
  });
});

describe('lspToResult', () => {
  const lines: Record<string, string[]> = {
    '/work/a/Foo.kt': ['class Foo {', '    fun save() {}', '}'],
    '/work/b/Bar.kt': ['import a.Foo', '', '    foo.save()  // save'],
  };
  const text = (p: string, l: number) => lines[p]?.[l] ?? '';
  const hits = [
    { path: '/work/b/Bar.kt', line: 2, character: 8, endLine: 2, endCharacter: 12 },
    { path: '/work/a/Foo.kt', line: 1, character: 8, endLine: 1, endCharacter: 12 },
    { path: '/work/b/Bar.kt', line: 0, character: 9, endLine: 0, endCharacter: 12 },
    { path: '/work/b/Bar.kt', line: 2, character: 8, endLine: 2, endCharacter: 12 },
  ];
  const r = lspToResult(hits, { path: '/work/a/Foo.kt', line: 2, column: 9 }, text, 'save', 12);
  it('groups by file and removes duplicates', () => {
    expect(r.files.map((f) => f.path)).toEqual(['/work/b/Bar.kt', '/work/a/Foo.kt']);
    expect(r.total).toBe(3);
    expect(r.source).toBe('lsp');
    expect(r.exact).toBe(true);
    expect(r.fileOnly).toBe(false);
    expect(r.files.every((f) => f.likely)).toBe(true);
  });
  it('marks the declaration, imports and references', () => {
    const kinds = Object.fromEntries(r.files.flatMap((f) => f.matches.map((x) => [`${f.path}:${x.line}`, x.kind])));
    expect(kinds).toEqual({
      '/work/a/Foo.kt:2': 'declaration',
      '/work/b/Bar.kt:1': 'import',
      '/work/b/Bar.kt:3': 'reference',
    });
  });
  it('trims the line and moves the range', () => {
    const decl = r.files[1]!.matches[0]!;
    expect(decl.text).toBe('fun save() {}');
    expect(decl.text.slice(decl.range[0], decl.range[1])).toBe('save');
    expect(decl.column).toBe(9);
    expect(decl.line).toBe(2);
  });
  it('sets the symbol', () => {
    expect(r.symbol).toEqual({ name: 'save', kind: 'unknown', lang: null });
    const noName = lspToResult(hits, { path: '/x', line: 1, column: 1 }, text, '', 0);
    expect(noName.symbol?.name).toBe('save');
  });
  it('stops at the maximum', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ path: '/work/a/Foo.kt', line: i, character: 0, endLine: i, endCharacter: 1 }));
    const cut = lspToResult(many, { path: '/x', line: 1, column: 1 }, () => 'abc', 'a', 0, 4);
    expect(cut.total).toBe(4);
    expect(cut.truncated).toBe(true);
  });
  it('treats an empty list', () => {
    const empty = lspToResult([], { path: '/x', line: 1, column: 1 }, text, 'a', 0);
    expect(empty.files).toEqual([]);
    expect(empty.total).toBe(0);
  });
});

describe('withTimeout', () => {
  it('passes the value', async () => {
    await expect(withTimeout(Promise.resolve(3), 50)).resolves.toBe(3);
  });
  it('rejects when too slow', async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow('timeout');
  });
  it('passes errors', async () => {
    await expect(withTimeout(Promise.reject(new Error('x')), 50)).rejects.toThrow('x');
  });
});

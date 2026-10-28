import { describe, expect, it } from 'vitest';
import type { CallTarget, CallerNode } from '../../ipc/code';
import {
  collapseAll,
  countNodes,
  createTree,
  edgeFromCaller,
  edgesFromLsp,
  expandAll,
  findNode,
  flattenCalls,
  isTestPath,
  itemFromTarget,
  revealNode,
  setCallers,
  type CallEdge,
  type CallNode,
  type Filters,
} from './call-model';
import { pushHistory } from './model';

const none: Filters = { hideTest: false };

function target(owner: string, name: string, over: Partial<CallTarget> = {}): CallTarget {
  return { owner, name, kind: 'method', params: 'id: Long', path: `/w/${owner}.kt`, line: 3, column: 9, lang: 'kotlin', ...over };
}

function edge(owner: string, name: string, over: Partial<CallEdge> = {}, sites = 1): CallEdge {
  const item = itemFromTarget(target(owner, name), 'src');
  return {
    item,
    sites: Array.from({ length: sites }, (_, i) => ({ line: 10 + i, column: 5, text: `${name}(1)`, range: [0, name.length] as [number, number] })),
    likely: true,
    test: false,
    ...over,
  };
}

const root = () => createTree(itemFromTarget(target('a.Foo', 'save'), ''), 'index', true);

describe('items', () => {
  it('builds titles and containers', () => {
    const i = itemFromTarget(target('jp.x.FooService', 'save'), 'src');
    expect(i.title).toBe('FooService.save(id: Long)');
    expect(i.container).toBe('jp.x');
    expect(itemFromTarget(target('', 'run', { kind: 'function', params: '' }), 'app/src').title).toBe('run()');
    expect(itemFromTarget(target('', 'run', { kind: 'function', params: '' }), 'app/src').container).toBe('app/src');
    expect(itemFromTarget(target('a.Foo', 'Foo', { kind: 'constructor', params: '' }), '').title).toBe('Foo()');
    expect(itemFromTarget(target('a.Foo', 'x', { kind: 'initializer', params: '' }), '').title).toBe('Foo (initializer)');
    expect(itemFromTarget(target('a.Foo', 'size', { kind: 'property', params: '' }), '').title).toBe('Foo.size');
  });
  it('maps a caller node', () => {
    const c: CallerNode = { caller: target('a.Bar', 'go'), sites: [], likely: false, test: true };
    const e = edgeFromCaller(c, () => 'f');
    expect(e.likely).toBe(false);
    expect(e.test).toBe(true);
    expect(e.item.title).toBe('Bar.go(id: Long)');
  });
  it('knows test paths', () => {
    expect(isTestPath('/p/src/test/kotlin/A.kt')).toBe(true);
    expect(isTestPath('/p/src/androidTest/A.kt')).toBe(true);
    expect(isTestPath('/p/src/main/FooTest.java')).toBe(true);
    expect(isTestPath('/p/src/main/a.spec.ts')).toBe(true);
    expect(isTestPath('/p/src/main/Foo.kt')).toBe(false);
    expect(isTestPath('/p/src/contest/Foo.kt')).toBe(false);
  });
});

describe('lazy tree and recursion', () => {
  it('starts with the open root that has no children yet', () => {
    const t = root();
    const rows = flattenCalls(t, none);
    expect(rows.map((r) => r.kind)).toEqual(['node', 'loading']);
  });
  it('lists sites, then callers, after loading', () => {
    const t = root();
    t.root.sites = [{ line: 1, column: 1, text: 'x', range: [0, 1] }];
    setCallers(t.root, [edge('a.Bar', 'go', {}, 2), edge('a.Baz', 'run')]);
    const rows = flattenCalls(t, none);
    expect(rows.map((r) => r.kind)).toEqual(['node', 'site', 'node', 'node']);
    expect(t.root.callers[0]!.depth).toBe(1);
    // A caller is closed, so its sites are not listed.
    expect(rows.filter((r) => r.kind === 'site')).toHaveLength(1);
    t.root.callers[0]!.open = true;
    t.root.callers[0]!.load = 'loaded';
    expect(flattenCalls(t, none).filter((r) => r.kind === 'site')).toHaveLength(3);
  });
  it('marks a caller that is on the path as recursive, and does not open it', () => {
    const t = root();
    setCallers(t.root, [edge('a.Bar', 'go'), edge('a.Foo', 'save')]);
    const rec = t.root.callers[1]!;
    expect(rec.recursive).toBe(true);
    expect(t.root.callers[0]!.recursive).toBe(false);
    rec.open = true;
    expect(flattenCalls(t, none).some((r) => r.kind === 'loading')).toBe(false);
    const deep = t.root.callers[0]!;
    setCallers(deep, [edge('a.Bar', 'go'), edge('a.Foo', 'save'), edge('a.Qux', 'q')]);
    expect(deep.callers.map((c) => c.recursive)).toEqual([true, true, false]);
  });
  it('shows loading, error and empty rows', () => {
    const t = root();
    setCallers(t.root, [edge('a.Bar', 'go')]);
    const n = t.root.callers[0]!;
    n.open = true;
    n.load = 'loading';
    expect(flattenCalls(t, none).at(-1)!.kind).toBe('loading');
    n.load = 'error';
    n.error = 'boom';
    const last = flattenCalls(t, none).at(-1)!;
    expect(last.kind === 'error' && last.text).toBe('boom');
    setCallers(n, []);
    const note = flattenCalls(t, none).at(-1)!;
    expect(note.kind === 'note' && note.text).toBe('No callers found.');
  });
  it('gives unique ids and finds nodes', () => {
    const t = root();
    setCallers(t.root, [edge('a.Bar', 'go'), edge('a.Bar', 'go')]);
    const ids = t.root.callers.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(findNode(t, ids[1]!)).toBe(t.root.callers[1]);
    expect(findNode(t, 'nope')).toBeNull();
    expect(countNodes(t)).toBe(3);
  });
});

describe('filters and the same-name group', () => {
  const build = () => {
    const t = root();
    setCallers(t.root, [
      edge('a.Bar', 'go', { test: true }),
      edge('a.Baz', 'run', { likely: false }),
      edge('a.Qux', 'q'),
      edge('a.Sam', 's', { likely: false, test: true }),
    ]);
    return t;
  };
  const kinds = (t: ReturnType<typeof root>, f: Filters) =>
    flattenCalls(t, f).map((r) => (r.kind === 'node' ? r.node.item.name : r.kind === 'group' ? `[${r.count}]` : r.kind));
  it('lists likely callers first, then a closed group', () => {
    expect(kinds(build(), none)).toEqual(['save', 'go', 'q', '[2]']);
    const g = flattenCalls(build(), none).at(-1)!;
    expect(g.kind === 'group' && g.label).toBe('Same name, maybe other methods (2)');
    expect(g.kind === 'group' && g.open).toBe(false);
  });
  it('opens the group and indents its callers one level deeper', () => {
    const t = build();
    t.root.sameOpen = true;
    const rows = flattenCalls(t, none);
    expect(rows.map((r) => `${r.kind}:${r.depth}`)).toEqual(['node:0', 'node:1', 'node:1', 'group:1', 'node:2', 'node:2']);
  });
  it('lets a same-name caller open and load like any other', () => {
    const t = build();
    t.root.sameOpen = true;
    const n = t.root.callers[1]!;
    n.open = true;
    expect(flattenCalls(t, none).some((r) => r.kind === 'loading' && r.node === n)).toBe(true);
  });
  it('hides test code in both parts', () => {
    expect(kinds(build(), { hideTest: true })).toEqual(['save', 'q', '[1]']);
  });
  it('says "No direct callers found." above the group when only same-name callers exist', () => {
    const t = root();
    setCallers(t.root, [edge('a.Baz', 'run', { likely: false })]);
    const rows = flattenCalls(t, none);
    expect(rows.map((r) => r.kind)).toEqual(['node', 'note', 'group']);
    const note = rows[1]!;
    expect(note.kind === 'note' && note.text).toBe('No direct callers found.');
  });
  it('says so when the test filter hides everything', () => {
    const t = root();
    setCallers(t.root, [edge('a.Bar', 'go', { test: true })]);
    const last = flattenCalls(t, { hideTest: true }).at(-1)!;
    expect(last.kind === 'note' && last.text).toBe('The filters hide all direct callers.');
  });
  it('shows no group when the only same-name callers are test code that is hidden', () => {
    const t = root();
    setCallers(t.root, [edge('a.Sam', 's', { likely: false, test: true })]);
    expect(flattenCalls(t, { hideTest: true }).map((r) => r.kind)).toEqual(['node', 'note']);
  });
});

describe('collapse and reveal', () => {
  it('keeps only the root open', () => {
    const t = root();
    setCallers(t.root, [edge('a.Bar', 'go')]);
    t.root.callers[0]!.open = true;
    t.root.sameOpen = true;
    collapseAll(t);
    expect(t.root.open).toBe(true);
    expect(t.root.sameOpen).toBe(false);
    expect(t.root.callers[0]!.open).toBe(false);
  });
  it('opens the parents of a node', () => {
    const t = root();
    setCallers(t.root, [edge('a.Bar', 'go')]);
    const a = t.root.callers[0]!;
    setCallers(a, [edge('a.Q', 'q')]);
    t.root.open = false;
    revealNode(a.callers[0]!);
    expect(t.root.open && a.open).toBe(true);
  });
});

describe('reveal of a same-name caller', () => {
  it('opens the group too', () => {
    const t = root();
    setCallers(t.root, [edge('a.Baz', 'run', { likely: false })]);
    const n = t.root.callers[0]!;
    revealNode(n);
    expect(t.root.sameOpen).toBe(true);
    expect(flattenCalls(t, none).some((r) => r.kind === 'node' && r.node === n)).toBe(true);
  });
});

describe('expandAll', () => {
  /** Every node has `fan` callers, all different. */
  function loader(fan: number, calls: string[] = []) {
    return async (n: CallNode) => {
      calls.push(n.id);
      setCallers(n, Array.from({ length: fan }, (_, i) => edge(`p.T${n.depth}x${i}x${n.id.length}`, `m${i}`)));
    };
  }
  it('opens to depth 3', async () => {
    const t = root();
    const calls: string[] = [];
    const r = await expandAll(t, none, loader(2, calls), { cancelled: () => false });
    // root + 2 + 4 + 8 = 15 nodes; nodes at depth 3 are shown but not loaded.
    expect(r).toEqual({ nodes: 15, limited: false });
    expect(calls).toHaveLength(1 + 2 + 4);
    expect(countNodes(t)).toBe(15);
    const rows = flattenCalls(t, none);
    expect(rows.filter((x) => x.kind === 'node')).toHaveLength(15);
  });
  it('stops adding nodes at the limit', async () => {
    const t = root();
    const r = await expandAll(t, none, loader(10), { cancelled: () => false, maxNodes: 50 });
    expect(r.limited).toBe(true);
    expect(r.nodes).toBe(50);
  });
  it('can be cancelled', async () => {
    const t = root();
    let stop = false;
    const calls: string[] = [];
    const load = async (n: CallNode) => {
      await loader(2, calls)(n);
      stop = true;
    };
    await expandAll(t, none, load, { cancelled: () => stop });
    expect(calls).toHaveLength(1);
    expect(t.root.callers[0]!.load).toBe('idle');
  });
  it('skips loaded nodes, errors and recursive nodes', async () => {
    const t = root();
    setCallers(t.root, [edge('a.Foo', 'save'), edge('a.Bad', 'x')]);
    const calls: string[] = [];
    const load = async (n: CallNode) => {
      calls.push(n.item.name);
      n.load = 'error';
      n.error = 'x';
    };
    await expandAll(t, none, load, { cancelled: () => false });
    expect(calls).toEqual(['x']);
    expect(t.root.open).toBe(true);
  });
  it('does not count hidden callers', async () => {
    const t = root();
    setCallers(t.root, [edge('a.A', 'a', { test: true }), edge('a.B', 'b')]);
    const r = await expandAll(t, { hideTest: true }, async (n) => setCallers(n, []), { cancelled: () => false });
    expect(r.nodes).toBe(2);
  });
  it('does not open or count the same-name groups, and does not load their callers', async () => {
    const t = root();
    setCallers(t.root, [edge('a.A', 'a'), edge('a.S1', 's1', { likely: false }), edge('a.S2', 's2', { likely: false })]);
    const loaded: string[] = [];
    const r = await expandAll(
      t,
      none,
      async (n) => {
        loaded.push(n.item.name);
        setCallers(n, []);
      },
      { cancelled: () => false },
    );
    expect(r.nodes).toBe(2);
    expect(loaded).toEqual(['a']);
    expect(t.root.sameOpen).toBe(false);
    expect(t.root.callers[1]!.load).toBe('idle');
  });
});

describe('language server mapping', () => {
  const pathOf = (u: string) => (u.startsWith('file://') ? u.slice(7) : null);
  const lines: Record<string, string[]> = {
    '/w/Bar.kt': ['class Bar {', '    fun go() {', '        foo.save(1)', '        save(2) }'],
  };
  const text = (p: string, l: number) => lines[p]?.[l] ?? '';
  const sel = { start: { line: 1, character: 8 }, end: { line: 1, character: 10 } };
  const calls = [
    {
      from: { name: 'go', kind: 6, detail: 'a.Bar', uri: 'file:///w/Bar.kt', range: sel, selectionRange: sel },
      fromRanges: [
        { start: { line: 3, character: 8 }, end: { line: 3, character: 12 } },
        { start: { line: 2, character: 12 }, end: { line: 2, character: 16 } },
      ],
    },
    { from: { name: 'x', kind: 6, uri: 'http://nope', range: sel, selectionRange: sel }, fromRanges: [] },
  ];
  const edges = edgesFromLsp(calls, pathOf, () => 'folder', text);
  it('skips items that are not files', () => expect(edges).toHaveLength(1));
  it('maps the item', () => {
    const i = edges[0]!.item;
    expect(i).toMatchObject({ name: 'go', kindWord: 'method', owner: 'Bar', container: 'folder', path: '/w/Bar.kt', line: 2, column: 9, nameLength: 2 });
    expect(i.lsp).toBe(calls[0]!.from);
    expect(edges[0]!.likely).toBe(true);
  });
  it('maps call sites sorted by line, with the name range in the trimmed text', () => {
    const s = edges[0]!.sites;
    expect(s.map((x) => x.line)).toEqual([3, 4]);
    expect(s[0]!.text).toBe('foo.save(1)');
    expect(s[0]!.text.slice(s[0]!.range[0], s[0]!.range[1])).toBe('save');
    expect(s[1]!.text.slice(s[1]!.range[0], s[1]!.range[1])).toBe('save');
  });
  it('uses detail as the container when it is not a type name', () => {
    const e = edgesFromLsp([{ from: { ...calls[0]!.from, detail: 'fun go(): Unit' }, fromRanges: [] }], pathOf, () => 'folder', text);
    expect(e[0]!.item.container).toBe('fun go(): Unit');
    expect(e[0]!.item.owner).toBe('');
  });
  it('flags test files', () => {
    const t = { ...calls[0]!.from, uri: 'file:///w/src/test/BarTest.kt' };
    expect(edgesFromLsp([{ from: t, fromRanges: [] }], pathOf, () => '', text)[0]!.test).toBe(true);
  });
});

describe('history of roots', () => {
  it('keeps the last 10 and moves a repeated root to the front', () => {
    let h: ReturnType<typeof pushHistory<number>> = [];
    for (let i = 0; i < 12; i++) h = pushHistory(h, { key: String(i), label: String(i), data: i });
    expect(h).toHaveLength(10);
    h = pushHistory(h, { key: '5', label: '5', data: 99 });
    expect(h[0]!.data).toBe(99);
    expect(h).toHaveLength(10);
  });
});

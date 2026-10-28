import { describe, expect, it } from 'vitest';
import { EDGES, node, NODES, RESULT } from './fixture';
import {
  annotationName,
  displayName,
  kindStereotype,
  matchScore,
  memberLine,
  mergeResults,
  neighborMap,
  pickNeighbor,
  scopeOfNodes,
  searchNodes,
  stereotypeLines,
  tabTitle,
  visibilityMark,
  visibleMembers,
  withoutHidden,
} from './model';
import { member } from './fixture';

const byId = (id: string) => NODES.find((n) => n.id === id)!;

describe('stereotypes', () => {
  it('names the kind', () => {
    expect(stereotypeLines(byId('demo.Repo'))).toEqual(['«interface»']);
    expect(stereotypeLines(byId('demo.User'))).toEqual(['«data»']);
    expect(stereotypeLines(byId('demo.Base'))).toEqual(['«abstract»']);
    expect(kindStereotype({ kind: 'class', modifiers: [] })).toBeNull();
    expect(kindStereotype({ kind: 'protocol', modifiers: [] })).toBe('protocol');
    expect(kindStereotype({ kind: 'object', modifiers: [] })).toBe('object');
    expect(kindStereotype({ kind: 'struct', modifiers: [] })).toBe('struct');
    expect(kindStereotype({ kind: 'actor', modifiers: [] })).toBe('actor');
    expect(kindStereotype({ kind: 'record', modifiers: [] })).toBe('record');
    expect(kindStereotype({ kind: 'enum', modifiers: [] })).toBe('enum');
  });

  it('adds at most two annotations, short and without arguments', () => {
    expect(stereotypeLines(byId('demo.UserRepo'))).toEqual(['«Service»', '«Transactional»']);
    expect(annotationName('@a.b.Foo(x = 1)')).toBe('Foo');
    expect(annotationName('@field:Inject')).toBe('Inject');
  });

  it('shows type parameters after the name', () => {
    expect(displayName(byId('demo.Repo'))).toBe('Repo<T, ID>');
    expect(displayName(byId('demo.User'))).toBe('User');
  });
});

describe('members', () => {
  it('uses the UML visibility marks', () => {
    expect(visibilityMark('public')).toBe('+');
    expect(visibilityMark('private')).toBe('-');
    expect(visibilityMark('protected')).toBe('#');
    expect(visibilityMark('package')).toBe('~');
    expect(visibilityMark('internal')).toBe('~');
  });

  it('writes member lines', () => {
    expect(memberLine(member({ name: 'find', params: 'id: Long', type: 'User?' }))).toBe('+ find(id: Long): User?');
    expect(memberLine(member({ name: 'users', kind: 'field', visibility: 'private', type: 'List<User>' }))).toBe('- users: List<User>');
    expect(memberLine(member({ name: 'run', kind: 'method', visibility: 'protected' }))).toBe('# run()');
    expect(memberLine(member({ name: 'A', kind: 'enumCase' }))).toBe('+ A');
    expect(memberLine(member({ name: 'x', params: 'a'.repeat(100) }), 20)).toHaveLength(20);
  });

  it('filters members by mode', () => {
    const repo = byId('demo.Repo');
    expect(visibleMembers(repo, 'none').methods).toHaveLength(0);
    expect(visibleMembers(repo, 'public').methods.map((m) => m.name)).toEqual(['find']);
    expect(visibleMembers(repo, 'all').methods).toHaveLength(2);
    const swift = node({ id: 's.A', name: 'A', lang: 'swift', methods: [member({ name: 'go', visibility: 'internal' }), member({ name: 'hide', visibility: 'private' })] });
    expect(visibleMembers(swift, 'public').methods.map((m) => m.name)).toEqual(['go']);
    const kt = node({ id: 'k.A', name: 'A', lang: 'kotlin', methods: [member({ name: 'go', visibility: 'internal' })] });
    expect(visibleMembers(kt, 'public').methods).toHaveLength(0);
  });
});

describe('search', () => {
  it('ranks exact, prefix, initials and substring matches', () => {
    const list = [node({ id: 'a.FooServiceImpl', name: 'FooServiceImpl' }), node({ id: 'a.Foo', name: 'Foo' }), node({ id: 'a.MyFoo', name: 'MyFoo' }), node({ id: 'a.Bar', name: 'Bar' })];
    expect(searchNodes(list, 'foo').map((n) => n.name)).toEqual(['Foo', 'FooServiceImpl', 'MyFoo']);
    expect(searchNodes(list, 'FSI').map((n) => n.name)).toEqual(['FooServiceImpl']);
    expect(searchNodes(list, '  ')).toEqual([]);
    expect(searchNodes(list, 'zzz')).toEqual([]);
  });

  it('matches the container as a weak hint', () => {
    expect(matchScore({ id: 'x', name: 'A', container: 'jp.example' }, 'jp.example')).toBeGreaterThan(0);
    expect(matchScore({ id: 'x', name: 'A', container: 'jp.example' }, 'nothing')).toBe(0);
  });
});

describe('graph helpers', () => {
  it('merges results without double nodes or edges', () => {
    const extra = {
      ...RESULT,
      nodes: [byId('demo.Base'), node({ id: 'demo.New', name: 'New' })],
      edges: [EDGES[1], { from: 'demo.New', to: 'demo.Base', kind: 'extends' as const }],
      focus: ['demo.New'],
    };
    const m = mergeResults(RESULT, extra, 150);
    expect(m.nodes).toHaveLength(NODES.length + 1);
    expect(m.edges).toHaveLength(EDGES.length + 1);
    expect(m.focus).toEqual(['demo.UserRepo']);
    const small = mergeResults(RESULT, extra, NODES.length);
    expect(small.truncated).toBe(true);
    expect(small.nodes).toHaveLength(NODES.length);
    expect(small.edges.every((e) => small.nodes.some((n) => n.id === e.to))).toBe(true);
  });

  it('lowers or clears the hidden count of the expanded node', () => {
    const hub = node({ id: 'h.Hub', name: 'Hub', hiddenIn: 3, hiddenOut: 2 });
    const base = { ...RESULT, nodes: [hub], edges: [], focus: ['h.Hub'] };
    const a = node({ id: 'h.A', name: 'A' });
    const b = node({ id: 'h.B', name: 'B' });
    const c = node({ id: 'h.C', name: 'C' });
    const extra = {
      ...RESULT,
      nodes: [hub, a, b, c],
      edges: [
        { from: 'h.A', to: 'h.Hub', kind: 'composition' as const },
        { from: 'h.B', to: 'h.Hub', kind: 'extends' as const },
        { from: 'h.C', to: 'h.Hub', kind: 'extends' as const },
      ],
    };
    const all = mergeResults(base, extra, 200, { id: 'h.Hub', direction: 'in' });
    const h1 = all.nodes.find((n) => n.id === 'h.Hub')!;
    expect(h1.hiddenIn).toBeUndefined();
    expect(h1.hiddenOut).toBe(2);
    const part = mergeResults(base, { ...extra, nodes: [hub, a], edges: [extra.edges[0]] }, 200, { id: 'h.Hub', direction: 'in' });
    expect(part.nodes.find((n) => n.id === 'h.Hub')!.hiddenIn).toBe(2);
    expect(base.nodes[0].hiddenIn).toBe(3); // the old result is not changed
  });

  it('hides nodes and their edges', () => {
    const r = withoutHidden(RESULT, new Set(['demo.Base']));
    expect(r.nodes.find((n) => n.id === 'demo.Base')).toBeUndefined();
    expect(r.edges.some((e) => e.from === 'demo.Base' || e.to === 'demo.Base')).toBe(false);
    expect(withoutHidden(RESULT, new Set())).toBe(RESULT);
  });

  it('builds the neighbor map in both directions', () => {
    const m = neighborMap(EDGES);
    expect([...(m.get('demo.Base') ?? [])].sort()).toEqual(['demo.User', 'demo.UserRepo']);
    expect(m.get('demo.Repo')?.has('demo.UserRepo')).toBe(true);
  });

  it('picks the neighbor in the arrow direction', () => {
    const from = { x: 100, y: 100 };
    const cands = [
      { id: 'up', x: 100, y: 0 },
      { id: 'down', x: 110, y: 200 },
      { id: 'right', x: 300, y: 105 },
    ];
    expect(pickNeighbor(from, cands, 'ArrowUp')).toBe('up');
    expect(pickNeighbor(from, cands, 'ArrowDown')).toBe('down');
    expect(pickNeighbor(from, cands, 'ArrowRight')).toBe('right');
    expect(pickNeighbor(from, cands, 'ArrowLeft')).toBeNull();
  });

  it('makes the tab title and the scope of kept nodes', () => {
    expect(tabTitle({ kind: 'cursor', path: '/a/B.kt' }, [{ name: 'Foo' }])).toBe('Foo');
    expect(tabTitle({ kind: 'cursor', path: '/a/B.kt' }, [])).toBe('B.kt');
    expect(tabTitle({ kind: 'file', path: '/a/B.kt' }, [{ name: 'X' }])).toBe('B.kt');
    expect(tabTitle({ kind: 'folder', path: '/a/b/' }, [])).toBe('b');
    expect(tabTitle({ kind: 'types' }, [{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe('A +2');
    expect(scopeOfNodes(NODES).ids).not.toContain('ext:JpaRepository');
  });
});

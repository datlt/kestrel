import { describe, expect, it } from 'vitest';
import type { VisibleGraph } from '../types';
import { bigGraph, makeGraph, makeInput, sampleGraph, seeded } from './fixtures';
import { bundlePath, buildVisibleGraph, treeLayout } from './index';

function build(graph = sampleGraph(), options = {}, extra = {}): VisibleGraph {
  return buildVisibleGraph(makeInput(graph, { options: { layout: 'radial', ...options }, ...extra }));
}
const at = (g: VisibleGraph, pos: Float64Array, id: string): [number, number] => {
  const i = g.nodes.findIndex((n) => n.id === id);
  if (i < 0) throw new Error(`no node ${id}`);
  return [pos[i * 2], pos[i * 2 + 1]];
};
const radius = (p: [number, number]): number => Math.hypot(p[0], p[1]);
const isLeaf = (g: VisibleGraph, i: number): boolean => !g.nodes.some((n) => n.parent === g.nodes[i].id);

describe('treeLayout: radial', () => {
  it('gives two numbers per node, all finite, root at the center', () => {
    const g = build();
    const pos = treeLayout(g, 'radial');
    expect(pos).toBeInstanceOf(Float64Array);
    expect(pos.length).toBe(g.nodes.length * 2);
    expect([...pos].every(Number.isFinite)).toBe(true);
    expect(at(g, pos, 'f:')).toEqual([0, 0]);
  });

  it('is deterministic', () => {
    const g = build();
    expect([...treeLayout(g, 'radial')]).toEqual([...treeLayout(g, 'radial')]);
  });

  it('puts the leaves on the outer circle and children farther out than their folder', () => {
    const g = build();
    const pos = treeLayout(g, 'radial');
    const leafRadius = g.nodes.map((_, i) => i).filter((i) => isLeaf(g, i)).map((i) => radius([pos[i * 2], pos[i * 2 + 1]]));
    expect(Math.max(...leafRadius) - Math.min(...leafRadius)).toBeLessThan(1e-6);
    for (const [i, n] of g.nodes.entries()) {
      if (!n.parent) continue;
      expect(radius([pos[i * 2], pos[i * 2 + 1]])).toBeGreaterThan(radius(at(g, pos, n.parent)) - 1e-9);
    }
  });

  it('gives each leaf label about 14 px on the outer circle', () => {
    const graph = bigGraph(1500, 0, 3);
    const g = build(graph);
    const pos = treeLayout(g, 'radial');
    const leaves = g.nodes.map((_, i) => i).filter((i) => isLeaf(g, i));
    const sorted = leaves.map((i) => ({ a: Math.atan2(pos[i * 2 + 1], pos[i * 2]), x: pos[i * 2], y: pos[i * 2 + 1] })).sort((p, q) => p.a - q.a);
    let min = Infinity;
    for (let k = 0; k < sorted.length; k++) {
      const p = sorted[k];
      const q = sorted[(k + 1) % sorted.length];
      min = Math.min(min, Math.hypot(p.x - q.x, p.y - q.y));
    }
    expect(min).toBeGreaterThan(13.9);
  });

  it('grows the radius with the number of leaves', () => {
    const small = build(bigGraph(100, 0, 1));
    const large = build(bigGraph(2000, 0, 1));
    const maxR = (g: VisibleGraph): number => {
      const p = treeLayout(g, 'radial');
      let m = 0;
      for (let i = 0; i < g.nodes.length; i++) m = Math.max(m, Math.hypot(p[i * 2], p[i * 2 + 1]));
      return m;
    };
    expect(maxR(large)).toBeGreaterThan(maxR(small) * 5);
  });

  it('keeps nodes apart', () => {
    const g = build();
    const pos = treeLayout(g, 'radial');
    for (let i = 0; i < g.nodes.length; i++) {
      for (let j = i + 1; j < g.nodes.length; j++) {
        expect(Math.hypot(pos[i * 2] - pos[j * 2], pos[i * 2 + 1] - pos[j * 2 + 1])).toBeGreaterThan(5);
      }
    }
  });

  it('puts tag nodes in a group of their own, on the outer circle', () => {
    const g = build(sampleGraph(), { showTags: true });
    const pos = treeLayout(g, 'radial');
    const tags = g.nodes.filter((n) => n.kind === 'tag');
    expect(tags.length).toBeGreaterThan(0);
    const leafR = radius(at(g, pos, 'n:Home.md'));
    for (const t of tags) expect(radius(at(g, pos, t.id))).toBeCloseTo(leafR, 6);
    expect([...pos].every(Number.isFinite)).toBe(true);
  });

  it('treats collapsed folders as leaves', () => {
    const g = build(sampleGraph(), {}, { folders: { collapsed: ['docs'], hidden: [] } });
    const pos = treeLayout(g, 'radial');
    expect(radius(at(g, pos, 'f:docs'))).toBeCloseTo(radius(at(g, pos, 'n:Home.md')), 6);
  });

  it('works without folder nodes', () => {
    const g = build(sampleGraph(), { layout: 'force', showFolders: false });
    expect(g.nodes.some((n) => n.kind === 'folder')).toBe(false);
    const pos = treeLayout(g, 'radial');
    expect([...pos].every(Number.isFinite)).toBe(true);
    const tpos = treeLayout(g, 'tree');
    expect([...tpos].every(Number.isFinite)).toBe(true);
  });

  it('works for empty graphs, one node and folder scope', () => {
    expect(treeLayout(build(makeGraph({})), 'radial').length).toBe(0);
    const one = build(makeGraph({ notes: ['a.md'] }));
    expect([...treeLayout(one, 'radial')].every(Number.isFinite)).toBe(true);
    const scoped = build(sampleGraph(), {}, { scope: { kind: 'folder', path: '/vault/docs' } });
    const pos = treeLayout(scoped, 'radial');
    expect(at(scoped, pos, 'f:docs')).toEqual([0, 0]);
  });
});

describe('treeLayout: tree', () => {
  it('goes from left to right, one column for each folder level', () => {
    const g = build(sampleGraph(), { layout: 'tree' });
    const pos = treeLayout(g, 'tree');
    for (const [i, n] of g.nodes.entries()) {
      if (!n.parent) continue;
      expect(pos[i * 2]).toBeGreaterThan(at(g, pos, n.parent)[0]);
    }
    // Same depth, same column.
    expect(at(g, pos, 'f:docs')[0]).toBeCloseTo(at(g, pos, 'f:notes')[0], 9);
    expect(at(g, pos, 'n:docs/Intro.md')[0]).toBeCloseTo(at(g, pos, 'n:Home.md')[0] + 200, 9);
  });

  it('is centered on 0, 0', () => {
    const g = build(sampleGraph(), { layout: 'tree' });
    const pos = treeLayout(g, 'tree');
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.length; i += 2) {
      minX = Math.min(minX, pos[i]);
      maxX = Math.max(maxX, pos[i]);
      minY = Math.min(minY, pos[i + 1]);
      maxY = Math.max(maxY, pos[i + 1]);
    }
    expect((minX + maxX) / 2).toBeCloseTo(0, 6);
    expect((minY + maxY) / 2).toBeCloseTo(0, 6);
  });

  it('gives each leaf a row of at least 14 px', () => {
    const g = build(bigGraph(1500, 0, 5), { layout: 'tree' });
    const pos = treeLayout(g, 'tree');
    const rows = g.nodes.map((_, i) => i).filter((i) => isLeaf(g, i)).map((i) => pos[i * 2 + 1]).sort((a, b) => a - b);
    let min = Infinity;
    for (let k = 1; k < rows.length; k++) min = Math.min(min, rows[k] - rows[k - 1]);
    expect(min).toBeGreaterThanOrEqual(14 - 1e-6);
  });

  it('puts tags in a group inside the root', () => {
    const g = build(sampleGraph(), { layout: 'tree', showTags: true });
    const pos = treeLayout(g, 'tree');
    const tags = g.nodes.filter((n) => n.kind === 'tag');
    expect(tags.length).toBeGreaterThan(0);
    const rootX = at(g, pos, 'f:')[0];
    for (const t of tags) expect(at(g, pos, t.id)[0]).toBeGreaterThan(rootX);
  });
});

describe('bundlePath', () => {
  const g = build();
  const pos = treeLayout(g, 'radial');
  const edgeIndex = (from: string, to: string): number =>
    g.edges.findIndex((e) => e.kind === 'link' && g.nodes[e.source].rel === from && g.nodes[e.target].rel === to);
  const point = (path: number[], k: number): [number, number] => [path[k * 2], path[k * 2 + 1]];

  it('goes through the folder for two notes in the same folder', () => {
    const path = bundlePath(g, edgeIndex('docs/api/Auth.md', 'docs/api/Users.md'), pos, 1);
    expect(path).toHaveLength(6);
    expect(point(path, 0)).toEqual(at(g, pos, 'n:docs/api/Auth.md'));
    expect(point(path, 1)).toEqual(at(g, pos, 'f:docs/api'));
    expect(point(path, 2)).toEqual(at(g, pos, 'n:docs/api/Users.md'));
  });

  it('goes up to the lowest common folder and down to the target', () => {
    const path = bundlePath(g, edgeIndex('notes/ideas/Idea.md', 'Home.md'), pos, 1);
    const expected = ['n:notes/ideas/Idea.md', 'f:notes/ideas', 'f:notes', 'f:', 'n:Home.md'].map((id) => at(g, pos, id));
    expect(path).toHaveLength(expected.length * 2);
    expected.forEach((p, k) => {
      expect(point(path, k)[0]).toBeCloseTo(p[0], 9);
      expect(point(path, k)[1]).toBeCloseTo(p[1], 9);
    });
  });

  it('goes down on both sides for notes in different folders', () => {
    const path = bundlePath(g, edgeIndex('Home.md', 'docs/Intro.md'), pos, 1);
    const expected = ['n:Home.md', 'f:', 'f:docs', 'n:docs/Intro.md'].map((id) => at(g, pos, id));
    expect(path).toHaveLength(expected.length * 2);
    expected.forEach((p, k) => expect(point(path, k)).toEqual(p));
    // Intro to Auth: lowest common folder is docs.
    const p2 = bundlePath(g, edgeIndex('docs/Intro.md', 'docs/api/Auth.md'), pos, 1);
    expect(p2).toHaveLength(8);
    expect(point(p2, 1)).toEqual(at(g, pos, 'f:docs'));
  });

  it('gives the straight line with beta 0', () => {
    const e = edgeIndex('notes/ideas/Idea.md', 'Home.md');
    const path = bundlePath(g, e, pos, 0);
    const a = at(g, pos, 'n:notes/ideas/Idea.md');
    const b = at(g, pos, 'n:Home.md');
    const n = path.length / 2;
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);
      expect(path[k * 2]).toBeCloseTo(a[0] + t * (b[0] - a[0]), 9);
      expect(path[k * 2 + 1]).toBeCloseTo(a[1] + t * (b[1] - a[1]), 9);
    }
  });

  it('straightens with beta like Holten 2006', () => {
    const e = edgeIndex('notes/ideas/Idea.md', 'Home.md');
    const full = bundlePath(g, e, pos, 1);
    const none = bundlePath(g, e, pos, 0);
    const half = bundlePath(g, e, pos, 0.5);
    for (let k = 0; k < full.length; k++) expect(half[k]).toBeCloseTo(0.5 * full[k] + 0.5 * none[k], 9);
  });

  it('keeps the end points at the nodes for every beta', () => {
    const e = edgeIndex('notes/ideas/Idea.md', 'Home.md');
    for (const beta of [0, 0.3, 0.85, 1]) {
      const path = bundlePath(g, e, pos, beta);
      const a = at(g, pos, 'n:notes/ideas/Idea.md');
      const b = at(g, pos, 'n:Home.md');
      expect(path[0]).toBeCloseTo(a[0], 9);
      expect(path[1]).toBeCloseTo(a[1], 9);
      expect(path[path.length - 2]).toBeCloseTo(b[0], 9);
      expect(path[path.length - 1]).toBeCloseTo(b[1], 9);
    }
  });

  it('clamps beta and accepts bad numbers', () => {
    const e = edgeIndex('notes/ideas/Idea.md', 'Home.md');
    expect(bundlePath(g, e, pos, 5)).toEqual(bundlePath(g, e, pos, 1));
    expect(bundlePath(g, e, pos, -5)).toEqual(bundlePath(g, e, pos, 0));
    expect(bundlePath(g, e, pos, NaN).every(Number.isFinite)).toBe(true);
  });

  it('returns an empty path for an unknown edge and a straight line when there is no common folder', () => {
    expect(bundlePath(g, -1, pos, 1)).toEqual([]);
    expect(bundlePath(g, 9999, pos, 1)).toEqual([]);
    const tg = build(sampleGraph(), { showTags: true });
    const tpos = treeLayout(tg, 'radial');
    const tagEdge = tg.edges.findIndex((x) => x.kind === 'tag');
    expect(bundlePath(tg, tagEdge, tpos, 1)).toHaveLength(4);
  });

  it('works without folder nodes (straight line)', () => {
    const fg = build(sampleGraph(), { layout: 'force', showFolders: false });
    const fpos = new Float64Array(fg.nodes.length * 2).map((_, i) => i * 3);
    const path = bundlePath(fg, 0, fpos, 1);
    expect(path).toHaveLength(4);
  });

  it('is fast for many edges', () => {
    const big = build(bigGraph(3000, 12000, 2));
    const bpos = treeLayout(big, 'radial');
    const start = performance.now();
    let total = 0;
    for (let e = 0; e < big.edges.length; e++) if (big.edges[e].kind === 'link') total += bundlePath(big, e, bpos, 0.85).length;
    const ms = performance.now() - start;
    expect(total).toBeGreaterThan(0);
    expect(ms).toBeLessThan(200);
  });
});

describe('seeded', () => {
  it('repeats', () => {
    const a = seeded(7);
    const b = seeded(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

import { polygonContains, polygonArea } from 'd3-polygon';
import { describe, expect, it } from 'vitest';
import type { FolderHull, VisibleGraph } from '../types';
import { bigGraph, makeGraph, makeInput, sampleGraph, seeded } from './fixtures';
import { buildVisibleGraph, folderHulls, nodeRadius } from './index';

function build(graph = sampleGraph(), options = {}, extra = {}): VisibleGraph {
  return buildVisibleGraph(makeInput(graph, { options: { layout: 'force', ...options }, ...extra }));
}

function randomPositions(g: VisibleGraph, seed = 1, spread = 400): Float64Array {
  const rnd = seeded(seed);
  const pos = new Float64Array(g.nodes.length * 2);
  for (let i = 0; i < pos.length; i++) pos[i] = (rnd() - 0.5) * spread;
  return pos;
}

function polygon(h: FolderHull): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < h.points.length; i += 2) out.push([h.points[i], h.points[i + 1]]);
  return out;
}

/** Distance from a point to the border of a polygon. */
function distanceToBorder(p: [number, number], poly: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

const membersOf = (g: VisibleGraph, folderRel: string): number[] =>
  g.nodes.map((_, i) => i).filter((i) => {
    const n = g.nodes[i];
    if (n.kind === 'tag') return false;
    const rel = n.kind === 'folder' ? n.rel : n.parent!.slice(2);
    return rel === folderRel || rel.startsWith(`${folderRel}/`);
  });

describe('folderHulls', () => {
  it('gives one hull for each folder except the root, shallow ones first', () => {
    const g = build();
    const hulls = folderHulls(g, randomPositions(g), 10);
    expect(hulls.map((h) => h.id).sort()).toEqual(['f:docs', 'f:docs/api', 'f:notes', 'f:notes/ideas']);
    const depths = hulls.map((h) => h.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(hulls.find((h) => h.id === 'f:docs/api')).toMatchObject({ depth: 2, label: 'api' });
    expect(hulls.find((h) => h.id === 'f:docs')!.color).toBe(g.nodes.find((n) => n.id === 'f:docs')!.color);
    for (const h of hulls) expect(h.points.length).toBeGreaterThanOrEqual(6);
  });

  it('holds all nodes inside the folder, with room for the node radius and the padding', () => {
    const g = build();
    const pos = randomPositions(g, 5);
    const pad = 10;
    for (const h of folderHulls(g, pos, pad)) {
      const poly = polygon(h);
      for (const i of membersOf(g, h.id.slice(2))) {
        const p: [number, number] = [pos[i * 2], pos[i * 2 + 1]];
        expect(polygonContains(poly, p), `${g.nodes[i].id} in ${h.id}`).toBe(true);
        expect(distanceToBorder(p, poly), `${g.nodes[i].id} in ${h.id}`).toBeGreaterThanOrEqual(nodeRadius(g.nodes[i], 1) + pad - 1e-6);
      }
    }
  });

  it('keeps the outline of an inner folder inside its parent', () => {
    const g = build(bigGraph(600, 0, 4));
    const pos = randomPositions(g, 9, 800);
    const hulls = folderHulls(g, pos, 12);
    const byId = new Map(hulls.map((h) => [h.id, h]));
    let checked = 0;
    for (const h of hulls) {
      const parentId = g.nodes.find((n) => n.id === h.id)!.parent!;
      const parent = byId.get(parentId);
      if (!parent) continue;
      const outer = polygon(parent);
      for (const p of polygon(h)) {
        // A point on the border can be a hair outside because of rounding, so test with a tolerance.
        expect(polygonContains(outer, p) || distanceToBorder(p, outer) < 1e-6, `${h.id} in ${parentId}`).toBe(true);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('gives deeper folders less padding', () => {
    // docs holds only the folder api, so both outlines have the same nodes.
    const graph = makeGraph({ notes: ['docs/api/a.md', 'docs/api/b.md', 'other/c.md'] });
    const g = build(graph);
    const pos = randomPositions(g, 2, 300);
    const hulls = folderHulls(g, pos, 10);
    const area = (id: string): number => Math.abs(polygonArea(polygon(hulls.find((h) => h.id === id)!)));
    expect(area('f:docs')).toBeGreaterThan(area('f:docs/api'));
  });

  it('draws a circle-like polygon around a folder with one node', () => {
    const graph = makeGraph({ notes: ['solo/a.md', 'b.md'] });
    const g = build(graph, { showFolders: false });
    const pos = new Float64Array(g.nodes.length * 2);
    const i = g.nodes.findIndex((n) => n.id === 'n:solo/a.md');
    pos[i * 2] = 100;
    pos[i * 2 + 1] = -50;
    const hull = folderHulls(g, pos, 8).find((h) => h.id === 'f:solo')!;
    const poly = polygon(hull);
    expect(poly.length).toBeGreaterThanOrEqual(8);
    const r = nodeRadius(g.nodes[i], 1) + 8;
    for (const p of poly) {
      const d = Math.hypot(p[0] - 100, p[1] + 50);
      expect(d).toBeGreaterThanOrEqual(r - 1e-6);
      expect(d).toBeLessThan(r * 1.05);
    }
  });

  it('works without folder nodes and takes the color the nodes share', () => {
    const g = build(sampleGraph(), { showFolders: false });
    const hulls = folderHulls(g, randomPositions(g), 10);
    expect(hulls.map((h) => h.id).sort()).toEqual(['f:docs', 'f:docs/api', 'f:notes', 'f:notes/ideas']);
    const docs = hulls.find((h) => h.id === 'f:docs')!;
    expect(docs.label).toBe('docs');
    expect(docs.depth).toBe(1);
    expect(docs.color).toBe(g.nodes.find((n) => n.id === 'n:docs/Intro.md')!.color);
  });

  it('treats a collapsed folder as a node inside its parent', () => {
    const g = build(sampleGraph(), {}, { folders: { collapsed: ['docs/api'], hidden: [] } });
    const pos = randomPositions(g, 3);
    const hulls = folderHulls(g, pos, 10);
    expect(hulls.some((h) => h.id === 'f:docs/api')).toBe(false);
    const docs = polygon(hulls.find((h) => h.id === 'f:docs')!);
    const i = g.nodes.findIndex((n) => n.id === 'f:docs/api');
    expect(polygonContains(docs, [pos[i * 2], pos[i * 2 + 1]])).toBe(true);
  });

  it('gives no outline for the folder that starts a folder scope', () => {
    const g = build(sampleGraph(), {}, { scope: { kind: 'folder', path: '/vault/docs' } });
    expect(folderHulls(g, randomPositions(g), 10).map((h) => h.id)).toEqual(['f:docs/api']);
  });

  it('handles collinear nodes, equal positions and odd padding', () => {
    const g = build();
    const line = new Float64Array(g.nodes.length * 2);
    for (let i = 0; i < g.nodes.length; i++) line[i * 2] = i * 30;
    for (const pos of [line, new Float64Array(g.nodes.length * 2)]) {
      for (const pad of [0, 10, -5, NaN, Infinity]) {
        const hulls = folderHulls(g, pos, pad);
        expect(hulls.length).toBe(4);
        for (const h of hulls) if (Number.isFinite(pad)) expect(h.points.every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('returns nothing for an empty graph or a graph without folders', () => {
    const empty = build(makeGraph({}));
    expect(folderHulls(empty, new Float64Array(0), 10)).toEqual([]);
    const flat = build(makeGraph({ notes: ['a.md', 'b.md'], links: [['a.md', 'b.md']] }), { showFolders: false });
    expect(folderHulls(flat, randomPositions(flat), 10)).toEqual([]);
  });

  it('follows the positions on every call and does not keep old results', () => {
    const g = build();
    const a = folderHulls(g, randomPositions(g, 1), 10);
    const b = folderHulls(g, randomPositions(g, 2), 10);
    const a2 = folderHulls(g, randomPositions(g, 1), 10);
    expect(a2).toEqual(a);
    expect(b).not.toEqual(a);
  });
});

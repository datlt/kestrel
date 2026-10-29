import { describe, expect, it } from 'vitest';
import { flattenFolders, defaultExpanded, findFolder } from './folder-rows';
import { sameNoteGraph } from './graph-diff';
import { makeFixtureGraph } from './fixture';
import { buildAdjacency, folderHighlight, isUnderFolder, nodeHighlight } from './highlight';
import { labelAlpha, labelFontPx } from './labels';
import { classifyOptionChange } from './option-changes';
import { seedPositions } from './positions';
import type { FolderNode, GraphOptions, VEdge, VisibleGraph, VNode } from './types';

const OPTS: GraphOptions = {
  layout: 'force', query: '', showTags: false, showAttachments: false, existingOnly: false, showOrphans: true, showFolders: true, folderOutlines: true, folderPull: 0.3,
  colorBy: 'folder', colorDepth: 1, groups: [], arrows: false, labelBy: 'name', textFade: 0, nodeSize: 1, linkThickness: 1, bundling: 0.85, centerForce: 0.5, repelForce: 10,
  linkForce: 1, linkDistance: 250, depth: 1, incoming: true, outgoing: true, neighborLinks: true,
};

function node(id: string, rel: string, parent: string | null, kind: VNode['kind'] = 'note'): VNode {
  return { id, kind, label: rel, path: '/r/' + rel, rel, parent, depth: 1, degree: 0, color: null, weight: 1, collapsed: false, active: false, source: -1 };
}
const edge = (source: number, target: number): VEdge => ({ source, target, kind: 'link', count: 1, embed: false, both: false });
function graph(nodes: VNode[], edges: VEdge[]): VisibleGraph {
  return { nodes, edges, stats: { notes: nodes.length, scopeNotes: nodes.length, links: edges.length }, emptyReason: null };
}

describe('highlight', () => {
  const g = graph([node('f:a', 'a', 'f:'), node('n:a/x.md', 'a/x.md', 'f:a'), node('n:a/y.md', 'a/y.md', 'f:a'), node('n:b/z.md', 'b/z.md', 'f:b'), node('t:tag', 'tag', null, 'tag')], [edge(1, 2), edge(2, 3), edge(1, 4)]);
  it('builds the edge lists of each node', () => {
    const adj = buildAdjacency(5, g.edges);
    expect(Array.from(adj.start)).toEqual([0, 0, 2, 4, 5, 6]);
    const at2 = Array.from(adj.other.slice(adj.start[2], adj.start[3])).sort();
    expect(at2).toEqual([1, 3]);
  });
  it('keeps the node, its edges and its neighbors bright', () => {
    const adj = buildAdjacency(5, g.edges);
    const h = nodeHighlight(g, adj, 2);
    expect(Array.from(h.nodes)).toEqual([0, 1, 1, 1, 0]);
    expect(Array.from(h.edges)).toEqual([1, 1, 0]);
    expect(h.focus).toBe(2);
  });
  it('lights the nodes inside a folder', () => {
    const h = folderHighlight(g, 'a');
    expect(Array.from(h.nodes)).toEqual([1, 1, 1, 0, 0]);
    expect(Array.from(h.edges)).toEqual([1, 0, 0]);
    expect(Array.from(folderHighlight(g, '').nodes)).toEqual([1, 1, 1, 1, 0]);
  });
  it('tests folder paths on whole names', () => {
    expect(isUnderFolder('docs/a.md', 'docs')).toBe(true);
    expect(isUnderFolder('docs2/a.md', 'docs')).toBe(false);
    expect(isUnderFolder('docs', 'docs')).toBe(true);
    expect(isUnderFolder('x.md', '')).toBe(true);
  });
});

describe('seedPositions', () => {
  const g = graph([node('n:a', 'a.md', 'f:'), node('n:b', 'b.md', 'f:'), node('n:c', 'c.md', 'f:x'), node('n:d', 'd.md', 'f:x')], [edge(0, 1), edge(2, 3)]);
  it('uses a spiral without old positions', () => {
    const { pos, fresh } = seedPositions(g, new Map());
    expect(fresh).toBe(4);
    expect(new Set(Array.from(pos)).size).toBe(8);
  });
  it('keeps old positions and puts new nodes next to a neighbor', () => {
    const kept = new Map<string, [number, number]>([['n:a', [500, 500]]]);
    const { pos, fresh } = seedPositions(g, kept);
    expect(fresh).toBe(3);
    expect(pos[0]).toBe(500);
    expect(Math.hypot(pos[2] - 500, pos[3] - 500)).toBeLessThan(40);
  });
  it('puts a new node next to the folder mates', () => {
    const g2 = graph([node('n:c', 'x/c.md', 'f:x'), node('n:d', 'x/d.md', 'f:x')], []);
    const { pos } = seedPositions(g2, new Map([['n:c', [-300, 200]]]));
    expect(Math.hypot(pos[2] + 300, pos[3] - 200)).toBeLessThan(40);
  });
  it('is the same every time', () => {
    const kept = new Map<string, [number, number]>([['n:a', [1, 2]]]);
    expect(Array.from(seedPositions(g, kept).pos)).toEqual(Array.from(seedPositions(g, kept).pos));
  });
});

describe('labelAlpha', () => {
  it('hides labels that would be tiny and shows them when zoomed in', () => {
    expect(labelAlpha(0.2, 0, 0)).toBe(0);
    expect(labelAlpha(0.43, 0, 0)).toBe(0);
    expect(labelAlpha(5, 0, 0)).toBe(1);
    const mid = labelAlpha(0.52, 0, 0);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
  it('shows labels later with a higher text fade', () => {
    expect(labelAlpha(1, 3, 0)).toBeLessThan(labelAlpha(1, 0, 0));
    expect(labelAlpha(0.6, -3, 0)).toBe(1);
  });
  it('shows linked nodes earlier', () => {
    expect(labelAlpha(0.45, 0, 30)).toBeGreaterThan(labelAlpha(0.45, 0, 0));
  });
  it('makes the font smaller when zoomed out', () => {
    expect(labelFontPx(0.43)).toBeLessThan(labelFontPx(1));
    expect(labelFontPx(100)).toBe(14);
  });
});

describe('classifyOptionChange', () => {
  it('knows what needs a new graph', () => {
    const c = classifyOptionChange(OPTS, { ...OPTS, showTags: true });
    expect(c.rebuild).toBe(true);
    expect(c.forces).toBe(false);
  });
  it('sends only force changes to the simulation', () => {
    const c = classifyOptionChange(OPTS, { ...OPTS, repelForce: 3 });
    expect(c).toMatchObject({ rebuild: false, forces: true, any: true });
  });
  it('redraws for display options', () => {
    const c = classifyOptionChange(OPTS, { ...OPTS, arrows: true });
    expect(c).toMatchObject({ rebuild: false, forces: false, radius: false, any: true });
  });
  it('sees changes in groups and the color depth', () => {
    expect(classifyOptionChange(OPTS, { ...OPTS, groups: [{ query: 'a', color: '#fff' }] }).rebuild).toBe(true);
    expect(classifyOptionChange(OPTS, { ...OPTS, colorDepth: 2 }).tree).toBe(true);
    expect(classifyOptionChange(OPTS, { ...OPTS, nodeSize: 2 }).radius).toBe(true);
    expect(classifyOptionChange(OPTS, { ...OPTS }).any).toBe(false);
  });
});

describe('folder rows', () => {
  const mk = (rel: string, children: FolderNode[] = []): FolderNode => ({ rel, name: rel || 'root', path: '/r/' + rel, depth: 0, children, notes: 1, totalNotes: 1, color: null });
  const root = mk('', [mk('a', [mk('a/b', [mk('a/b/c')])]), mk('z')]);
  it('opens the first two levels at first', () => {
    const rows = flattenFolders(root, defaultExpanded(root));
    expect(rows.map((r) => r.node.rel)).toEqual(['', 'a', 'a/b', 'z']);
    expect(rows.map((r) => r.level)).toEqual([0, 1, 2, 1]);
    expect(rows[1].expanded).toBe(true);
    expect(rows[2].expanded).toBe(false);
  });
  it('shows a deeper folder when it is open', () => {
    const rows = flattenFolders(root, new Set(['', 'a', 'a/b']));
    expect(rows.map((r) => r.node.rel)).toEqual(['', 'a', 'a/b', 'a/b/c', 'z']);
  });
  it('finds a folder by path', () => {
    expect(findFolder(root, '/r/a/b')?.rel).toBe('a/b');
    expect(findFolder(root, '/r/none')).toBeNull();
  });
});

describe('fixture and graph diff', () => {
  it('gives the same graph for the same seed', () => {
    const a = makeFixtureGraph({ notes: 80, seed: 5 });
    const b = makeFixtureGraph({ notes: 80, seed: 5 });
    expect(sameNoteGraph(a, b)).toBe(true);
    expect(sameNoteGraph(a, makeFixtureGraph({ notes: 80, seed: 6 }))).toBe(false);
  });
  it('follows the contract of NoteGraph', () => {
    const g = makeFixtureGraph({ notes: 300, seed: 2 });
    const kinds = g.nodes.map((n) => n.kind);
    expect(kinds.indexOf('attachment')).toBeGreaterThan(kinds.lastIndexOf('note') - 1);
    for (let i = 1; i < g.links.length; i++) {
      const p = g.links[i - 1];
      const l = g.links[i];
      expect(p.from < l.from || (p.from === l.from && p.to < l.to)).toBe(true);
    }
    for (const l of g.links) {
      expect(g.nodes[l.from].kind).toBe('note');
      expect(l.from).not.toBe(l.to);
    }
  });
  it('notices a changed note', () => {
    const a = makeFixtureGraph({ notes: 30, seed: 1 });
    const b = structuredClone(a);
    expect(sameNoteGraph(a, b)).toBe(true);
    b.nodes[3].mtimeMs += 1;
    expect(sameNoteGraph(a, b)).toBe(false);
  });
});

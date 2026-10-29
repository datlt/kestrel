import { describe, expect, it } from 'vitest';
import type { VisibleGraph, VNode } from '../types';
import { PALETTE_DARK, PALETTE_LIGHT } from './colors';
import { makeGraph, makeInput, ROOT, sampleGraph } from './fixtures';
import { buildVisibleGraph, nodeRadius } from './index';

const ids = (g: VisibleGraph): string[] => g.nodes.map((n) => n.id);
const byId = (g: VisibleGraph, id: string): VNode => {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id} in ${ids(g).join(', ')}`);
  return n;
};
const linkPairs = (g: VisibleGraph): string[] =>
  g.edges
    .filter((e) => e.kind === 'link')
    .map((e) => `${g.nodes[e.source].rel}>${g.nodes[e.target].rel}`)
    .sort();
const fileIds = (g: VisibleGraph): string[] => g.nodes.filter((n) => n.kind !== 'folder' && n.kind !== 'tag').map((n) => n.id);

function checkParents(g: VisibleGraph): void {
  const index = new Map(g.nodes.map((n, i) => [n.id, i]));
  g.nodes.forEach((n, i) => {
    if (n.kind === 'folder' && n.parent !== null) expect(index.get(n.parent), `${n.id} parent`).toBeLessThan(i);
  });
}

describe('buildVisibleGraph: project scope', () => {
  const g = buildVisibleGraph(makeInput(sampleGraph()));

  it('puts folders first, parents before children, then files', () => {
    expect(ids(g)).toEqual([
      'f:',
      'f:docs',
      'f:docs/api',
      'f:notes',
      'f:notes/ideas',
      'n:Home.md',
      'n:docs/Intro.md',
      'n:docs/api/Auth.md',
      'n:docs/api/Users.md',
      'n:notes/Daily.md',
      'n:notes/ideas/Idea.md',
      'n:docs/Todo.md',
    ]);
    checkParents(g);
  });

  it('sets parent, depth, path, rel, source and labels', () => {
    expect(byId(g, 'f:')).toMatchObject({ kind: 'folder', label: 'vault', path: '/vault', rel: '', parent: null, depth: 0, source: -1 });
    expect(byId(g, 'f:docs/api')).toMatchObject({ label: 'api', path: '/vault/docs/api', parent: 'f:docs', depth: 2 });
    expect(byId(g, 'n:Home.md')).toMatchObject({ kind: 'note', label: 'Home', path: '/vault/Home.md', parent: 'f:', depth: 1, source: 0, weight: 1 });
    expect(byId(g, 'n:docs/api/Auth.md')).toMatchObject({ parent: 'f:docs/api', depth: 3, source: 2 });
    expect(byId(g, 'n:docs/Todo.md')).toMatchObject({ kind: 'missing', source: 7 });
  });

  it('hides attachments by default and counts degree without tree edges', () => {
    expect(ids(g)).not.toContain('n:docs/logo.png');
    expect(byId(g, 'n:Home.md').degree).toBe(3);
    expect(byId(g, 'n:docs/api/Auth.md').degree).toBe(3);
    expect(byId(g, 'n:docs/Todo.md').degree).toBe(1);
    expect(byId(g, 'f:docs').degree).toBe(0);
  });

  it('merges both directions into one edge and sums counts', () => {
    expect(linkPairs(g)).toEqual([
      'Home.md>docs/Intro.md',
      'Home.md>notes/Daily.md',
      'docs/Intro.md>docs/api/Auth.md',
      'docs/api/Auth.md>docs/Todo.md',
      'docs/api/Auth.md>docs/api/Users.md',
      'notes/ideas/Idea.md>Home.md',
    ]);
    const pair = g.edges.find((e) => g.nodes[e.source].rel === 'docs/api/Auth.md' && g.nodes[e.target].rel === 'docs/api/Users.md')!;
    expect(pair).toMatchObject({ both: true, count: 2, kind: 'link' });
    const daily = g.edges.find((e) => g.nodes[e.target].rel === 'notes/Daily.md' && e.kind === 'link')!;
    expect(daily).toMatchObject({ both: false, count: 2 });
    expect(g.edges.filter((e) => e.both)).toHaveLength(1);
  });

  it('adds one tree edge from every node to its folder', () => {
    const tree = g.edges.filter((e) => e.kind === 'tree');
    expect(tree).toHaveLength(g.nodes.length - 1);
    for (const e of tree) {
      expect(g.nodes[e.target].kind).toBe('folder');
      expect(g.nodes[e.source].parent).toBe(g.nodes[e.target].id);
      expect(e).toMatchObject({ count: 1, both: false, embed: false });
    }
  });

  it('fills the stats', () => {
    expect(g.stats).toEqual({ notes: 6, scopeNotes: 6, links: 6 });
    expect(g.emptyReason).toBeNull();
  });

  it('gives only valid edge indices', () => {
    for (const e of g.edges) {
      expect(e.source).toBeGreaterThanOrEqual(0);
      expect(e.target).toBeLessThan(g.nodes.length);
    }
  });
});

describe('buildVisibleGraph: filters', () => {
  it('shows attachments and marks embeds', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { options: { showAttachments: true } }));
    expect(byId(g, 'n:docs/logo.png')).toMatchObject({ kind: 'attachment', label: 'logo.png', parent: 'f:docs' });
    const e = g.edges.find((x) => g.nodes[x.target].rel === 'docs/logo.png')!;
    expect(e.embed).toBe(true);
    expect(g.edges.filter((x) => x.kind === 'link' && x.embed)).toHaveLength(1);
  });

  it('hides missing nodes with existingOnly', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { options: { existingOnly: true } }));
    expect(ids(g)).not.toContain('n:docs/Todo.md');
    expect(byId(g, 'n:docs/api/Auth.md').degree).toBe(2);
  });

  it('filters with the query on rel path, tag and title', () => {
    const q = (query: string, extra = {}): string[] => fileIds(buildVisibleGraph(makeInput(sampleGraph(), { options: { query, ...extra } })));
    expect(q('docs/api')).toEqual(['n:docs/api/Auth.md', 'n:docs/api/Users.md']);
    expect(q('tag:guide')).toEqual(['n:docs/Intro.md', 'n:docs/api/Auth.md']);
    expect(q('title:introduction')).toEqual(['n:docs/Intro.md']);
    expect(q('todo')).toEqual(['n:docs/Todo.md']);
    expect(q('logo', { showAttachments: true })).toEqual(['n:docs/logo.png']);
    expect(q('logo')).toEqual([]);
  });

  it('does not filter on a broken query', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { options: { query: '"open' } }));
    expect(g.stats.notes).toBe(6);
  });

  it('removes folders without visible nodes below them', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { options: { query: 'docs/api' } }));
    expect(ids(g).filter((i) => i.startsWith('f:'))).toEqual(['f:', 'f:docs', 'f:docs/api']);
    expect(g.stats).toMatchObject({ notes: 2, scopeNotes: 6 });
  });

  it('hides folders with everything below them', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { folders: { collapsed: [], hidden: ['docs'] } }));
    expect(fileIds(g)).toEqual(['n:Home.md', 'n:notes/Daily.md', 'n:notes/ideas/Idea.md']);
    expect(ids(g)).not.toContain('f:docs');
    expect(g.stats.notes).toBe(3);
    // The link to a hidden note is gone and so is the degree.
    expect(byId(g, 'n:Home.md').degree).toBe(2);
  });

  it('hides a nested folder only', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { folders: { collapsed: [], hidden: ['docs/api'] } }));
    expect(ids(g)).toContain('f:docs');
    expect(ids(g)).not.toContain('f:docs/api');
    expect(ids(g)).toContain('n:docs/Intro.md');
    // The missing node Todo.md is in docs, so it stays, but its only link came from Auth.md.
    expect(byId(g, 'n:docs/Todo.md').degree).toBe(0);
  });

  it('ignores the root in hidden and collapsed', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { folders: { collapsed: [''], hidden: [''] } }));
    expect(g.stats.notes).toBe(6);
    expect(ids(g)).toContain('f:');
  });
});

describe('buildVisibleGraph: orphans', () => {
  const graph = makeGraph({ notes: ['a.md', 'b.md', 'lonely.md', 'dir/alone.md'], links: [['a.md', 'b.md']] });

  it('shows orphans by default', () => {
    const g = buildVisibleGraph(makeInput(graph));
    expect(fileIds(g)).toHaveLength(4);
    expect(byId(g, 'n:lonely.md').degree).toBe(0);
  });

  it('removes nodes with degree 0 and the folders that become empty', () => {
    const g = buildVisibleGraph(makeInput(graph, { options: { showOrphans: false } }));
    expect(fileIds(g)).toEqual(['n:a.md', 'n:b.md']);
    expect(ids(g)).toEqual(['f:', 'n:a.md', 'n:b.md']);
    expect(g.stats).toMatchObject({ notes: 2, scopeNotes: 4 });
  });

  it('counts a tag edge as a degree', () => {
    const g2 = makeGraph({ notes: [{ rel: 'a.md', tags: ['x'] }, 'b.md'] });
    const g = buildVisibleGraph(makeInput(g2, { options: { showOrphans: false, showTags: true } }));
    expect(ids(g)).toEqual(['f:', 'n:a.md', 't:x']);
  });

  it('keeps folder nodes that are not orphans themselves', () => {
    const g = buildVisibleGraph(makeInput(graph, { options: { showOrphans: false } }));
    expect(byId(g, 'f:').degree).toBe(0);
  });
});

describe('buildVisibleGraph: tags', () => {
  const graph = makeGraph({
    notes: [
      { rel: 'a.md', tags: ['Project/Kestrel', 'todo'] },
      { rel: 'b.md', tags: ['project/kestrel', 'TODO'] },
      { rel: 'c.md', tags: [] },
    ],
    links: [['a.md', 'b.md']],
  });

  it('makes one node per lower case tag, the first spelling as the label', () => {
    const g = buildVisibleGraph(makeInput(graph, { options: { showTags: true } }));
    const tags = g.nodes.filter((n) => n.kind === 'tag');
    expect(tags.map((t) => t.id)).toEqual(['t:project/kestrel', 't:todo']);
    expect(tags[0]).toMatchObject({ label: '#Project/Kestrel', rel: 'Project/Kestrel', path: null, parent: null, depth: 0, degree: 2, source: -1, weight: 1 });
    expect(tags[1].label).toBe('#todo');
    expect(g.edges.filter((e) => e.kind === 'tag')).toHaveLength(4);
    expect(g.edges.find((e) => e.kind === 'tag')).toMatchObject({ count: 1, both: false });
  });

  it('puts tags after the files and gives no tree edges to tags', () => {
    const g = buildVisibleGraph(makeInput(graph, { options: { showTags: true } }));
    expect(ids(g).slice(-2)).toEqual(['t:project/kestrel', 't:todo']);
    for (const e of g.edges.filter((x) => x.kind === 'tree')) expect(g.nodes[e.source].kind).not.toBe('tag');
    expect(byId(g, 'n:a.md').degree).toBe(3);
  });

  it('has no tag nodes without showTags', () => {
    expect(buildVisibleGraph(makeInput(graph)).nodes.some((n) => n.kind === 'tag')).toBe(false);
  });

  it('does not link nested tags to their parent tag', () => {
    const g2 = makeGraph({ notes: [{ rel: 'a.md', tags: ['a/b/c'] }] });
    const g = buildVisibleGraph(makeInput(g2, { options: { showTags: true } }));
    expect(g.nodes.filter((n) => n.kind === 'tag').map((n) => n.id)).toEqual(['t:a/b/c']);
  });

  it('tags only notes that pass the filters', () => {
    const g = buildVisibleGraph(makeInput(graph, { options: { showTags: true, query: 'c.md' } }));
    expect(g.nodes.some((n) => n.kind === 'tag')).toBe(false);
  });
});

describe('buildVisibleGraph: folders', () => {
  it('has no folder nodes with showFolders off, but parent ids stay', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { options: { showFolders: false } }));
    expect(g.nodes.some((n) => n.kind === 'folder')).toBe(false);
    expect(g.edges.some((e) => e.kind === 'tree')).toBe(false);
    expect(byId(g, 'n:docs/Intro.md').parent).toBe('f:docs');
  });

  it('always has folders in radial and tree layouts', () => {
    for (const layout of ['radial', 'tree'] as const) {
      const g = buildVisibleGraph(makeInput(sampleGraph(), { options: { showFolders: false, layout } }));
      expect(ids(g)[0]).toBe('f:');
      expect(g.edges.some((e) => e.kind === 'tree')).toBe(true);
    }
  });
});

describe('buildVisibleGraph: collapsed folders', () => {
  const collapsed = (c: string[], extra = {}) => buildVisibleGraph(makeInput(sampleGraph(), { folders: { collapsed: c, hidden: [] }, ...extra }));

  it('makes one node with the weight and moves the edges', () => {
    const g = collapsed(['docs']);
    expect(ids(g)).toEqual(['f:', 'f:docs', 'f:notes', 'f:notes/ideas', 'n:Home.md', 'n:notes/Daily.md', 'n:notes/ideas/Idea.md']);
    expect(byId(g, 'f:docs')).toMatchObject({ kind: 'folder', collapsed: true, weight: 3, parent: 'f:', depth: 1, source: -1, label: 'docs' });
    // Home to Intro now goes to the folder. The links inside docs are gone. Todo is inside docs.
    expect(linkPairs(g)).toEqual(['Home.md>docs', 'Home.md>notes/Daily.md', 'notes/ideas/Idea.md>Home.md']);
    expect(byId(g, 'f:docs').degree).toBe(1);
    expect(g.stats.notes).toBe(6);
  });

  it('sums the counts of merged edges', () => {
    const graph = makeGraph({
      notes: ['a.md', 'd/x.md', 'd/y.md'],
      links: [{ from: 'a.md', to: 'd/x.md', count: 2 }, { from: 'a.md', to: 'd/y.md', count: 3 }, ['d/x.md', 'a.md']],
    });
    const g = buildVisibleGraph(makeInput(graph, { folders: { collapsed: ['d'], hidden: [] } }));
    const links = g.edges.filter((e) => e.kind === 'link');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ count: 6, both: true });
    expect(g.nodes[links[0].source].id).toBe('n:a.md');
  });

  it('counts the folder as a tree edge target and keeps it with showFolders off', () => {
    const g = collapsed(['docs'], { options: { showFolders: false } });
    expect(ids(g)).toEqual(['f:docs', 'n:Home.md', 'n:notes/Daily.md', 'n:notes/ideas/Idea.md']);
    expect(byId(g, 'f:docs')).toMatchObject({ collapsed: true, weight: 3, parent: 'f:' });
    expect(g.edges.some((e) => e.kind === 'tree')).toBe(false);
  });

  it('uses only the outermost collapsed folder', () => {
    const g = collapsed(['docs/api', 'docs']);
    expect(ids(g).filter((i) => i.startsWith('f:'))).toEqual(['f:', 'f:docs', 'f:notes', 'f:notes/ideas']);
    expect(byId(g, 'f:docs').weight).toBe(3);
  });

  it('collapses a nested folder inside its parent', () => {
    const g = collapsed(['docs/api']);
    expect(byId(g, 'f:docs/api')).toMatchObject({ collapsed: true, weight: 2, parent: 'f:docs', depth: 2 });
    expect(ids(g)).not.toContain('n:docs/api/Auth.md');
    expect(ids(g)).toContain('n:docs/Intro.md');
    // The link Auth to Users is inside the folder. Intro to Auth now goes to the folder.
    expect(linkPairs(g)).toContain('docs/Intro.md>docs/api');
  });

  it('counts the notes inside after filters', () => {
    const g = collapsed(['docs'], { options: { query: 'Auth OR Users OR Home OR Daily OR Idea' } });
    expect(byId(g, 'f:docs').weight).toBe(2);
  });

  it('keeps a folder whose notes have no links (orphans)', () => {
    const graph = makeGraph({ notes: ['a.md', 'd/x.md', 'd/y.md'], links: [] });
    const g = buildVisibleGraph(makeInput(graph, { folders: { collapsed: ['d'], hidden: [] }, options: { showOrphans: false } }));
    expect(ids(g)).toContain('f:d');
    expect(ids(g)).not.toContain('n:a.md');
  });

  it('lets a hidden folder win over a collapsed one', () => {
    const g = collapsed(['docs']);
    const h = buildVisibleGraph(makeInput(sampleGraph(), { folders: { collapsed: ['docs'], hidden: ['docs'] } }));
    expect(ids(g)).toContain('f:docs');
    expect(ids(h)).not.toContain('f:docs');
  });

  it('ignores a collapsed folder that does not exist', () => {
    expect(collapsed(['nope', 'docs/nope']).stats.notes).toBe(6);
  });
});

describe('buildVisibleGraph: folder scope', () => {
  const scope = { kind: 'folder' as const, path: `${ROOT}/docs` };

  it('starts the tree at the folder and keeps notes inside it, with their attachments and missing nodes', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { scope, options: { showAttachments: true } }));
    expect(ids(g)).toEqual([
      'f:docs',
      'f:docs/api',
      'n:docs/Intro.md',
      'n:docs/api/Auth.md',
      'n:docs/api/Users.md',
      'n:docs/logo.png',
      'n:docs/Todo.md',
    ]);
    expect(byId(g, 'f:docs')).toMatchObject({ parent: null, depth: 0, label: 'docs' });
    expect(byId(g, 'f:docs/api')).toMatchObject({ parent: 'f:docs', depth: 1 });
    expect(byId(g, 'n:docs/Intro.md')).toMatchObject({ parent: 'f:docs', depth: 1 });
    expect(g.stats).toEqual({ notes: 3, scopeNotes: 3, links: 4 });
    // No note from outside, so Home.md and its links are gone.
    expect(linkPairs(g)).not.toContain('Home.md>docs/Intro.md');
    checkParents(g);
  });

  it('includes attachments that notes inside link to, also from outside the folder', () => {
    const graph = makeGraph({
      notes: ['a/x.md', 'b/y.md'],
      attachments: ['img/p.png', 'img/q.png'],
      missing: ['gone.md'],
      links: [['a/x.md', 'img/p.png'], ['b/y.md', 'img/q.png'], ['a/x.md', 'gone.md']],
    });
    const g = buildVisibleGraph(makeInput(graph, { scope: { kind: 'folder', path: `${ROOT}/a` }, options: { showAttachments: true } }));
    expect(fileIds(g)).toEqual(['n:a/x.md', 'n:img/p.png', 'n:gone.md']);
    // Nodes outside the folder hang under the folder that starts the tree.
    expect(byId(g, 'n:img/p.png')).toMatchObject({ parent: 'f:a', depth: 1 });
    expect(byId(g, 'n:gone.md')).toMatchObject({ parent: 'f:a' });
    checkParents(g);
  });

  it('works with the root folder and with a slash at the end', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { scope: { kind: 'folder', path: `${ROOT}/` } }));
    expect(g.stats.notes).toBe(6);
    expect(ids(g)[0]).toBe('f:');
  });

  it('gives an empty graph for a folder that is outside the root or has no notes', () => {
    for (const path of ['/elsewhere/docs', `${ROOT}/nothing`, `${ROOT}/docs2`]) {
      const g = buildVisibleGraph(makeInput(sampleGraph(), { scope: { kind: 'folder', path } }));
      expect(g.nodes).toEqual([]);
      expect(g.emptyReason).toBe('No markdown files in this folder.');
    }
  });

  it('does not take a folder with the same start as another one', () => {
    const graph = makeGraph({ notes: ['doc/a.md', 'docs/b.md'] });
    const g = buildVisibleGraph(makeInput(graph, { scope: { kind: 'folder', path: `${ROOT}/doc` } }));
    expect(fileIds(g)).toEqual(['n:doc/a.md']);
  });

  it('cannot hide or collapse the folder that starts the tree', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { scope, folders: { collapsed: ['docs'], hidden: ['docs'] } }));
    expect(g.stats.notes).toBe(3);
    expect(byId(g, 'f:docs').collapsed).toBe(false);
  });

  it('collapses a folder below it', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { scope, folders: { collapsed: ['docs/api'], hidden: [] } }));
    expect(byId(g, 'f:docs/api')).toMatchObject({ collapsed: true, weight: 2, parent: 'f:docs' });
  });
});

describe('buildVisibleGraph: local scope', () => {
  // a -> b -> c -> d, e -> a, b -> f
  const graph = makeGraph({
    notes: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'far.md'],
    links: [['a.md', 'b.md'], ['b.md', 'c.md'], ['c.md', 'd.md'], ['e.md', 'a.md'], ['b.md', 'f.md'], ['f.md', 'c.md'], ['d.md', 'far.md']],
  });
  const local = (path: string | null, options = {}, extra = {}) =>
    buildVisibleGraph(makeInput(graph, { scope: { kind: 'local', path, follow: false }, options: { showFolders: false, ...options }, ...extra }));

  it('shows only the center at depth 0 steps beyond one', () => {
    expect(fileIds(local(`${ROOT}/a.md`))).toEqual(['n:a.md', 'n:b.md', 'n:e.md']);
  });

  it('goes deeper with depth', () => {
    expect(fileIds(local(`${ROOT}/a.md`, { depth: 2 }))).toEqual(['n:a.md', 'n:b.md', 'n:c.md', 'n:e.md', 'n:f.md']);
    expect(fileIds(local(`${ROOT}/a.md`, { depth: 5 }))).toHaveLength(7);
  });

  it('follows only outgoing or only incoming links', () => {
    expect(fileIds(local(`${ROOT}/b.md`, { incoming: false }))).toEqual(['n:b.md', 'n:c.md', 'n:f.md']);
    expect(fileIds(local(`${ROOT}/b.md`, { outgoing: false }))).toEqual(['n:a.md', 'n:b.md']);
    expect(fileIds(local(`${ROOT}/b.md`, { outgoing: false, depth: 2 }))).toEqual(['n:a.md', 'n:b.md', 'n:e.md']);
    expect(fileIds(local(`${ROOT}/b.md`, { outgoing: false, incoming: false }))).toEqual(['n:b.md']);
  });

  it('shows the links between neighbors only with neighborLinks', () => {
    // b has neighbors c and f. f links to c.
    const yes = local(`${ROOT}/b.md`, { neighborLinks: true });
    const no = local(`${ROOT}/b.md`, { neighborLinks: false });
    expect(linkPairs(yes)).toContain('f.md>c.md');
    expect(linkPairs(no)).not.toContain('f.md>c.md');
    expect(linkPairs(no)).toEqual(['a.md>b.md', 'b.md>c.md', 'b.md>f.md']);
    expect(yes.stats.links).toBe(4);
  });

  it('keeps edges that BFS finds on the way at depth 2 without neighbor links', () => {
    const no = local(`${ROOT}/a.md`, { neighborLinks: false, depth: 2 });
    expect(linkPairs(no)).toEqual(['a.md>b.md', 'b.md>c.md', 'b.md>f.md', 'e.md>a.md']);
  });

  it('marks the center as active', () => {
    const g = local(`${ROOT}/a.md`);
    expect(g.nodes.filter((n) => n.active).map((n) => n.id)).toEqual(['n:a.md']);
  });

  it('keeps the center even when the query does not match it and when it is an orphan', () => {
    const g = local(`${ROOT}/a.md`, { query: 'b.md' });
    expect(fileIds(g)).toEqual(['n:a.md', 'n:b.md']);
    const lone = makeGraph({ notes: ['x.md', 'y.md'] });
    const g2 = buildVisibleGraph(makeInput(lone, { scope: { kind: 'local', path: `${ROOT}/x.md`, follow: false }, options: { showOrphans: false } }));
    expect(fileIds(g2)).toEqual(['n:x.md']);
  });

  it('does not walk through nodes that a filter removes', () => {
    const g = local(`${ROOT}/a.md`, { query: '-b.md', depth: 3 });
    expect(fileIds(g)).toEqual(['n:a.md', 'n:e.md']);
  });

  it('does not collapse or hide the folder of the center', () => {
    const g2 = makeGraph({ notes: ['d/x.md', 'd/y.md'], links: [['d/x.md', 'd/y.md']] });
    const g = buildVisibleGraph(makeInput(g2, { scope: { kind: 'local', path: `${ROOT}/d/x.md`, follow: false }, folders: { collapsed: ['d'], hidden: [] } }));
    expect(fileIds(g)).toEqual(['n:d/x.md', 'n:d/y.md']);
  });

  it('counts scopeNotes before the filters', () => {
    const g = local(`${ROOT}/a.md`, { query: 'a.md', depth: 1 });
    expect(g.stats.scopeNotes).toBe(3);
    expect(g.stats.notes).toBe(1);
  });

  it('uses the active file when follow is on, and the last path when it is not a note', () => {
    const scope = { kind: 'local' as const, path: `${ROOT}/a.md`, follow: true };
    const moved = buildVisibleGraph(makeInput(graph, { scope, activePath: `${ROOT}/d.md`, options: { showFolders: false } }));
    expect(moved.nodes.find((n) => n.active)!.id).toBe('n:d.md');
    const other = buildVisibleGraph(makeInput(graph, { scope, activePath: `${ROOT}/script.ts`, options: { showFolders: false } }));
    expect(other.nodes.find((n) => n.active)!.id).toBe('n:a.md');
    const fixed = buildVisibleGraph(makeInput(graph, { scope: { ...scope, follow: false }, activePath: `${ROOT}/d.md`, options: { showFolders: false } }));
    expect(fixed.nodes.filter((n) => n.active).map((n) => n.id)).toEqual(['n:a.md', 'n:d.md'].filter((i) => fixed.nodes.some((n) => n.id === i)));
  });

  it('gives the empty reason without a center', () => {
    for (const path of [null, `${ROOT}/missing.md`, `${ROOT}/a.txt`]) {
      const g = local(path);
      expect(g.nodes).toEqual([]);
      expect(g.emptyReason).toBe('Open a markdown file to see its local graph.');
    }
  });

  it('includes tags as steps when showTags is on', () => {
    const tg = makeGraph({
      notes: [{ rel: 'a.md', tags: ['t'] }, { rel: 'b.md', tags: ['t'] }, { rel: 'c.md', tags: ['t'] }, 'd.md'],
      links: [['a.md', 'd.md']],
    });
    const run = (depth: number, showTags: boolean) =>
      buildVisibleGraph(makeInput(tg, { scope: { kind: 'local', path: `${ROOT}/a.md`, follow: false }, options: { showFolders: false, showTags, depth } }));
    expect(ids(run(1, true))).toEqual(['n:a.md', 'n:d.md', 't:t']);
    expect(ids(run(2, true))).toEqual(['n:a.md', 'n:b.md', 'n:c.md', 'n:d.md', 't:t']);
    expect(ids(run(2, false))).toEqual(['n:a.md', 'n:d.md']);
  });
});

describe('buildVisibleGraph: colors', () => {
  it('colors files by the folder at the color depth', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { options: { colorDepth: 1 } }));
    expect(byId(g, 'n:docs/Intro.md').color).toBe(PALETTE_LIGHT[0]);
    expect(byId(g, 'n:docs/api/Auth.md').color).toBe(PALETTE_LIGHT[0]);
    expect(byId(g, 'n:notes/ideas/Idea.md').color).toBe(PALETTE_LIGHT[1]);
    expect(byId(g, 'n:Home.md').color).toBeNull();
    expect(byId(g, 'f:docs').color).toBe(PALETTE_LIGHT[0]);
    expect(byId(g, 'f:').color).toBeNull();
  });

  it('uses colorDepth 2 and the dark theme', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { theme: 'dark', options: { colorDepth: 2 } }));
    expect(byId(g, 'n:docs/api/Auth.md').color).toBe(PALETTE_DARK[0]);
    // A note in a folder that is above the color depth has no folder color.
    expect(byId(g, 'n:docs/Intro.md').color).toBeNull();
  });

  it('colors by the first tag, the same for the same tag in any case', () => {
    const graph = makeGraph({ notes: [{ rel: 'a.md', tags: ['Alpha', 'b'] }, { rel: 'b.md', tags: ['alpha'] }, 'c.md'] });
    const g = buildVisibleGraph(makeInput(graph, { options: { colorBy: 'tag', showTags: true } }));
    const a = byId(g, 'n:a.md').color;
    expect(a).not.toBeNull();
    expect(PALETTE_LIGHT).toContain(a);
    expect(byId(g, 'n:b.md').color).toBe(a);
    expect(byId(g, 'n:c.md').color).toBeNull();
    expect(byId(g, 't:alpha').color).toBe(a);
  });

  it('gives no colors with colorBy none', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { options: { colorBy: 'none' } }));
    expect(g.nodes.filter((n) => n.kind === 'note').every((n) => n.color === null)).toBe(true);
  });

  it('lets the first matching group win over colorBy', () => {
    const groups = [
      { query: 'tag:guide', color: '#ff0000' },
      { query: 'docs', color: '#00ff00' },
      { query: '', color: '#0000ff' },
      { query: '"bad', color: '#0000ff' },
    ];
    const g = buildVisibleGraph(makeInput(sampleGraph(), { options: { groups } }));
    expect(byId(g, 'n:docs/Intro.md').color).toBe('#ff0000');
    expect(byId(g, 'n:docs/api/Users.md').color).toBe('#00ff00');
    expect(byId(g, 'n:notes/Daily.md').color).toBe(PALETTE_LIGHT[1]);
    expect(byId(g, 'n:Home.md').color).toBeNull();
  });

  it('gives the same colors on every run', () => {
    const a = buildVisibleGraph(makeInput(sampleGraph()));
    const b = buildVisibleGraph(makeInput(sampleGraph()));
    expect(a.nodes.map((n) => n.color)).toEqual(b.nodes.map((n) => n.color));
  });
});

describe('buildVisibleGraph: labels and active', () => {
  it('uses the name or the title', () => {
    const name = buildVisibleGraph(makeInput(sampleGraph()));
    expect(byId(name, 'n:docs/Intro.md').label).toBe('Intro');
    const title = buildVisibleGraph(makeInput(sampleGraph(), { options: { labelBy: 'title', showAttachments: true } }));
    expect(byId(title, 'n:docs/Intro.md').label).toBe('Introduction');
    expect(byId(title, 'n:docs/api/Auth.md').label).toBe('Auth');
    expect(byId(title, 'n:docs/logo.png').label).toBe('logo.png');
  });

  it('marks the note of the active editor', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { activePath: '/vault/docs/Intro.md' }));
    expect(g.nodes.filter((n) => n.active).map((n) => n.id)).toEqual(['n:docs/Intro.md']);
  });

  it('marks a collapsed folder that holds the active note', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { activePath: '/vault/docs/Intro.md', folders: { collapsed: ['docs'], hidden: [] } }));
    expect(byId(g, 'f:docs').active).toBe(true);
  });
});

describe('buildVisibleGraph: empty reasons', () => {
  it('says there are no files', () => {
    const g = buildVisibleGraph(makeInput(makeGraph({})));
    expect(g).toMatchObject({ nodes: [], edges: [], emptyReason: 'No markdown files in this folder.', stats: { notes: 0, scopeNotes: 0, links: 0 } });
  });

  it('says no notes match when the filter removes everything', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { options: { query: 'zzz' } }));
    expect(g.nodes).toEqual([]);
    expect(g.emptyReason).toBe('No notes match the filter.');
    expect(g.stats).toEqual({ notes: 0, scopeNotes: 6, links: 0 });
  });

  it('says no notes match when hidden folders remove everything', () => {
    const g = buildVisibleGraph(makeInput(sampleGraph(), { folders: { collapsed: [], hidden: ['docs', 'notes'] }, options: { query: 'docs OR notes' } }));
    expect(g.emptyReason).toBe('No notes match the filter.');
  });
});

describe('nodeRadius', () => {
  const node = (over: Partial<VNode>): VNode => ({
    id: 'n:a',
    kind: 'note',
    label: 'a',
    path: null,
    rel: 'a',
    parent: null,
    depth: 1,
    degree: 0,
    color: null,
    weight: 1,
    collapsed: false,
    active: false,
    source: 0,
    ...over,
  });

  it('grows with the square root of the degree and scales with nodeSize', () => {
    const r0 = nodeRadius(node({ degree: 0 }), 1);
    const r4 = nodeRadius(node({ degree: 4 }), 1);
    const r16 = nodeRadius(node({ degree: 16 }), 1);
    expect(r4).toBeGreaterThan(r0);
    expect(r16 - r4).toBeCloseTo(r4 - r0, 9);
    expect(nodeRadius(node({ degree: 4 }), 2)).toBeCloseTo(r4 * 2, 9);
    expect(r0).toBeGreaterThan(0);
  });

  it('stays bounded for hubs', () => {
    expect(nodeRadius(node({ degree: 1e9 }), 1)).toBeLessThan(40);
  });

  it('grows folders with their weight', () => {
    const small = nodeRadius(node({ kind: 'folder', weight: 1 }), 1);
    const big = nodeRadius(node({ kind: 'folder', weight: 100, collapsed: true }), 1);
    expect(big).toBeGreaterThan(small);
    expect(nodeRadius(node({ kind: 'folder', weight: 4, degree: 99 }), 1)).toBe(nodeRadius(node({ kind: 'folder', weight: 4, degree: 0 }), 1));
  });
});

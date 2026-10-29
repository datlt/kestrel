// Helpers for the tests of the graph model: build a NoteGraph from a short description.

import type { NoteGraph, NoteLink, NoteNode, NoteNodeKind } from '../../../ipc/notes';
import type { BuildInput, GraphOptions } from '../types';
import { buildFolderTree } from './folders';
import { DEFAULT_OPTIONS } from './options';

export const ROOT = '/vault';

export interface NoteSpec {
  rel: string;
  tags?: string[];
  title?: string | null;
  aliases?: string[];
}

export interface LinkSpec {
  from: string;
  to: string;
  count?: number;
  embeds?: number;
}

export interface GraphSpec {
  notes?: (string | NoteSpec)[];
  attachments?: string[];
  missing?: string[];
  links?: (readonly [string, string] | LinkSpec)[];
  root?: string;
}

function nameOf(rel: string, kind: NoteNodeKind): string {
  const file = rel.slice(rel.lastIndexOf('/') + 1);
  return kind === 'note' ? file.replace(/\.(md|markdown|mdx)$/i, '') : file;
}

function makeNode(root: string, rel: string, kind: NoteNodeKind, extra: Partial<NoteNode> = {}): NoteNode {
  return {
    kind,
    path: `${root}/${rel}`,
    rel,
    name: nameOf(rel, kind),
    title: null,
    tags: [],
    aliases: [],
    size: kind === 'missing' ? 0 : 100,
    mtimeMs: kind === 'missing' ? 0 : 1,
    ...extra,
  };
}

/** Nodes sorted like Rust does it: notes, then attachments, then missing nodes, each by rel. */
export function makeGraph(spec: GraphSpec): NoteGraph {
  const root = spec.root ?? ROOT;
  const byRel = (a: NoteNode, b: NoteNode): number => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  const notes = (spec.notes ?? []).map((n) => {
    const s = typeof n === 'string' ? { rel: n } : n;
    return makeNode(root, s.rel, 'note', { tags: s.tags ?? [], title: s.title ?? null, aliases: s.aliases ?? [] });
  });
  const attachments = (spec.attachments ?? []).map((rel) => makeNode(root, rel, 'attachment'));
  const missing = (spec.missing ?? []).map((rel) => makeNode(root, rel, 'missing'));
  const nodes = [...notes.sort(byRel), ...attachments.sort(byRel), ...missing.sort(byRel)];
  const index = new Map(nodes.map((n, i) => [n.rel, i]));
  const links: NoteLink[] = [];
  for (const l of spec.links ?? []) {
    const s: LinkSpec = Array.isArray(l) ? { from: l[0], to: l[1] } : (l as LinkSpec);
    const from = index.get(s.from);
    const to = index.get(s.to);
    if (from === undefined || to === undefined) throw new Error(`unknown link ${s.from} -> ${s.to}`);
    links.push({ from, to, count: s.count ?? 1, embeds: s.embeds ?? 0, line: 1 });
  }
  links.sort((a, b) => a.from - b.from || a.to - b.to);
  return { root, nodes, links, truncated: false, elapsedMs: 0 };
}

/** A small vault that most tests use. */
export function sampleGraph(): NoteGraph {
  return makeGraph({
    notes: [
      'Home.md',
      { rel: 'docs/Intro.md', tags: ['Guide', 'api/v2'], title: 'Introduction' },
      { rel: 'docs/api/Auth.md', tags: ['guide'] },
      'docs/api/Users.md',
      'notes/Daily.md',
      'notes/ideas/Idea.md',
    ],
    attachments: ['docs/logo.png'],
    missing: ['docs/Todo.md'],
    links: [
      ['Home.md', 'docs/Intro.md'],
      { from: 'Home.md', to: 'notes/Daily.md', count: 2 },
      ['docs/Intro.md', 'docs/api/Auth.md'],
      { from: 'docs/Intro.md', to: 'docs/logo.png', embeds: 1 },
      ['docs/api/Auth.md', 'docs/api/Users.md'],
      ['docs/api/Users.md', 'docs/api/Auth.md'],
      ['docs/api/Auth.md', 'docs/Todo.md'],
      ['notes/ideas/Idea.md', 'Home.md'],
    ],
  });
}

export function makeInput(graph: NoteGraph, over: Partial<Omit<BuildInput, 'options'>> & { options?: Partial<GraphOptions> } = {}): BuildInput {
  const options: GraphOptions = { ...DEFAULT_OPTIONS, ...over.options };
  const theme = over.theme ?? 'light';
  return {
    graph,
    tree: over.tree ?? buildFolderTree(graph, options.colorDepth, theme),
    folders: over.folders ?? { collapsed: [], hidden: [] },
    scope: over.scope ?? { kind: 'project' },
    activePath: over.activePath ?? null,
    theme,
    options,
  };
}

/** A small random generator, so that big graphs are the same in every run. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** `notes` notes in nested folders (`notesPerFolder` in each, 40 by default) and `links` random links. */
export function bigGraph(notes: number, links: number, seed = 1, notesPerFolder = 40): NoteGraph {
  const rnd = seeded(seed);
  const folderCount = Math.max(1, Math.round(notes / notesPerFolder));
  const folders: string[] = [''];
  for (let i = 1; i < folderCount; i++) {
    const parent = folders[Math.floor(rnd() * folders.length)];
    if (parent.split('/').length > 4) {
      folders.push(`top${i % 7}/f${i}`);
    } else folders.push(parent ? `${parent}/f${i}` : `top${i % 7}`);
  }
  const rels: string[] = [];
  for (let i = 0; i < notes; i++) {
    const f = folders[Math.floor(rnd() * folders.length)];
    rels.push(`${f ? `${f}/` : ''}note${i}.md`);
  }
  const unique = [...new Set(rels)].sort();
  const nodes = unique.map((rel) => makeNode(ROOT, rel, 'note', { tags: rnd() < 0.3 ? [`t${Math.floor(rnd() * 50)}`] : [] }));
  const seen = new Set<number>();
  const list: NoteLink[] = [];
  const n = nodes.length;
  for (let i = 0; i < links; i++) {
    const from = Math.floor(rnd() * n);
    // Notes link to notes that are close in the list more often, like real notes do.
    const to = rnd() < 0.5 ? Math.floor(rnd() * n) : Math.min(n - 1, Math.max(0, from + Math.floor((rnd() - 0.5) * 200)));
    if (from === to || seen.has(from * n + to)) continue;
    seen.add(from * n + to);
    list.push({ from, to, count: 1, embeds: 0, line: 1 });
  }
  list.sort((a, b) => a.from - b.from || a.to - b.to);
  return { root: ROOT, nodes, links: list, truncated: false, elapsedMs: 0 };
}

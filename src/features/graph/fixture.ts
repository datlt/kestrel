// A generated `NoteGraph` for tests and for the browser without the Rust index.
// The dev build uses it when `localStorage['graph.fixture']` holds a number of
// notes (see `view.ts`). The same seed always gives the same graph.

import type { NoteGraph, NoteLink, NoteNode } from '../../ipc/notes';

export interface FixtureOptions {
  notes: number;
  /** Average number of links from each note. */
  linksPerNote?: number;
  seed?: number;
  root?: string;
  tags?: number;
  attachments?: number;
  missing?: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOP = ['docs', 'projects', 'areas', 'daily', 'archive', 'research'];
const SUB = ['api', 'design', 'notes', 'meetings', 'ideas', 'specs'];
const WORDS = ['Auth', 'Coin', 'Reader', 'Idea', 'Sync', 'Cache', 'Index', 'Plan', 'Review', 'Draft', 'Setup', 'Guide', 'Model', 'Graph', 'Search', 'Layout'];

export function makeFixtureGraph(opts: FixtureOptions): NoteGraph {
  const rand = rng(opts.seed ?? 1);
  const root = opts.root ?? '/fixture/vault';
  const nNotes = opts.notes;
  const perNote = opts.linksPerNote ?? 3;
  const tagCount = opts.tags ?? 14;

  // Folders: a few top folders, each with sub folders. The number grows with the notes.
  const folders: string[] = [''];
  const topCount = Math.min(TOP.length, Math.max(2, Math.round(Math.sqrt(nNotes) / 4)));
  for (let t = 0; t < topCount; t++) {
    folders.push(TOP[t]);
    const subs = Math.min(SUB.length, 1 + Math.floor(rand() * 4));
    for (let s = 0; s < subs; s++) folders.push(`${TOP[t]}/${SUB[s]}`);
  }

  const nodes: NoteNode[] = [];
  const used = new Set<string>();
  for (let i = 0; i < nNotes; i++) {
    const folder = rand() < 0.08 ? '' : folders[1 + Math.floor(rand() * (folders.length - 1))];
    let name = `${WORDS[Math.floor(rand() * WORDS.length)]} ${WORDS[Math.floor(rand() * WORDS.length)]} ${i}`;
    let rel = folder ? `${folder}/${name}.md` : `${name}.md`;
    while (used.has(rel)) {
      name += 'x';
      rel = folder ? `${folder}/${name}.md` : `${name}.md`;
    }
    used.add(rel);
    const tags: string[] = [];
    if (rand() < 0.5) tags.push(`tag${Math.floor(rand() * tagCount)}`);
    if (rand() < 0.15) tags.push(`area/part${Math.floor(rand() * 4)}`);
    nodes.push({ kind: 'note', path: `${root}/${rel}`, rel, name, title: rand() < 0.5 ? `${name} (title)` : null, tags: [...new Set(tags)], aliases: [], size: 500 + Math.floor(rand() * 5000), mtimeMs: 1_700_000_000_000 + i });
  }
  nodes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const attachments: NoteNode[] = [];
  const nAtt = opts.attachments ?? Math.round(nNotes / 15);
  for (let i = 0; i < nAtt; i++) {
    const name = `image-${i}.png`;
    const rel = `assets/${name}`;
    attachments.push({ kind: 'attachment', path: `${root}/${rel}`, rel, name, title: null, tags: [], aliases: [], size: 20000, mtimeMs: 1_700_000_000_000 });
  }
  attachments.sort((a, b) => (a.rel < b.rel ? -1 : 1));

  const missing: NoteNode[] = [];
  const nMiss = opts.missing ?? Math.round(nNotes / 25);
  for (let i = 0; i < nMiss; i++) {
    const name = `Missing ${i}`;
    missing.push({ kind: 'missing', path: `${root}/${name}.md`, rel: `${name}.md`, name, title: null, tags: [], aliases: [], size: 0, mtimeMs: 0 });
  }
  missing.sort((a, b) => (a.rel < b.rel ? -1 : 1));

  const all = [...nodes, ...attachments, ...missing];
  const noteEnd = nodes.length;
  const byFolder = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    const f = n.rel.includes('/') ? n.rel.slice(0, n.rel.lastIndexOf('/')) : '';
    const list = byFolder.get(f);
    if (list) list.push(i);
    else byFolder.set(f, [i]);
  });

  const pairs = new Map<number, NoteLink>();
  const total = Math.round(nNotes * perNote);
  for (let k = 0; k < total && noteEnd > 1; k++) {
    const from = Math.floor(rand() * noteEnd);
    let to: number;
    const r = rand();
    if (r < 0.6) {
      const f = nodes[from].rel.includes('/') ? nodes[from].rel.slice(0, nodes[from].rel.lastIndexOf('/')) : '';
      const list = byFolder.get(f) ?? [];
      to = list[Math.floor(rand() * list.length)];
    } else if (r < 0.9 || (attachments.length === 0 && missing.length === 0)) {
      // A few popular notes get many links.
      to = Math.floor(Math.pow(rand(), 2.2) * noteEnd);
    } else if (r < 0.95 && attachments.length) {
      to = noteEnd + Math.floor(rand() * attachments.length);
    } else if (missing.length) {
      to = noteEnd + attachments.length + Math.floor(rand() * missing.length);
    } else {
      to = Math.floor(rand() * noteEnd);
    }
    if (to === from) continue;
    const key = from * all.length + to;
    const old = pairs.get(key);
    const embed = to >= noteEnd && to < noteEnd + attachments.length ? 1 : 0;
    if (old) {
      old.count++;
      old.embeds += embed;
    } else {
      pairs.set(key, { from, to, count: 1, embeds: embed, line: 1 + Math.floor(rand() * 40) });
    }
  }
  const links = [...pairs.values()].sort((a, b) => a.from - b.from || a.to - b.to);
  return { root, nodes: all, links, truncated: false, elapsedMs: 0 };
}

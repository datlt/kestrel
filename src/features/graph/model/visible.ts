// Turns the NoteGraph into what the view draws (docs/DESIGN.md 14.4).
//
// Steps: scope, filters, tags, collapsed folders, orphans, folder nodes, then
// colors and labels. The code uses typed arrays and one pass over the links,
// because the speed target is 100 ms for 20,000 notes and 100,000 links.

import type { BuildInput, GraphOptions, NoteNode, VEdge, VisibleGraph, VNode } from '../types';
import { palette } from './colors';
import { folderColorMap } from './folders';
import { compileQuery } from './query';
import { compareRels, dirOf, hashString, joinPath, lastSegment, relUnderRoot } from './util';

const NO_FILES = 'No markdown files in this folder.';
const NO_LOCAL = 'Open a markdown file to see its local graph.';
const NO_MATCH = 'No notes match the filter.';

/** Multiplier for the key of a pair of slots. Slot numbers stay far below this. */
const PAIR = 1 << 24;

/** A node of the result before it gets its final index. */
interface Slot {
  kind: 'file' | 'collapsed' | 'tag';
  /** File: index in `graph.nodes`. Others: -1. */
  src: number;
  /** Collapsed folder: its rel. Tag: the tag as first written. File: not used. */
  rel: string;
  /** Collapsed folder: notes inside. */
  notes: number;
  degree: number;
  active: boolean;
  alive: boolean;
}

interface Bfs {
  dist: Int32Array;
  tagDist: Map<string, number> | null;
}

function segments(rel: string): number {
  return rel === '' ? 0 : rel.split('/').length;
}

/** Breadth first search from the center over link edges (and tags). `allowed` null means no filter. */
function localSearch(input: BuildInput, center: number, allowed: Uint8Array | null): Bfs {
  const { graph, options } = input;
  const dist = new Int32Array(graph.nodes.length).fill(-1);
  dist[center] = 0;
  const tagDist = options.showTags ? new Map<string, number>() : null;
  let tagNotes: Map<string, number[]> | null = null;
  if (tagDist) {
    tagNotes = new Map();
    graph.nodes.forEach((n, i) => {
      if (n.kind !== 'note' || (allowed && !allowed[i])) return;
      for (const t of n.tags) {
        const key = t.toLowerCase();
        if (!key) continue;
        const list = tagNotes!.get(key);
        if (list) list.push(i);
        else tagNotes!.set(key, [i]);
      }
    });
  }

  let frontier: number[] = [center];
  for (let d = 0; d < options.depth; d++) {
    const next: number[] = [];
    for (const l of graph.links) {
      if (options.outgoing && dist[l.from] === d && dist[l.to] < 0 && (!allowed || allowed[l.to])) {
        dist[l.to] = d + 1;
        next.push(l.to);
      }
      if (options.incoming && dist[l.to] === d && dist[l.from] < 0 && (!allowed || allowed[l.from])) {
        dist[l.from] = d + 1;
        next.push(l.from);
      }
    }
    if (tagDist && tagNotes) {
      const reached: string[] = [];
      for (const i of frontier) {
        for (const t of graph.nodes[i].tags) {
          const key = t.toLowerCase();
          if (key && !tagDist.has(key)) {
            tagDist.set(key, d + 1);
          }
        }
      }
      for (const [key, td] of tagDist) if (td === d) reached.push(key);
      for (const key of reached) {
        for (const i of tagNotes.get(key) ?? []) {
          if (dist[i] < 0) {
            dist[i] = d + 1;
            next.push(i);
          }
        }
      }
    }
    frontier = next;
  }
  return { dist, tagDist };
}

function emptyGraph(scopeNotes: number, reason: string): VisibleGraph {
  return { nodes: [], edges: [], stats: { notes: 0, scopeNotes, links: 0 }, emptyReason: reason };
}

/** Applies the scope, filters, folders and colors. */
export function buildVisibleGraph(input: BuildInput): VisibleGraph {
  const { graph, tree, options, folders, scope, activePath, theme } = input;
  const src = graph.nodes;
  const n = src.length;
  const showFolders = options.showFolders || options.layout !== 'force';

  // --- Scope: the folder and the center of a local graph.
  let scopeRel = '';
  let folderScope = false;
  if (scope.kind === 'folder') {
    const rel = relUnderRoot(graph.root, scope.path);
    if (rel === null) return emptyGraph(0, NO_FILES);
    scopeRel = rel;
    folderScope = true;
  }
  const underScope = (rel: string): boolean => scopeRel === '' || rel.startsWith(`${scopeRel}/`);

  let center = -1;
  if (scope.kind === 'local') {
    const find = (path: string | null): number => {
      if (!path) return -1;
      for (let i = 0; i < n; i++) if (src[i].kind === 'note' && src[i].path === path) return i;
      return -1;
    };
    if (scope.follow) center = find(activePath);
    if (center < 0) center = find(scope.path);
    if (center < 0) return emptyGraph(0, NO_LOCAL);
  }

  // --- Filters (not the scope). The center of a local graph always stays.
  const query = compileQuery(options.query);
  const hidden = new Set<string>();
  for (const rel of folders.hidden) {
    if (rel && (!folderScope || (rel !== scopeRel && underScope(rel)))) hidden.add(rel);
  }
  const hiddenMemo = new Map<string, boolean>();
  const isHidden = (folder: string): boolean => {
    if (folder === '') return false;
    const known = hiddenMemo.get(folder);
    if (known !== undefined) return known;
    const r = hidden.has(folder) || isHidden(dirOf(folder));
    hiddenMemo.set(folder, r);
    return r;
  };
  const pass = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const node = src[i];
    if (node.kind === 'attachment' && !options.showAttachments) continue;
    if (node.kind === 'missing' && options.existingOnly) continue;
    if (hidden.size > 0 && isHidden(dirOf(node.rel))) continue;
    if (!query.empty && !query.test(node)) continue;
    pass[i] = 1;
  }
  if (center >= 0) pass[center] = 1;

  // --- Scope: which nodes are inside.
  const inScope = new Uint8Array(n);
  let scopeNotes = 0;
  let dist: Int32Array | null = null;
  let tagDist: Map<string, number> | null = null;
  if (scope.kind === 'project') {
    inScope.fill(1);
    for (let i = 0; i < n; i++) if (src[i].kind === 'note') scopeNotes++;
  } else if (folderScope) {
    for (let i = 0; i < n; i++) {
      if (src[i].kind === 'note' && underScope(src[i].rel)) {
        inScope[i] = 1;
        scopeNotes++;
      }
    }
    // Attachments and missing notes that these notes link to.
    for (const l of graph.links) if (inScope[l.from] && src[l.to].kind !== 'note') inScope[l.to] = 1;
  } else {
    const all = localSearch(input, center, null);
    for (let i = 0; i < n; i++) if (all.dist[i] >= 0 && src[i].kind === 'note') scopeNotes++;
    const filtered = localSearch(input, center, pass);
    dist = filtered.dist;
    tagDist = filtered.tagDist;
    for (let i = 0; i < n; i++) if (dist[i] >= 0) inScope[i] = 1;
  }
  if (scopeNotes === 0 && scope.kind !== 'local') return emptyGraph(0, NO_FILES);

  // --- Collapsed folders (only the outermost one counts).
  const collapsedSet = new Set<string>();
  for (const rel of folders.collapsed) {
    if (!rel) continue;
    if (folderScope && (rel === scopeRel || !underScope(rel))) continue;
    if (center >= 0) {
      const cf = dirOf(src[center].rel);
      if (cf === rel || cf.startsWith(`${rel}/`)) continue;
    }
    collapsedSet.add(rel);
  }
  const topMemo = new Map<string, string | null>();
  const topCollapsed = (folder: string): string | null => {
    if (folder === '') return null;
    const known = topMemo.get(folder);
    if (known !== undefined) return known;
    const r = topCollapsed(dirOf(folder)) ?? (collapsedSet.has(folder) ? folder : null);
    topMemo.set(folder, r);
    return r;
  };

  // --- Slots for the files and the collapsed folders.
  const slots: Slot[] = [];
  const slotOf = new Int32Array(n).fill(-1);
  const collapsedSlot = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (!inScope[i] || !pass[i]) continue;
    const node = src[i];
    const active = i === center || (activePath !== null && node.path === activePath);
    const top = collapsedSet.size > 0 ? topCollapsed(dirOf(node.rel)) : null;
    if (top === null) {
      slotOf[i] = slots.length;
      slots.push({ kind: 'file', src: i, rel: '', notes: 0, degree: 0, active, alive: true });
      continue;
    }
    let s = collapsedSlot.get(top);
    if (s === undefined) {
      s = slots.length;
      collapsedSlot.set(top, s);
      slots.push({ kind: 'collapsed', src: -1, rel: top, notes: 0, degree: 0, active: false, alive: true });
    }
    if (node.kind === 'note') slots[s].notes++;
    if (active) slots[s].active = true;
    slotOf[i] = s;
  }

  // --- Link edges. Pairs with links in both directions merge into one edge.
  interface E {
    a: number;
    b: number;
    count: number;
    embed: boolean;
    both: boolean;
  }
  const linkEdges: E[] = [];
  const pairIndex = new Map<number, number>();
  const strictLocal = scope.kind === 'local' && !options.neighborLinks;
  for (const l of graph.links) {
    const a = slotOf[l.from];
    const b = slotOf[l.to];
    if (a < 0 || b < 0 || a === b) continue;
    if (strictLocal) {
      const df = dist![l.from];
      const dt = dist![l.to];
      if (!((options.outgoing && dt === df + 1) || (options.incoming && df === dt + 1))) continue;
    }
    const key = a < b ? a * PAIR + b : b * PAIR + a;
    const found = pairIndex.get(key);
    if (found === undefined) {
      pairIndex.set(key, linkEdges.length);
      linkEdges.push({ a, b, count: l.count, embed: l.embeds > 0, both: false });
    } else {
      const e = linkEdges[found];
      e.count += l.count;
      if (l.embeds > 0) e.embed = true;
      if (e.a !== a) e.both = true;
    }
  }

  // --- Tags: one node per tag (lower case id) and an edge from each note.
  const tagEdges: [number, number][] = [];
  const tagSlot = new Map<string, number>();
  if (options.showTags) {
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
      const a = slotOf[i];
      if (a < 0 || src[i].kind !== 'note') continue;
      for (const tag of src[i].tags) {
        const key = tag.toLowerCase();
        if (!key) continue;
        if (tagDist) {
          const td = tagDist.get(key);
          if (td === undefined) continue;
          if (strictLocal && Math.abs(td - dist![i]) !== 1) continue;
        }
        let ts = tagSlot.get(key);
        if (ts === undefined) {
          ts = slots.length;
          tagSlot.set(key, ts);
          slots.push({ kind: 'tag', src: -1, rel: tag, notes: 0, degree: 0, active: false, alive: true });
        }
        const pair = a * PAIR + ts;
        if (seen.has(pair)) continue;
        seen.add(pair);
        tagEdges.push([a, ts]);
      }
    }
  }

  // --- Degree and orphans.
  for (const e of linkEdges) {
    slots[e.a].degree++;
    slots[e.b].degree++;
  }
  for (const [a, b] of tagEdges) {
    slots[a].degree++;
    slots[b].degree++;
  }
  const centerSlot = center >= 0 ? slotOf[center] : -1;
  let aliveCount = 0;
  let notes = 0;
  for (let s = 0; s < slots.length; s++) {
    const slot = slots[s];
    slot.alive = options.showOrphans || slot.degree > 0 || slot.kind === 'collapsed' || s === centerSlot;
    if (!slot.alive) continue;
    aliveCount++;
    if (slot.kind === 'collapsed') notes += slot.notes;
    else if (slot.kind === 'file' && src[slot.src].kind === 'note') notes++;
  }
  if (aliveCount === 0) return emptyGraph(scopeNotes, scopeNotes === 0 ? NO_FILES : NO_MATCH);

  // --- Folder nodes.
  const root = scopeRel;
  const parentOfFile = (i: number): string => {
    const pf = dirOf(src[i].rel);
    return folderScope && !underScope(pf) ? root : pf;
  };
  const entries: { rel: string; slot: number }[] = [];
  const regular = new Set<string>();
  if (showFolders) {
    for (const slot of slots) {
      if (!slot.alive || slot.kind === 'tag') continue;
      const pf = slot.kind === 'file' ? parentOfFile(slot.src) : dirOf(slot.rel);
      for (let f = pf; !regular.has(f); f = dirOf(f)) {
        regular.add(f);
        if (f === root) break;
      }
    }
    for (const rel of regular) entries.push({ rel, slot: -1 });
  }
  slots.forEach((slot, s) => {
    if (slot.alive && slot.kind === 'collapsed') entries.push({ rel: slot.rel, slot: s });
  });
  entries.sort((x, y) => compareRels(x.rel, y.rel));

  // --- Colors and labels.
  const folderColors = folderColorMap(tree, options.colorDepth, theme);
  const groups = options.groups
    .map((g) => ({ q: compileQuery(g.query), color: g.color }))
    .filter((g) => !g.q.empty && g.q.error === null);
  const pal = palette(theme);
  const tagColor = (key: string): string => pal[hashString(key) % pal.length];
  const folderColorMemo = new Map<string, string | null>();
  const colorOfFolderPath = (pf: string): string | null => {
    const known = folderColorMemo.get(pf);
    if (known !== undefined) return known;
    let color: string | null = null;
    const parts = pf === '' ? [] : pf.split('/');
    if (parts.length >= options.colorDepth) color = folderColors.get(parts.slice(0, options.colorDepth).join('/')) ?? null;
    folderColorMemo.set(pf, color);
    return color;
  };
  const colorOfFile = (node: NoteNode): string | null => {
    for (const g of groups) if (g.q.test(node)) return g.color;
    if (options.colorBy === 'folder') return colorOfFolderPath(dirOf(node.rel));
    if (options.colorBy === 'tag' && node.kind === 'note' && node.tags.length > 0 && node.tags[0]) {
      return tagColor(node.tags[0].toLowerCase());
    }
    return null;
  };
  const rootName = lastSegment(graph.root);
  const rootDepth = segments(root);

  // --- Final nodes: folders (parents first), then files, then tags.
  const nodes: VNode[] = [];
  const finalOf = new Int32Array(slots.length).fill(-1);
  const folderIndex = new Map<string, number>();
  for (const { rel, slot } of entries) {
    const idx = nodes.length;
    folderIndex.set(rel, idx);
    const s = slot >= 0 ? slots[slot] : null;
    if (slot >= 0) finalOf[slot] = idx;
    nodes.push({
      id: `f:${rel}`,
      kind: 'folder',
      label: rel === '' ? rootName : lastSegment(rel),
      path: joinPath(graph.root, rel),
      rel,
      parent: rel === root ? null : `f:${dirOf(rel)}`,
      depth: segments(rel) - rootDepth,
      degree: s ? s.degree : 0,
      color: folderColors.get(rel) ?? null,
      weight: s ? Math.max(1, s.notes) : 1,
      collapsed: s !== null,
      active: s ? s.active : false,
      source: -1,
    });
  }
  for (let s = 0; s < slots.length; s++) {
    const slot = slots[s];
    if (!slot.alive || slot.kind === 'collapsed') continue;
    finalOf[s] = nodes.length;
    if (slot.kind === 'tag') {
      const key = slot.rel.toLowerCase();
      nodes.push({
        id: `t:${key}`,
        kind: 'tag',
        label: `#${slot.rel}`,
        path: null,
        rel: slot.rel,
        parent: null,
        depth: 0,
        degree: slot.degree,
        color: options.colorBy === 'tag' ? tagColor(key) : null,
        weight: 1,
        collapsed: false,
        active: false,
        source: -1,
      });
      continue;
    }
    const node = src[slot.src];
    const pf = parentOfFile(slot.src);
    nodes.push({
      id: `n:${node.rel}`,
      kind: node.kind,
      label: labelOf(node, options),
      path: node.path,
      rel: node.rel,
      parent: `f:${pf}`,
      depth: segments(pf) - rootDepth + 1,
      degree: slot.degree,
      color: colorOfFile(node),
      weight: 1,
      collapsed: false,
      active: slot.active,
      source: slot.src,
    });
  }

  // --- Final edges: links, tags, then the folder tree.
  const edges: VEdge[] = [];
  for (const e of linkEdges) {
    edges.push({ source: finalOf[e.a], target: finalOf[e.b], kind: 'link', count: e.count, embed: e.embed, both: e.both });
  }
  for (const [a, t] of tagEdges) {
    edges.push({ source: finalOf[a], target: finalOf[t], kind: 'tag', count: 1, embed: false, both: false });
  }
  if (showFolders) {
    for (let i = 0; i < nodes.length; i++) {
      const v = nodes[i];
      if (v.kind === 'tag' || v.parent === null) continue;
      const target = folderIndex.get(v.parent.slice(2));
      if (target !== undefined) edges.push({ source: i, target, kind: 'tree', count: 1, embed: false, both: false });
    }
  }

  return { nodes, edges, stats: { notes, scopeNotes, links: linkEdges.length }, emptyReason: null };
}

function labelOf(node: NoteNode, options: GraphOptions): string {
  if (options.labelBy === 'title' && node.kind === 'note' && node.title && node.title.trim()) return node.title.trim();
  return node.name;
}

/** Draw radius of a node in graph units. Folders grow with their `weight`, others with the degree. */
export function nodeRadius(n: VNode, nodeSize: number): number {
  const base = n.kind === 'folder' ? 6 + Math.min(Math.sqrt(n.weight) * 2.5, 30) : 4 + Math.min(Math.sqrt(n.degree) * 1.5, 24);
  return base * nodeSize;
}

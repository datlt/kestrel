// The folder tree of the graph and the folder colors.

import type { FolderNode, NoteGraph } from '../types';
import { palette } from './colors';
import { compareNames, dirOf, joinPath, lastSegment } from './util';

/**
 * Colors by folder. Folders above `colorDepth` get null. A folder at `colorDepth`
 * gets the next palette color, in the order of the tree (children sorted by
 * name), so the same tree always gives the same colors. Deeper folders take the
 * color of their ancestor at `colorDepth`.
 */
export function folderColorMap(tree: FolderNode, colorDepth: number, theme: 'light' | 'dark'): Map<string, string | null> {
  const colors = palette(theme);
  const depthLimit = Math.max(1, Math.floor(colorDepth) || 1);
  const out = new Map<string, string | null>();
  let counter = 0;
  const walk = (f: FolderNode, inherited: string | null): void => {
    let color = inherited;
    if (f.depth === depthLimit) color = colors[counter++ % colors.length];
    else if (f.depth < depthLimit) color = null;
    out.set(f.rel, color);
    for (const c of f.children) walk(c, color);
  };
  walk(tree, null);
  return out;
}

/** The folders that hold nodes of the graph, with note counts and folder colors. */
export function buildFolderTree(graph: NoteGraph, colorDepth: number, theme: 'light' | 'dark'): FolderNode {
  const root: FolderNode = {
    rel: '',
    name: lastSegment(graph.root),
    path: graph.root,
    depth: 0,
    children: [],
    notes: 0,
    totalNotes: 0,
    color: null,
  };
  const byRel = new Map<string, FolderNode>([['', root]]);
  const ensure = (rel: string): FolderNode => {
    const found = byRel.get(rel);
    if (found) return found;
    const parent = ensure(dirOf(rel));
    const f: FolderNode = {
      rel,
      name: lastSegment(rel),
      path: joinPath(graph.root, rel),
      depth: parent.depth + 1,
      children: [],
      notes: 0,
      totalNotes: 0,
      color: null,
    };
    byRel.set(rel, f);
    parent.children.push(f);
    return f;
  };

  for (const n of graph.nodes) {
    const folder = ensure(dirOf(n.rel));
    if (n.kind !== 'note') continue;
    folder.notes++;
    // Count the note in this folder and in every folder above it.
    for (let rel = folder.rel; ; rel = dirOf(rel)) {
      byRel.get(rel)!.totalNotes++;
      if (rel === '') break;
    }
  }

  for (const f of byRel.values()) f.children.sort((a, b) => compareNames(a.name, b.name));
  const colors = folderColorMap(root, colorDepth, theme);
  for (const [rel, f] of byRel) f.color = colors.get(rel) ?? null;
  return root;
}

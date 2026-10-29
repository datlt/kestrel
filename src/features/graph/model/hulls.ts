// Outlines of the folders around their nodes (`force` layout with `folderOutlines`).
//
// The view calls `folderHulls` many times a second while the simulation runs.
// The folder structure is computed once for each graph and cached. The work in
// each call reuses buffers, and the hull of a folder first uses only the nodes
// on the convex hull of the node centers.

import { polygonHull } from 'd3-polygon';
import type { FolderHull, VisibleGraph } from '../types';
import { nodeRadius } from './visible';
import { dirOf, lastSegment } from './util';

/** Points on the circle around one node. More points give rounder corners. */
const CORNER_POINTS = 12;
/** A polygon with `CORNER_POINTS` corners around a circle must be a bit bigger so that it holds the circle. */
const CORNER_SCALE = 1 / Math.cos(Math.PI / CORNER_POINTS);
const COS: number[] = [];
const SIN: number[] = [];
for (let k = 0; k < CORNER_POINTS; k++) {
  COS.push(Math.cos((2 * Math.PI * k) / CORNER_POINTS));
  SIN.push(Math.sin((2 * Math.PI * k) / CORNER_POINTS));
}

/** The folders of one graph and the nodes inside each of them. */
interface Structure {
  /** Folders that get an outline, shallow ones first. */
  folders: { id: string; label: string; depth: number; color: string | null; start: number; end: number }[];
  /** Node indices of all folders, one block for each folder (`start` to `end`). */
  members: Int32Array;
  /** Draw radius of each node for `nodeSize` 1. */
  radius: Float64Array;
  maxDepth: number;
}

const structureCache = new WeakMap<VisibleGraph, Structure>();

interface Entry {
  id: string;
  label: string;
  depth: number;
  color: string | null;
  collapsed: boolean;
  parent: number;
  /** Index of the folder node in `g.nodes`, -1 when the folder has no node. */
  node: number;
  explicit: boolean;
}

function buildStructure(g: VisibleGraph): Structure {
  const nodes = g.nodes;
  const entries: Entry[] = [];
  const entryOf = new Map<string, number>();

  // A folder entry for an id. Folders without a node get a name and a parent from the id.
  const ensure = (id: string, depth: number): number => {
    const known = entryOf.get(id);
    if (known !== undefined) return known;
    const rel = id.slice(2);
    const idx = entries.length;
    entries.push({ id, label: lastSegment(rel), depth, color: null, collapsed: false, parent: -1, node: -1, explicit: false });
    entryOf.set(id, idx);
    if (id !== 'f:') entries[idx].parent = ensure(`f:${dirOf(rel)}`, depth - 1);
    return idx;
  };

  nodes.forEach((v, i) => {
    if (v.kind !== 'folder') return;
    const idx = entries.length;
    entries.push({ id: v.id, label: v.label, depth: v.depth, color: v.color, collapsed: v.collapsed, parent: -1, node: i, explicit: true });
    entryOf.set(v.id, idx);
  });
  nodes.forEach((v) => {
    if (v.kind === 'folder' && v.parent !== null) entries[entryOf.get(v.id)!].parent = ensure(v.parent, v.depth - 1);
  });
  const startOf = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((v, i) => {
    if (v.kind === 'tag') return;
    if (v.kind === 'folder' && !v.collapsed) startOf[i] = entryOf.get(v.id)!;
    else if (v.parent !== null) startOf[i] = ensure(v.parent, v.depth - 1);
  });

  // An entry without a parent is the root. It gets no outline.
  const outlined = (e: Entry): boolean => e.parent >= 0 && !e.collapsed;

  // Count the members of every folder, then fill them (two passes, no small arrays).
  const counts = new Int32Array(entries.length);
  const eachChain = (i: number, fn: (e: number) => void): void => {
    for (let e = startOf[i]; e >= 0; e = entries[e].parent) if (outlined(entries[e])) fn(e);
  };
  for (let i = 0; i < nodes.length; i++) if (startOf[i] >= 0) eachChain(i, (e) => counts[e]++);
  const starts = new Int32Array(entries.length + 1);
  for (let e = 0; e < entries.length; e++) starts[e + 1] = starts[e] + counts[e];
  const members = new Int32Array(starts[entries.length]);
  const fill = starts.slice(0, entries.length);
  for (let i = 0; i < nodes.length; i++) if (startOf[i] >= 0) eachChain(i, (e) => (members[fill[e]++] = i));

  const radius = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) radius[i] = nodeRadius(nodes[i], 1);

  let maxDepth = 0;
  const folders: Structure['folders'] = [];
  entries.forEach((e, idx) => {
    if (!outlined(e)) return;
    // The folder node itself is inside its own outline but does not count as a node below it.
    const below = counts[idx] - (e.node >= 0 ? 1 : 0);
    if (below < 1) return;
    let color = e.color;
    if (!e.explicit) {
      // No folder node: use the color that all nodes inside share.
      color = nodes[members[starts[idx]]].color;
      for (let k = starts[idx] + 1; k < starts[idx + 1] && color !== null; k++) if (nodes[members[k]].color !== color) color = null;
    }
    if (e.depth > maxDepth) maxDepth = e.depth;
    folders.push({ id: e.id, label: e.label, depth: e.depth, color, start: starts[idx], end: starts[idx + 1] });
  });
  folders.sort((a, b) => a.depth - b.depth);
  return { folders, members, radius, maxDepth };
}

// Buffers for the points. They grow when needed and stay.
const centerPool: [number, number, number][] = [];
const cornerPool: [number, number][] = [];
let stamp = new Int32Array(0);
let generation = 0;

/**
 * Outlines of the folders around their visible nodes. Each outline is the convex
 * hull of circles around the nodes (radius of the node plus padding, with rounded
 * corners). Deeper folders get less padding, so they stay inside their parents.
 * The root folder gets no outline. The folders come shallow first, so drawing in
 * this order puts inner folders on top.
 */
export function folderHulls(g: VisibleGraph, pos: Float64Array, padding: number): FolderHull[] {
  let s = structureCache.get(g);
  if (!s || s.radius.length !== g.nodes.length) {
    s = buildStructure(g);
    structureCache.set(g, s);
  }
  const pad0 = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  const out: FolderHull[] = [];

  for (const f of s.folders) {
    const m = f.end - f.start;
    const pad = pad0 * (1 + 0.5 * (s.maxDepth - f.depth));

    // Step 1: the convex hull of the centers. Only its corners need circles.
    while (centerPool.length < m) centerPool.push([0, 0, 0]);
    const centers = centerPool.slice(0, m);
    for (let k = 0; k < m; k++) {
      const i = s.members[f.start + k];
      const c = centerPool[k];
      c[0] = pos[i * 2];
      c[1] = pos[i * 2 + 1];
      c[2] = i;
    }
    const corners = m >= 3 ? (polygonHull(centers as unknown as [number, number][]) as [number, number, number][] | null) : null;
    const chosen = corners && corners.length >= 3 ? corners : centers;

    // Nodes inside the hull are covered when every circle is at least as big as the biggest of them.
    let inner = 0;
    if (chosen !== centers) {
      if (stamp.length < g.nodes.length) stamp = new Int32Array(g.nodes.length);
      generation++;
      for (const c of chosen) stamp[c[2]] = generation;
      for (let k = 0; k < m; k++) {
        const i = s.members[f.start + k];
        if (stamp[i] !== generation && s.radius[i] > inner) inner = s.radius[i];
      }
    }

    // Step 2: circles around the chosen nodes, then the hull of all their points.
    let count = 0;
    for (const c of chosen) {
      const i = c[2];
      const r = (Math.max(s.radius[i], inner) + pad) * CORNER_SCALE;
      for (let k = 0; k < CORNER_POINTS; k++) {
        if (count === cornerPool.length) cornerPool.push([0, 0]);
        const p = cornerPool[count++];
        p[0] = c[0] + r * COS[k];
        p[1] = c[1] + r * SIN[k];
      }
    }
    const hull = polygonHull(cornerPool.slice(0, count));
    if (!hull) continue;
    const points: number[] = new Array(hull.length * 2);
    for (let k = 0; k < hull.length; k++) {
      points[k * 2] = hull[k][0];
      points[k * 2 + 1] = hull[k][1];
    }
    out.push({ id: f.id, depth: f.depth, label: f.label, color: f.color, points });
  }
  return out;
}

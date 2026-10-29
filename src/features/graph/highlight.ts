// Which nodes and edges stay bright on hover, and which go dim. Pure functions.

import type { VEdge, VisibleGraph } from './types';

/** Edges at each node, in compressed form: the edges of node `i` are `edge[start[i] .. start[i + 1]]`. */
export interface Adjacency {
  start: Int32Array;
  /** Edge index. */
  edge: Int32Array;
  /** The node at the other end of the edge. */
  other: Int32Array;
}

export function buildAdjacency(n: number, edges: readonly VEdge[]): Adjacency {
  const start = new Int32Array(n + 1);
  for (const e of edges) {
    start[e.source + 1]++;
    start[e.target + 1]++;
  }
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n);
  const edge = new Int32Array(edges.length * 2);
  const other = new Int32Array(edges.length * 2);
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k];
    edge[fill[e.source]] = k;
    other[fill[e.source]++] = e.target;
    edge[fill[e.target]] = k;
    other[fill[e.target]++] = e.source;
  }
  return { start, edge, other };
}

/** 1 = bright. Everything else dims. */
export interface Highlight {
  nodes: Uint8Array;
  edges: Uint8Array;
  /** The node that caused the highlight, or -1 for a folder. */
  focus: number;
}

/** The node, its edges and the nodes at their ends. */
export function nodeHighlight(g: VisibleGraph, adj: Adjacency, i: number): Highlight {
  const nodes = new Uint8Array(g.nodes.length);
  const edges = new Uint8Array(g.edges.length);
  nodes[i] = 1;
  for (let k = adj.start[i]; k < adj.start[i + 1]; k++) {
    edges[adj.edge[k]] = 1;
    nodes[adj.other[k]] = 1;
  }
  return { nodes, edges, focus: i };
}

/** True when the rel path `rel` is the folder `folderRel` or is inside it. The root folder is `''`. */
export function isUnderFolder(rel: string, folderRel: string): boolean {
  return folderRel === '' || rel === folderRel || rel.startsWith(folderRel + '/');
}

/** Indexes of the file and folder nodes inside a folder (tags are not inside folders). */
export function nodesUnderFolder(g: VisibleGraph, folderRel: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < g.nodes.length; i++) {
    const n = g.nodes[i];
    if (n.kind !== 'tag' && isUnderFolder(n.rel, folderRel)) out.push(i);
  }
  return out;
}

/** The nodes of a folder, and the edges between them. */
export function folderHighlight(g: VisibleGraph, folderRel: string): Highlight {
  const nodes = new Uint8Array(g.nodes.length);
  const edges = new Uint8Array(g.edges.length);
  for (const i of nodesUnderFolder(g, folderRel)) nodes[i] = 1;
  for (let k = 0; k < g.edges.length; k++) {
    const e = g.edges[k];
    if (nodes[e.source] && nodes[e.target]) edges[k] = 1;
  }
  return { nodes, edges, focus: -1 };
}

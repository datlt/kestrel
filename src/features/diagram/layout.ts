// Runs dagre on a `DagreInput`. This file imports dagre, so it loads lazily.

import dagre from '@dagrejs/dagre';
import type { DagreInput, Size } from './layout-input';

export interface PlacedNode extends Size {
  id: string;
  /** Center of the box. */
  x: number;
  y: number;
}

export interface PlacedEdge {
  /** Index in the edges of the diagram. */
  index: number;
  /** Points of the line from the `from` node to the `to` node of the diagram edge. */
  points: { x: number; y: number }[];
  /** Center of the label box, when the edge has a label. */
  label: { x: number; y: number } | null;
}

export interface Placement {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

export function runLayout(input: DagreInput): Placement {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ ...input.config });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of input.nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of input.edges) {
    g.setEdge(e.v, e.w, { weight: e.weight, width: e.labelWidth, height: e.labelHeight, labelpos: 'c' }, String(e.index));
  }
  dagre.layout(g);

  const nodes: PlacedNode[] = input.nodes.map((n) => {
    const p = g.node(n.id);
    return { id: n.id, width: n.width, height: n.height, x: p.x ?? 0, y: p.y ?? 0 };
  });
  const edges: PlacedEdge[] = input.edges.map((e) => {
    const label = g.edge(e.v, e.w, String(e.index));
    let points = ((label.points ?? []) as { x: number; y: number }[]).map((p) => ({ x: p.x, y: p.y }));
    // Dagre gives the points from `v` to `w`. The diagram edge of extends and
    // implements goes the other way.
    if (e.reversed) points = points.reverse();
    const hasLabel = e.labelWidth > 0 && typeof label.x === 'number' && typeof label.y === 'number';
    return { index: e.index, points, label: hasLabel ? { x: label.x as number, y: label.y as number } : null };
  });
  const gl = g.graph();
  return { nodes, edges, width: gl.width ?? 0, height: gl.height ?? 0 };
}

// Builds the input of the dagre layout: which node is above which, and the
// size of each node. Pure code, so the edge directions can be tested.

import type { DiagramEdge, DiagramNode, RelationKind } from '../../ipc/code';
import type { LayoutDirection } from './options';

export interface Size {
  width: number;
  height: number;
}

export interface DagreNodeInput extends Size {
  id: string;
}

export interface DagreEdgeInput {
  /** Index in the `edges` array of the diagram (also the dagre edge name). */
  index: number;
  /** Dagre edge from `v` to `w`: `v` is placed above (or left of) `w`. */
  v: string;
  w: string;
  /** True when `v` is the `to` end of the diagram edge (extends and implements). */
  reversed: boolean;
  /** Size of the label box, 0 when the edge has no label. */
  labelWidth: number;
  labelHeight: number;
  weight: number;
}

export interface DagreInput {
  config: { rankdir: LayoutDirection; nodesep: number; ranksep: number; edgesep: number; marginx: number; marginy: number };
  nodes: DagreNodeInput[];
  edges: DagreEdgeInput[];
}

/** Supertypes sit above subtypes: for these kinds the dagre edge goes from the target down to the source. */
export function isReversedKind(kind: RelationKind): boolean {
  return kind === 'extends' || kind === 'implements';
}

/** Text on an edge: the field names and the multiplicity. */
export function edgeLabelText(e: Pick<DiagramEdge, 'label' | 'multiplicity'>): string {
  const parts = [e.label ?? '', e.multiplicity ?? ''].filter(Boolean);
  return parts.join(' ');
}

const WEIGHTS: Record<RelationKind, number> = {
  extends: 4,
  implements: 3,
  composition: 2,
  aggregation: 2,
  nested: 2,
  dependency: 1,
};

export function buildLayoutInput(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  sizeOf: (id: string) => Size,
  direction: LayoutDirection,
  labelSize: (text: string) => Size,
): DagreInput {
  const ids = new Set(nodes.map((n) => n.id));
  const outEdges: DagreEdgeInput[] = [];
  edges.forEach((e, index) => {
    if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) return;
    const reversed = isReversedKind(e.kind);
    const text = edgeLabelText(e);
    const ls = text ? labelSize(text) : { width: 0, height: 0 };
    outEdges.push({
      index,
      v: reversed ? e.to : e.from,
      w: reversed ? e.from : e.to,
      reversed,
      labelWidth: ls.width,
      labelHeight: ls.height,
      weight: WEIGHTS[e.kind],
    });
  });
  return {
    config: {
      rankdir: direction,
      nodesep: direction === 'TB' ? 36 : 28,
      ranksep: direction === 'TB' ? 56 : 90,
      edgesep: 14,
      marginx: 16,
      marginy: 16,
    },
    nodes: nodes.map((n) => ({ id: n.id, ...sizeOf(n.id) })),
    edges: outEdges,
  };
}

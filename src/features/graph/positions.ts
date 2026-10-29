// Start positions of the nodes. Nodes that were on the screen before keep their
// place. A new node starts next to a linked node, or next to the other nodes of
// its folder. Without any old positions the nodes start on a spiral, in the
// order of the graph (a folder comes before its files, so neighbors stay near).

import { buildAdjacency } from './highlight';
import type { VisibleGraph } from './types';

const GOLDEN_ANGLE = 2.399963229728653;
/** Distance between spiral points, in graph units. */
const SPIRAL_STEP = 18;

/** A stable pair of numbers in 0 to 1 for an index. */
function hash2(i: number): [number, number] {
  let h = Math.imul(i + 1, 2654435761) >>> 0;
  const a = (h & 0xffff) / 65536;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return [a, (h & 0xffff) / 65536];
}

function near(i: number, x: number, y: number, out: Float64Array): void {
  const [a, r] = hash2(i);
  const angle = a * Math.PI * 2;
  const dist = 14 + r * 16;
  out[i * 2] = x + Math.cos(angle) * dist;
  out[i * 2 + 1] = y + Math.sin(angle) * dist;
}

export interface Seeded {
  pos: Float64Array;
  /** Nodes that had no old position. */
  fresh: number;
}

export function seedPositions(g: VisibleGraph, kept: ReadonlyMap<string, readonly [number, number]>): Seeded {
  const n = g.nodes.length;
  const pos = new Float64Array(n * 2);
  const done = new Uint8Array(n);
  let fresh = 0;
  for (let i = 0; i < n; i++) {
    const p = kept.get(g.nodes[i].id);
    if (p) {
      pos[i * 2] = p[0];
      pos[i * 2 + 1] = p[1];
      done[i] = 1;
    } else {
      fresh++;
    }
  }
  if (fresh === 0) return { pos, fresh };
  if (fresh === n) {
    for (let i = 0; i < n; i++) {
      const r = SPIRAL_STEP * Math.sqrt(i + 0.5);
      pos[i * 2] = Math.cos(i * GOLDEN_ANGLE) * r;
      pos[i * 2 + 1] = Math.sin(i * GOLDEN_ANGLE) * r;
    }
    return { pos, fresh };
  }

  // Middle of the old nodes of each folder.
  const centers = new Map<string, [number, number, number]>();
  let cx = 0;
  let cy = 0;
  let known = 0;
  for (let i = 0; i < n; i++) {
    if (!done[i]) continue;
    cx += pos[i * 2];
    cy += pos[i * 2 + 1];
    known++;
    const parent = g.nodes[i].parent;
    if (!parent) continue;
    const c = centers.get(parent);
    if (c) {
      c[0] += pos[i * 2];
      c[1] += pos[i * 2 + 1];
      c[2]++;
    } else {
      centers.set(parent, [pos[i * 2], pos[i * 2 + 1], 1]);
    }
  }
  cx /= known;
  cy /= known;

  const adj = buildAdjacency(n, g.edges);
  // A few passes: a new node can be linked to another new node that gets its place first.
  for (let pass = 0; pass < 3; pass++) {
    const placed: number[] = [];
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      let found = -1;
      for (let k = adj.start[i]; k < adj.start[i + 1]; k++) {
        const o = adj.other[k];
        if (done[o]) {
          found = o;
          break;
        }
      }
      if (found >= 0) {
        near(i, pos[found * 2], pos[found * 2 + 1], pos);
        placed.push(i);
        continue;
      }
      const parent = g.nodes[i].parent;
      const c = parent ? centers.get(parent) : undefined;
      if (c) {
        near(i, c[0] / c[2], c[1] / c[2], pos);
        placed.push(i);
      }
    }
    if (placed.length === 0) break;
    for (const i of placed) done[i] = 1;
  }
  // The rest has no neighbor and no folder mate: a small spiral around the middle.
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (done[i]) continue;
    const r = SPIRAL_STEP * Math.sqrt(k + 1);
    pos[i * 2] = cx + Math.cos(k * GOLDEN_ANGLE) * r;
    pos[i * 2 + 1] = cy + Math.sin(k * GOLDEN_ANGLE) * r;
    k++;
  }
  return { pos, fresh };
}

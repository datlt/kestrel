// Hierarchical edge bundling (Holten 2006) for the `radial` and `tree` layouts.

import type { VisibleGraph } from '../types';

/** Parent index of every node, cached for each graph (`bundlePath` runs for every edge in every frame). */
const parentCache = new WeakMap<VisibleGraph, Int32Array>();

function parentsOf(g: VisibleGraph): Int32Array {
  let parents = parentCache.get(g);
  if (parents && parents.length === g.nodes.length) return parents;
  const indexOf = new Map<string, number>();
  g.nodes.forEach((v, i) => indexOf.set(v.id, i));
  parents = new Int32Array(g.nodes.length);
  g.nodes.forEach((v, i) => {
    const p = v.parent === null ? -1 : (indexOf.get(v.parent) ?? -1);
    // A parent always has a lower index. This also stops loops in bad data.
    parents![i] = p < i ? p : -1;
  });
  parentCache.set(g, parents);
  return parents;
}

/**
 * Control points (x, y, x, y, ...) of a link edge in the tree layouts: from the
 * source up the folder tree to the lowest common folder and down to the target.
 * `beta` 0 gives the straight line, 1 the full bundle (Holten 2006, formula 1).
 * Returns an empty array for an unknown edge.
 */
export function bundlePath(g: VisibleGraph, edge: number, pos: Float64Array, beta: number): number[] {
  const e = g.edges[edge];
  if (!e || e.source === e.target) return [];
  const parents = parentsOf(g);
  const b = Number.isFinite(beta) ? Math.min(1, Math.max(0, beta)) : 0;

  // Find the lowest common ancestor. The chains are short (the depth of the folder tree).
  let lcaUp = -1;
  let lcaDown = -1;
  let up = 0;
  for (let a = e.source; a >= 0 && lcaUp < 0; a = parents[a], up++) {
    let down = 0;
    for (let c = e.target; c >= 0; c = parents[c], down++) {
      if (c === a) {
        lcaUp = up;
        lcaDown = down;
        break;
      }
    }
  }

  const chain: number[] = [];
  if (lcaUp >= 0) {
    let a = e.source;
    for (let i = 0; i <= lcaUp; i++, a = parents[a]) chain.push(a);
    const down: number[] = [];
    let c = e.target;
    for (let i = 0; i < lcaDown; i++, c = parents[c]) down.push(c);
    for (let i = down.length - 1; i >= 0; i--) chain.push(down[i]);
  } else {
    // No common folder (for example a tag): the straight line.
    chain.push(e.source, e.target);
  }

  const n = chain.length;
  const out: number[] = new Array(n * 2);
  const x0 = pos[e.source * 2];
  const y0 = pos[e.source * 2 + 1];
  const dx = pos[e.target * 2] - x0;
  const dy = pos[e.target * 2 + 1] - y0;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    out[i * 2] = b * pos[chain[i] * 2] + (1 - b) * (x0 + t * dx);
    out[i * 2 + 1] = b * pos[chain[i] * 2 + 1] + (1 - b) * (y0 + t * dy);
  }
  return out;
}

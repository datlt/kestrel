// Positions for the `radial` and `tree` layouts (d3-hierarchy over the folder tree).

import { cluster, hierarchy } from 'd3-hierarchy';
import type { VisibleGraph } from '../types';

/** Room for one leaf label on the outer circle or in one row, in pixels. */
const LEAF_SPACE = 14;
/** Width of one folder level in the `tree` layout. */
const COLUMN_WIDTH = 200;
/** Smallest distance between two folder levels in the `radial` layout. */
const RING_SPACE = 80;

interface Item {
  /** Index in `g.nodes`, or -1 for a helper item that is not drawn. */
  idx: number;
  children?: Item[];
}

/** The folder tree as items. Tags get a helper group of their own inside the root. */
function buildItems(g: VisibleGraph): Item {
  const nodes = g.nodes;
  const items: Item[] = nodes.map((_, i) => ({ idx: i }));
  const indexOf = new Map<string, number>();
  nodes.forEach((v, i) => indexOf.set(v.id, i));

  const roots: Item[] = [];
  const tags: Item[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const v = nodes[i];
    if (v.kind === 'tag') {
      tags.push(items[i]);
      continue;
    }
    // A parent has a lower index. Anything else goes to the top.
    const p = v.parent === null ? -1 : (indexOf.get(v.parent) ?? -1);
    if (p >= 0 && p < i && nodes[p].kind === 'folder') (items[p].children ??= []).push(items[i]);
    else roots.push(items[i]);
  }

  const tagGroup: Item | null = tags.length > 0 ? { idx: -1, children: tags } : null;
  if (roots.length === 1 && nodes[roots[0].idx].kind === 'folder') {
    const root = roots[0];
    if (tagGroup) (root.children ??= []).push(tagGroup);
    return root;
  }
  return { idx: -1, children: tagGroup ? [...roots, tagGroup] : roots };
}

/** Positions for the `radial` and `tree` layouts: x, y per node, centered on 0, 0. */
export function treeLayout(g: VisibleGraph, kind: 'radial' | 'tree'): Float64Array {
  const pos = new Float64Array(g.nodes.length * 2);
  if (g.nodes.length === 0) return pos;

  const h = hierarchy<Item>(buildItems(g));
  const leaves = h.leaves().length;
  const height = h.height;

  if (kind === 'radial') {
    // The root is in the middle. Leaves are on the outer circle, `LEAF_SPACE` apart.
    const radius = Math.max((leaves * LEAF_SPACE) / (2 * Math.PI), height * RING_SPACE, 100);
    cluster<Item>().size([2 * Math.PI, radius]).separation(() => 1)(h);
    h.each((d) => {
      if (d.data.idx < 0) return;
      const angle = (d.x ?? 0) - Math.PI / 2;
      const r = d.y ?? 0;
      // `+ 0` turns -0 into 0.
      pos[d.data.idx * 2] = r * Math.cos(angle) + 0;
      pos[d.data.idx * 2 + 1] = r * Math.sin(angle) + 0;
    });
    return pos;
  }

  // Left to right: one column for each folder level and one row for each leaf.
  // A folder sits in the middle of the rows of its children.
  let row = 0;
  for (const leaf of h.leaves()) leaf.x = row++ * LEAF_SPACE;
  h.eachAfter((d) => {
    if (d.children) d.x = (d.children[0].x! + d.children[d.children.length - 1].x!) / 2;
  });
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  h.each((d) => {
    if (d.data.idx < 0) return;
    const x = d.depth * COLUMN_WIDTH;
    const y = d.x ?? 0;
    pos[d.data.idx * 2] = x;
    pos[d.data.idx * 2 + 1] = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (let i = 0; i < pos.length; i += 2) {
    pos[i] -= cx;
    pos[i + 1] -= cy;
  }
  return pos;
}

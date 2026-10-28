// Pane layout of one terminal tab. This file is pure logic (no DOM), so tests can run it.
//
// A layout is a tree. A leaf is one pane. A split holds two or more children that
// sit side by side (`row`) or above each other (`column`). `sizes` has one share
// per child, and the shares add up to 1.

export type SplitDir = 'row' | 'column';

export interface Leaf {
  type: 'leaf';
  id: string;
}

export interface Split {
  type: 'split';
  dir: SplitDir;
  children: LayoutNode[];
  sizes: number[];
}

export type LayoutNode = Leaf | Split;

/** No pane can get smaller than this share of its split. */
export const MIN_SHARE = 0.08;

export function leaf(id: string): Leaf {
  return { type: 'leaf', id };
}

/** Pane ids from left to right and from top to bottom. */
export function leaves(node: LayoutNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return node.children.flatMap(leaves);
}

export function hasLeaf(node: LayoutNode, id: string): boolean {
  return leaves(node).includes(id);
}

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((s) => s / total);
}

/**
 * Splits the pane `id` and puts `newId` after it (right of it or below it).
 * When the parent already splits in the same direction, the new pane joins the
 * parent and takes half of the share of `id`.
 */
export function splitLeaf(root: LayoutNode, id: string, dir: SplitDir, newId: string): LayoutNode {
  if (root.type === 'leaf') {
    if (root.id !== id) return root;
    return { type: 'split', dir, children: [root, leaf(newId)], sizes: [0.5, 0.5] };
  }
  const index = root.children.findIndex((c) => c.type === 'leaf' && c.id === id);
  if (index >= 0 && root.dir === dir) {
    const children = [...root.children];
    children.splice(index + 1, 0, leaf(newId));
    const sizes = [...root.sizes];
    const half = sizes[index] / 2;
    sizes[index] = half;
    sizes.splice(index + 1, 0, half);
    return { ...root, children, sizes };
  }
  return { ...root, children: root.children.map((c) => splitLeaf(c, id, dir, newId)) };
}

/**
 * Removes the pane `id`. Its share goes to the neighbour before it (or after it
 * for the first child). A split with one child is replaced by that child, and a
 * child split in the same direction as its parent is merged into the parent.
 * Returns null when no pane is left.
 */
export function closeLeaf(root: LayoutNode, id: string): LayoutNode | null {
  if (root.type === 'leaf') return root.id === id ? null : root;
  const kept: { node: LayoutNode; size: number }[] = [];
  // Share of a removed first child. The next child gets it.
  let carry = 0;
  root.children.forEach((child, i) => {
    const next = closeLeaf(child, id);
    if (next === null) {
      if (kept.length > 0) kept[kept.length - 1].size += root.sizes[i];
      else carry += root.sizes[i];
      return;
    }
    kept.push({ node: next, size: root.sizes[i] + carry });
    carry = 0;
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].node;
  // Merge child splits that go in the same direction as this split.
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  for (const { node, size } of kept) {
    if (node.type === 'split' && node.dir === root.dir) {
      node.children.forEach((c, j) => {
        children.push(c);
        sizes.push(size * node.sizes[j]);
      });
    } else {
      children.push(node);
      sizes.push(size);
    }
  }
  return { type: 'split', dir: root.dir, children, sizes: normalize(sizes) };
}

/** The pane that gets the focus after `id` closed: the one before it, or the first one. */
export function paneAfterClose(root: LayoutNode, id: string): string | null {
  const ids = leaves(root);
  const i = ids.indexOf(id);
  if (i < 0) return ids[0] ?? null;
  return ids[i - 1] ?? ids[i + 1] ?? null;
}

/** Next pane (or previous with `step` -1). It wraps around. Returns `id` when there is only one pane. */
export function neighbour(root: LayoutNode, id: string, step: 1 | -1): string {
  const ids = leaves(root);
  const i = ids.indexOf(id);
  if (i < 0 || ids.length < 2) return id;
  return ids[(i + step + ids.length) % ids.length];
}

/**
 * New shares after the divider between child `index` and `index + 1` moved by
 * `delta` (a share of the whole split; positive moves it right or down).
 * Neither neighbour gets smaller than `MIN_SHARE`. Other shares stay the same.
 */
export function dragSizes(sizes: number[], index: number, delta: number, min = MIN_SHARE): number[] {
  if (index < 0 || index >= sizes.length - 1) return sizes;
  const pair = sizes[index] + sizes[index + 1];
  const first = Math.min(Math.max(sizes[index] + delta, Math.min(min, pair / 2)), pair - Math.min(min, pair / 2));
  const next = [...sizes];
  next[index] = first;
  next[index + 1] = pair - first;
  return next;
}

/** Follows `path` (child indexes from the root) to a split and replaces its sizes. */
export function setSizesAt(root: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (root.type === 'leaf') return root;
  if (path.length === 0) return { ...root, sizes };
  const [head, ...rest] = path;
  return { ...root, children: root.children.map((c, i) => (i === head ? setSizesAt(c, rest, sizes) : c)) };
}

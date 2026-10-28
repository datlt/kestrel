import { describe, expect, it } from 'vitest';
import { closeLeaf, dragSizes, leaf, leaves, neighbour, paneAfterClose, setSizesAt, splitLeaf, type LayoutNode } from './layout';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('splitLeaf', () => {
  it('splits a single pane into two halves', () => {
    const r = splitLeaf(leaf('a'), 'a', 'row', 'b');
    expect(r).toEqual({ type: 'split', dir: 'row', children: [leaf('a'), leaf('b')], sizes: [0.5, 0.5] });
  });

  it('adds a sibling when the parent goes the same way', () => {
    let r: LayoutNode = splitLeaf(leaf('a'), 'a', 'row', 'b');
    r = splitLeaf(r, 'a', 'row', 'c');
    expect(leaves(r)).toEqual(['a', 'c', 'b']);
    expect((r as any).sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it('nests a split when the direction changes', () => {
    let r: LayoutNode = splitLeaf(leaf('a'), 'a', 'row', 'b');
    r = splitLeaf(r, 'b', 'column', 'c');
    expect(leaves(r)).toEqual(['a', 'b', 'c']);
    const second = (r as any).children[1];
    expect(second.type).toBe('split');
    expect(second.dir).toBe('column');
  });

  it('ignores an unknown pane', () => {
    const r = leaf('a');
    expect(splitLeaf(r, 'zzz', 'row', 'b')).toBe(r);
  });
});

describe('closeLeaf', () => {
  it('returns null for the last pane', () => {
    expect(closeLeaf(leaf('a'), 'a')).toBeNull();
  });

  it('collapses a split with one child left', () => {
    const r = splitLeaf(leaf('a'), 'a', 'row', 'b');
    expect(closeLeaf(r, 'b')).toEqual(leaf('a'));
    expect(closeLeaf(r, 'a')).toEqual(leaf('b'));
  });

  it('gives the share to the neighbour and keeps the total at 1', () => {
    let r: LayoutNode = splitLeaf(leaf('a'), 'a', 'row', 'b');
    r = splitLeaf(r, 'b', 'row', 'c');
    // sizes: a 0.5, b 0.25, c 0.25
    const out = closeLeaf(r, 'b') as any;
    expect(leaves(out)).toEqual(['a', 'c']);
    expect(out.sizes[0]).toBeCloseTo(0.75);
    expect(out.sizes[1]).toBeCloseTo(0.25);
    const first = closeLeaf(r, 'a') as any;
    expect(leaves(first)).toEqual(['b', 'c']);
    expect(sum(first.sizes)).toBeCloseTo(1);
    expect(first.sizes[0]).toBeCloseTo(0.75);
  });

  it('merges a child split into its parent when both go the same way', () => {
    let r: LayoutNode = splitLeaf(leaf('a'), 'a', 'row', 'b');
    r = splitLeaf(r, 'b', 'column', 'c'); // row[a, column[b, c]]
    r = splitLeaf(r, 'c', 'row', 'd'); // row[a, column[b, row[c, d]]]
    const out = closeLeaf(r, 'b') as any; // column[b, row[c, d]] becomes row[c, d]
    expect(out.dir).toBe('row');
    expect(leaves(out)).toEqual(['a', 'c', 'd']);
    expect(sum(out.sizes)).toBeCloseTo(1);
  });

  it('leaves the tree alone for an unknown pane', () => {
    const r = splitLeaf(leaf('a'), 'a', 'row', 'b');
    expect(leaves(closeLeaf(r, 'zzz')!)).toEqual(['a', 'b']);
  });
});

describe('focus', () => {
  const tree = splitLeaf(splitLeaf(leaf('a'), 'a', 'row', 'b'), 'b', 'row', 'c');

  it('moves to the next and previous pane with wrap around', () => {
    expect(neighbour(tree, 'a', 1)).toBe('b');
    expect(neighbour(tree, 'c', 1)).toBe('a');
    expect(neighbour(tree, 'a', -1)).toBe('c');
    expect(neighbour(leaf('x'), 'x', 1)).toBe('x');
  });

  it('picks the pane before the closed one, else the one after', () => {
    expect(paneAfterClose(tree, 'b')).toBe('a');
    expect(paneAfterClose(tree, 'a')).toBe('b');
    expect(paneAfterClose(leaf('x'), 'x')).toBeNull();
  });
});

describe('dragSizes', () => {
  it('moves the divider and keeps the pair total', () => {
    const out = dragSizes([0.5, 0.5], 0, 0.1);
    expect(out[0]).toBeCloseTo(0.6);
    expect(out[1]).toBeCloseTo(0.4);
  });

  it('stops at the minimum share', () => {
    const out = dragSizes([0.5, 0.3, 0.2], 1, 5);
    expect(out[0]).toBe(0.5);
    expect(out[2]).toBeCloseTo(0.08);
    expect(sum(out)).toBeCloseTo(1);
    expect(dragSizes([0.5, 0.5], 0, -5)[0]).toBeCloseTo(0.08);
  });

  it('ignores a bad index', () => {
    expect(dragSizes([1], 0, 0.1)).toEqual([1]);
  });

  it('setSizesAt replaces the sizes of a nested split', () => {
    let r: LayoutNode = splitLeaf(leaf('a'), 'a', 'row', 'b');
    r = splitLeaf(r, 'b', 'column', 'c');
    const out = setSizesAt(r, [1], [0.3, 0.7]) as any;
    expect(out.children[1].sizes).toEqual([0.3, 0.7]);
    expect(out.sizes).toEqual([0.5, 0.5]);
  });
});

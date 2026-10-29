// HEAVY tests: big generated graphs and the speed targets of docs/DESIGN.md 14.4.
// Each target is measured as the best of a few runs, so that one slow run (garbage
// collection, other tests) does not fail it. The numbers are printed.

import { describe, expect, it } from 'vitest';
import type { NoteGraph, VisibleGraph } from '../types';
import { bigGraph, makeInput } from './fixtures';
import { buildFolderTree, buildVisibleGraph, compileQuery, folderHulls, treeLayout } from './index';

function best(runs: number, fn: () => void): number {
  let min = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    min = Math.min(min, performance.now() - t);
  }
  return min;
}

describe('HEAVY: speed targets', () => {
  const big: NoteGraph = bigGraph(20000, 110000, 11);

  it('has a big enough test graph', () => {
    expect(big.nodes.length).toBeGreaterThan(19000);
    expect(big.links.length).toBeGreaterThan(100000);
  });

  it('buildVisibleGraph: 20,000 notes and 100,000 links in under 100 ms', () => {
    const input = makeInput(big);
    let g: VisibleGraph | null = null;
    const ms = best(5, () => {
      g = buildVisibleGraph(input);
    });
    console.log(`[perf] buildVisibleGraph project/force: ${ms.toFixed(1)} ms (${g!.nodes.length} nodes, ${g!.edges.length} edges)`);
    expect(g!.stats.links).toBeGreaterThan(90000);
    expect(ms).toBeLessThan(100);
  });

  it('buildVisibleGraph: with tags, collapsed folders and a query', () => {
    const tree = buildFolderTree(big, 1, 'light');
    const collapsed = tree.children.slice(0, 3).map((c) => c.rel);
    const input = makeInput(big, { tree, folders: { collapsed, hidden: [] }, options: { showTags: true, query: 'note1 OR note2', showOrphans: false } });
    let g: VisibleGraph | null = null;
    const ms = best(3, () => {
      g = buildVisibleGraph(input);
    });
    console.log(`[perf] buildVisibleGraph tags+collapsed+query: ${ms.toFixed(1)} ms (${g!.nodes.length} nodes)`);
    expect(ms).toBeLessThan(100);
  });

  it('buildVisibleGraph: a local graph of depth 3', () => {
    const input = makeInput(big, { scope: { kind: 'local', path: big.nodes[100].path, follow: false }, options: { depth: 3 } });
    const ms = best(3, () => buildVisibleGraph(input));
    console.log(`[perf] buildVisibleGraph local depth 3: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(100);
  });

  it('buildFolderTree for 20,000 notes', () => {
    const ms = best(3, () => buildFolderTree(big, 1, 'light'));
    console.log(`[perf] buildFolderTree: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(100);
  });

  it('treeLayout in under 100 ms (radial and tree)', () => {
    const g = buildVisibleGraph(makeInput(big, { options: { layout: 'radial' } }));
    const radial = best(5, () => treeLayout(g, 'radial'));
    const tree = best(5, () => treeLayout(g, 'tree'));
    console.log(`[perf] treeLayout radial: ${radial.toFixed(1)} ms, tree: ${tree.toFixed(1)} ms (${g.nodes.length} nodes)`);
    expect(radial).toBeLessThan(100);
    expect(tree).toBeLessThan(100);
  });

  it('compileQuery and test for 20,000 nodes', () => {
    const ms = best(3, () => {
      const q = compileQuery('(note1 OR tag:t3) -f12 file:/^note\\d+/');
      let n = 0;
      for (const node of big.nodes) if (q.test(node)) n++;
      return n;
    });
    console.log(`[perf] query on 20,000 nodes: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(100);
  });

  it('folderHulls: 500 folders and 5,000 nodes in under 8 ms', () => {
    const graph = bigGraph(5000, 8000, 21, 10);
    const g = buildVisibleGraph(makeInput(graph));
    const folders = g.nodes.filter((n) => n.kind === 'folder').length;
    const pos = new Float64Array(g.nodes.length * 2);
    let seed = 5;
    const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < pos.length; i++) pos[i] = (rnd() - 0.5) * 3000;
    const t0 = performance.now();
    const first = folderHulls(g, pos, 12);
    const firstMs = performance.now() - t0;
    // The nodes move a little in each frame.
    const ms = best(20, () => {
      for (let i = 0; i < pos.length; i++) pos[i] += (rnd() - 0.5) * 2;
      folderHulls(g, pos, 12);
    });
    console.log(`[perf] folderHulls: ${ms.toFixed(2)} ms per call, first call ${firstMs.toFixed(1)} ms (${folders} folders, ${g.nodes.length - folders} files, ${first.length} hulls)`);
    expect(folders).toBeGreaterThan(100);
    expect(ms).toBeLessThan(8);
  });
});

import { describe, expect, it } from 'vitest';
import type { DiagramEdge } from '../../ipc/code';
import { EDGES, node, NODES } from './fixture';
import { runLayout } from './layout';
import { buildLayoutInput } from './layout-input';

const size = () => ({ width: 120, height: 60 });
const label = (t: string) => ({ width: t.length * 6, height: 14 });

describe('dagre layout', () => {
  it('places supertypes above subtypes and parts below owners', () => {
    const p = runLayout(buildLayoutInput(NODES, EDGES, size, 'TB', label));
    const y = (id: string) => p.nodes.find((n) => n.id === id)!.y;
    expect(y('demo.Repo')).toBeLessThan(y('demo.UserRepo'));
    expect(y('demo.UserRepo')).toBeLessThan(y('demo.User')); // aggregation: owner above part
  });

  it('gives edge points from the `from` node to the `to` node', () => {
    const p = runLayout(buildLayoutInput(NODES, EDGES, size, 'TB', label));
    const e = p.edges.find((x) => x.index === 0)!; // UserRepo implements Repo
    const first = e.points[0];
    const last = e.points[e.points.length - 1];
    expect(first.y).toBeGreaterThan(last.y); // starts at the subtype (below), ends at the supertype (above)
  });

  it('puts supertypes left of subtypes in left to right mode', () => {
    const p = runLayout(buildLayoutInput(NODES, EDGES, size, 'LR', label));
    const x = (id: string) => p.nodes.find((n) => n.id === id)!.x;
    expect(x('demo.Repo')).toBeLessThan(x('demo.UserRepo'));
  });

  it('lays out 150 nodes in under 300 ms', () => {
    const nodes = Array.from({ length: 150 }, (_, i) => node({ id: `n.N${i}`, name: `N${i}` }));
    const edges: DiagramEdge[] = [];
    for (let i = 1; i < 150; i++) {
      edges.push({ from: `n.N${i}`, to: `n.N${Math.floor((i - 1) / 3)}`, kind: i % 2 ? 'extends' : 'composition', label: i % 5 === 0 ? 'field' : undefined });
      if (i % 7 === 0) edges.push({ from: `n.N${i}`, to: `n.N${(i * 13) % 150}`, kind: 'dependency' });
    }
    const input = buildLayoutInput(nodes, edges, () => ({ width: 160, height: 90 }), 'TB', label);
    const t0 = performance.now();
    const p = runLayout(input);
    const ms = performance.now() - t0;
    expect(p.nodes).toHaveLength(150);
    expect(ms).toBeLessThan(300);
  });
});

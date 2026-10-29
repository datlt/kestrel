import { describe, expect, it } from 'vitest';
import { EDGE_LINK, EDGE_TREE, Sim } from './sim-core';
import type { SimInit, SimParams } from './sim-core';

const PARAMS: SimParams = { centerForce: 0.5, repelForce: 10, linkForce: 1, linkDistance: 250, folderPull: 0.3 };

/** Two folders (groups 0 and 1) with 10 nodes each, a ring of links inside each. */
function twoFolders(params = PARAMS, warmup = 0): SimInit {
  const n = 20;
  const edges: number[] = [];
  const kinds: number[] = [];
  for (let f = 0; f < 2; f++) {
    for (let k = 0; k < 10; k++) {
      edges.push(f * 10 + k, f * 10 + ((k + 1) % 10));
      kinds.push(EDGE_LINK);
    }
  }
  edges.push(0, 10);
  kinds.push(EDGE_LINK);
  const pos = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 2] = Math.cos(i) * 40 * (1 + (i % 3));
    pos[i * 2 + 1] = Math.sin(i) * 40 * (1 + (i % 3));
  }
  return {
    n,
    edges: Int32Array.from(edges),
    edgeKind: Uint8Array.from(kinds),
    group: Int32Array.from({ length: n }, (_, i) => (i < 10 ? 0 : 1)),
    folderParent: Int32Array.from([-1, -1]),
    radius: new Float32Array(n).fill(6),
    pos,
    params,
    alpha: 1,
    warmup,
  };
}

function run(sim: Sim, max = 2000): number {
  let ticks = 0;
  while (sim.active() && ticks < max) {
    sim.tick();
    ticks++;
  }
  return ticks;
}

describe('Sim', () => {
  it('cools down and stops', () => {
    const sim = new Sim(twoFolders());
    const ticks = run(sim);
    expect(ticks).toBeGreaterThan(50);
    expect(ticks).toBeLessThan(1000);
    expect(sim.active()).toBe(false);
    const p = sim.positions();
    expect(p.length).toBe(40);
    for (const v of p) expect(Number.isFinite(v)).toBe(true);
  });

  it('runs warm-up steps before the first answer', () => {
    const cold = new Sim(twoFolders(PARAMS, 0));
    const warm = new Sim(twoFolders(PARAMS, 60));
    expect(warm.alpha).toBeLessThan(cold.alpha);
  });

  it('keeps a pinned node where it is and wakes the simulation', () => {
    const sim = new Sim(twoFolders());
    run(sim);
    expect(sim.active()).toBe(false);
    sim.pin(3, 500, -400);
    expect(sim.active()).toBe(true);
    for (let i = 0; i < 20; i++) sim.tick();
    const p = sim.positions();
    expect(p[6]).toBeCloseTo(500);
    expect(p[7]).toBeCloseTo(-400);
    sim.unpin(3);
    expect(run(sim)).toBeGreaterThan(0);
    expect(sim.active()).toBe(false);
  });

  it('pulls nodes toward the middle of their folder', () => {
    const spread = (pull: number) => {
      const sim = new Sim(twoFolders({ ...PARAMS, folderPull: pull, linkForce: 0 }));
      run(sim);
      const p = sim.positions();
      // Mean distance of the nodes of folder 0 to their own middle.
      let mx = 0;
      let my = 0;
      for (let i = 0; i < 10; i++) {
        mx += p[i * 2] / 10;
        my += p[i * 2 + 1] / 10;
      }
      let d = 0;
      for (let i = 0; i < 10; i++) d += Math.hypot(p[i * 2] - mx, p[i * 2 + 1] - my) / 10;
      return d;
    };
    expect(spread(1)).toBeLessThan(spread(0) * 0.8);
  });

  it('pulls a tree edge to a short distance', () => {
    const init = twoFolders();
    init.edges = Int32Array.from([0, 1]);
    init.edgeKind = Uint8Array.from([EDGE_TREE]);
    init.group = new Int32Array(20).fill(-1);
    init.folderParent = new Int32Array(0);
    const sim = new Sim(init);
    run(sim);
    const p = sim.positions();
    expect(Math.hypot(p[0] - p[2], p[1] - p[3])).toBeLessThan(120);
  });

  it('accepts new forces and a new radius', () => {
    const sim = new Sim(twoFolders());
    run(sim);
    sim.setParams({ ...PARAMS, repelForce: 0 });
    sim.setRadius(new Float32Array(20).fill(12));
    sim.reheat(0.5);
    expect(sim.active()).toBe(true);
    run(sim);
    for (const v of sim.positions()) expect(Number.isFinite(v)).toBe(true);
  });

  it('works with no nodes', () => {
    const sim = new Sim({ ...twoFolders(), n: 0, edges: new Int32Array(0), edgeKind: new Uint8Array(0), group: new Int32Array(0), folderParent: new Int32Array(0), radius: new Float32Array(0), pos: new Float32Array(0) });
    run(sim);
    expect(sim.positions().length).toBe(0);
  });
});

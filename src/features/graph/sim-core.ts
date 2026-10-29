// The force simulation. It uses d3-force and has no DOM, so it runs in the
// worker (`sim-worker.ts`), and tests can run it directly.
//
// Forces: links (springs), many-body repulsion (Barnes-Hut), a pull to the
// center, collision, and a folder force. The folder force pulls each node
// toward the middle of its folder. The middle of a folder is the average
// position of all nodes below it, so sub folders gather inside their parents.
// Tree edges (a file to its folder) are springs too.

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { ForceCollide, ForceLink, ForceManyBody, ForceX, ForceY, Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';

export const EDGE_LINK = 0;
export const EDGE_TREE = 1;
export const EDGE_TAG = 2;

export interface SimParams {
  /** 0 to 1. */
  centerForce: number;
  /** 0 to 20. */
  repelForce: number;
  /** 0 to 1. */
  linkForce: number;
  /** 30 to 500. */
  linkDistance: number;
  /** 0 to 1. */
  folderPull: number;
}

export interface SimInit {
  n: number;
  /** source, target, source, target, ... (node indexes). */
  edges: Int32Array;
  /** `EDGE_LINK`, `EDGE_TREE` or `EDGE_TAG` per edge. */
  edgeKind: Uint8Array;
  /** Folder group of each node, -1 for none. */
  group: Int32Array;
  /** Parent group of each group, -1 for the root. */
  folderParent: Int32Array;
  radius: Float32Array;
  /** x, y per node. */
  pos: Float32Array;
  params: SimParams;
  /** Start heat, 0 to 1. */
  alpha: number;
  /** Steps to run before the first answer. */
  warmup: number;
}

interface SNode extends SimulationNodeDatum {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}

/** Above this many nodes the collision force is off: it costs too much. */
const COLLIDE_MAX_NODES = 6000;

function folderForce(group: Int32Array, folderParent: Int32Array) {
  const groups = folderParent.length;
  const sx = new Float64Array(groups);
  const sy = new Float64Array(groups);
  const cnt = new Float64Array(groups);
  let nodes: SNode[] = [];
  let strength = 0;
  const force = (alpha: number) => {
    if (strength <= 0 || groups === 0) return;
    sx.fill(0);
    sy.fill(0);
    cnt.fill(0);
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      let g = group[i];
      while (g >= 0) {
        sx[g] += nd.x;
        sy[g] += nd.y;
        cnt[g]++;
        g = folderParent[g];
      }
    }
    const k = strength * 0.4 * alpha;
    for (let i = 0; i < nodes.length; i++) {
      const g = group[i];
      if (g < 0 || cnt[g] < 2) continue;
      const nd = nodes[i];
      nd.vx += (sx[g] / cnt[g] - nd.x) * k;
      nd.vy += (sy[g] / cnt[g] - nd.y) * k;
    }
  };
  force.initialize = (n: SNode[]) => {
    nodes = n;
  };
  force.strength = (s: number) => {
    strength = s;
    return force;
  };
  return force;
}

export class Sim {
  readonly n: number;
  private nodes: SNode[];
  private sim: Simulation<SNode, undefined>;
  private link: ForceLink<SNode, SimulationLinkDatum<SNode>>;
  private charge: ForceManyBody<SNode>;
  private fx: ForceX<SNode>;
  private fy: ForceY<SNode>;
  private folder: ReturnType<typeof folderForce>;
  private collide: ForceCollide<SNode> | null;
  private radius: Float32Array;
  private pinned = new Set<number>();
  private edgeKind: Uint8Array;
  private degree: Int32Array;

  constructor(init: SimInit) {
    this.n = init.n;
    this.radius = init.radius;
    this.edgeKind = init.edgeKind;
    this.nodes = [];
    for (let i = 0; i < init.n; i++) {
      this.nodes.push({ x: init.pos[i * 2], y: init.pos[i * 2 + 1], vx: 0, vy: 0, fx: null, fy: null });
    }
    const m = init.edgeKind.length;
    this.degree = new Int32Array(init.n);
    const links: { source: number; target: number }[] = [];
    for (let e = 0; e < m; e++) {
      const s = init.edges[e * 2];
      const t = init.edges[e * 2 + 1];
      links.push({ source: s, target: t });
      this.degree[s]++;
      this.degree[t]++;
    }
    this.link = forceLink<SNode, SimulationLinkDatum<SNode>>(links).iterations(1);
    this.charge = forceManyBody<SNode>().theta(0.9).distanceMax(700);
    this.fx = forceX<SNode>(0);
    this.fy = forceY<SNode>(0);
    this.folder = folderForce(init.group, init.folderParent);
    this.collide = init.n <= COLLIDE_MAX_NODES ? forceCollide<SNode>((_d, i) => this.radius[i ?? 0] + 3).strength(0.7).iterations(1) : null;
    const big = init.n > 3000;
    this.sim = forceSimulation<SNode>(this.nodes)
      .alphaDecay(big ? 0.04 : 0.0228)
      .velocityDecay(0.4)
      .force('link', this.link)
      .force('charge', this.charge)
      .force('x', this.fx)
      .force('y', this.fy)
      .force('folder', this.folder);
    if (this.collide) this.sim.force('collide', this.collide);
    this.sim.stop();
    this.setParams(init.params);
    this.sim.alpha(init.alpha);
    for (let i = 0; i < init.warmup; i++) this.sim.tick();
  }

  setParams(p: SimParams): void {
    const kinds = this.edgeKind;
    const deg = this.degree;
    this.link
      .distance((_l, i) => {
        const k = kinds[i];
        return k === EDGE_TREE ? p.linkDistance * 0.12 : k === EDGE_TAG ? p.linkDistance * 0.22 : p.linkDistance * 0.3;
      })
      .strength((l, i) => {
        const s = (l.source as unknown as { index: number }).index;
        const t = (l.target as unknown as { index: number }).index;
        const base = 1 / Math.min(deg[s] || 1, deg[t] || 1);
        const k = kinds[i];
        return k === EDGE_TREE ? Math.min(1, base * 1.2) * 0.8 : base * p.linkForce * (k === EDGE_TAG ? 0.8 : 1);
      });
    this.charge.strength(-p.repelForce * 14);
    this.fx.strength(p.centerForce * 0.08);
    this.fy.strength(p.centerForce * 0.08);
    this.folder.strength(p.folderPull);
  }

  /** New draw radii (the node size option changed). */
  setRadius(radius: Float32Array): void {
    this.radius = radius;
    this.collide?.radius((_d, i) => this.radius[i ?? 0] + 3);
  }

  /** Raises the heat to at least `alpha`. */
  reheat(alpha: number): void {
    this.sim.alpha(Math.max(this.sim.alpha(), alpha));
  }

  /** Holds a node at a place (a drag). Keeps the simulation warm until `unpin`. */
  pin(i: number, x: number, y: number): void {
    const nd = this.nodes[i];
    if (!nd) return;
    nd.fx = x;
    nd.fy = y;
    nd.x = x;
    nd.y = y;
    this.pinned.add(i);
    this.sim.alphaTarget(0.3);
    this.reheat(0.3);
  }

  unpin(i: number): void {
    const nd = this.nodes[i];
    if (!nd) return;
    nd.fx = null;
    nd.fy = null;
    this.pinned.delete(i);
    if (this.pinned.size === 0) this.sim.alphaTarget(0);
  }

  tick(): void {
    this.sim.tick();
  }

  get alpha(): number {
    return this.sim.alpha();
  }

  /** True while the simulation still moves nodes. */
  active(): boolean {
    return this.sim.alpha() >= this.sim.alphaMin() || this.sim.alphaTarget() > 0;
  }

  positions(): Float32Array {
    const out = new Float32Array(this.n * 2);
    for (let i = 0; i < this.n; i++) {
      out[i * 2] = this.nodes[i].x;
      out[i * 2 + 1] = this.nodes[i].y;
    }
    return out;
  }
}

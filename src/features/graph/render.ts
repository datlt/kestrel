// Draws the graph on one canvas. It reads everything from a `Frame` and keeps
// only caches (which nodes share a color, the bent links as Path2D).
//
// The canvas has two phases. Shapes use the graph transform (the picture
// scales with the zoom). Text uses screen pixels, so it stays sharp.
//
// Colors come from the theme variables, read by `readPalette`.

import type { Camera } from './camera';
import { visibleRect } from './camera';
import type { Highlight } from './highlight';
import { labelAlpha, labelFontPx, MAX_LABELS } from './labels';
import { bundlePath } from './model';
import { appendBasis } from './spline';
import type { FolderHull, GraphLayout, GraphOptions, VEdge, VisibleGraph, VNode } from './types';

export interface Palette {
  bg: string;
  fg: string;
  fgMuted: string;
  fgFaint: string;
  accent: string;
  border: string;
  warn: string;
  info: string;
  dark: boolean;
}

export function readPalette(el: HTMLElement, dark: boolean): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--bg', dark ? '#1f2023' : '#ffffff'),
    fg: v('--fg', dark ? '#d6d7da' : '#1f2328'),
    fgMuted: v('--fg-muted', '#8b8e96'),
    fgFaint: v('--fg-faint', '#5d6068'),
    accent: v('--accent', '#4c9dff'),
    border: v('--border', '#303136'),
    warn: v('--warn', '#e3b341'),
    info: v('--info', '#4c9dff'),
    dark,
  };
}

/** What `draw` needs for one picture. */
export interface Frame {
  vg: VisibleGraph;
  pos: Float64Array;
  /** Changes whenever `pos` changes. The renderer keeps bent links until it changes. */
  posVersion: number;
  /** Draw radius of each node in graph units. */
  radii: Float32Array;
  options: GraphOptions;
  layout: GraphLayout;
  cam: Camera;
  hulls: FolderHull[] | null;
  /** Bright nodes and edges. Null: nothing is highlighted. */
  hl: Highlight | null;
  /** 0 to 1: how far the rest has faded. */
  dim: number;
  /** Id of the folder whose outline gets more color. */
  hullFocus: string | null;
  /** 1 for nodes that get the ring of the active note. Null: none. */
  active: Uint8Array | null;
  /** 0: straight links. Above 0: bent links (tree layouts). */
  bundleBeta: number;
}

export interface DrawStats {
  nodes: number;
  edges: number;
  labels: number;
}

const TAU = Math.PI * 2;
/** Link widths by `floor(log2(count))`. */
const LINK_WIDTH = [1, 1.35, 1.7, 2.1, 2.5];
const DIM_ALPHA = 0.8;

interface EdgeLists {
  link: Int32Array;
  tree: Int32Array;
  tag: Int32Array;
  /** Link edges by width class. */
  linkBuckets: Int32Array[];
}

function splitEdges(edges: readonly VEdge[]): EdgeLists {
  const link: number[] = [];
  const tree: number[] = [];
  const tag: number[] = [];
  const buckets: number[][] = LINK_WIDTH.map(() => []);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (e.kind === 'tree') tree.push(i);
    else if (e.kind === 'tag') tag.push(i);
    else {
      link.push(i);
      buckets[Math.min(LINK_WIDTH.length - 1, Math.floor(Math.log2(Math.max(1, e.count))))].push(i);
    }
  }
  return { link: Int32Array.from(link), tree: Int32Array.from(tree), tag: Int32Array.from(tag), linkBuckets: buckets.map((b) => Int32Array.from(b)) };
}

const KIND_RANK: Record<VNode['kind'], number> = { folder: 0, tag: 1, attachment: 2, missing: 3, note: 4 };

export class GraphRenderer {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  palette: Palette;

  // Caches.
  private cacheGraph: VisibleGraph | null = null;
  private cachePalette: Palette | null = null;
  private edgeLists: EdgeLists = { link: new Int32Array(0), tree: new Int32Array(0), tag: new Int32Array(0), linkBuckets: [] };
  private order = new Int32Array(0);
  /** Tree edges by the color of the child, so the folder tree shows the folder colors. */
  private treeGroups: { color: string; edges: Int32Array }[] = [];
  private colors: string[] = [];
  private bundleKey = '';
  private bundleGraph: VisibleGraph | null = null;
  private bundleCtrl: (number[] | undefined)[] = [];
  private bundlePaths: Path2D[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private fontFamily: string,
    palette: Palette,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas is not available.');
    this.ctx = c;
    this.palette = palette;
  }

  setPalette(p: Palette): void {
    this.palette = p;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  private nodeColor(n: VNode): string {
    if (n.color) return n.color;
    const p = this.palette;
    switch (n.kind) {
      case 'attachment':
        return p.info;
      case 'missing':
        return p.fgFaint;
      case 'tag':
        return p.warn;
      default:
        return p.fgMuted;
    }
  }

  private prepare(vg: VisibleGraph): void {
    if (this.cacheGraph === vg && this.cachePalette === this.palette) return;
    if (this.cacheGraph !== vg) this.edgeLists = splitEdges(vg.edges);
    this.cacheGraph = vg;
    this.cachePalette = this.palette;
    const n = vg.nodes.length;
    this.colors = vg.nodes.map((nd) => this.nodeColor(nd));
    const idx = Array.from({ length: n }, (_, i) => i);
    const colors = this.colors;
    idx.sort((a, b) => KIND_RANK[vg.nodes[a].kind] - KIND_RANK[vg.nodes[b].kind] || (colors[a] < colors[b] ? -1 : colors[a] > colors[b] ? 1 : 0) || a - b);
    this.order = Int32Array.from(idx);
    const byColor = new Map<string, number[]>();
    for (const e of this.edgeLists.tree) {
      const c = colors[vg.edges[e].source];
      const list = byColor.get(c);
      if (list) list.push(e);
      else byColor.set(c, [e]);
    }
    this.treeGroups = [...byColor].map(([color, list]) => ({ color, edges: Int32Array.from(list) }));
  }

  private ensureBundles(f: Frame): boolean {
    const beta = f.bundleBeta;
    if (beta <= 0 || this.edgeLists.link.length === 0) return false;
    const key = `${f.posVersion}|${beta}`;
    if (this.bundleGraph === f.vg && this.bundleKey === key) return true;
    this.bundleGraph = f.vg;
    this.bundleKey = key;
    this.bundleCtrl = new Array(f.vg.edges.length);
    this.bundlePaths = this.edgeLists.linkBuckets.map(() => new Path2D());
    this.edgeLists.linkBuckets.forEach((bucket, b) => {
      for (const e of bucket) {
        const ctrl = bundlePath(f.vg, e, f.pos, beta);
        this.bundleCtrl[e] = ctrl;
        appendBasis(this.bundlePaths[b], ctrl);
      }
    });
    return true;
  }

  draw(f: Frame): DrawStats {
    const ctx = this.ctx;
    const stats: DrawStats = { nodes: 0, edges: 0, labels: 0 };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (f.vg.nodes.length === 0) return stats;
    this.prepare(f.vg);

    const cam = f.cam;
    const dpr = this.dpr;
    const z = f.cam.zoom;
    const w = this.width;
    const h = this.height;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (w / 2 - cam.x * z), dpr * (h / 2 - cam.y * z));
    const view = visibleRect(cam, w, h, 40 / z);
    const dimmed = !!f.hl && f.dim > 0.001;
    const dimAlpha = dimmed ? 1 - DIM_ALPHA * f.dim : 1;
    const pxScale = Math.min(1.8, Math.max(0.6, Math.sqrt(z)));
    const p = this.palette;

    if (f.hulls && f.options.folderOutlines) this.drawHulls(f, view, dimmed ? 1 - 0.5 * f.dim : 1);

    // --- Edges
    const bent = this.ensureBundles(f);
    const treeLayout = f.layout !== 'force';
    const many = f.vg.edges.length > 5000;
    const thick = f.options.linkThickness;
    // In the tree layouts many bent links make a grey wall: fewer links get more alpha.
    const edgeAlpha = treeLayout ? Math.min(0.32, Math.max(0.06, 0.32 * Math.sqrt(400 / Math.max(1, this.edgeLists.link.length)))) : many ? 0.35 : 0.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (treeLayout) {
      // The folder tree is the frame of these layouts: clear curved links, under the link edges.
      ctx.globalAlpha = 0.75 * dimAlpha;
      ctx.lineWidth = (1.5 * thick * pxScale) / z;
      for (const gr of this.treeGroups) {
        ctx.strokeStyle = gr.color;
        this.strokeTreeLinks(f, gr.edges);
      }
    } else {
      ctx.globalAlpha = 0.5 * dimAlpha;
      ctx.strokeStyle = p.fgFaint;
      ctx.lineWidth = (0.9 * thick * pxScale) / z;
      this.strokeStraight(f, this.edgeLists.tree, view, stats);
    }

    ctx.globalAlpha = 0.6 * dimAlpha;
    ctx.strokeStyle = p.warn;
    ctx.lineWidth = (1.1 * thick * pxScale) / z;
    ctx.setLineDash([2.5 / z, 3.5 / z]);
    this.strokeStraight(f, this.edgeLists.tag, view, stats);
    ctx.setLineDash([]);

    ctx.globalAlpha = edgeAlpha * dimAlpha;
    ctx.strokeStyle = p.fgMuted;
    this.edgeLists.linkBuckets.forEach((bucket, b) => {
      if (bucket.length === 0) return;
      ctx.lineWidth = (1.1 * thick * LINK_WIDTH[b] * pxScale) / z;
      if (bent) ctx.stroke(this.bundlePaths[b]);
      else this.strokeStraight(f, bucket, view, stats);
      stats.edges += bucket.length;
    });

    if (f.options.arrows && z > 0.2 && this.edgeLists.link.length < 8000) {
      ctx.globalAlpha = Math.min(0.9, edgeAlpha + 0.3) * dimAlpha;
      ctx.fillStyle = p.fgMuted;
      this.drawArrows(f, this.edgeLists.link, bent, view, pxScale);
    }

    // The bright edges again on top, in the accent color.
    if (f.hl && dimmed) {
      ctx.globalAlpha = 0.5 + 0.4 * f.dim;
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = (1.6 * thick * pxScale) / z;
      ctx.beginPath();
      const hot: number[] = [];
      for (let e = 0; e < f.vg.edges.length; e++) {
        if (!f.hl.edges[e]) continue;
        const edge = f.vg.edges[e];
        if (edge.kind === 'link') hot.push(e);
        const ctrl = bent && edge.kind === 'link' ? this.bundleCtrl[e] : undefined;
        if (ctrl) appendBasis(ctx, ctrl);
        else if (treeLayout && edge.kind === 'tree') this.appendTreeLink(ctx, f, edge);
        else {
          ctx.moveTo(f.pos[edge.source * 2], f.pos[edge.source * 2 + 1]);
          ctx.lineTo(f.pos[edge.target * 2], f.pos[edge.target * 2 + 1]);
        }
      }
      ctx.stroke();
      if (f.options.arrows && hot.length < 2000) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = p.accent;
        this.drawArrows(f, Int32Array.from(hot), bent, view, pxScale);
      }
    }

    // --- Nodes
    ctx.globalAlpha = 1;
    this.drawNodes(f, view, dimmed, dimAlpha, stats);
    this.drawRings(f, pxScale);

    // --- Text (screen pixels)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    this.drawText(f, dimmed, dimAlpha, stats);
    ctx.globalAlpha = 1;
    return stats;
  }

  /** One folder tree link as a curve: `linkRadial` of d3 in the radial layout, `linkHorizontal` in the tree layout. */
  private appendTreeLink(path: Path2D | CanvasRenderingContext2D, f: Frame, e: VEdge): void {
    const cx = f.pos[e.source * 2];
    const cy = f.pos[e.source * 2 + 1];
    const px = f.pos[e.target * 2];
    const py = f.pos[e.target * 2 + 1];
    path.moveTo(px, py);
    if (f.layout === 'radial') {
      const r0 = Math.hypot(px, py);
      const r1 = Math.hypot(cx, cy);
      const a1 = Math.atan2(cy, cx);
      let a0 = r0 < 1e-6 ? a1 : Math.atan2(py, px);
      if (a0 - a1 > Math.PI) a0 -= TAU;
      else if (a0 - a1 < -Math.PI) a0 += TAU;
      const rm = (r0 + r1) / 2;
      path.bezierCurveTo(Math.cos(a0) * rm, Math.sin(a0) * rm, Math.cos(a1) * rm, Math.sin(a1) * rm, cx, cy);
    } else {
      const mx = (px + cx) / 2;
      path.bezierCurveTo(mx, py, mx, cy, cx, cy);
    }
  }

  private strokeTreeLinks(f: Frame, idxs: Int32Array): void {
    if (idxs.length === 0) return;
    const ctx = this.ctx;
    ctx.beginPath();
    for (let k = 0; k < idxs.length; k++) this.appendTreeLink(ctx, f, f.vg.edges[idxs[k]]);
    ctx.stroke();
  }

  private strokeStraight(f: Frame, idxs: Int32Array, view: { minX: number; maxX: number; minY: number; maxY: number }, _stats: DrawStats): void {
    if (idxs.length === 0) return;
    const ctx = this.ctx;
    const pos = f.pos;
    const edges = f.vg.edges;
    ctx.beginPath();
    for (let k = 0; k < idxs.length; k++) {
      const e = edges[idxs[k]];
      const x1 = pos[e.source * 2];
      const y1 = pos[e.source * 2 + 1];
      const x2 = pos[e.target * 2];
      const y2 = pos[e.target * 2 + 1];
      if ((x1 < view.minX && x2 < view.minX) || (x1 > view.maxX && x2 > view.maxX) || (y1 < view.minY && y2 < view.minY) || (y1 > view.maxY && y2 > view.maxY)) continue;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }

  private drawArrows(f: Frame, idxs: Int32Array, bent: boolean, view: { minX: number; maxX: number; minY: number; maxY: number }, pxScale: number): void {
    const ctx = this.ctx;
    const z = f.cam.zoom;
    const size = (5.5 * Math.min(1.6, f.options.linkThickness + 0.3) * pxScale) / z;
    ctx.beginPath();
    const tip = (tx: number, ty: number, fx: number, fy: number, r: number) => {
      const dx = tx - fx;
      const dy = ty - fy;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6 || len < r * 2 + size) return;
      const ux = dx / len;
      const uy = dy / len;
      const bx = tx - ux * (r + 1.5 / z);
      const by = ty - uy * (r + 1.5 / z);
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - ux * size + uy * size * 0.45, by - uy * size - ux * size * 0.45);
      ctx.lineTo(bx - ux * size - uy * size * 0.45, by - uy * size + ux * size * 0.45);
      ctx.closePath();
    };
    for (let k = 0; k < idxs.length; k++) {
      const ei = idxs[k];
      const e = f.vg.edges[ei];
      const x1 = f.pos[e.source * 2];
      const y1 = f.pos[e.source * 2 + 1];
      const x2 = f.pos[e.target * 2];
      const y2 = f.pos[e.target * 2 + 1];
      if (x1 < view.minX && x2 < view.minX) continue;
      if (x1 > view.maxX && x2 > view.maxX) continue;
      if (y1 < view.minY && y2 < view.minY) continue;
      if (y1 > view.maxY && y2 > view.maxY) continue;
      const ctrl = bent ? this.bundleCtrl[ei] : undefined;
      let fx2 = x1;
      let fy2 = y1;
      let fx1 = x2;
      let fy1 = y2;
      if (ctrl && ctrl.length >= 4) {
        const n = ctrl.length;
        fx2 = ctrl[n - 4];
        fy2 = ctrl[n - 3];
        fx1 = ctrl[2];
        fy1 = ctrl[3];
      }
      tip(x2, y2, fx2, fy2, f.radii[e.target]);
      if (e.both) tip(x1, y1, fx1, fy1, f.radii[e.source]);
    }
    ctx.fill();
  }

  private drawHulls(f: Frame, view: { minX: number; maxX: number; minY: number; maxY: number }, alphaMul: number): void {
    const ctx = this.ctx;
    const z = f.cam.zoom;
    const p = this.palette;
    const base = p.dark ? 0.07 : 0.1;
    ctx.lineJoin = 'round';
    for (const hull of f.hulls ?? []) {
      const pts = hull.points;
      if (pts.length < 6) continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        if (pts[i] < minX) minX = pts[i];
        if (pts[i] > maxX) maxX = pts[i];
        if (pts[i + 1] < minY) minY = pts[i + 1];
        if (pts[i + 1] > maxY) maxY = pts[i + 1];
      }
      if (maxX < view.minX || minX > view.maxX || maxY < view.minY || minY > view.maxY) continue;
      const color = hull.color ?? p.fgMuted;
      const focus = f.hullFocus === hull.id;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = (focus ? base * 2.6 : base) * alphaMul;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.globalAlpha = (focus ? 0.8 : 0.32) * alphaMul;
      ctx.lineWidth = (focus ? 1.8 : 1) / z;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawNodes(f: Frame, view: { minX: number; maxX: number; minY: number; maxY: number }, dimmed: boolean, dimAlpha: number, stats: DrawStats): void {
    const ctx = this.ctx;
    const g = f.vg;
    const z = f.cam.zoom;
    const pos = f.pos;
    const radii = f.radii;
    const order = this.order;
    const colors = this.colors;
    const p = this.palette;
    const hl = f.hl;
    const minR = 1.4 / z;
    const passes = dimmed ? [0, 1] : [-1];
    for (const pass of passes) {
      ctx.globalAlpha = pass === 0 ? dimAlpha : 1;
      let k = 0;
      while (k < order.length) {
        const first = order[k];
        const kind = g.nodes[first].kind;
        const color = colors[first];
        let end = k + 1;
        while (end < order.length && g.nodes[order[end]].kind === kind && colors[order[end]] === color) end++;
        if (kind === 'folder') {
          for (let q = k; q < end; q++) {
            const i = order[q];
            if (pass >= 0 && (hl!.nodes[i] ? 1 : 0) !== pass) continue;
            this.drawFolderNode(f, i, color);
            stats.nodes++;
          }
          k = end;
          continue;
        }
        ctx.beginPath();
        let count = 0;
        for (let q = k; q < end; q++) {
          const i = order[q];
          if (pass >= 0 && (hl!.nodes[i] ? 1 : 0) !== pass) continue;
          const x = pos[i * 2];
          const y = pos[i * 2 + 1];
          const r = Math.max(radii[i], minR);
          if (x + r < view.minX || x - r > view.maxX || y + r < view.minY || y - r > view.maxY) continue;
          count++;
          if (r <= minR * 1.01 && kind !== 'missing') {
            ctx.rect(x - r, y - r, r * 2, r * 2);
          } else if (kind === 'attachment') {
            ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
          } else if (kind === 'tag') {
            const d = r * 1.2;
            ctx.moveTo(x, y - d);
            ctx.lineTo(x + d, y);
            ctx.lineTo(x, y + d);
            ctx.lineTo(x - d, y);
            ctx.closePath();
          } else {
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, TAU);
          }
        }
        stats.nodes += count;
        if (count > 0) {
          if (kind === 'missing') {
            ctx.fillStyle = p.bg;
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5 / z;
            ctx.stroke();
          } else {
            ctx.fillStyle = color;
            ctx.fill();
          }
        }
        k = end;
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawFolderNode(f: Frame, i: number, color: string): void {
    const ctx = this.ctx;
    const z = f.cam.zoom;
    const n = f.vg.nodes[i];
    const x = f.pos[i * 2];
    const y = f.pos[i * 2 + 1];
    const r = Math.max(f.radii[i], 2 / z);
    const s = r * 2;
    const corner = Math.min(r * 0.4, 6 / z + r * 0.15);
    ctx.beginPath();
    ctx.roundRect(x - r, y - r, s, s, corner);
    ctx.fillStyle = this.palette.bg;
    ctx.fill();
    const prev = ctx.globalAlpha;
    ctx.fillStyle = color;
    ctx.globalAlpha = prev * (n.collapsed ? 0.45 : 0.28);
    ctx.fill();
    ctx.globalAlpha = prev;
    ctx.strokeStyle = color;
    ctx.lineWidth = (n.collapsed ? 2.2 : 1.4) / z;
    ctx.stroke();
  }

  private drawRings(f: Frame, pxScale: number): void {
    const act = f.active;
    if (!act) return;
    const ctx = this.ctx;
    const z = f.cam.zoom;
    ctx.strokeStyle = this.palette.accent;
    ctx.lineWidth = (2 * pxScale) / z;
    ctx.beginPath();
    for (let i = 0; i < act.length; i++) {
      if (!act[i]) continue;
      const x = f.pos[i * 2];
      const y = f.pos[i * 2 + 1];
      const r = f.radii[i] + 3.5 / z;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.stroke();
  }

  private drawText(f: Frame, dimmed: boolean, dimAlpha: number, stats: DrawStats): void {
    const ctx = this.ctx;
    const g = f.vg;
    const z = f.cam.zoom;
    const w = this.width;
    const h = this.height;
    const p = this.palette;
    const cx = f.cam.x;
    const cy = f.cam.y;
    const hl = f.hl;
    const layout = f.layout;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';

    // Folder names at the top of the outlines. An inner folder that has the same top edge as
    // its parent moves down by one line, so the names do not sit on top of each other.
    if (f.hulls && f.options.folderOutlines) {
      ctx.font = `600 11px ${this.fontFamily}`;
      ctx.textBaseline = 'bottom';
      const placed: { x0: number; x1: number; y: number }[] = [];
      for (const hull of f.hulls) {
        const pts = hull.points;
        if (pts.length < 6) continue;
        let top = Infinity;
        let topX = 0;
        let minX = Infinity;
        let maxX = -Infinity;
        for (let i = 0; i < pts.length; i += 2) {
          if (pts[i + 1] < top) {
            top = pts[i + 1];
            topX = pts[i];
          }
          if (pts[i] < minX) minX = pts[i];
          if (pts[i] > maxX) maxX = pts[i];
        }
        if ((maxX - minX) * z < 36) continue;
        const sx = (topX - cx) * z + w / 2;
        let sy = (top - cy) * z + h / 2 - 3;
        if (sx < -80 || sx > w + 80 || sy < -20 || sy > h + 40) continue;
        const half = ctx.measureText(hull.label).width / 2;
        for (let attempt = 0; attempt < 6; attempt++) {
          const clash = placed.some((q) => sx - half < q.x1 && sx + half > q.x0 && Math.abs(sy - q.y) < 13);
          if (!clash) break;
          sy += 13;
        }
        placed.push({ x0: sx - half, x1: sx + half, y: sy });
        ctx.globalAlpha = (f.hullFocus === hull.id ? 1 : 0.75) * (dimmed ? 1 - 0.4 * f.dim : 1);
        ctx.fillStyle = hull.color ?? p.fgMuted;
        ctx.fillText(hull.label, sx, sy);
        stats.labels++;
      }
    }

    // Node labels. The font gets smaller when you zoom out, and small labels are hidden.
    const textFade = f.options.textFade;
    const basePx = labelFontPx(z);
    const cand: { i: number; a: number; prio: number; forced: boolean }[] = [];
    for (let i = 0; i < g.nodes.length; i++) {
      const n = g.nodes[i];
      const sx = (f.pos[i * 2] - cx) * z + w / 2;
      const sy = (f.pos[i * 2 + 1] - cy) * z + h / 2;
      if (sx < -80 || sx > w + 80 || sy < -80 || sy > h + 80) continue;
      const bright = !!hl && hl.nodes[i] === 1;
      const forced = bright || f.active?.[i] === 1;
      let a = labelAlpha(z, textFade, n.degree + (n.kind === 'folder' ? 6 + Math.sqrt(n.weight) : 0));
      if (forced) a = 1;
      else if (dimmed) a *= dimAlpha;
      if (a < 0.04) continue;
      cand.push({ i, a, prio: forced ? 1e9 + n.degree : n.degree + (n.kind === 'folder' ? 20 : 0), forced });
    }
    let shown = cand;
    if (cand.length > MAX_LABELS) {
      cand.sort((a, b) => b.prio - a.prio);
      shown = cand.slice(0, MAX_LABELS);
    }
    const halo = shown.length <= 160;
    ctx.lineWidth = 3;
    for (const c of shown) {
      const n = g.nodes[c.i];
      const x = f.pos[c.i * 2];
      const y = f.pos[c.i * 2 + 1];
      const sx = (x - cx) * z + w / 2;
      const sy = (y - cy) * z + h / 2;
      const off = f.radii[c.i] * z + 4;
      const px = c.forced ? Math.max(basePx, 9) : basePx;
      const folder = n.kind === 'folder' && !n.collapsed;
      ctx.font = `${folder ? '600 ' : ''}${px.toFixed(1)}px ${this.fontFamily}`;
      const text = n.label.length > 30 ? n.label.slice(0, 29) + '…' : n.label;
      let tx = sx;
      let ty = sy;
      let angle = 0;
      if (layout === 'radial' && !folder) {
        // Leaf labels stand outside the circle and run along the radius. On the left half the text is turned over to read left to right.
        const ang = Math.atan2(y, x);
        const flip = Math.cos(ang) < 0;
        angle = flip ? ang + Math.PI : ang;
        tx = sx + Math.cos(ang) * off;
        ty = sy + Math.sin(ang) * off;
        ctx.textAlign = flip ? 'right' : 'left';
        ctx.textBaseline = 'middle';
      } else if (layout === 'tree') {
        tx = folder ? sx - off : sx + off;
        ctx.textAlign = folder ? 'right' : 'left';
        ctx.textBaseline = 'middle';
      } else {
        ty = sy + off - 1;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
      }
      if (angle !== 0) {
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(angle);
        tx = 0;
        ty = 0;
      }
      if (halo) {
        ctx.globalAlpha = c.a * 0.85;
        ctx.strokeStyle = p.bg;
        ctx.strokeText(text, tx, ty);
      }
      ctx.globalAlpha = c.a;
      ctx.fillStyle = n.kind === 'missing' ? p.fgMuted : p.fg;
      ctx.fillText(text, tx, ty);
      if (angle !== 0) ctx.restore();
      stats.labels++;
    }
    ctx.textAlign = 'center';

    // Count inside collapsed folders.
    ctx.textBaseline = 'middle';
    ctx.font = `600 10px ${this.fontFamily}`;
    for (let i = 0; i < g.nodes.length; i++) {
      const n = g.nodes[i];
      if (!n.collapsed || f.radii[i] * z < 8) continue;
      const sx = (f.pos[i * 2] - cx) * z + w / 2;
      const sy = (f.pos[i * 2 + 1] - cy) * z + h / 2;
      if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;
      ctx.globalAlpha = hl && !hl.nodes[i] ? dimAlpha : 1;
      ctx.fillStyle = p.fg;
      ctx.fillText(String(n.weight), sx, sy + 0.5);
    }
  }
}

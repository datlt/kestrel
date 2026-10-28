// Draws a placed diagram as SVG. All colors are theme variables, written in
// `style` attributes, so the same elements work in both themes. "Save as SVG"
// replaces the variables with the real colors (see `resolveCssVars`).

import type { DiagramEdge, DiagramNode, RelationKind } from '../../ipc/code';
import type { Placement } from './layout';
import { edgeLabelText } from './layout-input';
import type { NodeBox } from './node-box';
import { FONT_SIZE, PAD_X } from './node-box';

const NS = 'http://www.w3.org/2000/svg';

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number>, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(c);
  return el;
}

const STROKE = 'var(--fg-muted)';

export interface EdgeStyle {
  dashed: boolean;
  markerStart?: string;
  markerEnd?: string;
}

/** How each relation kind looks. The marker names are built with `markerId`. */
export const EDGE_STYLES: Record<RelationKind, EdgeStyle> = {
  extends: { dashed: false, markerEnd: 'triangle' },
  implements: { dashed: true, markerEnd: 'triangle' },
  composition: { dashed: false, markerStart: 'diamond-filled' },
  aggregation: { dashed: false, markerStart: 'diamond' },
  dependency: { dashed: true, markerEnd: 'arrow' },
  nested: { dashed: false, markerStart: 'nested' },
};

export function markerId(prefix: string, name: string): string {
  return `${prefix}-m-${name}`;
}

/** The marker definitions. One copy per diagram view lives in its SVG; legend and toolbar icons use it too. */
export function createDefs(prefix: string): SVGDefsElement {
  const marker = (name: string, w: number, h: number, refX: number, children: SVGElement[]) =>
    svgEl('marker', { id: markerId(prefix, name), markerWidth: w, markerHeight: h, refX, refY: h / 2, orient: 'auto', markerUnits: 'userSpaceOnUse', viewBox: `0 0 ${w} ${h}` }, ...children);
  const fillBg = `fill:var(--bg);stroke:${STROKE};stroke-width:1.2`;
  return svgEl(
    'defs',
    undefined,
    marker('triangle', 14, 12, 13, [svgEl('path', { d: 'M1,1 L13,6 L1,11 Z', style: fillBg })]),
    marker('arrow', 12, 12, 11, [svgEl('path', { d: 'M1,1 L11,6 L1,11', style: `fill:none;stroke:${STROKE};stroke-width:1.3` })]),
    marker('diamond', 18, 12, 1, [svgEl('path', { d: 'M1,6 L9,1 L17,6 L9,11 Z', style: fillBg })]),
    marker('diamond-filled', 18, 12, 1, [svgEl('path', { d: 'M1,6 L9,1 L17,6 L9,11 Z', style: `fill:${STROKE};stroke:${STROKE};stroke-width:1.2` })]),
    marker('nested', 16, 16, 1, [
      svgEl('circle', { cx: 8, cy: 8, r: 7, style: fillBg }),
      svgEl('path', { d: 'M8,4.5 V11.5 M4.5,8 H11.5', style: `fill:none;stroke:${STROKE};stroke-width:1.2` }),
    ]),
  );
}

/** A small sample of the line of one relation kind, for the toolbar and the legend. */
export function createEdgeSample(prefix: string, kind: RelationKind, width = 34, height = 14): SVGSVGElement {
  const st = EDGE_STYLES[kind];
  const y = height / 2;
  const path = svgEl('path', {
    d: `M2,${y} L${width - 2},${y}`,
    style: `fill:none;stroke:${STROKE};stroke-width:1.3${st.dashed ? ';stroke-dasharray:4 3' : ''}`,
  });
  if (st.markerStart) path.setAttribute('marker-start', `url(#${markerId(prefix, st.markerStart)})`);
  if (st.markerEnd) path.setAttribute('marker-end', `url(#${markerId(prefix, st.markerEnd)})`);
  return svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'diagram-sample' }, path);
}

/** A smooth line through the points: straight at both ends, so the markers point the right way. */
export function edgePath(points: readonly { x: number; y: number }[]): string {
  const n = points.length;
  if (n === 0) return '';
  const f = (v: number) => Math.round(v * 10) / 10;
  let d = `M${f(points[0].x)},${f(points[0].y)}`;
  if (n === 1) return d;
  for (let i = 1; i < n - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    d += ` Q${f(p.x)},${f(p.y)} ${f((p.x + q.x) / 2)},${f((p.y + q.y) / 2)}`;
  }
  d += ` L${f(points[n - 1].x)},${f(points[n - 1].y)}`;
  return d;
}

const BADGE_COLOR: Record<string, string> = { kotlin: 'var(--accent)', java: 'var(--warn)', swift: 'var(--danger)' };

export interface RenderInput {
  nodes: readonly DiagramNode[];
  edges: readonly DiagramEdge[];
  boxes: ReadonlyMap<string, NodeBox>;
  placement: Placement;
  focus: ReadonlySet<string>;
  prefix: string;
  fontFamily: string;
}

export interface Rendered {
  /** The group with edges and nodes. Pan and zoom change its `transform` only. */
  content: SVGGElement;
  nodeEls: Map<string, SVGGElement>;
  /** One entry per drawn edge, with the ids of its ends. */
  edgeEls: { el: SVGGElement; from: string; to: string }[];
}

function text(attrs: Record<string, string | number>, style: string, value: string): SVGTextElement {
  const t = svgEl('text', attrs);
  t.setAttribute('style', style);
  t.textContent = value;
  return t;
}

function drawNode(node: DiagramNode, box: NodeBox, cx: number, cy: number, focus: boolean, fontFamily: string): SVGGElement {
  const x = Math.round(cx - box.width / 2);
  const y = Math.round(cy - box.height / 2);
  const ext = node.external;
  const g = svgEl('g', { class: 'diagram-node', 'data-id': node.id, transform: `translate(${x},${y})` });
  if (ext) g.classList.add('is-external');
  if (focus) g.classList.add('is-focus');

  const stroke = focus ? 'var(--accent)' : ext ? 'var(--fg-faint)' : 'var(--border)';
  const rect = svgEl('rect', { class: 'diagram-box', width: box.width, height: box.height, rx: 4 });
  rect.setAttribute('style', `fill:${ext ? 'var(--bg-alt)' : 'var(--bg-elevated)'};stroke:${stroke};stroke-width:${focus ? 2 : 1}${ext ? ';stroke-dasharray:5 3' : ''}`);
  g.append(rect);

  const fg = ext ? 'var(--fg-muted)' : 'var(--fg)';
  const base = `font-family:${fontFamily}`;
  for (const row of box.rows) {
    const mid = row.y + row.height / 2;
    if (row.kind === 'stereotype') {
      g.append(text({ x: box.width / 2, y: mid + FONT_SIZE.stereotype * 0.35, 'text-anchor': 'middle' }, `${base};font-size:${FONT_SIZE.stereotype}px;fill:var(--fg-muted)`, row.text));
    } else if (row.kind === 'title') {
      const t = text({ x: PAD_X, y: mid + FONT_SIZE.title * 0.35 }, `${base};font-size:${FONT_SIZE.title}px;font-weight:700;fill:${fg}`, row.text);
      if (row.suffix) {
        const s = svgEl('tspan');
        s.setAttribute('style', 'font-weight:400');
        s.textContent = row.suffix;
        t.append(s);
      }
      g.append(t);
    } else if (row.kind === 'more') {
      g.append(text({ x: PAD_X, y: mid + FONT_SIZE.member * 0.2 }, `${base};font-size:${FONT_SIZE.member}px;fill:var(--fg-muted)`, '…'));
    } else {
      const m = row.member;
      const mg = svgEl('g', { class: 'diagram-member', 'data-member': `${row.kind === 'field' ? 'f' : 'm'}${row.memberIndex}` });
      const hit = svgEl('rect', { class: 'diagram-member-hit', x: 1, y: row.y, width: box.width - 2, height: row.height });
      hit.setAttribute('style', 'fill:transparent');
      let style = `${base};font-size:${FONT_SIZE.member}px;fill:${fg}`;
      if (m?.abstract) style += ';font-style:italic';
      if (m?.static) style += ';text-decoration:underline';
      mg.append(hit, text({ x: PAD_X, y: mid + FONT_SIZE.member * 0.35 }, style, row.text));
      g.append(mg);
    }
  }
  for (const sy of box.separators) {
    const line = svgEl('line', { x1: 0, x2: box.width, y1: sy, y2: sy });
    line.setAttribute('style', `stroke:${stroke === 'var(--accent)' ? 'var(--border)' : stroke};stroke-width:1;opacity:0.7`);
    g.append(line);
  }
  if (box.badge && node.lang) {
    const title = box.rows.find((r) => r.kind === 'title');
    const by = (title?.y ?? 5) + (title?.height ?? 22) / 2 - 7;
    const bx = box.width - box.badge.width - PAD_X;
    const color = BADGE_COLOR[node.lang] ?? 'var(--fg-muted)';
    const bg = svgEl('rect', { x: bx, y: by, width: box.badge.width, height: 14, rx: 3 });
    bg.setAttribute('style', `fill:none;stroke:${color};stroke-width:1`);
    g.append(
      bg,
      text({ x: bx + box.badge.width / 2, y: by + 10.2, 'text-anchor': 'middle' }, `${base};font-size:${FONT_SIZE.badge}px;font-weight:700;fill:${color}`, box.badge.text),
    );
  }
  if (node.hiddenIn) g.append(hiddenBadge(node.hiddenIn, box.width / 2, box.height, 'in', fontFamily));
  if (node.hiddenOut) g.append(hiddenBadge(node.hiddenOut, box.width / 2, 0, 'out', fontFamily));
  return g;
}

/** A small "+N" label on the bottom (`in`) or top (`out`) edge of a hub node. */
function hiddenBadge(count: number, cx: number, y: number, dir: 'in' | 'out', fontFamily: string): SVGGElement {
  const label = `+${count}`;
  const w = label.length * 6 + 12;
  const g = svgEl('g', { class: 'diagram-hidden-badge', 'data-hidden': dir });
  const tip = dir === 'in' ? `${count} more types hold, use or extend this type. Right-click to show them.` : `${count} more types are held, used or extended by this type. Right-click to show them.`;
  const title = svgEl('title');
  title.textContent = tip;
  const rect = svgEl('rect', { x: cx - w / 2, y: y - 8, width: w, height: 16, rx: 8 });
  rect.setAttribute('style', 'fill:var(--bg-elevated);stroke:var(--accent);stroke-width:1');
  const t = text({ x: cx, y: y + 3.8, 'text-anchor': 'middle' }, `font-family:${fontFamily};font-size:10px;font-weight:700;fill:var(--accent)`, label);
  g.append(title, rect, t);
  return g;
}

export function renderDiagram(input: RenderInput): Rendered {
  const { placement, prefix, fontFamily } = input;
  const content = svgEl('g', { class: 'diagram-content' });
  const edgeLayer = svgEl('g', { class: 'diagram-edges' });
  const nodeLayer = svgEl('g', { class: 'diagram-nodes' });
  content.append(edgeLayer, nodeLayer);

  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  const nodeEls = new Map<string, SVGGElement>();
  for (const p of placement.nodes) {
    const node = nodeById.get(p.id);
    const box = input.boxes.get(p.id);
    if (!node || !box) continue;
    const el = drawNode(node, box, p.x, p.y, input.focus.has(p.id), fontFamily);
    nodeEls.set(p.id, el);
    nodeLayer.append(el);
  }

  const edgeEls: Rendered['edgeEls'] = [];
  for (const pe of placement.edges) {
    const e = input.edges[pe.index];
    if (!e || pe.points.length < 2) continue;
    const st = EDGE_STYLES[e.kind];
    const g = svgEl('g', { class: `diagram-edge diagram-edge-${e.kind}`, 'data-from': e.from, 'data-to': e.to });
    const path = svgEl('path', { d: edgePath(pe.points) });
    path.setAttribute('style', `fill:none;stroke:${STROKE};stroke-width:1.3${st.dashed ? ';stroke-dasharray:6 4' : ''}`);
    if (st.markerStart) path.setAttribute('marker-start', `url(#${markerId(prefix, st.markerStart)})`);
    if (st.markerEnd) path.setAttribute('marker-end', `url(#${markerId(prefix, st.markerEnd)})`);
    g.append(path);
    const label = edgeLabelText(e);
    if (label && pe.label) {
      const t = text(
        { x: pe.label.x, y: pe.label.y + FONT_SIZE.edgeLabel * 0.35, 'text-anchor': 'middle' },
        `font-family:${fontFamily};font-size:${FONT_SIZE.edgeLabel}px;fill:var(--fg-muted);stroke:var(--bg);stroke-width:3px;paint-order:stroke`,
        label,
      );
      t.setAttribute('class', 'diagram-edge-label');
      g.append(t);
    }
    edgeLayer.append(g);
    edgeEls.push({ el: g, from: e.from, to: e.to });
  }
  return { content, nodeEls, edgeEls };
}

// --- Save as SVG -----------------------------------------------------------

/** Replaces `var(--name)` with the value from `lookup`. Unknown names stay as they are. */
export function resolveCssVars(svgText: string, lookup: (name: string) => string): string {
  return svgText.replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (all, name: string) => {
    const v = lookup(name).trim();
    return v || all;
  });
}

/** A standalone SVG file text for the placed diagram, without pan and zoom. */
export function buildSvgFile(rendered: Rendered, defs: SVGDefsElement, placement: Placement, lookup: (name: string) => string): string {
  const margin = 16;
  const w = Math.ceil(placement.width + margin * 2);
  const h = Math.ceil(placement.height + margin * 2);
  const svg = svgEl('svg', { xmlns: NS, width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  const bg = svgEl('rect', { width: w, height: h, style: 'fill:var(--bg)' });
  const g = rendered.content.cloneNode(true) as SVGGElement;
  g.setAttribute('transform', `translate(${margin},${margin})`);
  g.removeAttribute('class');
  svg.append(defs.cloneNode(true), bg, g);
  const text = new XMLSerializer().serializeToString(svg);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${resolveCssVars(text, lookup)}\n`;
}

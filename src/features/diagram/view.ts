// The diagram tab: toolbar, SVG canvas, pan and zoom, selection, menus.
// This file and dagre load with `import()` the first time a diagram opens.
//
// Pan and zoom only change the `transform` of one group. Hover and selection
// only change CSS classes. Only new data or new options run the layout again.

import { createElement, Download, Maximize, RefreshCw, Search, X, ZoomIn, ZoomOut } from 'lucide';
import { clear, h } from '../../core/dom';
import type { AppContext, MenuItem, TabContent } from '../../core/types';
import { rafThrottle } from '../../core/util';
import type { DiagramMember, DiagramNode, DiagramResult, DiagramScope, RelationKind } from '../../ipc/code';
import { ALL_RELATIONS, codeCancel, codeDiagram, codeIndexStatus, newCodeRequestId } from '../../ipc/code';
import { fsWriteFile } from '../../ipc/fs';
import './diagram.css';
import { toMermaid, toPlantUml } from './export-text';
import { buildLayoutInput } from './layout-input';
import type { Placement } from './layout';
import { createMeasure } from './measure';
import { mergeResults, neighborMap, pickNeighbor, scopeOfNodes, searchNodes, tabTitle, withoutHidden } from './model';
import type { ArrowKey } from './model';
import { computeNodeBox, edgeLabelSize } from './node-box';
import type { NodeBox } from './node-box';
import type { DiagramOptions, LayoutDirection, MembersMode, WalkDirection } from './options';
import {
  buildRequest,
  copyOptions,
  DIRECTION_LABELS,
  MAX_NODES,
  SHOW_MORE_CONFIRM_ABOVE,
  SHOW_MORE_FAN,
  SHOW_MORE_MAX_NODES,
  MEMBERS_LABELS,
  needsNewRequest,
  RELATION_HINTS,
  RELATION_LABELS,
  toggleRelation,
} from './options';
import { buildSvgFile, createDefs, createEdgeSample, renderDiagram, svgEl } from './render';
import type { Rendered } from './render';


/** What a tab remembers. `index.ts` saves it in the session. */
export interface DiagramTabState {
  scope: DiagramScope;
  options: DiagramOptions;
  /** Start types chosen by the user ("Add Supertypes" keeps the old start types). null: the answer of Rust. */
  focus: string[] | null;
  title: string;
}

/** Shared by the tabs of one workbench. */
export interface DiagramShared {
  /** True after Rust answered once, so the index exists. */
  indexReady: boolean;
  saveOptions(o: DiagramOptions): void;
  /** Newest text of unsaved files, for the scope of a request. */
  withEditorText(scope: DiagramScope): DiagramScope;
}

const MIN_ZOOM = 0.03;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.2;
const MESSAGE_READING = "Reading the project's Kotlin, Java and Swift files...";

interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function createDiagramContent(ctx: AppContext, host: HTMLElement, tabId: string, state: DiagramTabState, shared: DiagramShared): TabContent {
  const prefix = `dg${tabId.replace(/\W/g, '')}`;
  const cssVar = (name: string) => getComputedStyle(root).getPropertyValue(name);
  const fontFamily = (() => {
    const editorFont = ctx.settings.get('editor.fontFamily');
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
    return [editorFont, mono, 'monospace'].filter(Boolean).join(', ');
  })();
  const measure = createMeasure(fontFamily);

  let disposed = false;
  let data: DiagramResult | null = null;
  const hidden = new Set<string>();
  let visible: DiagramResult | null = null;
  let placement: Placement | null = null;
  let rendered: Rendered | null = null;
  let boxes = new Map<string, NodeBox>();
  let neighbors = new Map<string, Set<string>>();
  let nodePos = new Map<string, { x: number; y: number }>();
  let nodeById = new Map<string, DiagramNode>();
  let selectedId: string | null = null;
  let view: ViewTransform = { x: 0, y: 0, k: 1 };
  let fitPending = false;
  let seq = 0;
  let layoutSeq = 0;
  let running: { id: number; seq: number } | null = null;

  // --- DOM ---------------------------------------------------------------------

  const root = h('div', { class: 'diagram-root' });
  const toolbar = h('div', { class: 'diagram-toolbar' });
  const note = h('div', { class: 'diagram-note', hidden: true });
  const canvas = h('div', { class: 'diagram-canvas', tabindex: '0' });
  const overlay = h('div', { class: 'diagram-overlay', hidden: true });
  const defs = createDefs(prefix);
  const viewport = svgEl('g', { class: 'diagram-viewport' });
  const svg = svgEl('svg', { class: 'diagram-svg' }, defs, viewport);
  const legend = h('div', { class: 'diagram-legend' });
  canvas.append(svg, legend, overlay);
  root.append(toolbar, note, canvas);
  host.append(root);

  // --- Toolbar -----------------------------------------------------------------

  const relButtons = new Map<RelationKind, HTMLButtonElement>();
  for (const kind of ALL_RELATIONS) {
    const b = h(
      'button',
      { class: 'diagram-btn diagram-rel', type: 'button', title: RELATION_HINTS[kind], 'aria-pressed': 'false', onclick: () => setOptions(toggleRelation(state.options, kind)) },
      createEdgeSample(prefix, kind),
      RELATION_LABELS[kind],
    );
    relButtons.set(kind, b);
  }

  function makeSelect<T extends string>(title: string, entries: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
    const sel = h('select', { class: 'diagram-select', title });
    for (const [v, label] of entries) sel.append(h('option', { value: v }, label));
    sel.addEventListener('change', () => onChange(sel.value as T));
    return sel;
  }
  const field = (label: string, control: HTMLElement) => h('label', { class: 'diagram-field' }, h('span', { class: 'diagram-field-label' }, label), control);

  const depthSelect = makeSelect('How many steps to follow from the start types', ['0', '1', '2', '3', '4', '5'].map((d) => [d, d] as [string, string]), (v) =>
    setOptions({ ...state.options, depth: Number(v) }),
  );
  const directionSelect = makeSelect<WalkDirection>(
    'Which way to follow the relations',
    (['out', 'in', 'both'] as WalkDirection[]).map((d) => [d, DIRECTION_LABELS[d]] as [WalkDirection, string]),
    (v) => setOptions({ ...state.options, direction: v }),
  );
  const membersSelect = makeSelect<MembersMode>(
    'Fields and methods in each box',
    (['none', 'public', 'all'] as MembersMode[]).map((m) => [m, MEMBERS_LABELS[m]] as [MembersMode, string]),
    (v) => setOptions({ ...state.options, members: v }),
  );
  const layoutSelect = makeSelect<LayoutDirection>('Direction of the layout', [['TB', 'Top to bottom'], ['LR', 'Left to right']], (v) =>
    setOptions({ ...state.options, layout: v }),
  );
  const libraryBtn = h('button', {
    class: 'diagram-btn',
    type: 'button',
    title: 'Show types that are not in the project (JDK, libraries)',
    'aria-pressed': 'false',
    onclick: () => setOptions({ ...state.options, external: !state.options.external }),
  }, 'Library types');

  const iconBtn = (icon: Parameters<typeof createElement>[0], title: string, onclick: () => void) => {
    const b = h('button', { class: 'diagram-btn diagram-icon-btn', type: 'button', title, 'aria-label': title, onclick });
    b.append(createElement(icon));
    return b;
  };
  const fitBtn = iconBtn(Maximize, 'Fit to window (Mod-0)', () => fitView());
  const zoomOutBtn = iconBtn(ZoomOut, 'Zoom out (Mod--)', () => zoomBy(1 / ZOOM_STEP));
  const zoomInBtn = iconBtn(ZoomIn, 'Zoom in (Mod-=)', () => zoomBy(ZOOM_STEP));
  const refreshBtn = iconBtn(RefreshCw, 'Read the code again', () => void run());

  const searchInput = h('input', { class: 'diagram-search-input', type: 'text', placeholder: 'Find a type', spellcheck: 'false', 'aria-label': 'Find a type' });
  const searchCount = h('span', { class: 'diagram-search-count' });
  const searchClear = h('button', { class: 'diagram-search-clear', type: 'button', title: 'Clear', hidden: true, onclick: () => clearSearch(true) });
  searchClear.append(createElement(X));
  const searchIcon = h('span', { class: 'diagram-search-icon' });
  searchIcon.append(createElement(Search));
  const searchBox = h('div', { class: 'diagram-search' }, searchIcon, searchInput, searchCount, searchClear);

  const exportBtn = h('button', { class: 'diagram-btn diagram-tool', type: 'button', title: 'Copy the diagram as text, or save it as an image' });
  exportBtn.append(createElement(Download), 'Export');
  exportBtn.addEventListener('click', (e) => {
    ctx.ui.contextMenu(e, [
      { label: 'Copy as Mermaid', run: () => void copyText('Mermaid', (i) => toMermaid(i)) },
      { label: 'Copy as PlantUML', run: () => void copyText('PlantUML', (i) => toPlantUml(i)) },
      { label: 'Save as SVG...', run: () => void saveSvg(), separatorBefore: true },
    ]);
  });

  const sep = () => h('span', { class: 'diagram-sep' });
  toolbar.append(
    h('div', { class: 'diagram-group' }, ...relButtons.values()),
    sep(),
    field('Depth', depthSelect),
    field('Follow', directionSelect),
    field('Members', membersSelect),
    libraryBtn,
    field('Layout', layoutSelect),
    sep(),
    fitBtn,
    zoomOutBtn,
    zoomInBtn,
    refreshBtn,
    h('span', { class: 'diagram-spacer' }),
    searchBox,
    exportBtn,
  );

  // The legend uses the same marker definitions as the diagram.
  legend.append(h('div', { class: 'diagram-legend-title' }, 'Legend'));
  for (const kind of ALL_RELATIONS) legend.append(h('div', { class: 'diagram-legend-row' }, createEdgeSample(prefix, kind, 34, 14), RELATION_LABELS[kind]));

  function syncToolbar(): void {
    const o = state.options;
    for (const [kind, b] of relButtons) b.setAttribute('aria-pressed', String(o.relations.includes(kind)));
    depthSelect.value = String(o.depth);
    directionSelect.value = o.direction;
    membersSelect.value = o.members;
    layoutSelect.value = o.layout;
    libraryBtn.setAttribute('aria-pressed', String(o.external));
  }
  syncToolbar();

  function setOptions(next: DiagramOptions): void {
    const prev = state.options;
    state.options = copyOptions(next);
    shared.saveOptions(state.options);
    syncToolbar();
    if (needsNewRequest(prev, state.options)) void run();
    else if (prev.members !== state.options.members || prev.layout !== state.options.layout) void relayout(prev.layout !== state.options.layout);
  }

  // --- Overlay and note --------------------------------------------------------

  function showOverlay(...children: (Node | string | undefined)[]): void {
    clear(overlay);
    overlay.append(h('div', { class: 'diagram-card' }, ...children));
    overlay.hidden = false;
  }
  function hideOverlay(): void {
    overlay.hidden = true;
    clear(overlay);
  }
  function showMessage(text: string, action?: { label: string; run: () => void }): void {
    overlay.classList.add('is-solid');
    showOverlay(h('div', { class: 'diagram-message' }, text), action && h('button', { class: 'diagram-btn', type: 'button', onclick: action.run }, action.label));
  }
  function showLoading(text: string): void {
    overlay.classList.remove('is-solid');
    showOverlay(
      h('div', { class: 'diagram-spinner' }),
      h('div', { class: 'diagram-message' }, text),
      h('button', { class: 'diagram-btn', type: 'button', onclick: () => cancelRunning() }, 'Cancel'),
    );
  }

  function updateNote(): void {
    clear(note);
    const parts: (Node | string)[] = [];
    if (data?.truncated) parts.push(`Showing the nearest ${data.nodes.length} types. More types match. Lower the depth or turn off some relations to see less.`);
    if (hidden.size) {
      if (parts.length) parts.push(' ');
      parts.push(`${hidden.size} hidden. `, h('button', { class: 'diagram-link', type: 'button', onclick: () => showHidden() }, 'Show all'));
    }
    note.append(...parts);
    note.hidden = parts.length === 0;
  }

  function showHidden(): void {
    hidden.clear();
    void relayout(false);
  }

  // --- Requests ----------------------------------------------------------------

  function cancelRunning(): void {
    if (!running) return;
    const r = running;
    running = null;
    seq++;
    codeCancel(r.id).catch(() => {});
    if (data) {
      hideOverlay();
    } else {
      showMessage('Cancelled.', { label: 'Try Again', run: () => void run() });
    }
  }

  interface Job {
    scope: DiagramScope;
    options: DiagramOptions;
    /** Join the answer to the diagram on screen. */
    merge?: boolean;
    select?: string;
    maxNodes?: number;
    maxFan?: number;
    expanded?: { id: string; direction: 'in' | 'out' };
  }

  async function run(job?: Job): Promise<void> {
    if (running) {
      const r = running;
      running = null;
      codeCancel(r.id).catch(() => {});
    }
    const rootPath = ctx.workspace.root;
    const scopeNow = job?.scope ?? state.scope;
    const scopePath = 'path' in scopeNow ? scopeNow.path : null;
    const reqRoot = rootPath ?? (scopePath ? scopePath.replace(/[\\/][^\\/]*$/, '') : '');
    if (!reqRoot) {
      showMessage('Open a folder first.');
      return;
    }
    const my = ++seq;
    const id = newCodeRequestId();
    running = { id, seq: my };
    const scope = job?.merge ? scopeNow : shared.withEditorText(scopeNow);
    const options = job?.options ?? state.options;

    const ready = shared.indexReady;
    showLoading(ready ? 'Building the diagram...' : MESSAGE_READING);
    if (!ready) {
      // The index may exist already (another tab or the usages feature built it).
      codeIndexStatus(reqRoot)
        .then((s) => {
          if (s.state === 'ready') shared.indexReady = true;
          if (my === seq && s.state === 'ready') showLoading('Building the diagram...');
        })
        .catch(() => {});
    }

    try {
      const result = await codeDiagram(id, buildRequest(reqRoot, scope, options, job?.maxNodes, job?.maxFan));
      if (my !== seq || disposed) return;
      running = null;
      shared.indexReady = result.index.state === 'ready';
      hideOverlay();
      if (job?.merge && data) {
        const keep = data.focus;
        data = mergeResults(data, result, job.maxNodes ?? MAX_NODES, job.expanded);
        data.focus = keep;
        state.scope = scopeOfNodes(data.nodes);
      } else {
        if (job) {
          state.scope = job.scope;
          state.focus = null;
          hidden.clear();
        }
        data = result;
        if (state.focus) data.focus = state.focus.filter((fid) => result.nodes.some((n) => n.id === fid));
      }
      if (job?.merge) state.focus = data.focus;
      // A new answer always fits the view. A merge keeps it while part of the drawing is still visible.
      const fit = !job?.merge;
      updateTitle();
      await relayout(fit);
      if (job?.select && nodeById.has(job.select)) {
        select(job.select);
        centerOn(job.select);
      }
    } catch (e) {
      if (my !== seq || disposed) return;
      running = null;
      const code = (e as { code?: string }).code;
      if (code === 'cancelled') {
        if (data) hideOverlay();
        else showMessage('Cancelled.', { label: 'Try Again', run: () => void run() });
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      ctx.ui.notify(`Cannot build the class diagram: ${msg}`, { kind: 'error' });
      if (data) hideOverlay();
      else showMessage(`Cannot build the class diagram: ${msg}`, { label: 'Try Again', run: () => void run() });
    }
  }

  function updateTitle(): void {
    if (!data) return;
    const focusNodes = data.focus.map((id) => data?.nodes.find((n) => n.id === id)).filter((n): n is DiagramNode => !!n);
    const title = tabTitle(state.scope as { kind: string; path?: string }, focusNodes);
    state.title = title;
    ctx.tabs.setTitle(tabId, title, 'Class Diagram');
  }

  // --- Layout and drawing ------------------------------------------------------

  const nodeBoxKey = (n: DiagramNode, mode: MembersMode) => `${mode}|${n.id}`;
  let boxCacheData: DiagramResult | null = null;
  const boxCache = new Map<string, NodeBox>();

  async function relayout(fit: boolean): Promise<void> {
    if (!data || disposed) return;
    const my = ++layoutSeq;
    const current = data;
    if (current.focus.length === 0 && current.nodes.length === 0) {
      clearDrawing();
      const s = state.scope;
      showMessage(
        s.kind === 'cursor' ? 'No class, interface or other type at the cursor.' : s.kind === 'file' ? 'No class, interface or other type in this file.' : s.kind === 'folder' ? 'No class, interface or other type in this folder.' : 'These types are no longer in the project.',
        { label: 'Try Again', run: () => void run() },
      );
      return;
    }
    const vis = withoutHidden(current, hidden);
    if (vis.nodes.length === 0) {
      clearDrawing();
      showMessage('All types are hidden.', { label: 'Show All', run: () => showHidden() });
      updateNote();
      return;
    }
    const { runLayout } = await import('./layout');
    if (my !== layoutSeq || disposed) return;

    if (boxCacheData !== current) {
      boxCache.clear();
      boxCacheData = current;
    }
    const mode = state.options.members;
    boxes = new Map();
    for (const n of vis.nodes) {
      const k = nodeBoxKey(n, mode);
      let b = boxCache.get(k);
      if (!b) {
        b = computeNodeBox(n, mode, measure);
        boxCache.set(k, b);
      }
      boxes.set(n.id, b);
    }
    const input = buildLayoutInput(vis.nodes, vis.edges, (id) => boxes.get(id) as NodeBox, state.options.layout, (t) => edgeLabelSize(t, measure));
    placement = runLayout(input);
    visible = vis;
    nodeById = new Map(vis.nodes.map((n) => [n.id, n]));
    nodePos = new Map(placement.nodes.map((p) => [p.id, { x: p.x, y: p.y }]));
    neighbors = neighborMap(vis.edges);
    rendered = renderDiagram({ nodes: vis.nodes, edges: vis.edges, boxes, placement, focus: new Set(vis.focus), prefix, fontFamily });
    viewport.replaceChildren(rendered.content);
    overlay.classList.remove('is-solid');
    hideOverlay();
    if (selectedId && !nodeById.has(selectedId)) selectedId = null;
    applySelection();
    updateNote();
    updateSearch(false);
    if (fit || !drawingInView()) fitView();
    else applyView();
  }

  /** True when the drawing overlaps the canvas with the current pan and zoom. */
  function drawingInView(): boolean {
    if (!placement) return false;
    const r = canvas.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) return true;
    const left = view.x;
    const top = view.y;
    const right = view.x + placement.width * view.k;
    const bottom = view.y + placement.height * view.k;
    return right > 20 && bottom > 20 && left < r.width - 20 && top < r.height - 20;
  }

  function clearDrawing(): void {
    viewport.replaceChildren();
    rendered = null;
    placement = null;
    visible = null;
    selectedId = null;
    boxes = new Map();
    nodeById = new Map();
    neighbors = new Map();
    nodePos = new Map();
    applySelection();
    updateNote();
  }

  // --- Pan and zoom ------------------------------------------------------------

  function applyView(): void {
    viewport.setAttribute('transform', `translate(${view.x.toFixed(1)},${view.y.toFixed(1)}) scale(${view.k.toFixed(4)})`);
  }

  function fitView(): void {
    if (!placement) return;
    const r = canvas.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) {
      fitPending = true;
      return;
    }
    fitPending = false;
    const pad = 28;
    const pw = Math.max(1, placement.width);
    const ph = Math.max(1, placement.height);
    const k = clamp(Math.min((r.width - pad * 2) / pw, (r.height - pad * 2) / ph), MIN_ZOOM, 1.25);
    view = { k, x: (r.width - pw * k) / 2, y: (r.height - ph * k) / 2 };
    applyView();
  }

  function zoomAt(factor: number, cx: number, cy: number): void {
    const k = clamp(view.k * factor, MIN_ZOOM, MAX_ZOOM);
    const f = k / view.k;
    view = { k, x: cx - (cx - view.x) * f, y: cy - (cy - view.y) * f };
    applyView();
  }

  function zoomBy(factor: number): void {
    const r = canvas.getBoundingClientRect();
    zoomAt(factor, r.width / 2, r.height / 2);
  }

  function centerOn(id: string): void {
    const p = nodePos.get(id);
    if (!p) return;
    const r = canvas.getBoundingClientRect();
    if (view.k < 0.5) view.k = 0.8;
    view = { k: view.k, x: r.width / 2 - p.x * view.k, y: r.height / 2 - p.y * view.k };
    applyView();
  }

  /** Moves the view only when the node is outside it. */
  function ensureVisible(id: string): void {
    const p = nodePos.get(id);
    if (!p) return;
    const r = canvas.getBoundingClientRect();
    const sx = p.x * view.k + view.x;
    const sy = p.y * view.k + view.y;
    const m = 60;
    if (sx < m || sy < m || sx > r.width - m || sy > r.height - m) centerOn(id);
  }

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (!rendered) return;
      const r = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const dy = clamp(e.deltaY, -60, 60);
        zoomAt(Math.exp(-dy * 0.006), e.clientX - r.left, e.clientY - r.top);
      } else {
        view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY };
        applyView();
      }
    },
    { passive: false },
  );

  // Safari and WKWebView send gesture events for a pinch on the trackpad.
  interface GestureEvent extends UIEvent {
    scale: number;
    clientX: number;
    clientY: number;
  }
  let gestureStartK = 1;
  canvas.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    gestureStartK = view.k;
  });
  canvas.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const g = e as GestureEvent;
    const r = canvas.getBoundingClientRect();
    zoomAt((gestureStartK * g.scale) / view.k, g.clientX - r.left, g.clientY - r.top);
  });

  // Drag to pan. A drag of less than 4 px is a click.
  let drag: { sx: number; sy: number; vx: number; vy: number; moved: boolean; pointerId: number } | null = null;
  let suppressClick = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest('.diagram-legend, .diagram-overlay')) return;
    drag = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, pointerId: e.pointerId };
    canvas.focus({ preventScroll: true });
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      canvas.setPointerCapture(drag.pointerId);
      canvas.classList.add('is-panning');
    }
    view = { ...view, x: drag.vx + dx, y: drag.vy + dy };
    applyView();
  });
  const endDrag = () => {
    if (drag?.moved) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
    }
    drag = null;
    canvas.classList.remove('is-panning');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const ro = new ResizeObserver(
    rafThrottle(() => {
      if (fitPending && !disposed) fitView();
    }),
  );
  ro.observe(canvas);

  // --- Selection and keys ------------------------------------------------------

  function applySelection(): void {
    const sel = selectedId;
    canvas.classList.toggle('has-selection', !!sel);
    if (!rendered) return;
    const near = sel ? neighbors.get(sel) : undefined;
    for (const [id, el] of rendered.nodeEls) {
      el.classList.toggle('is-sel', id === sel);
      el.classList.toggle('is-near', !!near?.has(id));
    }
    for (const e of rendered.edgeEls) e.el.classList.toggle('is-hot', !!sel && (e.from === sel || e.to === sel));
  }

  function select(id: string | null): void {
    selectedId = id;
    applySelection();
  }

  function nodeAt(target: EventTarget | null): { node: DiagramNode; el: Element } | null {
    const el = (target as Element | null)?.closest?.('.diagram-node');
    const id = el?.getAttribute('data-id');
    const node = id ? nodeById.get(id) : undefined;
    return node && el ? { node, el } : null;
  }

  function memberAt(node: DiagramNode, target: EventTarget | null): DiagramMember | null {
    const key = (target as Element | null)?.closest?.('.diagram-member')?.getAttribute('data-member');
    if (!key) return null;
    const kind = key[0] === 'f' ? 'field' : 'method';
    const index = Number(key.slice(1));
    return boxes.get(node.id)?.rows.find((r) => r.kind === kind && r.memberIndex === index)?.member ?? null;
  }

  function open(node: DiagramNode, member?: DiagramMember | null): void {
    if (!node.path) {
      ctx.ui.notify(`${node.name} is not in the project, so there is no file to open.`, { kind: 'info', timeoutMs: 3000 });
      return;
    }
    ctx.editors
      .openFile(node.path, { line: member?.line || node.line || undefined, column: member?.column || node.column || undefined })
      .catch((e) => ctx.ui.notify(`Cannot open ${node.path}: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' }));
  }

  canvas.addEventListener('click', (e) => {
    if (suppressClick) return;
    const hit = nodeAt(e.target);
    if (hit) select(hit.node.id);
    else if ((e.target as Element).closest('.diagram-legend, .diagram-overlay')) return;
    else select(null);
  });
  canvas.addEventListener('dblclick', (e) => {
    const hit = nodeAt(e.target);
    if (hit) open(hit.node, memberAt(hit.node, e.target));
  });

  canvas.addEventListener('contextmenu', (e) => {
    const hit = nodeAt(e.target);
    if (!hit) return;
    e.preventDefault();
    select(hit.node.id);
    const member = memberAt(hit.node, e.target);
    ctx.ui.contextMenu(e, member ? memberMenu(hit.node, member) : nodeMenu(hit.node));
  });

  function usagesItem(path: string | null, line: number, column: number): MenuItem[] {
    if (!path || !ctx.commands.get('usages.find')) return [];
    return [
      {
        label: 'Find Usages',
        run: () => void ctx.commands.execute('usages.find', { path, line, column }).catch((err) => ctx.ui.notify(`Cannot find usages: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' })),
      },
    ];
  }

  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

  function nodeMenu(node: DiagramNode): MenuItem[] {
    const ext = node.external || !node.path;
    return [
      { label: 'Open', run: () => open(node), disabled: ext },
      { label: 'Focus on This Type', run: () => focusOn(node), disabled: ext, separatorBefore: true },
      { label: 'Add Supertypes', run: () => void addRelated(node, 'out'), disabled: ext },
      { label: 'Add Subtypes', run: () => void addRelated(node, 'in'), disabled: ext },
      ...(node.hiddenIn ? [{ label: `Show ${node.hiddenIn} More Subtypes and Users`, run: () => void showMore(node, 'in', node.hiddenIn ?? 0), disabled: ext }] : []),
      ...(node.hiddenOut ? [{ label: `Show ${node.hiddenOut} More Supertypes and Parts`, run: () => void showMore(node, 'out', node.hiddenOut ?? 0), disabled: ext }] : []),
      { label: 'Hide', run: () => hideNode(node.id), separatorBefore: true },
      ...usagesItem(node.path, node.line, node.column),
      { label: 'Copy Name', run: () => copy(node.name), separatorBefore: true },
    ];
  }

  function memberMenu(node: DiagramNode, m: DiagramMember): MenuItem[] {
    return [
      { label: 'Open', run: () => open(node, m), disabled: !node.path },
      ...usagesItem(node.path, m.line, m.column),
      { label: 'Copy Name', run: () => copy(m.name), separatorBefore: true },
    ];
  }

  function focusOn(node: DiagramNode): void {
    void run({ scope: { kind: 'types', ids: [node.id] }, options: state.options });
  }

  function addRelated(node: DiagramNode, direction: 'out' | 'in'): Promise<void> {
    return run({
      scope: { kind: 'types', ids: [node.id] },
      options: { ...state.options, relations: ['extends', 'implements'], depth: 1, direction },
      merge: true,
      select: node.id,
      expanded: { id: node.id, direction },
    });
  }

  async function showMore(node: DiagramNode, direction: 'in' | 'out', count: number): Promise<void> {
    if (count > SHOW_MORE_CONFIRM_ABOVE) {
      const answer = await ctx.ui.confirm({ title: `Add ${count} types to the diagram?`, message: 'It can get hard to read.', buttons: ['Add Types', 'Cancel'] });
      if (answer !== 'Add Types') return;
    }
    return run({
      scope: { kind: 'types', ids: [node.id] },
      options: { ...state.options, depth: 1, direction },
      merge: true,
      select: node.id,
      maxNodes: SHOW_MORE_MAX_NODES,
      maxFan: SHOW_MORE_FAN,
      expanded: { id: node.id, direction },
    });
  }

  function hideNode(id: string): void {
    hidden.add(id);
    if (selectedId === id) selectedId = null;
    void relayout(false);
  }

  canvas.addEventListener('keydown', (e) => {
    if (e.target !== canvas) return;
    if (e.key === 'Escape') {
      select(null);
      return;
    }
    if (e.key === 'Enter' && selectedId) {
      const n = nodeById.get(selectedId);
      if (n) open(n);
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (!selectedId) {
        const first = visible?.focus[0] ?? visible?.nodes[0]?.id;
        if (first) {
          select(first);
          ensureVisible(first);
        }
        return;
      }
      const from = nodePos.get(selectedId);
      if (!from) return;
      const cands = [...(neighbors.get(selectedId) ?? [])].flatMap((id) => {
        const p = nodePos.get(id);
        return p ? [{ id, x: p.x, y: p.y }] : [];
      });
      const next = pickNeighbor(from, cands, e.key as ArrowKey);
      if (next) {
        select(next);
        ensureVisible(next);
      }
    }
  });

  // --- Search ------------------------------------------------------------------

  let matches: DiagramNode[] = [];
  let matchIndex = -1;

  function updateSearch(jump: boolean): void {
    const q = searchInput.value;
    searchClear.hidden = q === '';
    matches = q.trim() && visible ? searchNodes(visible.nodes, q) : [];
    matchIndex = matches.length ? 0 : -1;
    renderSearchCount();
    if (jump && matches.length) goToMatch();
  }
  function renderSearchCount(): void {
    searchCount.textContent = !searchInput.value.trim() ? '' : matches.length ? `${matchIndex + 1}/${matches.length}` : 'None';
  }
  function goToMatch(): void {
    const n = matches[matchIndex];
    if (!n) return;
    select(n.id);
    centerOn(n.id);
    renderSearchCount();
  }
  function clearSearch(focusCanvas: boolean): void {
    searchInput.value = '';
    updateSearch(false);
    if (focusCanvas) canvas.focus({ preventScroll: true });
  }
  searchInput.addEventListener('input', () => updateSearch(true));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!matches.length) return;
      matchIndex = (matchIndex + (e.shiftKey ? -1 : 1) + matches.length) % matches.length;
      goToMatch();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clearSearch(true);
    }
  });

  // --- Export ------------------------------------------------------------------

  function exportInput() {
    if (!visible) return null;
    return { nodes: visible.nodes, edges: visible.edges, members: state.options.members, layout: state.options.layout };
  }

  async function copyText(what: string, make: (i: NonNullable<ReturnType<typeof exportInput>>) => string): Promise<void> {
    const input = exportInput();
    if (!input) {
      ctx.ui.notify('There is no diagram to copy yet.', { kind: 'warn', timeoutMs: 3000 });
      return;
    }
    try {
      await navigator.clipboard.writeText(make(input));
      ctx.ui.notify(`Copied ${input.nodes.length} types as ${what}.`, { timeoutMs: 3000 });
    } catch (e) {
      ctx.ui.notify(`Cannot copy: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
    }
  }

  async function saveSvg(): Promise<void> {
    if (!rendered || !placement) {
      ctx.ui.notify('There is no diagram to save yet.', { kind: 'warn', timeoutMs: 3000 });
      return;
    }
    const fileName = `${state.title.replace(/[^\w.-]+/g, '_') || 'class-diagram'}.svg`;
    let path: string | null;
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      let defaultPath = fileName;
      try {
        const { downloadDir, join } = await import('@tauri-apps/api/path');
        defaultPath = await join(await downloadDir(), fileName);
      } catch {
        // No Downloads folder (browser dev mode): use the name only.
      }
      path = await save({ title: 'Save as SVG', defaultPath, filters: [{ name: 'SVG', extensions: ['svg'] }] });
    } catch (e) {
      ctx.ui.notify(`Could not open the file dialog: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
      return;
    }
    if (!path) return;
    try {
      const text = buildSvgFile(rendered, defs, placement, cssVar);
      await fsWriteFile(path, text, { encoding: 'utf-8', bom: false, lineEnding: 'lf', expectedMtimeMs: null });
      ctx.ui.notify(`Saved ${path.split(/[\\/]/).pop()}.`, { timeoutMs: 4000 });
    } catch (e) {
      ctx.ui.notify(`Could not save the SVG file: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
    }
  }

  // --- Tab content -------------------------------------------------------------

  void run();

  return {
    focus() {
      canvas.focus({ preventScroll: true });
    },
    onShow() {
      if (fitPending) fitView();
    },
    zoom(step) {
      if (!rendered) return false;
      if (step === 0) fitView();
      else zoomBy(step > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
      return true;
    },
    dispose() {
      disposed = true;
      ro.disconnect();
      if (running) codeCancel(running.id).catch(() => {});
      running = null;
      host.replaceChildren();
    },
  };
}

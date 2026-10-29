// The graph tab: toolbar, canvas, panels, pointer input and the glue between
// the model (`model/index.ts`), the force simulation (worker) and the drawing
// (`render.ts`). This file and its CSS load with `import()` the first time a
// graph tab is created.
//
// Nothing is drawn while nothing changes. A frame is requested when a
// simulation tick arrives, when the camera or a node moves, when the highlight
// fades, or when the data or the options change.

import { quadtree } from 'd3-quadtree';
import type { Quadtree } from 'd3-quadtree';
import { createElement, FolderTree, Maximize, Search, Settings, X } from 'lucide';
import { clear, h } from '../../core/dom';
import type { AppContext, MenuItem, TabContent } from '../../core/types';
import { basename, debounce, dirname, isMac, rafThrottle } from '../../core/util';
import { fsCreateFile, fsWriteFile } from '../../ipc/fs';
import { notesCancel, notesGraph, notesIndexUpdate } from '../../ipc/notes';
import { approach, lerpPositions } from './animate';
import { boundsOf, fitBounds, lerpCamera, easeInOut, panBy, sameCamera, ZOOM_STEP, zoomAt, toGraph, clampZoom } from './camera';
import type { Camera } from './camera';
import { createFoldersPanel } from './folders-panel';
import { findFolder } from './folder-rows';
import './graph.css';
import { sameNoteGraph } from './graph-diff';
import { buildAdjacency, folderHighlight, nodeHighlight, nodesUnderFolder } from './highlight';
import type { Adjacency, Highlight } from './highlight';
import {
  buildFolderTree,
  buildVisibleGraph,
  compileQuery,
  DEFAULT_OPTIONS,
  folderHulls,
  graphTitle,
  nodeRadius,
  treeLayout,
} from './model';
import { classifyOptionChange } from './option-changes';
import { createSettingsPanel } from './panel';
import { seedPositions } from './positions';
import { GraphRenderer, readPalette } from './render';
import type { Frame } from './render';
import { EDGE_LINK, EDGE_TAG, EDGE_TREE } from './sim-core';
import { SimClient } from './sim-client';
import type { FolderHull, FolderNode, FolderState, GraphLayout, GraphOptions, GraphTabState, NoteGraph, VisibleGraph, VNode } from './types';

/** Shared by the graph tabs of one workbench. `index.ts` owns it. */
export interface GraphShared {
  saveOptions(o: GraphOptions): void;
  saveFolders(f: FolderState): void;
  /** Tabs add a function here. `index.ts` calls it after the note index changed. */
  onIndexChanged: Set<() => void>;
}

const LAYOUT_MS = 300;
const FIT_MARGIN = 56;
const MESSAGE_READING = 'Reading notes...';

/** Request ids must be unique for the whole window, so one counter serves all workbenches. */
let nextRequestId = 1;

const LAYOUTS: [GraphLayout, string, string][] = [
  ['force', 'Force', 'Free layout: linked notes pull each other close'],
  ['radial', 'Radial', 'The folder tree as circles'],
  ['tree', 'Tree', 'The folder tree from left to right'],
];

const isMarkdownPath = (p: string) => /\.(md|markdown|mdx)$/i.test(p);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function folderParentId(id: string): string | null {
  const rel = id.slice(2);
  if (rel === '') return null;
  const k = rel.lastIndexOf('/');
  return 'f:' + (k < 0 ? '' : rel.slice(0, k));
}

export function createGraphContent(ctx: AppContext, host: HTMLElement, tabId: string, state: GraphTabState, shared: GraphShared): TabContent {
  let disposed = false;
  let visible = true;
  let theme: 'light' | 'dark' = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

  // --- DOM ---------------------------------------------------------------------

  const root = h('div', { class: 'graph-root' });
  const toolbar = h('div', { class: 'graph-toolbar' });
  const body = h('div', { class: 'graph-body' });
  const canvas = h('canvas', { class: 'graph-canvas', tabindex: '0' });
  const overlay = h('div', { class: 'graph-overlay', hidden: true });
  body.append(canvas, overlay);
  root.append(toolbar, body);
  host.append(root);

  const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'sans-serif';
  const renderer = new GraphRenderer(canvas, fontFamily, readPalette(root, theme === 'dark'));

  // --- Data and derived state ----------------------------------------------------

  let data: NoteGraph | null = null;
  let tree: FolderNode | null = null;
  let vg: VisibleGraph = { nodes: [], edges: [], stats: { notes: 0, scopeNotes: 0, links: 0 }, emptyReason: null };
  let adj: Adjacency = buildAdjacency(0, []);
  let radii: Float32Array = new Float32Array(0);
  let pos: Float64Array = new Float64Array(0);
  let posVersion = 0;
  let activeFlags: Uint8Array | null = null;
  let hulls: FolderHull[] | null = null;
  let hullKey = '';
  let hullTime = 0;
  let hullSize = 0;
  /** Positions by node id just before the last rebuild (any layout). */
  let lastPos = new Map<string, [number, number]>();
  /** Positions of the force layout, so a switch back to it returns to the old picture. */
  const keptForce = new Map<string, [number, number]>();
  let curLayout: GraphLayout | null = null;
  let lastActive: string | null = ctx.editors.active()?.path ?? null;
  let seq = 0;
  let running: { id: number } | null = null;
  let stale = false;
  let pendingFollow = false;

  // Camera and animations.
  let cam: Camera = state.camera ? { ...state.camera } : { x: 0, y: 0, zoom: 1 };
  let autoFit = !state.camera;
  let camTween: { from: Camera; to: Camera; t0: number; ms: number } | null = null;
  let tween: { from: Float64Array; to: Float64Array; t0: number; then: (() => void) | null } | null = null;
  let tickCount = 0;
  let simRunning = false;

  // Interaction.
  let hoverIdx = -1;
  let panelHover: string | null = null;
  let selectedFolder: string | null = null;
  let hl: Highlight | null = null;
  let hlFading: Highlight | null = null;
  let hullFocus: string | null = null;
  let dim = 0;
  let width = 0;
  let height = 0;

  const sim = new SimClient((p, _alpha, done) => {
    if (curLayout !== 'force' || tween || p.length !== pos.length) return;
    for (let i = 0; i < pos.length; i++) pos[i] = p[i];
    if (drag?.mode === 'node') {
      pos[drag.idx * 2] = drag.gx;
      pos[drag.idx * 2 + 1] = drag.gy;
    }
    posVersion++;
    simRunning = !done;
    tickCount++;
    if (autoFit && (tickCount % 6 === 0 || done)) fitStep(done ? 1 : 0.35);
    requestDraw();
  });

  // --- Toolbar -----------------------------------------------------------------

  const iconBtn = (icon: Parameters<typeof createElement>[0], title: string, onclick: () => void) => {
    const b = h('button', { class: 'graph-btn graph-icon-btn', type: 'button', title, 'aria-label': title, onclick });
    b.append(createElement(icon));
    return b;
  };

  const scopeLabel = h('span', { class: 'graph-scope' });
  const layoutButtons = new Map<GraphLayout, HTMLButtonElement>();
  for (const [value, label, hint] of LAYOUTS) {
    layoutButtons.set(value, h('button', { class: 'graph-btn graph-seg', type: 'button', title: hint, 'aria-pressed': 'false', onclick: () => setOptions({ ...state.options, layout: value }) }, label));
  }
  const searchInput = h('input', { class: 'graph-search-input', type: 'text', placeholder: 'Search files', spellcheck: 'false', 'aria-label': 'Search files' });
  const searchClear = h('button', { class: 'graph-search-clear', type: 'button', title: 'Clear', 'aria-label': 'Clear', hidden: true });
  searchClear.append(createElement(X));
  const searchIcon = h('span', { class: 'graph-search-icon' });
  searchIcon.append(createElement(Search));
  const searchError = h('div', { class: 'graph-search-error', hidden: true });
  const searchBox = h('div', { class: 'graph-search' }, searchIcon, searchInput, searchClear, searchError);
  const counts = h('span', { class: 'graph-counts' });
  const fitBtn = iconBtn(Maximize, 'Fit to window (Mod-0)', () => fitView(true));
  const foldersBtn = iconBtn(FolderTree, 'Folders', () => togglePanel('folders'));
  const settingsBtn = iconBtn(Settings, 'Settings', () => togglePanel('settings'));
  foldersBtn.setAttribute('aria-pressed', 'false');
  settingsBtn.setAttribute('aria-pressed', 'false');
  toolbar.append(
    scopeLabel,
    h('span', { class: 'graph-sep' }),
    h('div', { class: 'graph-group' }, ...layoutButtons.values()),
    h('span', { class: 'graph-sep' }),
    searchBox,
    counts,
    h('span', { class: 'graph-spacer' }),
    fitBtn,
    foldersBtn,
    settingsBtn,
  );

  const pushSearch = debounce((v: string) => setOptions({ ...state.options, query: v }), 150);
  searchInput.addEventListener('input', () => {
    searchClear.hidden = !searchInput.value;
    showQueryError(searchInput.value);
    pushSearch(searchInput.value);
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.hidden = true;
    showQueryError('');
    pushSearch.cancel();
    setOptions({ ...state.options, query: '' });
    searchInput.focus();
  });
  function showQueryError(text: string): void {
    const err = compileQuery(text).error;
    searchError.textContent = err ?? '';
    searchError.hidden = !err;
  }

  // --- Panels ------------------------------------------------------------------

  const settings = createSettingsPanel({
    change: (patch) => setOptions({ ...state.options, ...patch }),
    reset: () => setOptions({ ...DEFAULT_OPTIONS, layout: state.options.layout }),
    setFollow: (follow) => {
      if (state.scope.kind !== 'local') return;
      state.scope = { ...state.scope, follow };
      syncUi();
      if (follow) maybeFollow();
    },
    close: () => togglePanel('settings', false),
  });
  const folders = createFoldersPanel({
    hover: (rel) => {
      panelHover = rel;
      computeHighlight();
    },
    click: (rel) => {
      selectedFolder = rel;
      computeHighlight();
      zoomToFolder(rel);
    },
    toggleHidden: (rel) => setFolders(toggled(state.folders, 'hidden', rel)),
    toggleCollapsed: (rel) => setFolders(toggled(state.folders, 'collapsed', rel)),
    close: () => togglePanel('folders', false),
  });
  body.append(folders.el, settings.el);

  function togglePanel(which: 'settings' | 'folders', force?: boolean): void {
    const el = which === 'settings' ? settings.el : folders.el;
    const btn = which === 'settings' ? settingsBtn : foldersBtn;
    el.hidden = force === undefined ? !el.hidden : !force;
    btn.setAttribute('aria-pressed', String(!el.hidden));
  }

  function toggled(f: FolderState, key: 'hidden' | 'collapsed', rel: string): FolderState {
    if (rel === '') return f;
    const list = f[key];
    return { ...f, [key]: list.includes(rel) ? list.filter((r) => r !== rel) : [...list, rel] };
  }

  function setFolders(next: FolderState): void {
    state.folders = next;
    shared.saveFolders(next);
    folders.set(panelRoot(), next);
    if (selectedFolder !== null && next.hidden.includes(selectedFolder)) selectedFolder = null;
    rebuild();
  }

  function panelRoot(): FolderNode | null {
    if (!tree) return null;
    if (state.scope.kind === 'folder') return findFolder(tree, state.scope.path) ?? tree;
    return tree;
  }

  function syncUi(): void {
    const o = state.options;
    for (const [value, b] of layoutButtons) b.setAttribute('aria-pressed', String(o.layout === value));
    if (document.activeElement !== searchInput) searchInput.value = o.query;
    searchClear.hidden = !o.query;
    showQueryError(o.query);
    settings.sync(o, state.scope);
    const title = graphTitle(state.scope, ctx.workspace.root);
    scopeLabel.textContent = title;
    ctx.tabs.setTitle(tabId, title, 'Graph');
  }

  function updateCounts(): void {
    const s = vg.stats;
    const parts = [`${s.notes} ${s.notes === 1 ? 'note' : 'notes'}`, `${s.links} ${s.links === 1 ? 'link' : 'links'}`];
    counts.textContent = parts.join(', ');
    counts.title = data?.truncated ? 'The folder has more notes than the index keeps (20,000). Only the first ones are shown.' : '';
    counts.classList.toggle('is-warn', !!data?.truncated);
  }

  // --- Overlay -----------------------------------------------------------------

  function showOverlay(solid: boolean, ...children: (Node | string | undefined)[]): void {
    clear(overlay);
    overlay.classList.toggle('is-solid', solid);
    overlay.append(h('div', { class: 'graph-card' }, ...children));
    overlay.hidden = false;
  }
  function hideOverlay(): void {
    overlay.hidden = true;
    clear(overlay);
  }
  function showMessage(text: string, action?: { label: string; run: () => void }): void {
    showOverlay(true, h('div', { class: 'graph-message' }, text), action && h('button', { class: 'graph-btn', type: 'button', onclick: action.run }, action.label));
  }
  function showLoading(text: string): void {
    showOverlay(
      !data,
      h('div', { class: 'graph-spinner' }),
      h('div', { class: 'graph-message' }, text),
      h('button', { class: 'graph-btn', type: 'button', onclick: () => cancelRunning() }, 'Cancel'),
    );
  }

  // --- Loading -----------------------------------------------------------------

  function cancelRunning(): void {
    if (!running) return;
    const r = running;
    running = null;
    seq++;
    notesCancel(r.id).catch(() => {});
    if (data) hideOverlay();
    else showMessage('Cancelled.', { label: 'Try Again', run: () => void load(false) });
  }

  /** Dev only: `localStorage['graph.fixture'] = '500'` shows a generated graph without Rust. */
  async function fetchGraph(id: number, rootPath: string): Promise<NoteGraph> {
    if (import.meta.env.DEV) {
      const n = Number(localStorage.getItem('graph.fixture'));
      if (n > 0) {
        const { makeFixtureGraph } = await import('./fixture');
        return makeFixtureGraph({ notes: n, root: rootPath });
      }
    }
    return notesGraph(id, rootPath);
  }

  async function load(silent: boolean): Promise<void> {
    const rootPath = ctx.workspace.root;
    if (!rootPath) {
      showMessage('Open a folder first.');
      return;
    }
    if (running) notesCancel(running.id).catch(() => {});
    const my = ++seq;
    const id = nextRequestId++;
    running = { id };
    stale = false;
    if (!silent || !data) showLoading(MESSAGE_READING);
    try {
      const graph = await fetchGraph(id, rootPath);
      if (my !== seq || disposed) return;
      running = null;
      hideOverlay();
      if (data && sameNoteGraph(data, graph)) return;
      data = graph;
      tree = buildFolderTree(graph, state.options.colorDepth, theme);
      initLocalCenter();
      folders.set(panelRoot(), state.folders);
      rebuild();
    } catch (e) {
      if (my !== seq || disposed) return;
      running = null;
      if ((e as { code?: string }).code === 'cancelled') {
        if (data) hideOverlay();
        else showMessage('Cancelled.', { label: 'Try Again', run: () => void load(false) });
        return;
      }
      const msg = errText(e);
      ctx.ui.notify(`Cannot read the notes: ${msg}`, { kind: 'error' });
      if (data) hideOverlay();
      else showMessage(`Cannot read the notes: ${msg}`, { label: 'Try Again', run: () => void load(false) });
    }
  }

  /** A local graph without a center takes the active markdown file. */
  function initLocalCenter(): void {
    const s = state.scope;
    if (s.kind === 'local' && !s.path && lastActive && isMarkdownPath(lastActive)) {
      state.scope = { ...s, path: lastActive };
      syncUi();
    }
  }

  // --- Building the picture -------------------------------------------------------

  function currentRadii(g: VisibleGraph): Float32Array {
    const out = new Float32Array(g.nodes.length);
    const size = state.options.nodeSize;
    const fixed = state.options.layout !== 'force';
    for (let i = 0; i < out.length; i++) {
      const n = g.nodes[i];
      if (!fixed) out[i] = nodeRadius(n, size);
      // The tree layouts put leaves on a circle or in a column: a small fixed size keeps them apart.
      else if (n.kind === 'folder') out[i] = Math.min(nodeRadius(n, size), (n.collapsed ? 9 : 7) * size);
      else out[i] = (activeFlags?.[i] ? 5.5 : 4) * size;
    }
    return out;
  }

  function capturePositions(): void {
    const map = new Map<string, [number, number]>();
    for (let i = 0; i < vg.nodes.length; i++) map.set(vg.nodes[i].id, [pos[i * 2], pos[i * 2 + 1]]);
    lastPos = map;
    if (curLayout === 'force') for (const [k, v] of map) keptForce.set(k, v);
  }

  function rebuild(): void {
    if (!data || !tree || disposed) return;
    if (vg.nodes.length) capturePositions();
    let next: VisibleGraph;
    try {
      next = buildVisibleGraph({
        graph: data,
        tree,
        options: state.options,
        folders: state.folders,
        scope: state.scope,
        activePath: lastActive,
        theme,
      });
    } catch (e) {
      console.error('graph: cannot build the visible graph', e);
      showMessage(`Cannot build the graph: ${errText(e)}`, { label: 'Try Again', run: () => void load(false) });
      return;
    }
    vg = next;
    hoverIdx = -1;
    adj = buildAdjacency(vg.nodes.length, vg.edges);
    computeActive();
    radii = currentRadii(vg);
    hulls = null;
    hullKey = '';
    qtVersion = -1;
    updateCounts();
    computeHighlight(true);
    if (vg.nodes.length === 0) {
      sim.stop();
      pos = new Float64Array(0);
      tween = null;
      simRunning = false;
      posVersion++;
      if (vg.emptyReason) showMessage(vg.emptyReason);
      requestDraw();
      curLayout = state.options.layout;
      return;
    }
    if (!overlay.hidden && !running) hideOverlay();
    startLayout();
  }

  function startLayout(): void {
    const o = state.options;
    const prevLayout = curLayout;
    const hadNodes = lastPos.size > 0;
    curLayout = o.layout;
    tickCount = 0;
    const n = vg.nodes.length;
    if (o.layout === 'force') {
      const base = prevLayout === 'force' || prevLayout === null ? lastPos : keptForce;
      const seeded = seedPositions(vg, base);
      const alpha = seeded.fresh === n ? 1 : seeded.fresh === 0 ? 0.3 : 0.5;
      const begin = () => startSim(alpha, seeded.fresh === n && !hadNodes ? (n <= 2000 ? 40 : 8) : 0);
      if (prevLayout && prevLayout !== 'force' && hadNodes) {
        sim.stop();
        animateTo(seedPositions(vg, lastPos).pos, seeded.pos, begin);
      } else {
        pos = seeded.pos;
        posVersion++;
        begin();
      }
    } else {
      sim.stop();
      simRunning = false;
      const target = treeLayout(vg, o.layout);
      if (hadNodes) animateTo(seedPositions(vg, lastPos).pos, target, null);
      else {
        pos = target;
        posVersion++;
        afterLayoutSettled();
      }
    }
    requestDraw();
  }

  function startSim(alpha: number, warmup: number): void {
    const n = vg.nodes.length;
    const groupIndex = new Map<string, number>();
    const parents: number[] = [];
    const groupOf = (id: string): number => {
      const have = groupIndex.get(id);
      if (have !== undefined) return have;
      const idx = parents.length;
      groupIndex.set(id, idx);
      parents.push(-1);
      const up = folderParentId(id);
      parents[idx] = up ? groupOf(up) : -1;
      return idx;
    };
    const group = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const parent = vg.nodes[i].parent;
      group[i] = parent ? groupOf(parent) : -1;
    }
    const m = vg.edges.length;
    const edges = new Int32Array(m * 2);
    const edgeKind = new Uint8Array(m);
    for (let e = 0; e < m; e++) {
      const ed = vg.edges[e];
      edges[e * 2] = ed.source;
      edges[e * 2 + 1] = ed.target;
      edgeKind[e] = ed.kind === 'tree' ? EDGE_TREE : ed.kind === 'tag' ? EDGE_TAG : EDGE_LINK;
    }
    const p32 = new Float32Array(n * 2);
    for (let i = 0; i < p32.length; i++) p32[i] = pos[i];
    simRunning = true;
    sim.init({ n, edges, edgeKind, group, folderParent: Int32Array.from(parents), radius: radii.slice(), pos: p32, params: simParams(), alpha, warmup });
  }

  function simParams() {
    const o = state.options;
    return { centerForce: o.centerForce, repelForce: o.repelForce, linkForce: o.linkForce, linkDistance: o.linkDistance, folderPull: o.folderPull };
  }

  function animateTo(from: Float64Array, to: Float64Array, then: (() => void) | null): void {
    pos = Float64Array.from(from);
    tween = { from, to, t0: performance.now(), then };
    posVersion++;
    if (autoFit) {
      const b = boundsOf(to);
      if (b && width > 0) animateCamera(fitBounds(b, width, height, FIT_MARGIN), LAYOUT_MS);
    }
  }

  function afterLayoutSettled(): void {
    if (autoFit) fitView(false);
  }

  // --- Camera ------------------------------------------------------------------

  function saveCamera(): void {
    state.camera = autoFit ? null : { x: cam.x, y: cam.y, zoom: cam.zoom };
  }

  function fitTarget(indices?: ArrayLike<number> | null, margin = state.options.layout === 'radial' ? 150 : state.options.layout === 'tree' ? 110 : FIT_MARGIN): Camera | null {
    if (width <= 0 || vg.nodes.length === 0) return null;
    const b = boundsOf(pos, indices ?? null, vg.nodes.length);
    return b ? fitBounds(b, width, height, margin) : null;
  }

  /** Moves the camera a part of the way to the fit (used while the layout is still moving). */
  function fitStep(k: number): void {
    const t = fitTarget();
    if (!t) return;
    cam = k >= 1 ? t : lerpCamera(cam, t, k);
    requestDraw();
  }

  function fitView(animate: boolean): void {
    const t = fitTarget();
    if (!t) return;
    autoFit = true;
    saveCamera();
    if (animate) animateCamera(t, 280);
    else {
      cam = t;
      camTween = null;
      requestDraw();
    }
  }

  function animateCamera(to: Camera, ms: number): void {
    camTween = { from: { ...cam }, to, t0: performance.now(), ms };
    requestDraw();
  }

  function zoomToFolder(rel: string): void {
    const idx = nodesUnderFolder(vg, rel);
    const t = fitTarget(idx, 90);
    if (!t) return;
    autoFit = false;
    animateCamera({ ...t, zoom: Math.min(t.zoom, 1.4) }, 320);
    saveCamera();
  }

  function userCamera(next: Camera): void {
    cam = next;
    camTween = null;
    autoFit = false;
    saveCamera();
    requestDraw();
  }

  // --- Drawing -----------------------------------------------------------------

  let raf = 0;
  let lastT = 0;
  const frameData: Frame = { vg, pos, posVersion: 0, radii, options: state.options, layout: state.options.layout, cam, hulls: null, hl: null, dim: 0, hullFocus: null, active: null, bundleBeta: 0 };
  const frameTimes: number[] = [];

  function requestDraw(): void {
    if (raf || disposed || !visible) return;
    raf = requestAnimationFrame(frame);
  }

  let laterTimer: ReturnType<typeof setTimeout> | undefined;
  /** A frame that shows outlines from an old frame must be followed by one with fresh outlines. */
  function requestDrawLater(): void {
    if (laterTimer !== undefined) return;
    laterTimer = setTimeout(() => {
      laterTimer = undefined;
      requestDraw();
    }, 60);
  }

  function computeHulls(): FolderHull[] | null {
    const o = state.options;
    if (curLayout !== 'force' || !o.folderOutlines || vg.nodes.length === 0) return null;
    const key = `${posVersion}|${o.nodeSize}`;
    if (key === hullKey) return hulls;
    // While the simulation runs, the outlines are at most 60 ms old (the call costs several ms).
    const now = performance.now();
    if (hulls && simRunning && now - hullTime < 60 && hullSize === o.nodeSize) {
      requestDrawLater();
      return hulls;
    }
    hullKey = key;
    hullTime = now;
    hullSize = o.nodeSize;
    const list = folderHulls(vg, pos, 14 * o.nodeSize);
    hulls = list.slice().sort((a, b) => a.depth - b.depth);
    return hulls;
  }

  function frame(t: number): void {
    raf = 0;
    if (disposed || !visible || width <= 0) return;
    const dt = lastT ? Math.min(64, t - lastT) : 16;
    let more = false;

    if (tween) {
      const k = (t - tween.t0) / LAYOUT_MS;
      if (k >= 1) {
        pos = Float64Array.from(tween.to);
        const then = tween.then;
        tween = null;
        posVersion++;
        if (then) then();
        else afterLayoutSettled();
      } else {
        lerpPositions(tween.from, tween.to, k, pos);
        posVersion++;
        more = true;
      }
    }
    if (camTween) {
      const k = (t - camTween.t0) / camTween.ms;
      if (k >= 1) {
        cam = camTween.to;
        camTween = null;
        saveCamera();
      } else {
        cam = lerpCamera(camTween.from, camTween.to, easeInOut(Math.max(0, k)));
        more = true;
      }
    }
    const target = hl ? 1 : 0;
    if (dim !== target) {
      dim = approach(dim, target, dt, 160);
      if (dim !== target) more = true;
    }

    const f = frameData;
    f.vg = vg;
    f.pos = pos;
    f.posVersion = posVersion;
    f.radii = radii;
    f.options = state.options;
    f.layout = curLayout ?? state.options.layout;
    f.cam = cam;
    f.hulls = computeHulls();
    f.hl = hl ?? (dim > 0 ? hlFading : null);
    f.dim = dim;
    f.hullFocus = hullFocus;
    f.active = activeFlags;
    f.bundleBeta = curLayout !== 'force' && !(tween && vg.edges.length > 1500) ? state.options.bundling : 0;
    const t0 = performance.now();
    renderer.draw(f);
    if (import.meta.env.DEV) {
      frameTimes.push(performance.now() - t0);
      if (frameTimes.length > 600) frameTimes.shift();
    }
    lastT = more ? t : 0;
    if (more) requestDraw();
  }

  // --- Highlight and hit tests ----------------------------------------------------

  function computeActive(): void {
    const n = vg.nodes.length;
    const local = state.scope.kind === 'local';
    let any = false;
    const flags = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const nd = vg.nodes[i];
      const on = local ? nd.active : !!nd.path && nd.path === lastActive && nd.kind !== 'folder';
      if (on) {
        flags[i] = 1;
        any = true;
      }
    }
    activeFlags = any ? flags : null;
  }

  function computeHighlight(silent = false): void {
    let next: Highlight | null = null;
    let focus: string | null = null;
    if (hoverIdx >= 0 && hoverIdx < vg.nodes.length) {
      next = nodeHighlight(vg, adj, hoverIdx);
      if (vg.nodes[hoverIdx].kind === 'folder') focus = vg.nodes[hoverIdx].id;
    } else if (panelHover !== null) {
      next = folderHighlight(vg, panelHover);
      focus = 'f:' + panelHover;
    } else if (selectedFolder !== null) {
      next = folderHighlight(vg, selectedFolder);
      focus = 'f:' + selectedFolder;
    }
    if (next && !next.nodes.includes(1)) {
      // A folder without visible nodes (hidden): nothing to light up.
      next = null;
      focus = null;
    }
    if (hl) hlFading = hl;
    hl = next;
    if (next) hlFading = next;
    hullFocus = focus;
    if (!silent) requestDraw();
  }

  let qt: Quadtree<number> | null = null;
  let qtVersion = -1;
  function hit(sx: number, sy: number): number {
    const n = vg.nodes.length;
    if (n === 0) return -1;
    if (qt === null || qtVersion !== posVersion) {
      qt = quadtree<number>()
        .x((i) => pos[i * 2])
        .y((i) => pos[i * 2 + 1])
        .addAll(Array.from({ length: n }, (_, i) => i));
      qtVersion = posVersion;
    }
    const [gx, gy] = toGraph(cam, width, height, sx, sy);
    const reach = Math.max(8 / cam.zoom, 24);
    const near = qt.find(gx, gy, reach);
    if (near === undefined) return -1;
    const d = Math.hypot(pos[near * 2] - gx, pos[near * 2 + 1] - gy);
    return d <= Math.max(radii[near], 5 / cam.zoom) + 2 / cam.zoom ? near : -1;
  }

  // --- Pointer input -----------------------------------------------------------

  interface Drag {
    mode: 'node' | 'pan';
    idx: number;
    x0: number;
    y0: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    gx: number;
    gy: number;
  }
  let drag: Drag | null = null;
  let suppressClick = false;

  const local = (e: MouseEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.focus({ preventScroll: true });
    const [sx, sy] = local(e);
    const idx = hit(sx, sy);
    const mode = idx >= 0 && curLayout === 'force' && !tween ? 'node' : 'pan';
    const [gx, gy] = toGraph(cam, width, height, sx, sy);
    drag = { mode, idx, x0: sx, y0: sy, lastX: sx, lastY: sy, moved: false, gx, gy };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = local(e);
    if (!drag) {
      hoverMove(sx, sy);
      return;
    }
    if (!drag.moved && Math.hypot(sx - drag.x0, sy - drag.y0) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      canvas.classList.add('is-dragging');
      if (drag.mode === 'node') {
        hoverIdx = drag.idx;
        computeHighlight();
      }
    }
    if (drag.mode === 'node') {
      const [gx, gy] = toGraph(cam, width, height, sx, sy);
      drag.gx = gx;
      drag.gy = gy;
      pos[drag.idx * 2] = gx;
      pos[drag.idx * 2 + 1] = gy;
      posVersion++;
      sim.pin(drag.idx, gx, gy);
      requestDraw();
    } else {
      userCamera(panBy(cam, sx - drag.lastX, sy - drag.lastY));
    }
    drag.lastX = sx;
    drag.lastY = sy;
  });

  const endDrag = (e: PointerEvent) => {
    const d = drag;
    drag = null;
    canvas.classList.remove('is-dragging');
    if (!d) return;
    if (d.mode === 'node' && d.moved) sim.unpin(d.idx);
    if (d.moved) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
    } else if (e.type === 'pointerup') {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      onClick(d.idx, mod);
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (!drag && hoverIdx !== -1) {
      hoverIdx = -1;
      canvas.style.cursor = '';
      computeHighlight();
    }
  });

  const hoverMove = rafThrottle((sx: number, sy: number) => {
    if (drag || disposed) return;
    const idx = hit(sx, sy);
    if (idx === hoverIdx) return;
    hoverIdx = idx;
    canvas.style.cursor = idx >= 0 ? 'pointer' : '';
    computeHighlight();
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const speed = e.ctrlKey ? 0.01 : 0.0018;
      const factor = Math.exp(-e.deltaY * unit * speed);
      const [sx, sy] = local(e);
      userCamera(zoomAt(cam, width, height, sx, sy, factor));
    },
    { passive: false },
  );

  canvas.addEventListener('dblclick', (e) => {
    const [sx, sy] = local(e);
    const idx = hit(sx, sy);
    if (idx < 0) return;
    const n = vg.nodes[idx];
    if (n.kind === 'folder' && n.rel !== '') setFolders(toggled(state.folders, 'collapsed', n.rel));
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const [sx, sy] = local(e);
    const idx = hit(sx, sy);
    const items = idx >= 0 ? menuFor(vg.nodes[idx]) : [{ label: 'Fit to Window', run: () => fitView(true) }];
    ctx.ui.contextMenu(e, items);
  });

  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectedFolder !== null) {
      selectedFolder = null;
      computeHighlight();
    }
  });

  function onClick(idx: number, mod: boolean): void {
    if (suppressClick) return;
    if (idx < 0) {
      if (selectedFolder !== null) {
        selectedFolder = null;
        computeHighlight();
      }
      return;
    }
    const n = vg.nodes[idx];
    if (n.kind === 'folder') {
      selectedFolder = selectedFolder === n.rel ? null : n.rel;
      computeHighlight();
    } else if (n.kind === 'missing') {
      void createNote(n);
    } else if (n.kind !== 'tag' && n.path) {
      openNode(n, !mod);
    }
  }

  // --- Actions on nodes ----------------------------------------------------------

  function openNode(n: VNode, activate: boolean): void {
    if (!n.path) return;
    ctx.editors.openFile(n.path, { activate }).catch((e) => ctx.ui.notify(`Cannot open ${n.path}: ${errText(e)}`, { kind: 'error' }));
  }

  async function createNote(n: VNode): Promise<void> {
    const path = n.path;
    const rootPath = ctx.workspace.root;
    if (!path || !rootPath) return;
    const file = basename(path);
    const answer = await ctx.ui.confirm({ title: `Create note ${file}?`, message: ctx.workspace.relative(path), buttons: ['Create', 'Cancel'] });
    if (answer !== 'Create' || disposed) return;
    const title = file.replace(/\.(md|markdown|mdx)$/i, '');
    try {
      await fsCreateFile(path);
      await fsWriteFile(path, `# ${title}\n`, { encoding: 'utf-8', bom: false, lineEnding: 'lf', expectedMtimeMs: null });
    } catch (e) {
      if ((e as { code?: string }).code !== 'already_exists') {
        ctx.ui.notify(`Cannot create ${file}: ${errText(e)}`, { kind: 'error' });
        return;
      }
    }
    await notesIndexUpdate(rootPath, [path], false).catch(() => {});
    void load(true);
    openNode({ ...n, path }, true);
  }

  function folderRelOf(n: VNode): string | null {
    if (n.kind === 'folder') return n.rel;
    return n.parent ? n.parent.slice(2) : null;
  }

  function revealItem(path: string): MenuItem {
    return {
      label: 'Reveal in Explorer',
      run: () => void ctx.commands.execute('explorer.revealPath', path).catch((e) => ctx.ui.notify(`Cannot reveal ${path}: ${errText(e)}`, { kind: 'error' })),
      separatorBefore: true,
    };
  }

  function menuFor(n: VNode): MenuItem[] {
    const items: MenuItem[] = [];
    const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
    const folderRel = folderRelOf(n);
    const folderItems = (label: string): MenuItem[] => {
      if (folderRel === null || folderRel === '') return [];
      const collapsed = state.folders.collapsed.includes(folderRel);
      return [
        { label: collapsed ? `Expand ${label}` : `Collapse ${label}`, run: () => setFolders(toggled(state.folders, 'collapsed', folderRel)), separatorBefore: true },
        { label: `Hide ${label}`, run: () => setFolders(toggled(state.folders, 'hidden', folderRel)) },
      ];
    };
    if (n.kind === 'folder') {
      items.push({ label: 'Highlight Folder', run: () => ((selectedFolder = n.rel), computeHighlight()) });
      if (n.path && n.rel !== '') items.push({ label: 'Show Graph for Folder', run: () => void ctx.commands.execute('graph.showFolder', n.path) });
      items.push(...folderItems('Folder'));
      if (n.path) items.push(revealItem(n.path), { label: 'Copy Path', run: () => copy(n.path!) });
    } else if (n.kind === 'tag') {
      items.push({ label: 'Search for This Tag', run: () => setOptions({ ...state.options, query: `tag:#${n.rel}` }) });
    } else {
      const path = n.path;
      if (n.kind === 'missing') items.push({ label: 'Create Note...', run: () => void createNote(n) });
      else {
        items.push({ label: 'Open', run: () => openNode(n, true) });
        items.push({ label: 'Open in Background', run: () => openNode(n, false) });
      }
      if (n.kind === 'note' && path) items.push({ label: 'Open Local Graph', run: () => void ctx.commands.execute('graph.showLocal', path) });
      if (n.kind !== 'missing' && path) items.push(revealItem(path));
      if (path) items.push({ label: 'Copy Path', run: () => copy(path) });
      items.push(...folderItems('Folder'));
    }
    return items;
  }

  // --- Options and follow ---------------------------------------------------------

  function setOptions(next: GraphOptions): void {
    const prev = state.options;
    state.options = next;
    shared.saveOptions(next);
    const c = classifyOptionChange(prev, next);
    if (!c.any) return;
    syncUi();
    if (c.tree && data) {
      tree = buildFolderTree(data, next.colorDepth, theme);
      folders.set(panelRoot(), state.folders);
    }
    if (c.rebuild || c.tree) {
      rebuild();
      return;
    }
    if (c.forces && curLayout === 'force' && !tween) {
      sim.setParams(simParams(), 0.4);
      simRunning = true;
    }
    if (c.radius) {
      radii = currentRadii(vg);
      sim.setRadius(radii.slice());
    }
    requestDraw();
  }

  function maybeFollow(): void {
    const s = state.scope;
    if (s.kind !== 'local' || !s.follow || !lastActive || !isMarkdownPath(lastActive) || lastActive === s.path) return;
    if (!visible) {
      pendingFollow = true;
      return;
    }
    pendingFollow = false;
    state.scope = { ...s, path: lastActive };
    syncUi();
    rebuild();
  }

  function onActiveChanged(): void {
    const ed = ctx.editors.active();
    if (!ed || ed.path === lastActive) return;
    lastActive = ed.path;
    if (state.scope.kind === 'local' && state.scope.follow && isMarkdownPath(lastActive)) {
      maybeFollow();
    } else {
      computeActive();
      if (state.options.layout !== 'force') radii = currentRadii(vg);
      requestDraw();
    }
  }

  const subs = [
    ctx.bus.on('tab:activated', onActiveChanged),
    ctx.bus.on('file:opened', onActiveChanged),
    ctx.bus.on('theme:changed', ({ theme: t }) => {
      theme = t;
      requestAnimationFrame(() => {
        if (disposed) return;
        renderer.setPalette(readPalette(root, t === 'dark'));
        if (data) {
          tree = buildFolderTree(data, state.options.colorDepth, t);
          folders.set(panelRoot(), state.folders);
          rebuild();
        }
        requestDraw();
      });
    }),
  ];

  const onIndexChanged = () => {
    if (!visible) {
      stale = true;
      return;
    }
    void load(true);
  };
  shared.onIndexChanged.add(onIndexChanged);

  // --- Size ----------------------------------------------------------------------

  const resize = () => {
    const r = body.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    width = r.width;
    height = r.height;
    renderer.resize(width, height, window.devicePixelRatio || 1);
    if (autoFit && vg.nodes.length) {
      const t = fitTarget();
      if (t) cam = t;
    }
    requestDraw();
  };
  const ro = new ResizeObserver(rafThrottle(resize));
  ro.observe(body);

  // --- Start ---------------------------------------------------------------------

  syncUi();
  resize();
  void load(false);

  if (import.meta.env.DEV) {
    // For measuring in the browser: `__graph.frames()` gives the draw times in ms.
    (window as unknown as { __graph?: unknown }).__graph = {
      frames: () => frameTimes.slice(),
      info: () => ({ nodes: vg.nodes.length, edges: vg.edges.length, zoom: cam.zoom, running: simRunning, layout: curLayout, width, height }),
      redraw: () => requestDraw(),
      drawNow: () => {
        const t0 = performance.now();
        renderer.draw({ ...frameData, cam });
        return performance.now() - t0;
      },
      setCamera: (c: Camera) => userCamera(c),
      load: () => load(false),
    };
  }

  return {
    focus() {
      canvas.focus({ preventScroll: true });
    },
    onShow() {
      visible = true;
      resize();
      if (stale) void load(true);
      if (pendingFollow) maybeFollow();
      requestDraw();
    },
    onHide() {
      visible = false;
    },
    zoom(step) {
      if (vg.nodes.length === 0) return false;
      if (step === 0) fitView(true);
      else {
        const target: Camera = { ...cam, zoom: clampZoom(cam.zoom * (step > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)) };
        if (!sameCamera(target, cam)) {
          autoFit = false;
          saveCamera();
          animateCamera(target, 140);
        }
      }
      return true;
    },
    dispose() {
      disposed = true;
      visible = false;
      cancelAnimationFrame(raf);
      clearTimeout(laterTimer);
      ro.disconnect();
      sim.dispose();
      pushSearch.cancel();
      for (const s of subs) s.dispose();
      shared.onIndexChanged.delete(onIndexChanged);
      if (running) notesCancel(running.id).catch(() => {});
      running = null;
      host.replaceChildren();
    },
  };
}

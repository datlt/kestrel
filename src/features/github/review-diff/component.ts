// The review diff component: a diff of one file with the review threads inside it.
// `index.ts` loads this file with `import()` the first time a diff is made, so
// `@codemirror/merge` stays out of the startup code.

import { EditorState, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, highlightActiveLine, lineNumbers, type DecorationSet } from '@codemirror/view';
import { forceParsing } from '@codemirror/language';
import type { Chunk, MergeView } from '@codemirror/merge';
import type { Disposable } from '../../../core/types';
import { h } from '../../../core/dom';
import { rafThrottle } from '../../../core/util';
import { Composer } from './composer';
import {
  collapsedStartAt,
  decoField,
  deletedLineNumbers,
  ghostDeco,
  itemDeco,
  lineDeco,
  plusGutter,
  setDecos,
  type ItemHost,
} from './cm-ext';
import { keyAction } from './drafts';
import { chunkLineMarks, withTrimmedChunks, type MergeModule } from './merge-tweaks';
import {
  counterpartLine,
  nextChunkIndex,
  placeLine,
  rangeLabel,
  splitThreads,
  threadRange,
  type FileKind,
  type LineChunk,
  type Place,
  type PlaceInput,
} from './placement';
import { ThreadView } from './thread-view';
import type { DiffSide, ReviewDiffHandle, ReviewDiffOptions, ReviewThread } from './types';
import './review-diff.css';

type ViewKey = 'a' | 'b';

/** Docs bigger than this are not parsed in one go. */
const FULL_PARSE_CHARS = 1_000_000;
/** No syntax colors for texts bigger than this (characters). */
const MAX_HIGHLIGHT_CHARS = 3_000_000;
/** The most lines that one multi-line mark covers. */
const MAX_RANGE_LINES = 5000;
const MIN_FONT = 8;
const MAX_FONT = 40;

let mergeModule: Promise<MergeModule> | null = null;
const loadMerge = () => (mergeModule ??= import('@codemirror/merge'));

interface Box {
  id: string;
  side: DiffSide;
  line: number;
  startLine?: number;
  composer: Composer;
  dom: HTMLElement;
}

interface Item {
  view: ViewKey;
  pos: number;
  /** Block side: 1 is after the line, a negative value is before the line. */
  side: number;
  key: string;
}

interface Drag {
  view: EditorView;
  side: DiffSide;
  anchor: number;
  current: number;
  fromPlus: boolean;
}

/** Old and new line chunks, from the chunks of the merge package. */
function toLineChunks(chunks: readonly Chunk[], docA: Text, docB: Text): LineChunk[] {
  return chunks.map((c) => {
    const aFrom = docA.lineAt(Math.min(c.fromA, docA.length)).number;
    const bFrom = docB.lineAt(Math.min(c.fromB, docB.length)).number;
    return {
      aFrom,
      aTo: c.toA <= c.fromA ? aFrom : docA.lineAt(Math.min(c.endA, docA.length)).number + 1,
      bFrom,
      bTo: c.toB <= c.fromB ? bFrom : docB.lineAt(Math.min(c.endB, docB.length)).number + 1,
    };
  });
}

/** Position in the other editor for a position at the start of a folded block (same code as the merge package). */
function mapPos(pos: number, chunks: readonly Chunk[], isA: boolean): number {
  let startOur = 0;
  let startOther = 0;
  for (let i = 0; ; i++) {
    const next = i < chunks.length ? chunks[i] : null;
    if (!next || (isA ? next.fromA : next.fromB) >= pos) return startOther + (pos - startOur);
    [startOur, startOther] = isA ? [next.toA, next.toB] : [next.toB, next.toA];
  }
}

export class ReviewDiffComponent implements ReviewDiffHandle, ItemHost {
  private root: HTMLElement;
  private outdatedHost: HTMLElement;
  private outdatedList: HTMLElement;
  private outdatedBtn: HTMLButtonElement;
  private outdatedOpen = false;
  private body: HTMLElement;
  private style: HTMLStyleElement;

  private opts: ReviewDiffOptions;
  private m: MergeModule | null = null;
  private langExt: Extension | null = null;
  private kind: FileKind;
  private merge: MergeView | null = null;
  private single: EditorView | null = null;
  private views: Partial<Record<ViewKey, EditorView>> = {};
  private lineChunks: LineChunk[] = [];
  private built = false;
  private whenBuilt: Array<() => void> = [];
  private disposed = false;
  private buildToken = 0;
  private viewGen = 0;
  private parseTimer: ReturnType<typeof setTimeout> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private lastView: EditorView | null = null;

  private threadViews = new Map<string, ThreadView>();
  private threadById = new Map<string, ReviewThread>();
  private outdatedIds = new Set<string>();
  private labels = new Map<string, string>();
  private boxes: Box[] = [];
  private boxSeq = 0;
  private htmlCache = new Map<string, string>();
  private heights = new Map<string, number>();
  private elementKeys = new Map<Element, string>();
  private ghostKeys = new Set<string>();
  private observer: ResizeObserver | null = null;
  private paneObserver: ResizeObserver | null = null;
  private rangeSig = '';

  private drag: Drag | null = null;
  private anchor: { side: DiffSide; line: number } | null = null;
  private flash: { side: DiffSide; line: number } | null = null;

  private fontSize: number | null = null;
  private subs: Disposable[] = [];
  private cleanups: Array<() => void> = [];

  constructor(
    private host: HTMLElement,
    options: ReviewDiffOptions,
  ) {
    this.opts = { ...options };
    this.kind = options.oldText == null ? 'added' : options.newText == null ? 'deleted' : 'both';

    this.outdatedBtn = h('button', { type: 'button', class: 'review-diff-outdated-btn', onclick: () => this.toggleOutdated() });
    this.outdatedList = h('div', { class: 'review-diff-outdated-list' });
    this.outdatedHost = h('div', { class: 'review-diff-outdated', hidden: true }, this.outdatedBtn, this.outdatedList);
    this.body = h('div', { class: 'review-diff-body' });
    this.style = h('style');
    this.root = h('div', { class: 'review-diff', tabindex: -1 }, this.outdatedHost, this.body, this.style);
    host.append(this.root);

    const onKey = (e: KeyboardEvent) => this.onKeyDown(e);
    this.root.addEventListener('keydown', onKey);
    this.cleanups.push(() => this.root.removeEventListener('keydown', onKey));
    this.root.addEventListener('focusin', (e) => {
      const view = [this.views.a, this.views.b].find((v) => v?.dom.contains(e.target as Node));
      if (view) this.lastView = view;
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver((entries) => this.onResize(entries));
      this.paneObserver = new ResizeObserver(() => this.updatePaneSizes());
    }

    this.subs.push(options.ctx.bus.on('theme:changed', () => this.updateCss()));
    this.updateCss();
    this.syncThreadViews();
    void this.init();
  }

  // --- Handle ----------------------------------------------------------------------------

  setThreads(threads: ReviewThread[]): void {
    this.opts.threads = threads;
    this.syncThreadViews();
    if (this.built) this.refresh();
  }

  setLayout(layout: 'split' | 'unified'): void {
    if (layout === this.opts.layout) return;
    this.opts.layout = layout;
    if (this.built) void this.build();
  }

  reveal(side: DiffSide, line: number): void {
    this.afterBuilt(() => {
      const place = this.place(side, line);
      if (!place) return;
      const view = this.views[place.view];
      if (!view) return;
      const doc = view.state.doc;
      const pos = place.kind === 'deleted' ? doc.line(Math.min(place.line, doc.lines)).from : doc.line(line > doc.lines ? doc.lines : line).from;
      this.expandAt(place.view, pos);
      this.flash = { side, line };
      this.refresh();
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      if (place.kind === 'deleted') this.flashDeleted(view, line);
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => {
        this.flash = null;
        if (!this.disposed && this.built) this.refresh();
      }, 1600);
    });
  }

  nextChange(dir: 1 | -1): boolean {
    const view = this.views.b;
    if (!this.built || this.kind !== 'both' || !view || !this.lineChunks.length) return false;
    const doc = view.state.doc;
    const starts = this.lineChunks.map((c) => doc.line(Math.min(c.bFrom, doc.lines)).from);
    const i = nextChunkIndex(starts, view.state.selection.main.head, dir);
    if (i < 0) return false;
    view.dispatch({
      selection: { anchor: starts[i] },
      effects: EditorView.scrollIntoView(starts[i], { y: 'center' }),
    });
    this.lastView = view;
    return true;
  }

  zoom(step: 1 | -1 | 0): boolean {
    if (step === 0) {
      this.fontSize = null;
      this.root.style.removeProperty('--review-diff-font-size');
    } else {
      const code = this.views.b?.contentDOM ?? this.views.a?.contentDOM ?? this.root;
      const current = this.fontSize ?? (parseFloat(getComputedStyle(code).fontSize) || 13);
      this.fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, current + step));
      this.root.style.setProperty('--review-diff-font-size', `${this.fontSize}px`);
    }
    for (const v of this.allViews()) v.requestMeasure();
    return true;
  }

  focus(): void {
    (this.lastView ?? this.views.b ?? this.views.a)?.contentDOM.focus({ preventScroll: true });
    if (!this.root.contains(document.activeElement)) this.root.focus({ preventScroll: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.parseTimer);
    clearTimeout(this.flashTimer);
    this.stopDrag();
    this.cleanups.forEach((c) => c());
    this.cleanups = [];
    this.subs.forEach((s) => s.dispose());
    this.subs = [];
    this.observer?.disconnect();
    this.paneObserver?.disconnect();
    this.destroyViews();
    for (const tv of this.threadViews.values()) tv.dispose();
    this.threadViews.clear();
    for (const b of this.boxes) b.dom.remove();
    this.boxes = [];
    this.root.remove();
  }

  // --- ItemHost: the DOM of threads and boxes ---------------------------------------------

  dom(key: string): HTMLElement {
    if (key.startsWith('t:')) {
      const tv = this.threadView(key.slice(2));
      tv?.ensureRendered();
      const el = tv?.dom ?? h('div');
      this.observe(key, el);
      return el;
    }
    const box = this.boxes.find((b) => `b:${b.id}` === key);
    const el = box?.dom ?? h('div');
    this.observe(key, el);
    return el;
  }

  height(key: string): number {
    return this.heights.get(key) ?? (key.startsWith('b:') ? 130 : 110);
  }

  private observe(key: string, el: HTMLElement): void {
    if (this.elementKeys.get(el) === key) return;
    this.elementKeys.set(el, key);
    this.observer?.observe(el);
  }

  private onResize(entries: ResizeObserverEntry[]): void {
    let ghostChanged = false;
    for (const e of entries) {
      const key = this.elementKeys.get(e.target);
      if (!key) continue;
      const height = Math.round(e.target.getBoundingClientRect().height);
      if (height === 0) continue;
      const old = this.heights.get(key);
      this.heights.set(key, height);
      if (this.ghostKeys.has(key) && (old == null || Math.abs(old - height) >= 1)) ghostChanged = true;
    }
    if (ghostChanged) this.scheduleRefresh();
  }

  private scheduleRefresh = rafThrottle(() => {
    if (!this.disposed && this.built) this.refresh();
  });

  // --- Setup -----------------------------------------------------------------------------

  private updateCss(): void {
    this.style.textContent = this.opts.ctx.editors.highlightCss();
  }

  private afterBuilt(fn: () => void): void {
    if (this.built) fn();
    else this.whenBuilt.push(fn);
  }

  private async init(): Promise<void> {
    const { ctx, path, oldText, newText } = this.opts;
    const big = Math.max(oldText?.length ?? 0, newText?.length ?? 0) > MAX_HIGHLIGHT_CHARS;
    try {
      const [m, lang] = await Promise.all([
        loadMerge(),
        big ? null : ctx.editors.loadLanguage(ctx.editors.languageIdFor(path)).catch(() => null),
      ]);
      if (this.disposed) return;
      this.m = m;
      this.langExt = lang?.extension ?? null;
      await this.build();
    } catch (e) {
      if (this.disposed) return;
      this.body.replaceChildren(h('div', { class: 'review-diff-message' }, e instanceof Error ? e.message : String(e)));
    }
  }

  private allViews(): EditorView[] {
    return [this.views.a, this.views.b].filter((v): v is EditorView => !!v);
  }

  private destroyViews(): void {
    this.viewGen++;
    clearTimeout(this.parseTimer);
    this.paneObserver?.disconnect();
    this.merge?.destroy();
    this.single?.destroy();
    this.merge = null;
    this.single = null;
    this.views = {};
    this.lastView = null;
  }

  private scroller(): HTMLElement | null {
    return this.merge?.dom ?? this.single?.scrollDOM ?? null;
  }

  /** The editor extensions that both sides share. `viewKey` tells the side of the editor. */
  private commonExtensions(m: MergeModule, viewKey: ViewKey, unified: boolean): Extension[] {
    const { ctx, canComment } = this.opts;
    const ext: Extension[] = [
      EditorState.phrases.of({ '$ unchanged lines': 'Show $ unchanged lines' }),
      chunkLineMarks(m),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      ctx.editors.highlightExtension(),
      decoField,
      highlightActiveLine(),
      EditorView.domEventHandlers({
        mousedown: (e, view) => {
          this.lastView = view;
          if ((e.target as HTMLElement).closest?.('.review-diff-slot, .cm-gutters, .cm-deletedChunk')) return;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
          view.dispatch({ selection: { anchor: pos } });
        },
      }),
    ];
    const side: DiffSide = viewKey === 'a' ? 'LEFT' : 'RIGHT';
    const down = (view: EditorView, line: number, e: MouseEvent, fromPlus: boolean) =>
      this.startDrag(view, side, line, e, fromPlus);
    if (canComment) {
      ext.push(plusGutter(down));
      ext.push(lineNumbers({ domEventHandlers: { mousedown: (view, line, e) => (down(view, view.state.doc.lineAt(line.from).number, e as MouseEvent, false), true) } }));
    } else {
      ext.push(lineNumbers());
    }
    if (unified) {
      ext.push(
        deletedLineNumbers({
          firstOldLine: (view, pos) => {
            const info = m.getChunks(view.state);
            const c = info?.chunks.find((x) => x.fromB === pos);
            const orig = m.getOriginalDoc(view.state);
            return c ? orig.lineAt(Math.min(c.fromA, orig.length)).number : null;
          },
          onDown: canComment ? (view, line, e, fromPlus) => this.startDrag(view, 'LEFT', line, e, fromPlus) : null,
          onNumberDown: (view, line, e) => {
            if (canComment) this.startDrag(view, 'LEFT', line, e, false);
          },
        }),
      );
    }
    if (this.langExt) ext.push(this.langExt);
    return ext;
  }

  /** Makes the editors. Keeps the scroll position when it can. */
  private async build(): Promise<void> {
    const m = this.m;
    if (!m || this.disposed) return;
    const token = ++this.buildToken;
    const keepScroll = this.scroller()?.scrollTop ?? 0;
    this.built = false;
    this.stopDrag();
    this.destroyViews();
    this.body.replaceChildren();
    const { oldText, newText, layout } = this.opts;
    const collapse = { margin: 3, minSize: 4 };
    const diffConfig = { scanLimit: 1000, timeout: 1000 };
    this.body.classList.toggle('review-diff-only-add', this.kind === 'added');
    this.body.classList.toggle('review-diff-only-del', this.kind === 'deleted');

    if (this.kind === 'added' || this.kind === 'deleted') {
      const key: ViewKey = this.kind === 'added' ? 'b' : 'a';
      const doc = (this.kind === 'added' ? newText : oldText) ?? '';
      const view = new EditorView({
        parent: this.body,
        state: EditorState.create({ doc, extensions: this.commonExtensions(m, key, false) }),
      });
      this.single = view;
      this.views[key] = view;
      this.lineChunks = [];
      this.warmParsing([view], view.scrollDOM);
    } else if (layout === 'split') {
      const mv = withTrimmedChunks(
        m,
        () =>
          new m.MergeView({
            a: { doc: oldText ?? '', extensions: this.commonExtensions(m, 'a', false) },
            b: { doc: newText ?? '', extensions: this.commonExtensions(m, 'b', false) },
            parent: this.body,
            gutter: true,
            highlightChanges: true,
            collapseUnchanged: collapse,
            diffConfig,
          }),
      );
      this.merge = mv;
      this.views = { a: mv.a, b: mv.b };
      this.lineChunks = toLineChunks(mv.chunks, mv.a.state.doc, mv.b.state.doc);
      this.warmParsing([mv.a, mv.b], mv.dom);
    } else {
      const state = withTrimmedChunks(m, () =>
        EditorState.create({
          doc: newText ?? '',
          extensions: [
            ...this.commonExtensions(m, 'b', true),
            m.unifiedMergeView({
              original: oldText ?? '',
              gutter: true,
              mergeControls: false,
              highlightChanges: true,
              collapseUnchanged: collapse,
              diffConfig,
            }),
          ],
        }),
      );
      const view = new EditorView({ parent: this.body, state });
      this.single = view;
      this.views = { b: view };
      this.lineChunks = toLineChunks(m.getChunks(state)?.chunks ?? [], m.getOriginalDoc(state), state.doc);
      this.warmParsing([view], view.scrollDOM);
    }
    if (token !== this.buildToken) return;
    this.built = true;
    this.heightsStale();
    for (const v of this.allViews()) {
      this.paneObserver?.observe(v.dom);
      const g = v.dom.querySelector('.cm-gutters');
      if (g) this.paneObserver?.observe(g);
    }
    this.updatePaneSizes();
    this.refresh();
    const sc = this.scroller();
    if (sc && keepScroll) sc.scrollTop = keepScroll;
    const queued = this.whenBuilt;
    this.whenBuilt = [];
    queued.forEach((fn) => fn());
  }

  /**
   * Widgets are as wide as the visible part of the editor, and stay at the left edge
   * while the code scrolls sideways. The CSS reads these two variables.
   */
  private updatePaneSizes(): void {
    for (const v of this.allViews()) {
      const gutters = v.dom.querySelector<HTMLElement>('.cm-gutters');
      const gw = gutters?.offsetWidth ?? 0;
      const visible = Math.min(v.dom.clientWidth, v.scrollDOM.clientWidth || v.dom.clientWidth);
      v.dom.style.setProperty('--review-diff-gutter-w', `${gw}px`);
      v.dom.style.setProperty('--review-diff-pane-w', `${Math.max(120, visible - gw)}px`);
    }
  }

  /** Heights of old editors are not valid for the new layout. */
  private heightsStale(): void {
    this.ghostKeys.clear();
  }

  /**
   * Parses the whole file in small steps, and ahead of the viewport on scroll. The two
   * editors of a split diff sit in one outer scroll box, so each editor alone would parse
   * only a part of its text.
   */
  private warmParsing(views: EditorView[], scroller: HTMLElement): void {
    const gen = this.viewGen;
    const step = () => {
      if (this.disposed || gen !== this.viewGen) return;
      let done = true;
      for (const v of views) {
        const len = v.state.doc.length;
        if (len < FULL_PARSE_CHARS && !forceParsing(v, len, 30)) done = false;
      }
      if (!done) this.parseTimer = setTimeout(step, 10);
    };
    step();
    const onScroll = rafThrottle(() => {
      if (this.disposed || gen !== this.viewGen) return;
      for (const v of views) {
        v.requestMeasure();
        forceParsing(v, Math.min(v.state.doc.length, v.viewport.to + 20_000), 15);
      }
    });
    scroller.addEventListener('scroll', onScroll, { passive: true });
  }

  // --- Threads ---------------------------------------------------------------------------

  private placeInput(): PlaceInput {
    const a = this.views.a?.state.doc.lines ?? this.opts.oldText?.split('\n').length ?? 0;
    const b = this.views.b?.state.doc.lines ?? this.opts.newText?.split('\n').length ?? 0;
    return { layout: this.opts.layout, kind: this.kind, chunks: this.lineChunks, linesA: a, linesB: b };
  }

  private place(side: DiffSide, line: number): Place | null {
    return placeLine(this.placeInput(), side, line);
  }

  private threadView(id: string): ThreadView | null {
    let tv = this.threadViews.get(id);
    if (tv) return tv;
    const thread = this.threadById.get(id);
    if (!thread) return null;
    tv = new ThreadView(thread, {
      opts: this.opts,
      htmlCache: this.htmlCache,
      onChange: () => this.onItemChange(),
      locationLabel: (t) => this.labels.get(t.id) ?? '',
    });
    this.threadViews.set(id, tv);
    return tv;
  }

  /** Updates the thread elements that exist. New ones are made when a widget needs them. */
  private syncThreadViews(): void {
    this.threadById = new Map(this.opts.threads.map((t) => [t.id, t]));
    for (const [id, tv] of [...this.threadViews]) {
      const t = this.threadById.get(id);
      if (!t) {
        tv.dispose();
        this.threadViews.delete(id);
      } else {
        tv.update(t);
      }
    }
  }

  private onItemChange = rafThrottle(() => {
    if (this.disposed || !this.built) return;
    for (const v of this.allViews()) v.requestMeasure();
    if (this.rangeSignature() !== this.rangeSig) this.refresh();
  });

  private labelFor(t: ReviewThread, listed: boolean): string {
    if (listed) return t.line > 0 ? rangeLabel(t.side, t.line, t.startLine) : 'This line is not in the diff any more.';
    if (this.opts.layout === 'unified' && t.side === 'LEFT') return rangeLabel('LEFT', t.line, t.startLine);
    return '';
  }

  /** Maps a side and a line to the editor, and tells if a line mark applies there. */
  private viewForSide(side: DiffSide): ViewKey | null {
    if (this.kind === 'added') return side === 'RIGHT' ? 'b' : null;
    if (this.kind === 'deleted') return side === 'LEFT' ? 'a' : null;
    if (this.opts.layout === 'split') return side === 'LEFT' ? 'a' : 'b';
    return side === 'RIGHT' ? 'b' : null;
  }

  private ranges(): Array<{ side: DiffSide; from: number; to: number; cls: string }> {
    const out: Array<{ side: DiffSide; from: number; to: number; cls: string }> = [];
    for (const t of this.opts.threads) {
      if (this.outdatedIds.has(t.id)) continue;
      const r = threadRange(t);
      if (r && (this.threadViews.get(t.id)?.isOpen() ?? !t.resolved)) out.push({ side: t.side, ...r, cls: 'review-diff-range' });
    }
    for (const b of this.boxes) {
      const r = threadRange({ line: b.line, startLine: b.startLine });
      if (r) out.push({ side: b.side, ...r, cls: 'review-diff-range' });
    }
    if (this.drag && this.drag.anchor !== this.drag.current) {
      out.push({
        side: this.drag.side,
        from: Math.min(this.drag.anchor, this.drag.current),
        to: Math.max(this.drag.anchor, this.drag.current),
        cls: 'review-diff-range review-diff-range-drag',
      });
    }
    if (this.flash) out.push({ side: this.flash.side, from: this.flash.line, to: this.flash.line, cls: 'review-diff-flash' });
    return out;
  }

  private rangeSignature(): string {
    return JSON.stringify(this.ranges());
  }

  /** Opens a folded block of unchanged lines when it hides `pos`. */
  private expandAt(key: ViewKey, pos: number): void {
    const view = this.views[key];
    const m = this.m;
    if (!view || !m) return;
    const from = collapsedStartAt(view, pos);
    if (from == null) return;
    view.dispatch({ effects: m.uncollapseUnchanged.of(from) });
    if (this.merge) {
      const other = key === 'a' ? this.merge.b : this.merge.a;
      other.dispatch({ effects: m.uncollapseUnchanged.of(mapPos(from, this.merge.chunks, key === 'a')) });
    }
  }

  /** Builds the widgets and the line marks of both editors again. The scroll position stays. */
  private refresh(): void {
    if (!this.built || this.disposed) return;
    const { threads } = this.opts;
    const input = this.placeInput();
    const { placed, outdated } = splitThreads(threads, (t) => placeLine(input, t.side, t.line));
    this.outdatedIds = new Set(outdated.map((t) => t.id));

    // Labels depend on the layout and the list, so draw the threads again when one changed.
    const wanted = new Map<string, string>();
    for (const t of threads) wanted.set(t.id, this.labelFor(t, this.outdatedIds.has(t.id)));
    const changed = threads.filter((t) => this.labels.get(t.id) !== wanted.get(t.id));
    this.labels = wanted;
    for (const t of changed) this.threadViews.get(t.id)?.update(t);

    const items: Item[] = [];
    const ghosts: Array<{ view: ViewKey; pos: number; key: string }> = [];
    this.ghostKeys = new Set();
    const addItem = (key: string, side: DiffSide, line: number, p: Place) => {
      const view = this.views[p.view];
      if (!view) return;
      const doc = view.state.doc;
      if (p.kind === 'deleted') {
        items.push({ view: p.view, pos: doc.line(Math.min(p.line, doc.lines)).from, side: -0.5, key });
        return;
      }
      items.push({ view: p.view, pos: doc.line(p.line).to, side: 1, key });
      // Split layout: keep the other side the same height when the line is the same on both sides.
      if (this.merge && this.kind === 'both') {
        const cl = counterpartLine(this.lineChunks, side, line);
        const otherKey: ViewKey = p.view === 'a' ? 'b' : 'a';
        const other = this.views[otherKey];
        if (cl && other && cl <= other.state.doc.lines) {
          ghosts.push({ view: otherKey, pos: other.state.doc.line(cl).to, key });
          this.ghostKeys.add(key);
        }
      }
    };
    for (const { thread, place } of placed) addItem(`t:${thread.id}`, thread.side, thread.line, place);
    for (const b of this.boxes) {
      const p = this.place(b.side, b.line);
      if (p) addItem(`b:${b.id}`, b.side, b.line, p);
    }

    for (const it of items) {
      const doc = this.views[it.view]?.state.doc;
      if (doc) this.expandAt(it.view, it.pos);
    }

    this.renderOutdated(outdated);

    // Line marks.
    const perView: Record<ViewKey, Array<ReturnType<Decoration['range']>>> = { a: [], b: [] };
    for (const r of this.ranges()) {
      const key = this.viewForSide(r.side);
      const view = key && this.views[key];
      if (!key || !view) continue;
      const doc = view.state.doc;
      const to = Math.min(r.to, doc.lines, r.from + MAX_RANGE_LINES);
      for (let n = Math.max(1, r.from); n <= to; n++) perView[key].push(lineDeco(r.cls).range(doc.line(n).from));
    }
    for (const it of items) perView[it.view].push(itemDeco(it.key, this, it.side).range(it.pos));
    for (const g of ghosts) perView[g.view].push(ghostDeco(g.key, this.heights.get(g.key) ?? this.height(g.key)).range(g.pos));
    this.rangeSig = this.rangeSignature();

    const scroller = this.scroller();
    const top = scroller?.scrollTop ?? 0;
    for (const key of ['a', 'b'] as const) {
      const view = this.views[key];
      if (!view) continue;
      const set: DecorationSet = Decoration.set(perView[key], true);
      view.dispatch({ effects: setDecos.of(set) });
    }
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
  }

  // --- Outdated list ---------------------------------------------------------------------

  private toggleOutdated(): void {
    this.outdatedOpen = !this.outdatedOpen;
    this.refresh();
  }

  private renderOutdated(list: ReviewThread[]): void {
    this.outdatedHost.hidden = list.length === 0;
    this.outdatedBtn.textContent = `${this.outdatedOpen ? '▾' : '▸'} Outdated comments (${list.length})`;
    this.outdatedBtn.setAttribute('aria-expanded', String(this.outdatedOpen));
    this.outdatedList.hidden = !this.outdatedOpen;
    if (!this.outdatedOpen) {
      this.outdatedList.replaceChildren();
      return;
    }
    const els: HTMLElement[] = [];
    for (const t of list) {
      const tv = this.threadView(t.id);
      if (!tv) continue;
      tv.ensureRendered();
      els.push(tv.dom);
    }
    this.outdatedList.replaceChildren(...els);
  }

  // --- New comments ----------------------------------------------------------------------

  private openBox(side: DiffSide, line: number, startLine?: number): void {
    if (!this.opts.canComment || !this.built) return;
    if (!this.place(side, line)) return;
    const start = startLine && startLine < line ? startLine : undefined;
    const same = this.boxes.find((b) => b.side === side && b.line === line && b.startLine === start);
    if (same) {
      same.composer.focus();
      return;
    }
    const id = String(++this.boxSeq);
    const send = async (mode: 'review' | 'now', body: string) => {
      await this.opts.onAddComment({ side, line, ...(start ? { startLine: start } : {}), body, mode });
      this.closeBox(id);
    };
    const composer = new Composer({
      placeholder: 'Leave a comment',
      buttons: [
        { id: 'review', label: 'Add to Review', primary: true },
        { id: 'now', label: 'Comment Now' },
      ],
      onSubmit: (btn, body) => send(btn === 'now' ? 'now' : 'review', body),
      onCancel: () => this.closeBox(id),
      onResize: () => this.onItemChange(),
    });
    const dom = h(
      'div',
      { class: 'review-diff-box' },
      h('div', { class: 'review-diff-box-title' }, rangeLabel(side, line, start)),
      composer.dom,
    );
    this.boxes.push({ id, side, line, startLine: start, composer, dom });
    this.refresh();
    requestAnimationFrame(() => {
      if (this.disposed) return;
      dom.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      composer.focus();
    });
  }

  private closeBox(id: string): void {
    const i = this.boxes.findIndex((b) => b.id === id);
    if (i < 0) return;
    const [b] = this.boxes.splice(i, 1);
    b.dom.remove();
    this.elementKeys.delete(b.dom);
    this.observer?.unobserve(b.dom);
    this.heights.delete(`b:${id}`);
    if (this.built && !this.disposed) this.refresh();
    this.root.focus({ preventScroll: true });
  }

  /** Line of the cursor, for the `c` key. */
  private cursorTarget(): { side: DiffSide; line: number } | null {
    const view = this.lastView ?? this.views.b ?? this.views.a;
    if (!view) return null;
    const side: DiffSide = view === this.views.a ? 'LEFT' : 'RIGHT';
    const doc = view.state.doc;
    let head = view.state.selection.main.head;
    if (head === 0 && (this.scroller()?.scrollTop ?? 0) > 0) {
      const r = view.dom.getBoundingClientRect();
      const top = Math.max(r.top, this.body.getBoundingClientRect().top);
      head = view.posAtCoords({ x: r.left + 80, y: top + 8 }, false);
    }
    return { side, line: doc.lineAt(head).number };
  }

  // --- Mouse: select lines ---------------------------------------------------------------

  private startDrag(view: EditorView, side: DiffSide, line: number, e: MouseEvent, fromPlus: boolean): void {
    if (!this.opts.canComment || e.button !== 0) return;
    e.preventDefault();
    if (e.shiftKey && this.anchor && this.anchor.side === side && this.anchor.line !== line) {
      const lo = Math.min(this.anchor.line, line);
      const hi = Math.max(this.anchor.line, line);
      this.openBox(side, hi, lo);
      return;
    }
    this.anchor = { side, line };
    this.drag = { view, side, anchor: line, current: line, fromPlus };
    this.root.classList.add('review-diff-dragging');
    document.addEventListener('mousemove', this.onDragMove);
    document.addEventListener('mouseup', this.onDragEnd);
  }

  private stopDrag(): void {
    document.removeEventListener('mousemove', this.onDragMove);
    document.removeEventListener('mouseup', this.onDragEnd);
    this.root.classList.remove('review-diff-dragging');
    this.drag = null;
  }

  private onDragMove = (e: MouseEvent): void => {
    const d = this.drag;
    if (!d) return;
    const hit = this.hitTest(d.view, e);
    if (hit && hit.side === d.side && hit.line !== d.current) {
      d.current = hit.line;
      this.refresh();
    }
  };

  private onDragEnd = (e: MouseEvent): void => {
    const d = this.drag;
    if (!d) return;
    const hit = this.hitTest(d.view, e);
    if (hit && hit.side === d.side) d.current = hit.line;
    this.stopDrag();
    if (d.current === d.anchor) {
      if (d.fromPlus) this.openBox(d.side, d.anchor);
      else this.refresh();
      return;
    }
    this.openBox(d.side, Math.max(d.anchor, d.current), Math.min(d.anchor, d.current));
  };

  /** The side and the line under the mouse, for the editor where the drag began. */
  private hitTest(view: EditorView, e: MouseEvent): { side: DiffSide; line: number } | null {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const del = el?.closest<HTMLElement>('.cm-deletedLine[data-old-line]');
    if (del && view.dom.contains(del)) return { side: 'LEFT', line: Number(del.dataset.oldLine) };
    const r = view.contentDOM.getBoundingClientRect();
    const pos = view.posAtCoords({ x: r.left + 8, y: e.clientY }, false);
    const side: DiffSide = view === this.views.a ? 'LEFT' : 'RIGHT';
    return { side, line: view.state.doc.lineAt(pos).number };
  }

  /** Flash for a line inside the deleted block of the unified layout. */
  private flashDeleted(view: EditorView, oldLine: number): void {
    requestAnimationFrame(() => {
      const el = view.dom.querySelector<HTMLElement>(`.cm-deletedLine[data-old-line="${oldLine}"]`);
      if (!el) return;
      el.classList.add('review-diff-flash');
      setTimeout(() => el.classList.remove('review-diff-flash'), 1600);
    });
  }

  // --- Keys ------------------------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    const inEditable = !!t?.closest('textarea, input, select, [contenteditable="true"]');
    const action = keyAction(
      { key: e.key, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, inEditable },
      this.opts.canComment,
    );
    if (!action) return;
    if (action === 'next' || action === 'prev') {
      e.preventDefault();
      this.nextChange(action === 'next' ? 1 : -1);
    } else if (action === 'comment') {
      const target = this.cursorTarget();
      if (target) {
        e.preventDefault();
        this.openBox(target.side, target.line);
      }
    } else if (action === 'escape') {
      const empty = [...this.boxes].reverse().find((b) => b.composer.isEmpty() && !b.composer.isBusy());
      if (empty) {
        e.preventDefault();
        this.closeBox(empty.id);
      }
    }
  }
}

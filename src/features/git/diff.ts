// Diff tab: base text on the left, working tree text on the right.
// `@codemirror/merge` loads the first time a diff opens. This whole file loads
// with `import()` when the first diff tab is created (see `diff-tab.ts`).

import { EditorState, RangeSetBuilder, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, lineNumbers, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { forceParsing } from '@codemirror/language';
import { createElement, ArrowDown, ArrowUp, ChevronsDownUp, Columns2, ExternalLink, RefreshCw, Rows2 } from 'lucide';
import type { Change, MergeView } from '@codemirror/merge';
import type { AppContext, Disposable, TabContent } from '../../core/types';
import { h } from '../../core/dom';
import { basename, rafThrottle } from '../../core/util';
import { fsReadFile } from '../../ipc/fs';
import { gitShow, type GitShowResult } from '../../ipc/git';
import { isIpcError } from '../../ipc/invoke';
import { loadMerge, type DiffParams } from './diff-tab';
import type { GitService } from './service';
import './git.css';

type Mode = 'split' | 'unified';

const MODE_KEY = 'git.diffMode';
const COLLAPSE_KEY = 'git.diffCollapse';

export interface DiffData {
  left: string;
  right: string;
  /** Message instead of a diff (binary, too large). */
  message: string | null;
  note: string | null;
  leftExists: boolean;
  rightExists: boolean;
  large: boolean;
}


type MergeModule = typeof import('@codemirror/merge');

/** Docs bigger than this are not parsed in one go. */
const FULL_PARSE_CHARS = 1_000_000;

export const changeCount = (n: number) => (n === 0 ? 'No changes' : n === 1 ? '1 change' : `${n} changes`);

/** True when the range starts at a line start and ends at a line end. */
function coversWholeLines(doc: Text, from: number, to: number): boolean {
  const starts = from === doc.lineAt(from).from || doc.sliceString(from, from + 1) === '\n';
  const ends = to >= doc.length || doc.sliceString(to, to + 1) === '\n' || doc.sliceString(to - 1, to) === '\n';
  return starts && ends;
}

/**
 * Removes the inline changes of lines that are fully added or fully deleted.
 * The merge view draws a strong mark for each inline change. A new or deleted
 * line must only get the line background. Changes inside modified lines stay.
 */
function trimChunk(chunk: InstanceType<MergeModule['Chunk']>, a: Text, b: Text): void {
  const pure = chunk.fromA === chunk.toA || chunk.fromB === chunk.toB;
  const keep = pure
    ? []
    : chunk.changes.filter((ch: Change) => {
        if (ch.fromA === ch.toA) return !coversWholeLines(b, chunk.fromB + ch.fromB, chunk.fromB + ch.toB);
        if (ch.fromB === ch.toB) return !coversWholeLines(a, chunk.fromA + ch.fromA, chunk.fromA + ch.toA);
        return true;
      });
  if (keep.length !== chunk.changes.length) (chunk as unknown as { changes: readonly Change[] }).changes = keep;
}

/**
 * Runs `fn` (which creates a merge view or a unified state) while
 * `Chunk.build` removes the inline changes of whole added or deleted lines.
 * The merge package has no option for this, and it builds the chunks inside
 * its constructors. The patch lasts only for the synchronous call.
 */
function withTrimmedChunks<T>(m: MergeModule, fn: () => T): T {
  const original = m.Chunk.build;
  m.Chunk.build = (a, b, conf) => {
    const chunks = original.call(m.Chunk, a, b, conf);
    for (const c of chunks) trimChunk(c, a, b);
    return chunks;
  };
  try {
    return fn();
  } finally {
    m.Chunk.build = original;
  }
}

/**
 * Gives every line of a changed chunk a line background of our own. The merge
 * package can miss a deleted last line (for example an empty last line).
 */
function chunkLineMarks(m: MergeModule): Extension {
  const build = (view: EditorView): DecorationSet => {
    const info = m.getChunks(view.state);
    const builder = new RangeSetBuilder<Decoration>();
    if (!info) return builder.finish();
    const isA = info.side === 'a';
    const deco = Decoration.line({ class: isA ? 'git-line-del' : 'git-line-add' });
    const doc = view.state.doc;
    const { from: vFrom, to: vTo } = view.viewport;
    let last = 0;
    for (const c of info.chunks) {
      const from = isA ? c.fromA : c.fromB;
      const end = Math.min(isA ? c.endA : c.endB, doc.length);
      if (from === (isA ? c.toA : c.toB) || from > doc.length) continue;
      if (from > vTo) break;
      if (end < vFrom) continue;
      for (let n = Math.max(doc.lineAt(from).number, last + 1); n <= doc.lineAt(end).number; n++) {
        const line = doc.line(n);
        if (line.to < vFrom || line.from > vTo) continue;
        builder.add(line.from, line.from, deco);
        last = n;
      }
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      deco: DecorationSet;
      constructor(view: EditorView) {
        this.deco = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || m.getChunks(u.startState)?.chunks !== m.getChunks(u.state)?.chunks)
          this.deco = build(u.view);
      }
    },
    { decorations: (v) => v.deco },
  );
}

const icon = (node: Parameters<typeof createElement>[0]) => createElement(node);

export interface DiffOptions {
  /**
   * Replaces the default data source (base vs working tree). The history tab
   * uses it to show one commit. In this mode the diff does not watch files.
   */
  loader?: () => Promise<DiffData>;
}

/** Builds `DiffData` from two texts read with `gitShow` or the file system. */
export function makeDiffData(
  ctx: AppContext,
  left: GitShowResult,
  right: { text: string; exists: boolean; binary: boolean; tooLarge: boolean; size: number },
  note: string | null,
): DiffData {
  const maxMB = ctx.settings.get('editor.maxFileMB');
  const largeMB = ctx.settings.get('editor.largeFileMB');
  const large = Math.max(left.size, right.size) > largeMB * 1024 * 1024;
  let message: string | null = null;
  if (left.binary || right.binary) message = 'Binary file: no text diff.';
  else if (left.tooLarge || right.tooLarge) message = `The file is bigger than ${maxMB} MB. Open it in the editor.`;
  return { left: left.text, right: right.text, message, note, leftExists: left.exists, rightExists: right.exists, large };
}

export class DiffContent implements TabContent {
  private root: HTMLElement;
  private body: HTMLElement;
  private info: HTMLElement;
  private btnMode: HTMLButtonElement;
  private btnCollapse: HTMLButtonElement;
  private btnOpen: HTMLButtonElement;
  private nameEl: HTMLElement;
  private style: HTMLStyleElement;

  private mode: Mode;
  private collapse: boolean;
  private merge: MergeView | null = null;
  private single: EditorView | null = null;
  private data: DiffData | null = null;
  private token = 0;
  private disposed = false;
  private visible = true;
  private stale = false;
  private subs: Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private parseTimer: ReturnType<typeof setTimeout> | undefined;
  /** Changes each time the editors are rebuilt. Old timers see it and stop. */
  private viewGen = 0;

  constructor(
    private ctx: AppContext,
    private svc: GitService,
    private p: DiffParams,
    host: HTMLElement,
    private opts: DiffOptions = {},
  ) {
    this.mode = ctx.workspace.globalState.get<Mode>(MODE_KEY) === 'unified' ? 'unified' : 'split';
    this.collapse = ctx.workspace.globalState.get<boolean>(COLLAPSE_KEY) ?? true;

    const btn = (title: string, node: Parameters<typeof createElement>[0], onclick: () => void) =>
      h('button', { class: 'git-btn', title, type: 'button', onclick }, icon(node));
    this.info = h('span', { class: 'git-diff-info' });
    this.btnMode = btn('Switch side by side / unified', Columns2, () => this.toggleMode());
    this.btnCollapse = btn('Collapse unchanged lines', ChevronsDownUp, () => this.toggleCollapse());
    this.btnOpen = btn('Open file', ExternalLink, () => void ctx.editors.openFile(p.path));
    this.nameEl = h('span', { class: 'git-diff-name', title: p.path }, basename(p.path));
    const toolbar = h(
      'div',
      { class: 'git-diff-toolbar' },
      this.nameEl,
      this.info,
      h('span', { class: 'git-spacer' }),
      btn('Previous change (Shift-Alt-F5)', ArrowUp, () => this.go(-1)),
      btn('Next change (Alt-F5)', ArrowDown, () => this.go(1)),
      this.btnCollapse,
      this.btnMode,
      btn('Refresh', RefreshCw, () => void this.load()),
      this.btnOpen,
    );
    this.body = h('div', { class: 'git-diff-body' });
    this.style = h('style');
    this.root = h('div', { class: 'git-diff' }, toolbar, this.body, this.style);
    host.append(this.root);
    if (opts.loader) this.btnOpen.style.display = 'none';
    this.updateButtons();

    const sameFile = (path: string) => path === p.path || path.replace(/\\/g, '/') === p.path.replace(/\\/g, '/');
    this.subs.push(ctx.bus.on('theme:changed', () => this.updateCss()));
    if (!opts.loader) {
      this.subs.push(
        ctx.bus.on('file:saved', (e) => sameFile(e.path) && this.requestRefresh()),
        ctx.bus.on('fs:changed', (e) => (e.gitChanged || e.rescan || e.paths.some(sameFile)) && this.requestRefresh()),
      );
    }
    this.updateCss();
    void this.load();
  }

  private updateCss() {
    // Colors of the `tok-*` classes for the current theme.
    this.style.textContent = this.ctx.editors.highlightCss();
  }

  focus(): void {
    (this.single ?? this.merge?.b)?.focus();
  }

  onShow(): void {
    this.visible = true;
    if (this.stale) void this.load();
    else this.merge?.b.requestMeasure();
  }

  onHide(): void {
    this.visible = false;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.parseTimer);
    this.subs.forEach((s) => s.dispose());
    this.destroyViews();
    this.root.remove();
  }

  private requestRefresh() {
    this.stale = true;
    if (!this.visible) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.load(), 300);
  }

  private updateButtons() {
    this.btnMode.replaceChildren(icon(this.mode === 'split' ? Rows2 : Columns2));
    this.btnMode.title = this.mode === 'split' ? 'Show unified diff' : 'Show side by side diff';
    this.btnCollapse.classList.toggle('git-btn-on', this.collapse);
    this.btnCollapse.title = this.collapse ? 'Show unchanged lines' : 'Collapse unchanged lines';
    this.btnOpen.disabled = !!this.data && !this.data.rightExists;
  }

  private toggleMode() {
    this.mode = this.mode === 'split' ? 'unified' : 'split';
    this.ctx.workspace.globalState.set(MODE_KEY, this.mode);
    this.updateButtons();
    void this.render();
  }

  private toggleCollapse() {
    this.collapse = !this.collapse;
    this.ctx.workspace.globalState.set(COLLAPSE_KEY, this.collapse);
    this.updateButtons();
    void this.render();
  }

  private async fetchData(): Promise<DiffData> {
    if (this.opts.loader) return this.opts.loader();
    const { ctx, svc, p } = this;
    const maxBytes = ctx.settings.get('editor.maxFileMB') * 1024 * 1024;
    const top = await svc.topLevel();
    const root = ctx.workspace.root;
    const rel = top ? svc.toRel(p.path, top) : null;
    if (!root || !rel) throw new Error('This file is not inside a git repository.');

    const rev = await svc.resolveBase(p.base);
    const left = await gitShow(root, rev, p.origPath ?? rel, maxBytes);

    let right = { text: '', exists: true, binary: false, tooLarge: false, size: 0 };
    const open = ctx.editors.get(p.path);
    if (open) {
      const text = open.getText();
      right = { text, exists: true, binary: false, tooLarge: false, size: text.length };
    } else {
      try {
        const r = await fsReadFile(p.path, { maxBytes });
        right = { text: r.text, exists: true, binary: r.binary, tooLarge: r.tooLarge, size: r.size };
      } catch (e) {
        if (!isIpcError(e, 'not_found')) throw e;
        right.exists = false;
      }
    }
    let note: string | null = null;
    if (!left.exists && right.exists) note = p.base === 'HEAD' ? 'New file' : `New file (not in ${p.base})`;
    else if (left.exists && !right.exists) note = 'Deleted file';
    else if (p.origPath) note = `Renamed from ${p.origPath}`;
    else if (!left.exists && !right.exists) note = 'File does not exist';
    return makeDiffData(ctx, left, right, note);
  }

  /** Changes the file name in the toolbar. */
  setName(text: string, title = text): void {
    this.nameEl.textContent = text;
    this.nameEl.title = title;
  }

  /** Shows another source (history tab). */
  setLoader(loader: () => Promise<DiffData>): Promise<void> {
    this.opts = { ...this.opts, loader };
    return this.load();
  }

  private destroyViews() {
    this.viewGen++;
    clearTimeout(this.parseTimer);
    this.merge?.destroy();
    this.single?.destroy();
    this.merge = null;
    this.single = null;
  }

  async load(): Promise<void> {
    const token = ++this.token;
    this.stale = false;
    try {
      const data = await this.fetchData();
      if (this.disposed || token !== this.token) return;
      this.data = data;
      await this.render();
    } catch (e) {
      if (this.disposed || token !== this.token) return;
      this.destroyViews();
      this.body.replaceChildren(h('div', { class: 'git-diff-message' }, e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * Both editors sit in one outer scroll box, so CodeMirror only parses near
   * its own idea of the viewport. We parse the whole file at start (in small
   * steps, so the UI stays free) and parse ahead of the viewport on scroll.
   */
  private warmParsing(views: EditorView[], scroller: HTMLElement) {
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

  private scrollTop(): number {
    return this.merge?.dom.scrollTop ?? this.single?.scrollDOM.scrollTop ?? 0;
  }

  private async render(): Promise<void> {
    const data = this.data;
    if (!data) return;
    const token = this.token;
    const keepScroll = this.scrollTop();
    this.updateButtons();
    this.info.textContent = data.note ?? '';
    if (data.message) {
      this.destroyViews();
      this.body.replaceChildren(h('div', { class: 'git-diff-message' }, data.message));
      return;
    }
    const [m, lang] = await Promise.all([
      loadMerge(),
      data.large ? null : this.ctx.editors.loadLanguage(this.ctx.editors.languageIdFor(this.p.path)).catch(() => null),
    ]);
    if (this.disposed || token !== this.token) return;

    const common: Extension[] = [
      lineNumbers(),
      // Clear text for the bar of folded lines.
      EditorState.phrases.of({ '$ unchanged lines': 'Show $ unchanged lines' }),
      chunkLineMarks(m),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      this.ctx.editors.highlightExtension(),
    ];
    if (lang) common.push(lang.extension);
    const collapseUnchanged = this.collapse ? { margin: 3, minSize: 4 } : undefined;
    const diffConfig = { scanLimit: 1000, timeout: 1000 };

    this.destroyViews();
    this.body.replaceChildren();
    if (this.mode === 'split') {
      const merge = withTrimmedChunks(
        m,
        () =>
          new m.MergeView({
            a: { doc: data.left, extensions: common },
            b: { doc: data.right, extensions: common },
            parent: this.body,
            gutter: true,
            highlightChanges: true,
            collapseUnchanged,
            diffConfig,
          }),
      );
      this.merge = merge;
      merge.dom.scrollTop = keepScroll;
      this.info.textContent = `${data.note ? data.note + '. ' : ''}${changeCount(merge.chunks.length)}`;
      this.warmParsing([merge.a, merge.b], merge.dom);
    } else {
      const state = withTrimmedChunks(m, () =>
        EditorState.create({
          doc: data.right,
          extensions: [
            ...common,
            m.unifiedMergeView({
              original: data.left,
              gutter: true,
              mergeControls: false,
              highlightChanges: true,
              collapseUnchanged,
              diffConfig,
            }),
          ],
        }),
      );
      const single = new EditorView({ parent: this.body, state });
      this.single = single;
      single.scrollDOM.scrollTop = keepScroll;
      const n = m.getChunks(single.state)?.chunks.length ?? 0;
      this.info.textContent = `${data.note ? data.note + '. ' : ''}${changeCount(n)}`;
      this.warmParsing([single], single.scrollDOM);
    }
  }

  /** Moves to the next (1) or previous (-1) change. */
  go(dir: 1 | -1): void {
    const view = this.single ?? this.merge?.b;
    if (!view) return;
    void loadMerge().then((m) => {
      const cmd = dir > 0 ? m.goToNextChunk : m.goToPreviousChunk;
      cmd({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    });
  }
}

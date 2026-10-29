// One open file: a CodeMirror view plus the state around it (encoding, line
// ending, dirty state, preview, extension providers). It is also the content
// of the tab.

import { history } from '@codemirror/commands';
import type { LanguageSupport } from '@codemirror/language';
import { openSearchPanel } from '@codemirror/search';
import { EditorSelection, EditorState, Text, type Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { h } from '../core/dom';
import type {
  Disposable,
  EditorExtensionProvider,
  FileEditor,
  FileMeta,
  LineEnding,
  TabContent,
  ViewMode,
} from '../core/types';
import { fsReadFile } from '../ipc/fs';
import { deleteDraftFile, renameDraftForLanguage } from './draft-ops';
import { programmatic, type EngineHost } from './host';
import { detectIndentation, type IndentInfo } from './indent';
import { languageIdFor, languageLabel, loadLanguageSupport } from './languages';
import { PreviewHost } from './preview-host';
import { saveFile } from './save';
import { activeLineExtension, baseExtensions, createCompartments, indentExtension, lineNumbersExtension, wrapExtension } from './setup';
import { minimalChange } from './text';

export interface Position {
  /** 1-based. */
  line?: number;
  column?: number;
  scrollTop?: number;
}

export interface EditorInit {
  /** Absolute path. */
  path: string;
  title: string;
  /** The file is inside the drafts folder. */
  isDraft: boolean;
  text: string;
  meta: FileMeta;
  /** Some bytes were not valid in the encoding. */
  lossy: boolean;
  languageId: string;
  support: LanguageSupport | null;
  position?: Position;
  mode?: ViewMode;
}

export interface TabData {
  path: string;
  line: number;
  column: number;
  scrollTop: number;
  mode: ViewMode;
  /** The file is a draft. The restored tab shows the draft title before the drafts folder is known. */
  draft?: boolean;
}

/** Drafts save this long after the last edit when `files.autoSave` is not `afterDelay`. */
const DRAFT_SAVE_DELAY_MS = 800;

export class FileEditorImpl implements FileEditor, TabContent {
  readonly path: string;
  readonly tabId: string;
  readonly meta: FileMeta;
  readonly view: EditorView;
  readonly root: HTMLElement;
  readonly isDraft: boolean;
  title: string;
  /** The user was asked about lossy bytes already. */
  lossyAccepted = false;
  /** Set while a write is running. File watcher events are ignored then. */
  saving = false;
  saveQueue: Promise<unknown> = Promise.resolve();
  lossy: boolean;
  /** Encoding was chosen by the user (reopen with encoding). Reload keeps it. */
  forcedEncoding = false;
  /**
   * Auto save stopped for this file (it conflicts with the disk, cannot encode
   * the text, or failed). It starts again after a manual save, a reload or a
   * choice in the notification.
   */
  autosaveStopped = false;

  private languageIdValue: string;
  private readonly compartments = createCompartments();
  private readonly previewHost: PreviewHost;
  private readonly codeEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly listeners = new Set<() => void>();
  private readonly providerExts = new Map<EditorExtensionProvider, Extension | null>();
  private readonly providerPending = new Set<EditorExtensionProvider>();
  private savedDoc: Text;
  private metaDirty = false;
  private lastDirty = false;
  private lastEditWasUser = false;
  private detected: IndentInfo | null = null;
  private manualIndent: IndentInfo | null = null;
  private lastScrollTop = 0;
  private disposed = false;
  private externalPrompt = 0;
  private checking = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: EngineHost,
    init: EditorInit,
  ) {
    const { ctx } = host;
    this.path = init.path;
    this.tabId = `file:${init.path}`;
    this.title = init.title;
    this.meta = init.meta;
    this.lossy = init.lossy;
    this.isDraft = init.isDraft;
    this.languageIdValue = init.languageId;
    const large = init.meta.large;

    if (!large && ctx.settings.get('editor.detectIndentation')) this.detected = detectIndentation(init.text);

    const state = EditorState.create({
      doc: init.text,
      extensions: [
        baseExtensions({
          compartments: this.compartments,
          large,
          lineNumbers: ctx.settings.get('editor.lineNumbers'),
          activeLine: ctx.settings.get('editor.highlightActiveLine'),
          wordWrap: ctx.settings.get('editor.wordWrap'),
          indent: this.effectiveIndent(),
          language: init.support ?? [],
          onFocusLost: () => this.focusLost(),
        }),
        EditorView.updateListener.of((u) => this.onUpdate(u)),
      ],
    });
    this.view = new EditorView({ state });
    this.savedDoc = this.view.state.doc;

    this.view.scrollDOM.addEventListener(
      'scroll',
      () => {
        if (this.view.scrollDOM.clientHeight > 0) this.lastScrollTop = this.view.scrollDOM.scrollTop;
      },
      { passive: true },
    );

    this.codeEl = h('div', { class: 'editor-code' }, this.view.dom);
    this.body = h('div', { class: 'editor-body' }, this.codeEl);
    this.root = h('div', { class: 'editor-file', 'data-mode': 'code' }, this.body);

    this.previewHost = new PreviewHost(
      {
        editor: this,
        root: this.root,
        body: this.body,
        codeEl: this.codeEl,
        modeChanged: () => this.host.statusChanged(this),
        splitRatio: () => this.host.splitRatio(),
        setSplitRatio: (ratio) => this.host.setSplitRatio(ratio),
      },
      this.view,
    );
    const provider = host.findPreview(this.path, this.languageIdValue, large);
    if (provider) this.previewHost.attach(provider, init.mode ?? provider.defaultMode(this.path));

    this.applyPosition(init.position);
  }

  // --- FileEditor -------------------------------------------------------------------

  get languageId(): string {
    return this.languageIdValue;
  }

  get large(): boolean {
    return this.meta.large;
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  isDirty(): boolean {
    if (this.metaDirty) return true;
    const doc = this.view.state.doc;
    if (doc === this.savedDoc) return false;
    if (doc.length !== this.savedDoc.length) return true;
    return !doc.eq(this.savedDoc);
  }

  save(): Promise<boolean> {
    return saveFile(this.host, this);
  }

  saveAs(): Promise<boolean> {
    return saveFile(this.host, this, { saveAs: true });
  }

  /** Saves without asking questions. Used by auto save. Does nothing when auto save is stopped for this file. */
  autosaveNow(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.disposed || this.autosaveStopped || this.meta.readonly || !this.isDirty()) return Promise.resolve(false);
    return saveFile(this.host, this, { auto: true });
  }

  /**
   * Stops auto save for this file and shows one notification. The notification
   * stays until the user closes it or picks an action. Every action must call
   * `resumeAutosave()` when it fixes the problem.
   */
  stopAutosave(text: string, actions: { label: string; run(): void }[], kind: 'warn' | 'error' = 'warn'): void {
    if (this.autosaveStopped) return;
    this.autosaveStopped = true;
    clearTimeout(this.timer);
    this.host.ctx.ui.notify(text, { kind, timeoutMs: 0, actions });
  }

  resumeAutosave(): void {
    this.autosaveStopped = false;
  }

  /** Auto save settings changed: start or cancel the timer for unsaved changes. */
  autosaveSettingsChanged(): void {
    clearTimeout(this.timer);
    this.scheduleAutosave();
  }

  /** Auto save mode for this file. Drafts always save after a delay. */
  private autosaveMode(): 'off' | 'afterDelay' | 'onFocusChange' {
    return this.isDraft ? 'afterDelay' : this.host.ctx.settings.get('files.autoSave');
  }

  /** Save now when the setting says `onFocusChange`. Called when the editor, the tab or the window loses focus. */
  autosaveOnFocusLost(): void {
    if (this.host.ctx.settings.get('files.autoSave') === 'onFocusChange') void this.autosaveNow();
  }

  async reload(opts?: { encoding?: string }): Promise<void> {
    if (this.disposed) return;
    const { ctx } = this.host;
    const encoding = opts?.encoding ?? (this.forcedEncoding ? this.meta.encoding : null);
    let res;
    try {
      res = await fsReadFile(this.path, { encoding, maxBytes: Math.floor(ctx.settings.get('editor.maxFileMB') * 1048576) });
    } catch (e) {
      ctx.ui.notify(`Cannot reload ${this.title}: ${(e as Error).message}`, { kind: 'error' });
      return;
    }
    if (this.disposed) return;
    if (res.binary || res.tooLarge) {
      ctx.ui.notify(`Cannot reload ${this.title}: the file is now ${res.binary ? 'binary' : 'too large'}.`, { kind: 'warn' });
      return;
    }
    if (opts?.encoding) this.forcedEncoding = true;

    const change = minimalChange(this.getText(), res.text);
    if (change) {
      this.view.dispatch({ changes: change, annotations: programmatic.of(true), scrollIntoView: false });
    }
    this.meta.encoding = res.encoding;
    this.meta.bom = res.bom;
    this.meta.lineEnding = res.lineEnding;
    this.meta.mtimeMs = res.mtimeMs;
    this.meta.size = res.size;
    this.meta.readonly = res.readonly;
    this.lossy = res.lossy;
    this.lossyAccepted = false;
    this.resumeAutosave();
    this.markClean(this.view.state.doc);
    this.resetHistory();
    this.host.statusChanged(this);
  }

  /** Public reveal: moves the cursor and scrolls it to the center. */
  revealLine(line: number, column = 1): void {
    const doc = this.view.state.doc;
    const info = doc.line(Math.min(Math.max(1, Math.floor(line)), doc.lines));
    const pos = info.from + Math.min(Math.max(0, Math.floor(column) - 1), info.length);
    this.view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    // A file that just opened can still change its layout in the next frame
    // (gutter width, tab size). Measure again, so the cursor and the selection
    // are drawn at the right place.
    requestAnimationFrame(() => this.view.requestMeasure());
  }

  /** Reveal for callers that open a file at a line. The preview follows when the code is hidden. */
  revealLineAndPreview(line: number, column?: number): void {
    this.revealLine(line, column);
    this.previewHost.revealInPreview(line);
  }

  getMode(): ViewMode {
    return this.previewHost.getMode();
  }

  setMode(mode: ViewMode): void {
    const provider = this.host.findPreview(this.path, this.languageIdValue, this.large);
    if (provider && !this.previewHost.hasProvider()) this.previewHost.attach(provider, mode);
    else this.previewHost.setMode(mode);
    if (mode !== 'preview') this.view.requestMeasure();
  }

  hasPreview(): boolean {
    return this.previewHost.hasProvider();
  }

  onDidChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  focus(): void {
    if (this.previewHost.getMode() === 'preview') this.previewHost.focusPreview();
    else this.view.focus();
  }

  // --- TabContent -------------------------------------------------------------------

  /** Puts the editor into the tab area. */
  mount(host: HTMLElement): void {
    host.append(this.root);
    this.view.requestMeasure();
    this.restoreScroll();
  }

  onShow(): void {
    this.view.requestMeasure();
    this.restoreScroll();
    this.host.statusChanged(this);
  }

  onHide(): void {
    this.autosaveOnFocusLost();
  }

  zoom(step: 1 | -1 | 0): boolean {
    if (!this.previewHost.zoom(step)) this.host.zoom(step);
    return true;
  }

  find(): boolean {
    if (this.previewHost.find()) return true;
    if (this.previewHost.getMode() === 'preview') return false;
    this.view.focus();
    return openSearchPanel(this.view);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    // An empty draft that is saved has no use. A draft with text stays on disk.
    if (this.isDraft && this.view.state.doc.length === 0 && !this.isDirty()) {
      void deleteDraftFile(this.path).catch((e) => console.error('could not delete the empty draft', e));
    }
    this.previewHost.dispose();
    this.listeners.clear();
    this.host.forget(this);
    this.view.destroy();
    this.root.remove();
  }

  // --- Language -----------------------------------------------------------------------

  languageLabel(): string {
    if (this.large) return 'Plain Text (large file)';
    return languageLabel(this.languageIdValue);
  }

  async setLanguage(id: string): Promise<void> {
    if (this.large || this.disposed) return;
    const support = await loadLanguageSupport(id, this.path);
    if (this.disposed) return;
    this.languageIdValue = support ? id : 'plaintext';
    this.view.dispatch({ effects: this.compartments.language.reconfigure(support ?? []) });
    this.resetProviders();
    this.syncPreviewProvider();
    this.host.statusChanged(this);
    if (this.isDraft) await renameDraftForLanguage(this.host, this, this.languageIdValue);
  }

  /** The default language for the file name. */
  async resetLanguage(): Promise<void> {
    await this.setLanguage(languageIdFor(this.path));
  }

  private syncPreviewProvider(): void {
    const provider = this.host.findPreview(this.path, this.languageIdValue, this.large);
    const mode = this.previewHost.getMode();
    this.previewHost.attach(provider, provider ? (this.previewHost.hasProvider() ? mode : provider.defaultMode(this.path)) : 'code');
  }

  /** Called when a preview provider is added or removed. */
  refreshPreview(): void {
    this.syncPreviewProvider();
  }

  // --- Extension providers ----------------------------------------------------------------

  async applyProvider(provider: EditorExtensionProvider): Promise<void> {
    if (this.disposed || this.providerExts.has(provider) || this.providerPending.has(provider)) return;
    if (this.large && !this.host.extensionProviders(true).includes(provider)) return;
    this.providerPending.add(provider);
    try {
      const ext = await provider(this);
      if (this.disposed || !this.host.extensionProviders(this.large).includes(provider)) return;
      this.providerExts.set(provider, ext);
      this.flushProviders();
    } catch (e) {
      console.error('editor extension provider failed', e);
      this.providerExts.set(provider, null);
    } finally {
      this.providerPending.delete(provider);
    }
  }

  removeProvider(provider: EditorExtensionProvider): void {
    if (this.providerExts.delete(provider)) this.flushProviders();
  }

  applyAllProviders(): void {
    for (const p of this.host.extensionProviders(this.large)) void this.applyProvider(p);
  }

  private resetProviders(): void {
    this.providerExts.clear();
    this.flushProviders();
    this.applyAllProviders();
  }

  private flushProviders(): void {
    if (this.disposed) return;
    const exts = [...this.providerExts.values()].filter((e): e is Extension => e != null);
    this.view.dispatch({ effects: this.compartments.providers.reconfigure(exts) });
  }

  // --- Settings -----------------------------------------------------------------------------

  applySettings(): void {
    if (this.disposed) return;
    const s = this.host.ctx.settings;
    if (this.large) {
      this.view.dispatch({
        effects: [
          this.compartments.lineNumbers.reconfigure(lineNumbersExtension(s.get('editor.lineNumbers'))),
          this.compartments.activeLine.reconfigure(activeLineExtension(s.get('editor.highlightActiveLine'))),
          this.compartments.indent.reconfigure(indentExtension(this.effectiveIndent())),
        ],
      });
      return;
    }
    if (s.get('editor.detectIndentation') && !this.detected) this.detected = detectIndentation(this.getText());
    this.view.dispatch({
      effects: [
        this.compartments.wrap.reconfigure(wrapExtension(s.get('editor.wordWrap'))),
        this.compartments.lineNumbers.reconfigure(lineNumbersExtension(s.get('editor.lineNumbers'))),
        this.compartments.activeLine.reconfigure(activeLineExtension(s.get('editor.highlightActiveLine'))),
        this.compartments.indent.reconfigure(indentExtension(this.effectiveIndent())),
      ],
    });
    this.host.statusChanged(this);
  }

  // --- Indentation --------------------------------------------------------------------------

  private effectiveIndent(): { insertSpaces: boolean; size: number } {
    const s = this.host.ctx.settings;
    const base = { insertSpaces: s.get('editor.insertSpaces'), size: s.get('editor.tabSize') };
    const pick = this.manualIndent ?? (s.get('editor.detectIndentation') ? this.detected : null);
    if (!pick) return base;
    return { insertSpaces: pick.insertSpaces, size: pick.size ?? base.size };
  }

  indentInfo(): { insertSpaces: boolean; size: number } {
    return this.effectiveIndent();
  }

  setIndentation(info: IndentInfo | null): void {
    this.manualIndent = info;
    if (!info) this.detected = this.large ? null : detectIndentation(this.getText());
    this.view.dispatch({ effects: this.compartments.indent.reconfigure(indentExtension(this.effectiveIndent())) });
    this.host.statusChanged(this);
  }

  // --- Meta -----------------------------------------------------------------------------------

  setLineEnding(lineEnding: LineEnding): void {
    if (this.meta.lineEnding === lineEnding) return;
    this.meta.lineEnding = lineEnding;
    this.metaChanged();
  }

  setEncoding(encoding: string, bom: boolean): void {
    if (this.meta.encoding === encoding && this.meta.bom === bom) return;
    this.meta.encoding = encoding;
    this.meta.bom = bom;
    this.forcedEncoding = true;
    this.metaChanged();
  }

  private metaChanged(): void {
    this.metaDirty = true;
    this.updateDirty();
    this.scheduleAutosave();
    this.host.statusChanged(this);
  }

  // --- Saving (called by save.ts) -------------------------------------------------------------

  /** The text of `doc` is on disk now. */
  markClean(doc: Text): void {
    this.savedDoc = doc;
    this.metaDirty = false;
    this.updateDirty();
  }

  // --- External changes -----------------------------------------------------------------------

  /** Compares the file on disk with what we loaded. Reloads or asks the user. */
  async checkDisk(statFn: () => Promise<{ exists: boolean; mtimeMs: number }>): Promise<void> {
    if (this.disposed || this.saving || this.checking) return;
    this.checking = true;
    try {
      const st = await statFn();
      if (this.disposed || this.saving || !st.exists || st.mtimeMs === this.meta.mtimeMs) return;
      if (!this.isDirty()) {
        await this.reload();
        return;
      }
      if (this.externalPrompt === st.mtimeMs) return;
      this.externalPrompt = st.mtimeMs;
      // Auto save would overwrite the other change. It waits for the user's choice.
      this.stopAutosave(`${this.title} changed on disk, and you have unsaved changes.`, [
        { label: 'Reload', run: () => void this.reload() },
        {
          label: 'Keep mine',
          run: () => {
            this.meta.mtimeMs = st.mtimeMs;
            this.resumeAutosave();
            this.scheduleAutosave();
          },
        },
      ]);
    } catch (e) {
      console.error('check file on disk failed', e);
    } finally {
      this.checking = false;
    }
  }

  // --- Tab data -------------------------------------------------------------------------------

  tabData(): TabData {
    const sel = this.view.state.selection.main;
    const line = this.view.state.doc.lineAt(sel.head);
    return {
      path: this.path,
      line: line.number,
      column: sel.head - line.from + 1,
      scrollTop: Math.round(this.lastScrollTop),
      mode: this.getMode(),
      draft: this.isDraft,
    };
  }

  /** 1-based line and visual column of the cursor, plus selection size, for the status bar. */
  cursorInfo(): { line: number; column: number; selected: number; ranges: number } {
    const { state } = this.view;
    const main = state.selection.main;
    const line = state.doc.lineAt(main.head);
    let column = 0;
    const text = line.text.slice(0, main.head - line.from);
    for (let i = 0; i < text.length; i++) {
      column += text.charCodeAt(i) === 9 ? state.tabSize - (column % state.tabSize) : 1;
    }
    let selected = 0;
    for (const r of state.selection.ranges) selected += r.to - r.from;
    return { line: line.number, column: column + 1, selected, ranges: state.selection.ranges.length };
  }

  // --- Internals ------------------------------------------------------------------------------

  private applyPosition(pos: Position | undefined): void {
    if (!pos) return;
    const doc = this.view.state.doc;
    if (pos.line) {
      const info = doc.line(Math.min(Math.max(1, Math.floor(pos.line)), doc.lines));
      const at = info.from + Math.min(Math.max(0, Math.floor(pos.column ?? 1) - 1), info.length);
      if (pos.scrollTop != null) {
        // Restore: keep the old scroll position, only place the cursor.
        this.view.dispatch({ selection: EditorSelection.cursor(at) });
        this.lastScrollTop = pos.scrollTop;
      } else {
        this.revealLine(pos.line, pos.column);
      }
    } else if (pos.scrollTop != null) {
      this.lastScrollTop = pos.scrollTop;
    }
  }

  private restoreScroll(): void {
    const top = this.lastScrollTop;
    if (!top) return;
    let tries = 0;
    const step = () => {
      if (this.disposed) return;
      const scroller = this.view.scrollDOM;
      if (scroller.clientHeight === 0 && tries++ < 20) {
        requestAnimationFrame(step);
        return;
      }
      if (Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top;
    };
    requestAnimationFrame(step);
  }

  private onUpdate(u: ViewUpdate): void {
    if (u.docChanged) {
      this.lastEditWasUser = !u.transactions.every((tr) => tr.annotation(programmatic));
      this.updateDirty();
      for (const fn of [...this.listeners]) {
        try {
          fn();
        } catch (e) {
          console.error('onDidChange handler failed', e);
        }
      }
      this.previewHost.docChanged();
      this.scheduleAutosave();
    }
    if (u.docChanged || u.selectionSet) this.host.statusChanged(this);
  }

  private updateDirty(): void {
    const dirty = this.isDirty();
    if (dirty === this.lastDirty) return;
    this.lastDirty = dirty;
    const { tabs } = this.host.ctx;
    tabs.setDirty(this.tabId, dirty);
    if (dirty && this.lastEditWasUser) tabs.pin(this.tabId);
  }

  /** Starts the timer for `afterDelay` auto save. Every edit starts it again. */
  private scheduleAutosave(): void {
    clearTimeout(this.timer);
    if (this.disposed || this.autosaveStopped || this.autosaveMode() !== 'afterDelay' || !this.isDirty()) return;
    const s = this.host.ctx.settings;
    const delay = s.get('files.autoSave') === 'afterDelay' ? s.get('files.autoSaveDelayMs') : DRAFT_SAVE_DELAY_MS;
    this.timer = setTimeout(() => void this.autosaveNow(), Math.max(200, delay));
  }

  private focusLost(): void {
    this.autosaveOnFocusLost();
  }

  private resetHistory(): void {
    const c = this.compartments.history;
    this.view.dispatch({ effects: c.reconfigure([]) });
    this.view.dispatch({ effects: c.reconfigure(history()) });
  }
}

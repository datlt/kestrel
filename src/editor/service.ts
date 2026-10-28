// The editor service: opens files in tabs, keeps the registries (extension
// providers, previews, openers) and reacts to settings, file changes and zoom.

import { syntaxHighlighting, type Language } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { h } from '../core/dom';
import type {
  AppContext,
  Disposable,
  EditorExtensionProvider,
  EditorService,
  FileEditor,
  FileMeta,
  FileOpener,
  FsChangeEvent,
  OpenFileOptions,
  PreviewProvider,
  TabContent,
  TabInput,
  ViewMode,
} from '../core/types';
import { basename, debounce, joinPath, rafThrottle } from '../core/util';
import { appInfo } from '../ipc/app';
import { fsCreateFile, fsReadFile, fsStat, type ReadFileResult } from '../ipc/fs';
import { isIpcError } from '../ipc/invoke';
import { registerEngineCommands } from './commands';
import { createDraftFile } from './draft-ops';
import { draftTitle, isDraftPath } from './drafts';
import { FileEditorImpl, type Position, type TabData } from './file-editor';
import type { EngineHost } from './host';
import { buildHighlightCss, highlightToHtmlString, kestrelHighlighter } from './highlight';
import { languageIdFor, loadLanguageById, loadLanguageSupport, preloadFenceLanguages, resolveLanguageId } from './languages';
import { EditorStatus } from './status';
import { escapeText } from './text';

const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 48;
/** Code longer than this is not highlighted for previews. */
const MAX_HIGHLIGHT_CHARS = 2_000_000;
const MB = 1024 * 1024;

/** Settings that change how an open editor looks or behaves. */
const EDITOR_SETTING_KEYS = [
  'editor.wordWrap',
  'editor.lineNumbers',
  'editor.highlightActiveLine',
  'editor.tabSize',
  'editor.insertSpaces',
  'editor.detectIndentation',
] as const;

interface BuildOptions {
  position?: Position;
  mode?: ViewMode;
  /** Tell the user why a file did not open. */
  notify: boolean;
}

export class EditorEngine implements EditorService, EngineHost {
  private readonly editors = new Map<string, FileEditorImpl>();
  private readonly building = new Map<string, Promise<FileEditorImpl | null>>();
  private readonly openErrors = new Map<string, string>();
  private providers: EditorExtensionProvider[] = [];
  private previews: PreviewProvider[] = [];
  private openers: FileOpener[] = [];
  private readonly status: EditorStatus;
  private fontSize: number;
  private zoomPending = false;
  private statusFrame = 0;
  private splitRatioValue = 0.5;
  private draftsDirValue: string | null = null;
  private draftsDirPromise: Promise<string | null> | null = null;
  private readonly cleanup: Disposable[] = [];

  constructor(readonly ctx: AppContext) {
    this.status = new EditorStatus(ctx);
    this.fontSize = clampFont(ctx.settings.get('editor.fontSize'));
    this.applyFont();

    ctx.tabs.registerKind('file', (data) => {
      const d = data as Partial<TabData> | null;
      if (!d || typeof d.path !== 'string' || !d.path) return null;
      return this.tabInput(d.path, d as TabData);
    });
    registerEngineCommands(this);

    ctx.bus.on('fs:changed', (e) => this.onFsChanged(e));
    ctx.bus.on('tab:activated', () => this.refreshStatus());
    ctx.bus.on('settings:changed', ({ settings, previous }) => {
      if (!this.zoomPending) this.fontSize = clampFont(settings['editor.fontSize']);
      this.applyFont();
      if (EDITOR_SETTING_KEYS.some((k) => settings[k] !== previous[k])) {
        for (const ed of this.editors.values()) ed.applySettings();
      }
      if (settings['files.autoSave'] !== previous['files.autoSave'] || settings['files.autoSaveDelayMs'] !== previous['files.autoSaveDelayMs']) {
        for (const ed of this.editors.values()) ed.autosaveSettingsChanged();
      }
    });

    // The window loses focus (the user switches to another program). Only the visible workbench reacts.
    const onWindowBlur = () => {
      if (!ctx.window.isActive()) return;
      for (const ed of this.editors.values()) ed.autosaveOnFocusLost();
    };
    window.addEventListener('blur', onWindowBlur);
    this.cleanup.push({ dispose: () => window.removeEventListener('blur', onWindowBlur) });

    // The user opens another workspace tab. This workbench is hidden now, so save what is open.
    ctx.bus.on('workbench:deactivated', () => {
      for (const ed of this.editors.values()) ed.autosaveOnFocusLost();
    });
    ctx.bus.on('workbench:activated', () => {
      this.applyFont();
      this.refreshStatus();
    });
    ctx.bus.on('workbench:disposing', () => this.dispose());

    // Load the drafts folder early, so restored draft tabs get the right title.
    void this.draftsDir();
  }

  /** Removes everything that this workbench put on `window` and stops its timers. */
  private dispose(): void {
    for (const d of this.cleanup.splice(0)) d.dispose();
    if (this.zoomPending) this.saveZoom.flush();
    if (this.statusFrame) cancelAnimationFrame(this.statusFrame);
    this.statusFrame = 0;
    for (const ed of [...this.editors.values()]) ed.dispose();
  }

  // --- EditorService ------------------------------------------------------------------

  async openFile(path: string, opts: OpenFileOptions = {}): Promise<FileEditor | null> {
    const { tabs } = this.ctx;
    await this.draftsDir();
    const id = `file:${path}`;
    const activate = opts.activate !== false;

    if (tabs.get(id)) {
      if (activate) tabs.activate(id);
      const ed = await this.ensureEditor(path, { notify: true });
      if (!ed) return null;
      if (opts.mode) ed.setMode(opts.mode);
      if (opts.line) ed.revealLineAndPreview(opts.line, opts.column);
      return ed;
    }

    for (const opener of this.openers) {
      if (!opener.matches(path)) continue;
      try {
        if (await opener.open(path, opts)) return null;
      } catch (e) {
        console.error(`opener ${opener.id} failed`, e);
      }
    }

    const ed = await this.ensureEditor(path, {
      position: opts.line ? { line: opts.line, column: opts.column } : undefined,
      mode: opts.mode,
      notify: true,
    });
    if (!ed) return null;
    if (!tabs.get(id)) {
      try {
        tabs.open(this.tabInput(path), { activate, preview: opts.preview });
      } catch (e) {
        ed.dispose();
        throw e;
      }
    } else if (activate) {
      tabs.activate(id);
    }
    return ed;
  }

  get(path: string): FileEditor | undefined {
    const exact = this.editors.get(path);
    if (exact) return exact;
    const key = this.normalize(path);
    for (const ed of this.editors.values()) if (this.normalize(ed.path) === key) return ed;
    return undefined;
  }

  active(): FileEditorImpl | null {
    const content = this.ctx.tabs.active()?.content;
    return content instanceof FileEditorImpl ? content : null;
  }

  all(): FileEditorImpl[] {
    return [...this.editors.values()];
  }

  async newDraft(): Promise<FileEditor | null> {
    const path = await createDraftFile(this);
    if (!path) return null;
    return this.openFile(path);
  }

  registerExtension(provider: EditorExtensionProvider): Disposable {
    this.providers = [...this.providers, provider];
    for (const ed of this.editors.values()) void ed.applyProvider(provider);
    return {
      dispose: () => {
        this.providers = this.providers.filter((p) => p !== provider);
        for (const ed of this.editors.values()) ed.removeProvider(provider);
      },
    };
  }

  registerPreview(provider: PreviewProvider): Disposable {
    this.previews = [...this.previews, provider];
    for (const ed of this.editors.values()) ed.refreshPreview();
    return {
      dispose: () => {
        this.previews = this.previews.filter((p) => p !== provider);
        for (const ed of this.editors.values()) ed.refreshPreview();
      },
    };
  }

  registerOpener(opener: FileOpener): Disposable {
    this.openers = [...this.openers, opener].sort((a, b) => b.priority - a.priority);
    return { dispose: () => (this.openers = this.openers.filter((o) => o !== opener)) };
  }

  languageIdFor(path: string): string {
    return languageIdFor(path);
  }

  async loadLanguage(idOrAlias: string): Promise<Language | null> {
    return loadLanguageById(idOrAlias);
  }

  async highlightToHtml(code: string, idOrAlias: string): Promise<string> {
    const id = resolveLanguageId(idOrAlias);
    if (!id || id === 'plaintext' || code.length > MAX_HIGHLIGHT_CHARS) return escapeText(code);
    const support = await loadLanguageSupport(id);
    if (!support) return escapeText(code);
    if (id === 'markdown') await preloadFenceLanguages(code);
    try {
      return highlightToHtmlString(code, support.language);
    } catch (e) {
      console.error('highlight failed', e);
      return escapeText(code);
    }
  }

  highlightCss(): string {
    const style = getComputedStyle(document.documentElement);
    return buildHighlightCss((name) => style.getPropertyValue(name));
  }

  highlightExtension(): Extension {
    return syntaxHighlighting(kestrelHighlighter);
  }

  zoom(step: 1 | -1 | 0): void {
    const next = step === 0 ? DEFAULT_FONT_SIZE : clampFont(this.fontSize + step);
    if (next === this.fontSize) return;
    this.fontSize = next;
    this.applyFont();
    this.zoomPending = true;
    this.saveZoom();
  }

  // --- EngineHost -----------------------------------------------------------------------

  findPreview(path: string, languageId: string): PreviewProvider | null {
    return this.previews.find((p) => p.matches(path, languageId)) ?? null;
  }

  extensionProviders(): EditorExtensionProvider[] {
    return this.providers;
  }

  forget(ed: FileEditorImpl): void {
    if (this.editors.get(ed.path) === ed) {
      this.editors.delete(ed.path);
      this.ctx.bus.emit('file:closed', { path: ed.path });
    }
    this.refreshStatus();
  }

  draftsDir(): Promise<string | null> {
    this.draftsDirPromise ??= appInfo().then(
      (info) => (this.draftsDirValue = joinPath(info.dataDir, 'drafts')),
      (e) => {
        console.error('could not read the app data folder', e);
        return null;
      },
    );
    return this.draftsDirPromise;
  }

  isDraft(path: string): boolean {
    return isDraftPath(path, this.draftsDirValue);
  }

  openEditors(): FileEditorImpl[] {
    return this.all();
  }

  splitRatio(): number {
    return this.splitRatioValue;
  }

  setSplitRatio(ratio: number): void {
    this.splitRatioValue = ratio;
    const value = `${(ratio * 100).toFixed(2)}%`;
    for (const ed of this.editors.values()) ed.root.style.setProperty('--editor-split', value);
  }

  statusChanged(ed: FileEditorImpl): void {
    if (ed !== this.active() || this.statusFrame) return;
    this.statusFrame = requestAnimationFrame(() => {
      this.statusFrame = 0;
      this.refreshStatus();
    });
  }

  /** Shows the status items of the active editor now. */
  refreshStatus(): void {
    this.status.show(this.active());
  }

  // --- Opening files --------------------------------------------------------------------------

  private tabInput(path: string, restore?: TabData): TabInput {
    const draft = restore?.draft === true || this.isDraft(path);
    return {
      id: `file:${path}`,
      kind: 'file',
      title: draft ? draftTitle(path) : basename(path),
      description: draft ? 'draft' : undefined,
      tooltip: path,
      create: async (host: HTMLElement): Promise<TabContent> => {
        const ed = await this.ensureEditor(path, {
          position: restore ? { line: restore.line, column: restore.column, scrollTop: restore.scrollTop } : undefined,
          mode: restore?.mode,
          notify: false,
        });
        if (!ed) return this.errorContent(host, path);
        ed.mount(host);
        return ed;
      },
      serialize: () => {
        const ed = this.editors.get(path);
        return ed ? ed.tabData() : (restore ?? { path, line: 1, column: 1, scrollTop: 0, mode: 'code' });
      },
    };
  }

  private errorContent(host: HTMLElement, path: string): TabContent {
    const el = h(
      'div',
      { class: 'editor-error' },
      h('div', { class: 'editor-error-title' }, basename(path)),
      this.openErrors.get(path) ?? 'This file could not be opened.',
    );
    host.append(el);
    return { focus() {}, dispose: () => el.remove() };
  }

  private ensureEditor(path: string, o: BuildOptions): Promise<FileEditorImpl | null> {
    const open = this.editors.get(path);
    if (open) return Promise.resolve(open);
    let pending = this.building.get(path);
    if (!pending) {
      pending = this.build(path, o).finally(() => this.building.delete(path));
      this.building.set(path, pending);
    }
    return pending;
  }

  private fail(path: string, text: string, o: BuildOptions, kind: 'warn' | 'error' = 'error'): null {
    this.openErrors.set(path, text);
    if (o.notify) this.ctx.ui.notify(text, { kind });
    return null;
  }

  private async build(path: string, o: BuildOptions): Promise<FileEditorImpl | null> {
    const { settings } = this.ctx;
    await this.draftsDir();
    const isDraft = this.isDraft(path);
    const name = isDraft ? draftTitle(path) : basename(path);
    const languageId = languageIdFor(path);
    const maxMB = settings.get('editor.maxFileMB');
    // Load the language while the file is read.
    const supportPromise = loadLanguageSupport(languageId, path);

    let res: ReadFileResult;
    try {
      try {
        res = await fsReadFile(path, { maxBytes: Math.floor(maxMB * MB) });
      } catch (e) {
        // A restored draft tab whose file is gone (an empty draft was deleted). Make it again.
        if (!isDraft || !isIpcError(e, 'not_found')) throw e;
        await fsCreateFile(path);
        res = await fsReadFile(path, { maxBytes: Math.floor(maxMB * MB) });
      }
    } catch (e) {
      return this.fail(path, `Cannot open ${name}: ${e instanceof Error ? e.message : String(e)}`, o);
    }
    if (res.binary) return this.fail(path, `${name} is a binary file. It cannot be opened as text.`, o, 'warn');
    if (res.tooLarge) {
      const size = (res.size / MB).toFixed(1);
      return this.fail(path, `${name} is too large to open (${size} MB, the limit is ${maxMB} MB).`, o, 'warn');
    }

    const large = res.size > settings.get('editor.largeFileMB') * MB;
    const support = large ? null : await supportPromise;
    const existing = this.editors.get(path);
    if (existing) return existing;

    const meta: FileMeta = {
      encoding: res.encoding,
      bom: res.bom,
      lineEnding: res.lineEnding,
      mtimeMs: res.mtimeMs,
      size: res.size,
      readonly: res.readonly,
      large,
    };
    const ed = new FileEditorImpl(this, {
      path,
      title: name,
      isDraft,
      text: res.text,
      meta,
      lossy: res.lossy,
      languageId: large ? 'plaintext' : languageId,
      support,
      position: o.position,
      mode: o.mode,
    });
    this.editors.set(path, ed);
    this.openErrors.delete(path);
    this.ctx.bus.emit('file:opened', { path });
    ed.applyAllProviders();

    if (o.notify) {
      if (large) {
        this.ctx.ui.notify(`${name} is a large file. It opens in plain mode: no syntax colors and no language features.`, { kind: 'info' });
      }
      if (res.lossy) {
        this.ctx.ui.notify(`Some bytes of ${name} are not valid ${res.encoding}. They show as U+FFFD, and saving would lose them.`, { kind: 'warn' });
      }
      if (res.mixedLineEndings) {
        this.ctx.ui.notify(`${name} mixes line endings. Saving makes all of them ${res.lineEnding.toUpperCase()}.`, { kind: 'info' });
      }
    }
    return ed;
  }

  // --- Disk changes ---------------------------------------------------------------------------

  private normalize(path: string): string {
    const n = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return this.ctx.platform === 'linux' ? n : n.toLowerCase();
  }

  private onFsChanged(e: FsChangeEvent): void {
    let targets: FileEditorImpl[];
    if (e.rescan) {
      targets = [...this.editors.values()];
    } else {
      if (!e.paths.length) return;
      const changed = new Set(e.paths.map((p) => this.normalize(p)));
      targets = [...this.editors.values()].filter((ed) => changed.has(this.normalize(ed.path)));
    }
    for (const ed of targets) {
      void ed.checkDisk(() => fsStat(ed.path));
    }
  }

  // --- Font and zoom --------------------------------------------------------------------------

  private readonly measureAll = rafThrottle(() => {
    for (const ed of this.editors.values()) ed.view.requestMeasure();
  });

  private readonly saveZoom = debounce(() => {
    const size = this.fontSize;
    this.ctx.settings
      .update({ 'editor.fontSize': size })
      .catch((e) => console.error('could not save the font size', e))
      .finally(() => {
        this.zoomPending = false;
      });
  }, 400);

  /** Sets the CSS variables that the editor theme reads, then asks all editors to measure again. */
  private applyFont(): void {
    const style = document.documentElement.style;
    const { settings } = this.ctx;
    const lineHeight = settings.get('editor.lineHeight');
    style.setProperty('--editor-font-size', `${this.fontSize}px`);
    style.setProperty('--editor-line-height', lineHeight > 4 ? `${lineHeight}px` : String(lineHeight));
    style.setProperty('--editor-font-family', settings.get('editor.fontFamily'));
    this.measureAll();
  }
}

function clampFont(size: number): number {
  const n = Number.isFinite(size) ? Math.round(size) : DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, n));
}

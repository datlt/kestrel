// The Find in Files popup (Mod-Shift-f) and Replace in Files (Mod-Shift-r).
// It lives in the overlay layer of the workbench. The object stays alive when
// the popup is closed, so the next opening shows the last results at once.
// This file loads with `import()` the first time the popup opens.

import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Folder,
  FolderOpen,
  Funnel,
  History,
  Pin,
  RotateCcw,
  Rows3,
  WholeWord,
  X,
  Regex,
  createElement,
} from 'lucide';
import type { AppContext, MenuItem } from '../../core/types';
import { h } from '../../core/dom';
import { basename, debounce, dirname, rafThrottle } from '../../core/util';
import { overlayClosed, overlayOpened } from '../../shell/overlay-count';
import { searchCancel, searchModules, searchText, type SearchModule, type TextSearchEvent } from '../../ipc/search';
import { fileIcon } from '../../ui/file-icons';
import { compilePattern, type CompiledPattern, type ReplaceOptions } from './pattern';
import { previewReplacements } from './apply';
import { cleanHistory, pushHistory } from './history';
import { parseFileMask } from './globs';
import { buildSearchRequest, changedFilesOf, passesPostFilter, scopeSpec, type ScopeEnv, type ScopeSpec } from './scope';
import {
  CONTEXTS,
  CONTEXT_LABELS,
  SCOPE_FILES,
  SCOPE_FILE_LABELS,
  activeMask,
  formToChoice,
  loadForm,
  type FindForm,
  type ScopeTab,
} from './state';
import {
  countResults,
  countsText,
  findRow,
  flattenResults,
  isExcluded,
  matchKey,
  newExclusions,
  sortFiles,
  targetsOf,
  toResultFile,
  type ListRow,
  type ResultFile,
} from './results';
import {
  clampGeometry,
  clampSplit,
  defaultGeometry,
  loadGeometry,
  resizeGeometry,
  DEFAULT_SPLIT,
  type Edge,
  type Geometry,
} from './geometry';
import { runReplace, type ReplaceJob } from './replace-apply';
import { ResultPreview, previewShell } from './preview';
import type { FindWindowPayload } from './find-window';
import './find-popup.css';

const ROW_HEIGHT = 24;
const OVERSCAN = 8;
const SEARCH_DEBOUNCE_MS = 150;
const KEY_FORM = 'search.find.form';
const KEY_GEOMETRY = 'search.find.geometry';
const KEY_SPLIT = 'search.find.split';
const KEY_HISTORY = { query: 'search.find.history.query', mask: 'search.find.history.mask', replace: 'search.find.history.replace' };
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

type Icon = Parameters<typeof createElement>[0];
type HistoryKind = keyof typeof KEY_HISTORY;

function iconButton(icon: Icon, title: string, cls = 'find-btn'): HTMLButtonElement {
  const b = h('button', { class: cls, type: 'button', title, 'aria-label': title });
  b.append(createElement(icon));
  return b;
}

export interface OpenOptions {
  replace: boolean;
  /** Text for the query field (the editor selection). */
  text: string | null;
}

export class FindPopup {
  private form: FindForm;
  private readonly history: Record<HistoryKind, string[]>;
  private replaceMode = false;
  private geometry: Geometry | null;
  private split: number;

  // Results
  private files: ResultFile[] = [];
  private rows: ListRow[] = [];
  private truncated = false;
  private running = false;
  private status = '';
  private statusError = false;
  private collapsed = new Set<string>();
  private exclusions = newExclusions();
  private selected = -1;
  private userMoved = false;
  private seq = 0;
  private searchId: number | null = null;
  private lastRoot: string | null = null;
  private modules: SearchModule[] | null = null;
  private changed: string[] = [];
  private busy = false;
  private pattern: CompiledPattern | null = null;
  private patternKey = '';

  // UI
  private readonly el: HTMLElement;
  private readonly layerWatch: ResizeObserver;
  private layer: HTMLElement | null = null;
  private isOpen = false;
  private previousFocus: HTMLElement | null = null;
  private savedScroll = 0;
  private readonly title: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly pinBtn: HTMLButtonElement;
  private readonly query: HTMLInputElement;
  private readonly replace: HTMLInputElement;
  private readonly mask: HTMLInputElement;
  private readonly maskCheck: HTMLInputElement;
  private readonly toggles: Record<'matchCase' | 'wholeWord' | 'regex', HTMLButtonElement>;
  private readonly preserveBtn: HTMLButtonElement;
  private readonly filterBtn: HTMLButtonElement;
  private readonly groupBtn: HTMLButtonElement;
  private readonly replaceRow: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly tabButtons = new Map<ScopeTab, HTMLButtonElement>();
  private readonly scopeBar: HTMLElement;
  private readonly body: HTMLElement;
  private readonly listWrap: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly replaceBtn: HTMLButtonElement;
  private readonly replaceAllBtn: HTMLButtonElement;
  private readonly footerHint: HTMLElement;
  private readonly previewPath: HTMLElement;
  private readonly preview: ResultPreview;
  private readonly rendered = new Map<number, HTMLElement>();

  private readonly scheduleRender = rafThrottle(() => this.renderList());
  private readonly runDebounced = debounce(() => this.run(), SEARCH_DEBOUNCE_MS);
  private readonly previewDebounced = debounce(() => this.updatePreview(), 50);
  private readonly decoSub: { dispose(): void };

  constructor(private readonly ctx: AppContext) {
    const gs = ctx.workspace.globalState;
    this.form = loadForm(gs.get(KEY_FORM));
    this.history = {
      query: cleanHistory(gs.get(KEY_HISTORY.query)),
      mask: cleanHistory(gs.get(KEY_HISTORY.mask)),
      replace: cleanHistory(gs.get(KEY_HISTORY.replace)),
    };
    this.geometry = loadGeometry(gs.get(KEY_GEOMETRY));
    this.split = clampSplit(gs.get<number>(KEY_SPLIT) ?? DEFAULT_SPLIT);

    // Header
    this.title = h('span', { class: 'find-title' });
    this.countEl = h('span', { class: 'find-count' });
    this.pinBtn = iconButton(Pin, 'Keep the popup open when it loses focus');
    const openWindow = iconButton(ExternalLink, `Open in Find Window (${ctx.commands.keyLabel('Mod-Enter')})`);
    openWindow.addEventListener('click', () => this.openInFindWindow());
    const closeBtn = iconButton(X, 'Close (Esc)');
    closeBtn.addEventListener('click', () => this.close());
    this.pinBtn.addEventListener('click', () => {
      this.form.pinned = !this.form.pinned;
      this.saveForm();
      this.syncForm();
    });
    const head = h('div', { class: 'find-head' }, this.title, this.countEl, h('span', { class: 'find-grow' }), this.pinBtn, openWindow, closeBtn);
    this.makeDraggable(head);

    // Query row
    this.query = this.input('Search text', 'Find');
    const toggle = (key: 'matchCase' | 'wholeWord' | 'regex', icon: Icon, label: string, code: string) => {
      const b = iconButton(icon, `${label} (Alt-${code})`, 'find-toggle');
      b.addEventListener('click', () => this.flip(key));
      return b;
    };
    this.toggles = {
      matchCase: toggle('matchCase', CaseSensitive, 'Match Case', 'C'),
      wholeWord: toggle('wholeWord', WholeWord, 'Words', 'O'),
      regex: toggle('regex', Regex, 'Regex', 'X'),
    };
    const queryHistory = iconButton(History, 'History (Alt-Down)', 'find-toggle');
    queryHistory.addEventListener('click', () => this.showHistory('query', queryHistory));
    this.filterBtn = iconButton(Funnel, 'Filter: where a match may be');
    this.filterBtn.addEventListener('click', () => this.showFilterMenu(this.filterBtn));
    this.groupBtn = iconButton(Rows3, 'Group results by file');
    this.groupBtn.addEventListener('click', () => {
      this.form.grouped = !this.form.grouped;
      this.saveForm();
      this.syncForm();
      this.rebuildRows();
    });
    const queryRow = h(
      'div',
      { class: 'find-row-form' },
      h('div', { class: 'find-field' }, this.query, queryHistory, this.toggles.matchCase, this.toggles.wholeWord, this.toggles.regex),
      this.filterBtn,
      this.groupBtn,
    );

    // Replace row
    this.replace = this.input('Replace with', 'Replace');
    const replaceHistory = iconButton(History, 'History (Alt-Down)', 'find-toggle');
    replaceHistory.addEventListener('click', () => this.showHistory('replace', replaceHistory));
    this.preserveBtn = h('button', { class: 'find-toggle find-toggle-text', type: 'button', title: 'Preserve Case', 'aria-label': 'Preserve Case' }, 'AB');
    this.preserveBtn.addEventListener('click', () => {
      this.form.preserveCase = !this.form.preserveCase;
      this.saveForm();
      this.syncForm();
      this.redrawAll();
    });
    this.replaceRow = h('div', { class: 'find-row-form' }, h('div', { class: 'find-field' }, this.replace, replaceHistory, this.preserveBtn));

    this.errorEl = h('div', { class: 'find-error' });
    this.errorEl.hidden = true;

    // File mask
    this.maskCheck = h('input', { type: 'checkbox', id: `find-mask-${Math.random().toString(36).slice(2)}` });
    this.mask = this.input('*.kt, *.java, !*Test.kt', 'File mask');
    const maskHistory = iconButton(History, 'History (Alt-Down)', 'find-toggle');
    maskHistory.addEventListener('click', () => this.showHistory('mask', maskHistory));
    const maskRow = h(
      'div',
      { class: 'find-row-form' },
      h('label', { class: 'find-check', for: this.maskCheck.id }, this.maskCheck, 'File mask'),
      h('div', { class: 'find-field' }, this.mask, maskHistory),
    );
    this.maskCheck.addEventListener('change', () => {
      this.form.maskOn = this.maskCheck.checked;
      this.saveForm();
      if (this.form.mask.trim()) this.run();
    });

    // Scope
    const tabs = h('div', { class: 'find-tabs', role: 'tablist' });
    const tabDefs: [ScopeTab, string][] = [
      ['project', 'In Project'],
      ['module', 'Module'],
      ['directory', 'Directory'],
      ['scope', 'Scope'],
    ];
    for (const [id, label] of tabDefs) {
      const b = h('button', { class: 'find-tab', type: 'button', role: 'tab' }, label);
      b.addEventListener('click', () => this.setTab(id));
      this.tabButtons.set(id, b);
      tabs.append(b);
    }
    this.scopeBar = h('div', { class: 'find-scope-bar' });

    const form = h('div', { class: 'find-form' }, queryRow, this.replaceRow, this.errorEl, maskRow, tabs, this.scopeBar);

    // Results and preview
    this.spacer = h('div', { class: 'find-spacer' });
    this.scroller = h('div', { class: 'find-results', tabindex: '0', role: 'listbox', 'aria-label': 'Results' }, this.spacer);
    this.emptyEl = h('div', { class: 'find-empty' });
    this.listWrap = h('div', { class: 'find-list' }, this.scroller, this.emptyEl);
    const pv = previewShell();
    this.previewPath = pv.path;
    this.preview = new ResultPreview(ctx, pv.host, pv.message, () => void this.openSelected(true));
    const handle = h('div', { class: 'find-split', title: 'Drag to resize' });
    this.makeSplitter(handle);
    this.body = h('div', { class: 'find-body' }, this.listWrap, handle, pv.root);
    this.applySplit();

    // Footer (Replace mode)
    this.replaceBtn = h('button', { class: 'find-action', type: 'button' }, 'Replace');
    this.replaceAllBtn = h('button', { class: 'find-action find-action-primary', type: 'button' }, 'Replace All');
    this.replaceBtn.addEventListener('click', () => void this.replaceSelected());
    this.replaceAllBtn.addEventListener('click', () => void this.replaceAll());
    this.footerHint = h('span', { class: 'find-hint' }, 'Delete excludes the selected match.');
    this.footer = h('div', { class: 'find-foot' }, this.footerHint, h('span', { class: 'find-grow' }), this.replaceBtn, this.replaceAllBtn);

    this.el = h('div', { class: 'find-popup', role: 'dialog', 'aria-label': 'Find in Files' }, head, form, this.body, this.footer);
    for (const edge of EDGES) {
      const grip = h('div', { class: `find-grip find-grip-${edge}`, 'data-edge': edge });
      this.makeResizable(grip, edge);
      this.el.append(grip);
    }

    this.wire();
    this.layerWatch = new ResizeObserver(() => this.fit());
    this.decoSub = ctx.bus.on('git:decorations', (e) => {
      if (e.root === ctx.workspace.root) this.changed = changedFilesOf(e.files);
    });
    this.syncForm();
  }

  // --- Building blocks -------------------------------------------------------------

  private input(placeholder: string, label: string): HTMLInputElement {
    return h('input', { class: 'find-input', type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': label });
  }

  private wire(): void {
    // Typing. IME text is not searched until the composition ends.
    const typed = (el: HTMLInputElement, apply: () => void, search: boolean) => {
      const go = () => {
        apply();
        if (search) this.scheduleRun();
      };
      el.addEventListener('input', (e) => {
        if (!(e as InputEvent).isComposing) go();
      });
      el.addEventListener('compositionend', go);
    };
    typed(this.query, () => (this.form.query = this.query.value), true);
    typed(this.mask, () => (this.form.mask = this.mask.value), true);
    typed(this.replace, () => {
      this.form.replace = this.replace.value;
      this.redrawAll();
      this.updateActions();
    }, false);
    this.mask.addEventListener('input', () => {
      // Typing a mask turns the check box on.
      if (this.mask.value.trim() && !this.form.maskOn) {
        this.form.maskOn = true;
        this.maskCheck.checked = true;
      }
    });
    this.mask.addEventListener('change', () => this.remember('mask', this.mask.value));
    this.query.addEventListener('change', () => this.remember('query', this.query.value));
    this.replace.addEventListener('change', () => this.remember('replace', this.replace.value));

    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.scroller.addEventListener('scroll', this.scheduleRender, { passive: true });
    this.scroller.addEventListener('click', (e) => this.onListClick(e));
    this.scroller.addEventListener('dblclick', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.find-row');
      if (row && this.rows[Number(row.dataset.index)]?.kind === 'match') void this.openSelected(true);
    });
    new ResizeObserver(this.scheduleRender).observe(this.scroller);
  }

  private remember(kind: HistoryKind, value: string): void {
    this.history[kind] = pushHistory(this.history[kind], value);
    this.ctx.workspace.globalState.set(KEY_HISTORY[kind], this.history[kind]);
  }

  private saveForm(): void {
    this.ctx.workspace.globalState.set(KEY_FORM, this.form);
  }

  private flip(key: 'matchCase' | 'wholeWord' | 'regex'): void {
    this.form.options[key] = !this.form.options[key];
    this.saveForm();
    this.syncForm();
    this.runDebounced.cancel();
    this.run();
  }

  /** Copies the form state into the controls. */
  private syncForm(): void {
    const f = this.form;
    this.query.value = f.query;
    this.mask.value = f.mask;
    this.replace.value = f.replace;
    this.maskCheck.checked = f.maskOn;
    for (const [k, b] of Object.entries(this.toggles)) b.setAttribute('aria-pressed', String(f.options[k as keyof typeof f.options]));
    this.preserveBtn.setAttribute('aria-pressed', String(f.preserveCase));
    this.pinBtn.setAttribute('aria-pressed', String(f.pinned));
    this.groupBtn.setAttribute('aria-pressed', String(f.grouped));
    this.filterBtn.setAttribute('aria-pressed', String(f.context !== 'anywhere'));
    for (const [id, b] of this.tabButtons) b.setAttribute('aria-selected', String(id === f.tab));
    this.title.textContent = this.replaceMode ? 'Replace in Files' : 'Find in Files';
    this.replaceRow.hidden = !this.replaceMode;
    this.footer.hidden = !this.replaceMode;
    this.el.classList.toggle('find-replace-mode', this.replaceMode);
    this.buildScopeBar();
    this.updateActions();
  }

  // --- Scope ---------------------------------------------------------------------------

  private activeDir(): string | null {
    const ed = this.ctx.editors.active();
    return ed && !ed.isDraft ? dirname(ed.path) : null;
  }

  private setTab(tab: ScopeTab): void {
    this.form.tab = tab;
    if (tab === 'directory' && !this.form.directory) this.form.directory = this.activeDir() ?? this.ctx.workspace.root ?? '';
    this.saveForm();
    this.syncForm();
    this.run();
  }

  private buildScopeBar(): void {
    const f = this.form;
    const bar = this.scopeBar;
    bar.replaceChildren();
    bar.hidden = f.tab === 'project';
    if (f.tab === 'module') {
      const select = h('select', { class: 'find-select', 'aria-label': 'Module' });
      const mods = this.modules;
      if (!mods) {
        select.append(h('option', { value: '' }, 'Loading modules...'));
        void this.loadModules();
      } else if (!mods.length) {
        select.append(h('option', { value: '' }, 'No modules found'));
      } else {
        for (const m of mods) {
          const rel = this.ctx.workspace.relative(m.path);
          const o = h('option', { value: m.path }, rel && rel !== m.path ? `${m.name} (${rel})` : m.name);
          if (m.path === f.modulePath) o.selected = true;
          select.append(o);
        }
        if (!f.modulePath || !mods.some((m) => m.path === f.modulePath)) {
          f.modulePath = mods[0].path;
          f.moduleName = mods[0].name;
        }
      }
      select.addEventListener('change', () => {
        const m = this.modules?.find((x) => x.path === select.value);
        f.modulePath = m?.path ?? null;
        f.moduleName = m?.name ?? null;
        this.saveForm();
        this.run();
      });
      bar.append(select);
    } else if (f.tab === 'directory') {
      const path = this.input('Folder', 'Folder');
      path.value = f.directory;
      path.classList.add('find-path');
      path.addEventListener('input', () => {
        f.directory = path.value;
        this.saveForm();
        this.scheduleRun();
      });
      const rec = h('button', { class: 'find-toggle find-toggle-text', type: 'button', title: 'Search in sub folders' }, 'Recursive');
      rec.setAttribute('aria-pressed', String(f.recursive));
      rec.addEventListener('click', () => {
        f.recursive = !f.recursive;
        rec.setAttribute('aria-pressed', String(f.recursive));
        this.saveForm();
        this.run();
      });
      const choose = h('button', { class: 'find-action', type: 'button', title: 'Choose a folder' });
      choose.append(createElement(FolderOpen), 'Choose');
      choose.addEventListener('click', () => void this.chooseFolder(path));
      bar.append(createElement(Folder), path, rec, choose);
    } else if (f.tab === 'scope') {
      const select = h('select', { class: 'find-select', 'aria-label': 'Scope' });
      for (const s of SCOPE_FILES) {
        const o = h('option', { value: s }, SCOPE_FILE_LABELS[s]);
        if (s === f.scopeFiles) o.selected = true;
        select.append(o);
      }
      select.addEventListener('change', () => {
        f.scopeFiles = select.value as FindForm['scopeFiles'];
        this.saveForm();
        this.run();
      });
      bar.append(select);
    }
  }

  private async loadModules(): Promise<void> {
    const root = this.ctx.workspace.root;
    if (!root) return;
    try {
      this.modules = await searchModules(root);
    } catch {
      this.modules = [];
    }
    if (this.form.tab === 'module') {
      this.buildScopeBar();
      this.run();
    }
  }

  private async chooseFolder(field: HTMLInputElement): Promise<void> {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false, defaultPath: this.form.directory || this.ctx.workspace.root || undefined });
      if (typeof picked === 'string' && picked) {
        this.form.directory = picked;
        field.value = picked;
        this.saveForm();
        this.run();
      }
    } catch (e) {
      this.ctx.ui.notify(`Cannot open the folder dialog: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
    }
    this.query.focus();
  }

  private currentSpec(): ScopeSpec {
    const root = this.ctx.workspace.root ?? '';
    const env: ScopeEnv = {
      root,
      openFiles: this.ctx.editors.all().filter((e) => !e.isDraft).map((e) => e.path),
      changedFiles: this.changed,
      currentFile: this.ctx.editors.active()?.path ?? null,
    };
    return scopeSpec(formToChoice(this.form, this.activeDir()), env);
  }

  // --- Menus ---------------------------------------------------------------------------

  private menuAt(anchor: HTMLElement, items: MenuItem[]): void {
    const r = anchor.getBoundingClientRect();
    this.ctx.ui.contextMenu(new MouseEvent('click', { clientX: r.left, clientY: r.bottom + 2 }), items);
  }

  private showFilterMenu(anchor: HTMLElement): void {
    this.menuAt(
      anchor,
      CONTEXTS.map((c) => ({
        label: `${this.form.context === c ? '✓ ' : '  '}${CONTEXT_LABELS[c]}`,
        run: () => {
          this.form.context = c;
          this.saveForm();
          this.syncForm();
          this.run();
        },
      })),
    );
  }

  private showHistory(kind: HistoryKind, anchor: HTMLElement): void {
    const field = kind === 'query' ? this.query : kind === 'mask' ? this.mask : this.replace;
    const list = this.history[kind];
    this.menuAt(
      anchor,
      list.length
        ? list.map((value) => ({
            label: value.length > 80 ? value.slice(0, 80) + '...' : value,
            run: () => {
              field.value = value;
              field.dispatchEvent(new Event('input'));
              field.focus();
            },
          }))
        : [{ label: 'No history yet', run: () => {}, disabled: true }],
    );
  }

  // --- Opening and closing ---------------------------------------------------------------

  private findLayer(): HTMLElement | null {
    const root = this.ctx.editors.active()?.view.dom.closest('.shell-root');
    const own = root?.querySelector<HTMLElement>(':scope > .shell-overlays');
    if (own) return own;
    for (const r of document.querySelectorAll<HTMLElement>('.shell-root')) {
      if (r.getClientRects().length) return r.querySelector<HTMLElement>(':scope > .shell-overlays');
    }
    return null;
  }

  open(o: OpenOptions): void {
    const layer = this.layer && this.layer.isConnected && this.isOpen ? this.layer : this.findLayer();
    if (!layer) {
      this.ctx.ui.notify('Cannot show the search popup: the workbench is not ready.', { kind: 'error' });
      return;
    }
    const root = this.ctx.workspace.root;
    if (root !== this.lastRoot) {
      this.resetResults();
      this.modules = null;
      this.lastRoot = root;
    }
    this.replaceMode = o.replace;
    if (this.form.tab === 'directory' && !this.form.directory) this.form.directory = this.activeDir() ?? root ?? '';
    if (!this.isOpen) {
      this.previousFocus = document.activeElement as HTMLElement | null;
      this.layer = layer;
      layer.append(this.el);
      overlayOpened(layer);
      this.isOpen = true;
      this.layerWatch.observe(layer);
      document.addEventListener('pointerdown', this.onOutside, true);
    }
    if (o.text) this.form.query = o.text;
    this.syncForm();
    this.fit();
    this.scroller.scrollTop = this.savedScroll;
    this.preview.refresh();
    this.redrawAll();
    this.setStatusFromState();
    this.query.focus();
    this.query.select();
    // New text, or a query from the last session without results yet (after a
    // restart the popup keeps the query, not the results): search now.
    if (o.text || (this.form.query && this.files.length === 0)) {
      this.runDebounced.cancel();
      this.run();
    } else if (this.replaceMode) {
      this.updateActions();
    }
    this.updatePreview();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.savedScroll = this.scroller.scrollTop;
    document.removeEventListener('pointerdown', this.onOutside, true);
    this.layerWatch.disconnect();
    this.el.remove();
    if (this.layer) overlayClosed(this.layer);
    this.runDebounced.cancel();
    const back = this.previousFocus;
    this.previousFocus = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  /** A click outside the popup closes it, unless it is pinned. Clicks on other overlays (menus, dialogs) do not. */
  private readonly onOutside = (e: Event): void => {
    if (this.form.pinned || this.busy) return;
    const t = e.target;
    if (!(t instanceof Node) || this.el.contains(t)) return;
    if (this.layer?.contains(t)) return;
    this.close();
  };

  dispose(): void {
    this.close();
    this.cancelSearch();
    this.layerWatch.disconnect();
    this.decoSub.dispose();
    this.previewDebounced.cancel();
    this.preview.dispose();
  }

  /** Handles a new folder: drops results of the old folder. */
  workspaceChanged(): void {
    this.cancelSearch();
    this.resetResults();
    this.modules = null;
    this.lastRoot = this.ctx.workspace.root;
    if (this.isOpen) this.close();
  }

  // --- Geometry -------------------------------------------------------------------------

  private area() {
    return { w: this.layer?.clientWidth ?? 1000, h: this.layer?.clientHeight ?? 700 };
  }

  private fit(): void {
    if (!this.layer) return;
    const area = this.area();
    this.geometry = clampGeometry(this.geometry ?? defaultGeometry(area), area);
    this.applyGeometry(this.geometry);
  }

  private applyGeometry(g: Geometry): void {
    Object.assign(this.el.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
  }

  private saveGeometry(): void {
    if (this.geometry) this.ctx.workspace.globalState.set(KEY_GEOMETRY, this.geometry);
  }

  private makeDraggable(head: HTMLElement): void {
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button') || e.button !== 0 || !this.geometry) return;
      const start = { ...this.geometry };
      const x0 = e.clientX;
      const y0 = e.clientY;
      head.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        this.geometry = clampGeometry({ ...start, x: start.x + m.clientX - x0, y: start.y + m.clientY - y0 }, this.area());
        this.applyGeometry(this.geometry);
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        this.saveGeometry();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }

  private makeResizable(grip: HTMLElement, edge: Edge): void {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.geometry) return;
      e.preventDefault();
      const start = { ...this.geometry };
      const x0 = e.clientX;
      const y0 = e.clientY;
      grip.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        this.geometry = resizeGeometry(start, edge, m.clientX - x0, m.clientY - y0, this.area());
        this.applyGeometry(this.geometry);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        this.saveGeometry();
        this.preview.refresh();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }

  private applySplit(): void {
    this.listWrap.style.flexBasis = `${this.split * 100}%`;
  }

  private makeSplitter(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        const box = this.body.getBoundingClientRect();
        this.split = clampSplit((m.clientY - box.top) / Math.max(1, box.height));
        this.applySplit();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        this.ctx.workspace.globalState.set(KEY_SPLIT, this.split);
        this.preview.refresh();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // --- Running a search -------------------------------------------------------------------

  private cancelSearch(): void {
    this.seq++;
    this.runDebounced.cancel();
    this.pending = false;
    const id = this.searchId;
    this.searchId = null;
    this.running = false;
    if (id !== null) searchCancel(id).catch(() => {});
  }

  private resetResults(): void {
    this.files = [];
    this.rows = [];
    this.truncated = false;
    this.selected = -1;
    this.userMoved = false;
    this.collapsed.clear();
    this.exclusions = newExclusions();
    this.status = '';
    this.statusError = false;
    this.errorEl.hidden = true;
    this.redrawAll();
    this.preview.clear();
    this.previewPath.textContent = '';
    this.updateCount();
    this.updateActions();
  }

  private run(keep?: { exclusions: boolean; selection: number }): void {
    this.pending = false;
    this.cancelSearch();
    const root = this.ctx.workspace.root;
    const f = this.form;
    const keptEx = keep?.exclusions ? this.exclusions : null;
    this.resetResults();
    if (keptEx) this.exclusions = keptEx;
    if (!root) return this.setStatus('Open a folder to search.');
    if (!f.query) return this.setStatus('Type to search.');
    const spec = this.currentSpec();
    if (spec.empty) return this.setStatus(spec.empty);
    const req = buildSearchRequest(spec, parseFileMask(activeMask(f)));
    const seq = this.seq;
    this.running = true;
    this.setStatus('Searching...');
    searchText(
      req.root,
      {
        query: f.query,
        regex: f.options.regex,
        matchCase: f.options.matchCase,
        wholeWord: f.options.wholeWord,
        include: req.include,
        exclude: req.exclude,
        maxResults: this.ctx.settings.get('search.maxResults') ?? 20000,
        ...(req.paths ? { paths: req.paths } : {}),
        context: f.context,
      },
      (e) => {
        if (seq === this.seq) this.onEvent(e, spec, keep?.selection ?? -1);
      },
    )
      .then((id) => {
        if (seq === this.seq) this.searchId = id;
        else searchCancel(id).catch(() => {});
      })
      .catch((e) => {
        if (seq !== this.seq) return;
        this.running = false;
        this.setStatus(e instanceof Error ? e.message : String(e), true);
      });
  }

  private onEvent(e: TextSearchEvent, spec: ScopeSpec, hint: number): void {
    const root = this.ctx.workspace.root ?? '';
    if (e.type === 'batch') {
      for (const f of e.files) {
        if (!passesPostFilter(spec.postFilter, f.path, root)) continue;
        this.files.push(toResultFile(root, f));
      }
      this.rebuildRowsSoon();
      this.updateCount();
    } else if (e.type === 'done') {
      this.running = false;
      this.truncated = e.truncated;
      const key = this.selectedKey();
      sortFiles(this.files);
      this.rebuildRows();
      if (hint >= 0 && this.rows.length) this.select(Math.min(hint, this.rows.length - 1), false);
      else if (this.userMoved && key) this.select(Math.max(0, findRow(this.rows, key.path, key.line)), false);
      else if (this.rows.length) this.select(0, false);
      this.setStatus(this.files.length ? '' : 'No results found.');
      this.updateCount();
    } else {
      this.running = false;
      this.setStatus(e.message, true);
    }
    this.updateActions();
  }

  private setStatus(text: string, error = false): void {
    this.status = text;
    this.statusError = error;
    this.setStatusFromState();
  }

  private setStatusFromState(): void {
    const showEmpty = !this.rows.length;
    this.emptyEl.textContent = this.status;
    this.emptyEl.hidden = !showEmpty || !this.status;
    this.emptyEl.classList.toggle('find-error-text', this.statusError);
    // A wrong pattern also shows under the query field.
    this.errorEl.hidden = !(this.statusError && this.status);
    this.errorEl.textContent = this.statusError ? this.status : '';
    this.updateCount();
  }

  private updateCount(): void {
    if (this.statusError) {
      this.countEl.textContent = '';
      return;
    }
    const c = countResults(this.files);
    if (this.running) this.countEl.textContent = `Searching... ${c.matches.toLocaleString('en-US')} matches`;
    else this.countEl.textContent = this.files.length ? countsText(c, this.truncated) : '';
  }

  // --- Result list -------------------------------------------------------------------------

  private readonly rebuildRowsSoon = rafThrottle(() => {
    this.rebuildRows();
    if (this.selected < 0 && this.rows.length) this.select(0, false);
  });

  private rebuildRows(): void {
    this.rows = flattenResults(this.files, this.form.grouped, this.collapsed);
    this.selected = Math.min(this.selected, this.rows.length - 1);
    this.redrawAll();
    this.setStatusFromState();
  }

  private selectedKey(): { path: string; line: number } | null {
    const r = this.rows[this.selected];
    return r?.kind === 'match' ? { path: r.file.path, line: r.match.line } : null;
  }

  private redrawAll(): void {
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
    this.renderList();
  }

  private renderList(): void {
    this.spacer.style.height = `${this.rows.length * ROW_HEIGHT}px`;
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight || 300;
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(this.rows.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    for (const [i, el] of this.rendered) {
      if (i < start || i >= end) {
        el.remove();
        this.rendered.delete(i);
      }
    }
    for (let i = start; i < end; i++) {
      if (this.rendered.has(i)) continue;
      const el = this.makeRow(i, this.rows[i]);
      this.rendered.set(i, el);
      this.spacer.append(el);
    }
  }

  private replaceOptions(): ReplaceOptions {
    return { template: this.form.replace, regex: this.form.options.regex, preserveCase: this.form.preserveCase };
  }

  /** The pattern for Replace. Compiled again only when the query or an option changes. */
  private compiled(): CompiledPattern {
    const o = this.form.options;
    const key = JSON.stringify([this.form.query, o]);
    if (!this.pattern || key !== this.patternKey) {
      this.pattern = compilePattern({ query: this.form.query, ...o });
      this.patternKey = key;
    }
    return this.pattern;
  }

  private makeRow(index: number, row: ListRow): HTMLElement {
    const el = h('div', { class: 'find-row', 'data-index': index, style: `top:${index * ROW_HEIGHT}px`, role: 'option' });
    el.classList.toggle('find-selected', index === this.selected);
    const rep = this.replaceMode;
    if (row.kind === 'file') {
      const f = row.file;
      const excluded = this.exclusions.files.has(f.path);
      el.classList.add('find-file-row');
      el.classList.toggle('find-excluded', excluded);
      el.title = f.rel;
      const chevron = h('span', { class: 'find-chevron' });
      chevron.append(createElement(row.collapsed ? ChevronRight : ChevronDown));
      el.append(chevron, fileIcon(f.name), h('span', { class: 'find-file-name' }, f.name), h('span', { class: 'find-file-dir' }, f.dir), h('span', { class: 'find-grow' }), h('span', { class: 'find-badge' }, String(f.matches.length)));
      if (rep) el.append(this.excludeButton(excluded, 'file', f.path, 0));
      return el;
    }
    const m = row.match;
    const f = row.file;
    const excluded = isExcluded(this.exclusions, f.path, m.line);
    el.classList.add('find-match-row');
    el.classList.toggle('find-excluded', excluded);
    el.classList.toggle('find-indent', row.grouped);
    el.title = `${f.rel}:${m.line}`;
    let news: string[] | null = null;
    if (rep) {
      const p = this.compiled();
      if (p.ok) news = previewReplacements(m.text, m.ranges, p.re, this.replaceOptions());
    }
    const text = h('span', { class: 'find-text' });
    let pos = 0;
    m.ranges.forEach(([s, e], i) => {
      if (s > pos) text.append(m.text.slice(pos, s));
      const old = m.text.slice(s, e);
      if (news) {
        text.append(h('s', { class: 'find-old' }, old), h('span', { class: 'find-new' }, news[i].replace(/\n/g, '↵')));
      } else {
        text.append(h('b', { class: 'find-hit' }, old));
      }
      pos = e;
    });
    if (pos < m.text.length) text.append(m.text.slice(pos));
    el.append(text, h('span', { class: 'find-where' }, row.grouped ? null : h('span', { class: 'find-where-file' }, f.name), h('span', { class: 'find-lineno' }, String(m.line))));
    if (rep) el.append(this.excludeButton(excluded, 'match', f.path, m.line));
    return el;
  }

  private excludeButton(excluded: boolean, kind: 'file' | 'match', path: string, line: number): HTMLElement {
    const b = iconButton(excluded ? RotateCcw : X, excluded ? 'Include again' : 'Exclude from replace (Delete)', 'find-x');
    b.dataset.kind = kind;
    b.dataset.path = path;
    b.dataset.line = String(line);
    return b;
  }

  private toggleExclude(kind: 'file' | 'match', path: string, line: number): void {
    const set = kind === 'file' ? this.exclusions.files : this.exclusions.matches;
    const key = kind === 'file' ? path : matchKey(path, line);
    if (!set.delete(key)) set.add(key);
    this.redrawAll();
    this.updateActions();
  }

  private onListClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const x = target.closest<HTMLElement>('.find-x');
    if (x) {
      this.toggleExclude(x.dataset.kind as 'file' | 'match', x.dataset.path!, Number(x.dataset.line));
      return;
    }
    const el = target.closest<HTMLElement>('.find-row');
    if (!el) return;
    const index = Number(el.dataset.index);
    const row = this.rows[index];
    this.select(index, true);
    if (row?.kind === 'file') {
      if (!this.collapsed.delete(row.file.path)) this.collapsed.add(row.file.path);
      this.rebuildRows();
      this.select(index, true);
    }
  }

  private select(index: number, byUser: boolean): void {
    if (!this.rows.length) return;
    index = Math.min(Math.max(index, 0), this.rows.length - 1);
    if (byUser) this.userMoved = true;
    this.rendered.get(this.selected)?.classList.remove('find-selected');
    this.selected = index;
    const top = index * ROW_HEIGHT;
    const view = this.scroller.clientHeight;
    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > this.scroller.scrollTop + view) this.scroller.scrollTop = top + ROW_HEIGHT - view;
    this.renderList();
    this.rendered.get(index)?.classList.add('find-selected');
    this.previewDebounced();
    this.updateActions();
  }

  private updatePreview(): void {
    const row = this.rows[this.selected];
    if (!row) {
      this.preview.clear();
      this.previewPath.textContent = '';
      return;
    }
    const line = row.kind === 'match' ? row.match.line : (row.file.matches[0]?.line ?? 1);
    this.previewPath.textContent = row.kind === 'match' ? `${row.file.rel}:${row.match.line}` : row.file.rel;
    void this.preview.show(row.file, line);
  }

  // --- Opening a match -----------------------------------------------------------------------

  /** Opens the selected match. `close`: close the popup (unless it is pinned). */
  private async openSelected(close: boolean): Promise<void> {
    const row = this.rows[this.selected];
    if (!row) return;
    const file = row.file;
    const m = row.kind === 'match' ? row.match : file.matches[0];
    if (!m) return;
    const first = m.ranges[0] ?? [0, 0];
    const keepOpen = !close || this.form.pinned;
    if (!keepOpen) this.close();
    let editor;
    try {
      editor = await this.ctx.editors.openFile(file.path, { line: m.line, column: m.offset + first[0] + 1 });
    } catch (e) {
      this.ctx.ui.notify(`Cannot open ${file.rel}: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
      return;
    }
    if (!editor) return;
    const doc = editor.view.state.doc;
    const line = doc.line(Math.min(Math.max(m.line, 1), doc.lines));
    const from = Math.min(line.from + m.offset + first[0], line.to);
    const to = Math.min(line.from + m.offset + first[1], line.to);
    editor.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    if (keepOpen) {
      if (this.isOpen) this.scroller.focus();
    } else {
      editor.focus();
    }
  }

  private openInFindWindow(): void {
    const f = this.form;
    const mask = parseFileMask(activeMask(f));
    const payload: FindWindowPayload = {
      query: f.query,
      options: { ...f.options },
      context: f.context,
      include: mask.include.join(', '),
      exclude: mask.exclude.join(', '),
      scope: this.currentSpec(),
      files: this.files,
      truncated: this.truncated,
    };
    if (!f.pinned) this.close();
    void this.ctx.commands.execute('search.showFindWindow', payload);
  }

  // --- Keys ------------------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    // Keys during IME composition belong to the IME.
    if (e.isComposing || e.keyCode === 229) return;
    const target = e.target as HTMLElement;
    const inInput = target instanceof HTMLInputElement;
    const mod = e.metaKey || e.ctrlKey;

    // Toggles use `code`, so Alt works on macOS where it changes the letter.
    if (e.altKey && !mod && !e.shiftKey) {
      const key = e.code === 'KeyC' ? 'matchCase' : e.code === 'KeyO' ? 'wholeWord' : e.code === 'KeyX' ? 'regex' : null;
      if (key) {
        e.preventDefault();
        this.flip(key);
        return;
      }
      if (e.key === 'ArrowDown' && inInput) {
        const kind: HistoryKind | null = target === this.query ? 'query' : target === this.mask ? 'mask' : target === this.replace ? 'replace' : null;
        if (kind) {
          e.preventDefault();
          this.showHistory(kind, target);
        }
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    const inList = this.scroller.contains(target) || target === this.scroller;
    if (e.key === 'Enter') {
      if (target instanceof HTMLButtonElement || target instanceof HTMLSelectElement) return;
      e.preventDefault();
      if (mod) {
        if (inList) void this.openSelected(false);
        else this.openInFindWindow();
      } else if (inList) {
        void this.openSelected(true);
      } else if (this.runPending()) {
        // The search ran now. A second Enter opens the match.
      } else {
        void this.openSelected(true);
      }
      return;
    }
    if (!mod && (inInput || inList)) {
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? 10 : e.key === 'PageUp' ? -10 : 0;
      if (step && !(inInput && target !== this.query && target !== this.replace && target !== this.mask)) {
        e.preventDefault();
        this.select(this.selected < 0 ? 0 : this.selected + step, true);
        return;
      }
      if (inList && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const row = this.rows[this.selected];
        if (row?.kind === 'file' && this.form.grouped) {
          e.preventDefault();
          if (e.key === 'ArrowLeft') this.collapsed.add(row.file.path);
          else this.collapsed.delete(row.file.path);
          const i = this.selected;
          this.rebuildRows();
          this.select(i, true);
        }
        return;
      }
    }
    if (inList && this.replaceMode && (e.key === 'Delete' || e.key === 'Backspace')) {
      const row = this.rows[this.selected];
      if (!row) return;
      e.preventDefault();
      if (row.kind === 'file') this.toggleExclude('file', row.file.path, 0);
      else this.toggleExclude('match', row.file.path, row.match.line);
      return;
    }
    // Mod-Shift-f and Mod-Shift-r run their commands (they call `open` again).
  }

  /** Runs a search that waits for the debounce. Returns true when it did. */
  private runPending(): boolean {
    if (!this.pending) return false;
    this.runDebounced.cancel();
    this.run();
    return true;
  }

  private pending = false;

  private scheduleRun(): void {
    this.pending = true;
    this.runDebounced();
  }

  // --- Replace -----------------------------------------------------------------------------------

  private updateActions(): void {
    const p = this.replaceMode ? this.compiled() : null;
    const bad = p && !p.ok ? p : null;
    const counts = countResults(this.files, this.exclusions);
    const canRun = !!p?.ok && !this.running && !this.busy;
    const row = this.rows[this.selected];
    const rowIncluded = row?.kind === 'match' && !isExcluded(this.exclusions, row.file.path, row.match.line);
    this.replaceBtn.disabled = !(canRun && rowIncluded);
    this.replaceAllBtn.disabled = !(canRun && counts.matches > 0);
    this.footerHint.textContent = bad
      ? `This pattern cannot be used to replace: ${bad.error}`
      : counts.matches
        ? `Delete excludes the selected match. ${counts.matches.toLocaleString('en-US')} to replace.`
        : 'Delete excludes the selected match.';
    this.footerHint.classList.toggle('find-error-text', !!bad);
  }

  private async replaceSelected(): Promise<void> {
    const row = this.rows[this.selected];
    if (row?.kind !== 'match') return;
    const targets = targetsOf({ ...row.file, matches: [row.match] }, newExclusions());
    await this.apply([{ path: row.file.path, targets }], { keepExclusions: true, selection: this.selected });
  }

  private async replaceAll(): Promise<void> {
    const counts = countResults(this.files, this.exclusions);
    if (!counts.matches) return;
    this.busy = true;
    this.updateActions();
    let choice: string | null;
    try {
      choice = await this.ctx.ui.confirm({
        title: 'Replace in Files',
        message: `Replace ${counts.matches.toLocaleString('en-US')} match${counts.matches === 1 ? '' : 'es'} in ${counts.files.toLocaleString('en-US')} file${counts.files === 1 ? '' : 's'}?`,
        buttons: ['Replace All', 'Cancel'],
      });
    } finally {
      this.busy = false;
    }
    if (choice !== 'Replace All') {
      this.updateActions();
      if (this.isOpen) this.query.focus();
      return;
    }
    const jobs: ReplaceJob[] = [];
    for (const file of this.files) {
      if (this.exclusions.files.has(file.path)) continue;
      const targets = targetsOf(file, this.exclusions);
      if (targets.some((t) => !t.excluded)) jobs.push({ path: file.path, targets });
    }
    await this.apply(jobs, { keepExclusions: false, selection: -1 });
  }

  private async apply(jobs: ReplaceJob[], after: { keepExclusions: boolean; selection: number }): Promise<void> {
    const p = this.compiled();
    if (!p.ok || !jobs.length) return;
    this.busy = true;
    this.updateActions();
    this.countEl.textContent = 'Replacing...';
    try {
      const report = await runReplace(this.ctx, jobs, p.re, this.replaceOptions(), (done, total) => {
        this.countEl.textContent = `Replacing... ${done} of ${total} files`;
      });
      this.remember('replace', this.form.replace);
      this.remember('query', this.form.query);
      this.report(report);
    } catch (e) {
      this.ctx.ui.notify(`Replace failed: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
    } finally {
      this.busy = false;
    }
    if (this.isOpen) this.run({ exclusions: after.keepExclusions, selection: after.selection });
  }

  private report(r: Awaited<ReturnType<typeof runReplace>>): void {
    const lines = [`Replaced ${r.replaced.toLocaleString('en-US')} match${r.replaced === 1 ? '' : 'es'} in ${r.files.toLocaleString('en-US')} file${r.files === 1 ? '' : 's'}.`];
    if (r.missed) lines.push(`${r.missed} match${r.missed === 1 ? ' was' : 'es were'} not found any more and ${r.missed === 1 ? 'was' : 'were'} skipped.`);
    if (r.unsaved.length && this.ctx.settings.get('files.autoSave') === 'off') {
      lines.push(`${r.unsaved.length} open file${r.unsaved.length === 1 ? ' is' : 's are'} not saved. Use Save All.`);
    }
    if (r.skipped.length) {
      lines.push('Skipped files:');
      for (const s of r.skipped.slice(0, 8)) lines.push(`${basename(s.path)}: ${s.reason}`);
      if (r.skipped.length > 8) lines.push(`and ${r.skipped.length - 8} more.`);
    }
    this.ctx.ui.notify(lines.join('\n'), { kind: r.skipped.length || r.missed ? 'warn' : 'info', timeoutMs: r.skipped.length ? 0 : 6000 });
  }
}

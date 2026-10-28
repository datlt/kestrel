// The Search sidebar view: find in files with streamed, virtualized results.

import { CaseSensitive, ChevronDown, ChevronRight, Ellipsis, Regex, WholeWord, createElement } from 'lucide';
import type { AppContext, Disposable, ViewInstance } from '../../core/types';
import { h } from '../../core/dom';
import { basename, debounce, dirname, rafThrottle, samePath } from '../../core/util';
import {
  searchCancel,
  searchText,
  type FileMatches,
  type LineMatch,
  type SearchContext,
  type TextSearchEvent,
} from '../../ipc/search';
import { highlightSegments, splitGlobs } from './query';
import { buildSearchRequest, passesPostFilter, type ScopeSpec } from './scope';
import type { FindWindowPayload } from './find-window';
import { fileIcon } from '../../ui/file-icons';
import './search.css';

const ROW_HEIGHT = 22;
const OVERSCAN = 8;
const OPTIONS_KEY = 'search.options';
const INCLUDE_KEY = 'search.include';
const EXCLUDE_KEY = 'search.exclude';

interface FileGroup {
  path: string;
  rel: string;
  name: string;
  dir: string;
  matches: LineMatch[];
  collapsed: boolean;
}

type Row = { kind: 'file'; group: FileGroup } | { kind: 'match'; group: FileGroup; match: LineMatch };

interface Options {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export class SearchView implements ViewInstance {
  private readonly input: HTMLInputElement;
  private readonly include: HTMLInputElement;
  private readonly exclude: HTMLInputElement;
  private readonly details: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly toggles = new Map<keyof Options, HTMLButtonElement>();
  private options: Options;
  /** Scope that came from the Find in Files popup. null: the whole project. */
  private scope: ScopeSpec | null = null;
  private context: SearchContext = 'anywhere';
  private readonly chip: HTMLElement;

  private groups: FileGroup[] = [];
  private rows: Row[] = [];
  private readonly rendered = new Map<number, HTMLElement>();
  private selected = -1;

  /** Number of the newest search. Events of older searches are ignored. */
  private seq = 0;
  private searchId: number | null = null;
  /** Scope of the running search, for the post filter. */
  private postFilter: ScopeSpec | null = null;
  private running = false;
  private totalMatches = 0;

  private readonly resizeObserver: ResizeObserver;
  private readonly workspaceSub: Disposable;

  private readonly scheduleRender = rafThrottle(() => this.render());
  private readonly runDebounced = debounce(() => this.run(), 300);

  constructor(
    private readonly ctx: AppContext,
    host: HTMLElement,
  ) {
    this.options = { matchCase: false, wholeWord: false, regex: false, ...ctx.workspace.globalState.get<Options>(OPTIONS_KEY) };

    this.input = h('input', {
      class: 'search-input',
      type: 'text',
      placeholder: 'Search',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Search query',
    });
    this.include = this.glob('files to include', 'e.g. *.ts, src/features');
    this.exclude = this.glob('files to exclude', 'e.g. dist, *.min.js');
    this.include.value = ctx.workspace.state.get<string>(INCLUDE_KEY) ?? '';
    this.exclude.value = ctx.workspace.state.get<string>(EXCLUDE_KEY) ?? '';

    const toggle = (key: keyof Options, icon: Parameters<typeof createElement>[0], title: string) => {
      const b = h('button', { class: 'search-toggle', type: 'button', title, 'aria-label': title });
      b.append(createElement(icon));
      b.addEventListener('click', () => {
        this.options[key] = !this.options[key];
        ctx.workspace.globalState.set(OPTIONS_KEY, this.options);
        this.syncToggles();
        this.run();
      });
      this.toggles.set(key, b);
      return b;
    };
    const detailsButton = h('button', { class: 'search-toggle search-toggle-details', type: 'button', title: 'Toggle include and exclude filters', 'aria-label': 'Toggle include and exclude filters' });
    detailsButton.append(createElement(Ellipsis));
    detailsButton.addEventListener('click', () => {
      this.details.hidden = !this.details.hidden;
      detailsButton.setAttribute('aria-pressed', String(!this.details.hidden));
    });

    const queryField = h(
      'div',
      { class: 'search-field' },
      this.input,
      toggle('matchCase', CaseSensitive, 'Match case'),
      toggle('wholeWord', WholeWord, 'Match whole word'),
      toggle('regex', Regex, 'Use regular expression'),
    );
    this.details = h(
      'div',
      { class: 'search-details' },
      h('label', { class: 'search-label' }, 'Files to include'),
      h('div', { class: 'search-field' }, this.include),
      h('label', { class: 'search-label' }, 'Files to exclude'),
      h('div', { class: 'search-field' }, this.exclude),
    );
    this.details.hidden = !(this.include.value || this.exclude.value);
    detailsButton.setAttribute('aria-pressed', String(!this.details.hidden));

    this.chip = h('div', { class: 'search-chip-row' });
    this.chip.hidden = true;
    this.summary = h('div', { class: 'search-summary' });
    this.spacer = h('div', { class: 'search-spacer' });
    this.scroller = h('div', { class: 'search-results', tabindex: '0', role: 'tree', 'aria-label': 'Search results' }, this.spacer);

    host.classList.add('search-view');
    host.append(
      h('div', { class: 'search-form' }, h('div', { class: 'search-query-row' }, queryField, detailsButton), this.details, this.chip),
      this.summary,
      this.scroller,
    );
    this.syncToggles();

    // Do not search for half-typed IME text. `compositionend` starts the search.
    this.input.addEventListener('input', (e) => {
      if (!(e as InputEvent).isComposing) this.runDebounced();
    });
    this.input.addEventListener('compositionend', () => this.runDebounced());
    this.input.addEventListener('keydown', (e) => {
      // Keys during IME composition belong to the IME (Enter confirms the text).
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        this.runDebounced.cancel();
        this.run();
      } else if (e.key === 'Escape') {
        this.cancel();
        this.finish();
      } else if (e.key === 'ArrowDown' && this.rows.length) {
        e.preventDefault();
        this.scroller.focus();
        this.select(Math.max(0, this.selected));
      }
    });
    for (const el of [this.include, this.exclude]) {
      el.addEventListener('input', (e) => {
        ctx.workspace.state.set(el === this.include ? INCLUDE_KEY : EXCLUDE_KEY, el.value);
        if (!(e as InputEvent).isComposing) this.runDebounced();
      });
      el.addEventListener('compositionend', () => this.runDebounced());
      el.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') {
          this.runDebounced.cancel();
          this.run();
        }
      });
    }

    this.scroller.addEventListener('scroll', this.scheduleRender, { passive: true });
    this.scroller.addEventListener('click', (e) => this.onClick(e));
    this.scroller.addEventListener('keydown', (e) => this.onKey(e));
    this.resizeObserver = new ResizeObserver(this.scheduleRender);
    this.resizeObserver.observe(this.scroller);

    this.workspaceSub = ctx.bus.on('workspace:changed', () => {
      this.cancel();
      this.reset();
      this.include.value = ctx.workspace.state.get<string>(INCLUDE_KEY) ?? '';
      this.exclude.value = ctx.workspace.state.get<string>(EXCLUDE_KEY) ?? '';
      this.setSummary('');
    });
  }

  // --- Public ---------------------------------------------------------

  /** Called by the `search.findInFiles` command. */
  activate(text?: string | null): void {
    if (text) {
      this.input.value = text;
      this.runDebounced.cancel();
      this.run();
    }
    this.focus();
  }

  /** Fills the view with the query, options, scope and results of the popup. Does not search. */
  load(p: FindWindowPayload): void {
    this.cancel();
    this.input.value = p.query;
    this.options = { ...p.options };
    this.ctx.workspace.globalState.set(OPTIONS_KEY, this.options);
    this.syncToggles();
    this.include.value = p.include;
    this.exclude.value = p.exclude;
    this.ctx.workspace.state.set(INCLUDE_KEY, p.include);
    this.ctx.workspace.state.set(EXCLUDE_KEY, p.exclude);
    this.details.hidden = !(p.include || p.exclude);
    const custom = p.scope.label !== 'In Project' || p.context !== 'anywhere';
    this.scope = custom ? p.scope : null;
    this.context = p.context;
    this.showChip();
    this.reset();
    for (const f of p.files) {
      this.groups.push({
        path: f.path,
        rel: f.rel,
        name: f.name,
        dir: f.dir,
        matches: f.matches,
        collapsed: false,
      });
      this.totalMatches += f.matches.length;
    }
    this.rebuildRows();
    const files = this.groups.length;
    const plus = p.truncated ? ' (limit reached, refine the search)' : '';
    this.setSummary(
      this.totalMatches
        ? `${this.totalMatches.toLocaleString()} result${this.totalMatches === 1 ? '' : 's'} in ${files.toLocaleString()} file${files === 1 ? '' : 's'}${plus}`
        : p.query
          ? 'No results found.'
          : '',
    );
    this.focus();
  }

  private showChip(): void {
    this.chip.replaceChildren();
    const parts: string[] = [];
    if (this.scope && this.scope.label !== 'In Project') parts.push(this.scope.label);
    if (this.context !== 'anywhere') parts.push(this.context);
    this.chip.hidden = !parts.length;
    if (!parts.length) return;
    const clear = h('button', { class: 'search-chip-clear', type: 'button', title: 'Search the whole project again', 'aria-label': 'Clear the scope' }, '\u00d7');
    clear.addEventListener('click', () => {
      this.scope = null;
      this.context = 'anywhere';
      this.showChip();
      this.run();
    });
    this.chip.append(h('span', { class: 'search-chip' }, `Scope: ${parts.join(', ')}`), clear);
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  dispose(): void {
    this.cancel();
    this.resizeObserver.disconnect();
    this.workspaceSub.dispose();
  }

  // --- Form -----------------------------------------------------------

  private glob(label: string, placeholder: string): HTMLInputElement {
    return h('input', { class: 'search-input', type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': label });
  }

  private syncToggles(): void {
    for (const [key, b] of this.toggles) b.setAttribute('aria-pressed', String(this.options[key]));
  }

  // --- Running a search -------------------------------------------------

  private cancel(): void {
    this.seq++;
    this.runDebounced.cancel();
    const id = this.searchId;
    this.searchId = null;
    if (id !== null) searchCancel(id).catch(() => {});
  }

  private run(): void {
    this.cancel();
    const root = this.ctx.workspace.root;
    const query = this.input.value;
    this.reset();
    if (!root || !query) {
      this.finish();
      this.setSummary(root ? '' : 'Open a folder to search.');
      return;
    }
    const seq = this.seq;
    this.running = true;
    this.totalMatches = 0;
    const scope: ScopeSpec = this.scope ?? { label: 'In Project', root, include: [], exclude: [], postFilter: null };
    if (scope.empty) {
      this.finish();
      this.setSummary(scope.empty);
      return;
    }
    const req = buildSearchRequest(scope, { include: splitGlobs(this.include.value), exclude: splitGlobs(this.exclude.value) });
    this.postFilter = scope;
    this.setSummary('Searching…');
    searchText(
      req.root,
      {
        query,
        regex: this.options.regex,
        matchCase: this.options.matchCase,
        wholeWord: this.options.wholeWord,
        include: req.include,
        exclude: req.exclude,
        maxResults: this.ctx.settings.get('search.maxResults') ?? 20000,
        ...(req.paths ? { paths: req.paths } : {}),
        context: this.context,
      },
      (e) => {
        if (seq === this.seq) this.onEvent(e);
      },
    )
      .then((id) => {
        if (seq === this.seq) this.searchId = id;
        else searchCancel(id).catch(() => {});
      })
      .catch((e) => {
        if (seq !== this.seq) return;
        this.finish();
        this.setSummary(e instanceof Error ? e.message : String(e), true);
      });
  }

  private onEvent(e: TextSearchEvent): void {
    if (e.type === 'batch') {
      for (const f of e.files) this.addFile(f);
      this.setSummary(`Searching… ${this.totalMatches.toLocaleString()} results`);
      this.scheduleRender();
    } else if (e.type === 'done') {
      this.finish();
      // The walk is parallel, so files arrive in any order. Sort them once at the end.
      this.groups.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      this.rebuildRows();
      const files = this.groups.length;
      if (this.totalMatches === 0) {
        this.setSummary('No results found.');
      } else {
        const limit = e.truncated ? ' (limit reached, refine the search)' : '';
        this.setSummary(`${this.totalMatches.toLocaleString()} result${this.totalMatches === 1 ? '' : 's'} in ${files.toLocaleString()} file${files === 1 ? '' : 's'}${limit}`);
      }
    } else {
      this.finish();
      this.setSummary(e.message, true);
    }
  }

  private finish(): void {
    this.running = false;
    this.searchId = null;
  }

  private setSummary(text: string, error = false): void {
    this.summary.textContent = text;
    this.summary.classList.toggle('search-error', error);
    this.summary.hidden = !text;
  }

  // --- Result model -----------------------------------------------------

  private reset(): void {
    this.groups = [];
    this.rows = [];
    this.selected = -1;
    this.totalMatches = 0;
    this.redrawAll();
  }

  private addFile(f: FileMatches): void {
    const root = this.ctx.workspace.root ?? '';
    if (this.postFilter && !passesPostFilter(this.postFilter.postFilter, f.path, root)) return;
    const rel = this.ctx.workspace.relative(f.path).replace(/\\/g, '/');
    const group: FileGroup = {
      path: f.path,
      rel,
      name: basename(f.path),
      dir: samePath(rel, f.path) ? dirname(f.path) : dirname(rel),
      matches: f.matches,
      collapsed: false,
    };
    this.groups.push(group);
    this.totalMatches += f.matches.length;
    this.rows.push({ kind: 'file', group });
    for (const match of f.matches) this.rows.push({ kind: 'match', group, match });
  }

  private rebuildRows(): void {
    const rows: Row[] = [];
    for (const group of this.groups) {
      rows.push({ kind: 'file', group });
      if (group.collapsed) continue;
      for (const match of group.matches) rows.push({ kind: 'match', group, match });
    }
    this.rows = rows;
    this.selected = Math.min(this.selected, rows.length - 1);
    this.redrawAll();
  }

  // --- Virtual list -----------------------------------------------------

  private redrawAll(): void {
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
    this.render();
  }

  private render(): void {
    this.spacer.style.height = `${this.rows.length * ROW_HEIGHT}px`;
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight || 400;
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

  private makeRow(index: number, row: Row): HTMLElement {
    const el = h('div', { class: 'search-row', 'data-index': index, style: `top:${index * ROW_HEIGHT}px` });
    el.classList.toggle('search-selected', index === this.selected);
    if (row.kind === 'file') {
      const g = row.group;
      el.classList.add('search-file');
      el.setAttribute('role', 'treeitem');
      el.setAttribute('aria-expanded', String(!g.collapsed));
      el.title = g.rel;
      const chevron = h('span', { class: 'search-chevron' });
      chevron.append(createElement(g.collapsed ? ChevronRight : ChevronDown));
      el.append(
        chevron,
        fileIcon(g.name),
        h('span', { class: 'search-file-name' }, g.name),
        h('span', { class: 'search-file-dir' }, g.dir),
        h('span', { class: 'search-count' }, String(g.matches.length)),
      );
    } else {
      el.classList.add('search-match');
      el.setAttribute('role', 'treeitem');
      const line = h('span', { class: 'search-line' });
      for (const seg of highlightSegments(row.match.text, row.match.ranges)) {
        if (seg.hit) line.append(h('span', { class: 'search-hit' }, seg.text));
        else line.append(seg.text);
      }
      el.title = `${row.group.rel}:${row.match.line}`;
      el.append(line);
    }
    return el;
  }

  private select(index: number): void {
    if (!this.rows.length) return;
    index = Math.min(Math.max(index, 0), this.rows.length - 1);
    this.rendered.get(this.selected)?.classList.remove('search-selected');
    this.selected = index;
    const top = index * ROW_HEIGHT;
    const view = this.scroller.clientHeight;
    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > this.scroller.scrollTop + view) this.scroller.scrollTop = top + ROW_HEIGHT - view;
    this.render();
    this.rendered.get(index)?.classList.add('search-selected');
  }

  // --- Interaction ------------------------------------------------------

  private onClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.search-row');
    if (!el) return;
    const index = Number(el.dataset.index);
    this.select(index);
    this.activateRow(index, e.detail >= 2);
  }

  private onKey(e: KeyboardEvent): void {
    const row = this.rows[this.selected];
    switch (e.key) {
      case 'ArrowDown':
        this.select(this.selected + 1);
        break;
      case 'ArrowUp':
        if (this.selected <= 0) this.input.focus();
        else this.select(this.selected - 1);
        break;
      case 'Enter':
        if (row) this.activateRow(this.selected, true);
        break;
      case 'ArrowLeft':
        if (row && row.kind === 'file' && !row.group.collapsed) this.toggle(row.group);
        else if (row?.kind === 'match') this.select(this.rows.findIndex((r) => r.kind === 'file' && r.group === row.group));
        break;
      case 'ArrowRight':
        if (row?.kind === 'file' && row.group.collapsed) this.toggle(row.group);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  private toggle(group: FileGroup): void {
    group.collapsed = !group.collapsed;
    const index = this.rows.findIndex((r) => r.kind === 'file' && r.group === group);
    this.rebuildRows();
    this.selected = index;
    this.rendered.get(index)?.classList.add('search-selected');
  }

  private activateRow(index: number, focusEditor: boolean): void {
    const row = this.rows[index];
    if (!row) return;
    if (row.kind === 'file') this.toggle(row.group);
    else void this.openMatch(row.group, row.match, focusEditor);
  }

  /** Opens the file at the match and selects the matched text. */
  private async openMatch(group: FileGroup, m: LineMatch, focusEditor: boolean): Promise<void> {
    const first = m.ranges[0] ?? [0, 0];
    const column = m.offset + first[0] + 1;
    let editor;
    try {
      editor = await this.ctx.editors.openFile(group.path, { line: m.line, column, preview: true });
    } catch (e) {
      this.ctx.ui.notify(`Cannot open ${group.rel}: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
      return;
    }
    if (!editor) return;
    const doc = editor.view.state.doc;
    const line = doc.line(Math.min(Math.max(m.line, 1), doc.lines));
    const from = Math.min(line.from + m.offset + first[0], line.to);
    const to = Math.min(line.from + m.offset + first[1], line.to);
    editor.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    if (focusEditor) editor.focus();
  }
}

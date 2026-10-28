// The Search Everywhere popup: tab strip, query field, filter menu, virtualized
// list and status line. All state lives inside `createPopup(ctx)`, so every
// workbench has its own popup (docs/DESIGN.md, 8.1 and 13.4).

import {
  AtSign,
  Blocks,
  Box,
  Braces,
  ChevronRight,
  CircleDot,
  Cog,
  Cuboid,
  Diamond,
  Funnel,
  Hash,
  Key,
  ListTree,
  Puzzle,
  SquareFunction,
  Tag,
  TextSearch,
  Type,
  Variable,
  Workflow,
  Zap,
  createElement,
} from 'lucide';
import { h } from '../../core/dom';
import type { AppContext } from '../../core/types';
import { fileIcon } from '../../ui/file-icons';
import { overlayClosed, overlayOpened } from '../../shell/overlay-count';
import { joinPath } from '../../core/util';
import { SearchRun, type RunStatus } from './fetch';
import {
  CLASS_KINDS,
  FILTER_KEY,
  FILTER_LANGS,
  SYMBOL_KINDS,
  isFilterActive,
  readFilter,
  toggleIn,
  type GotoFilter,
} from './filter';
import { langBadge } from './lsp-map';
import { groupAll } from './merge';
import { parseLineSuffix } from './query';
import { addRecent, readRecent, RECENT_KEY, type RecentEntry } from './recent';
import {
  TAB_ORDER,
  TAB_TITLES,
  recentFromClassRow,
  type ClassRow,
  type Group,
  type Row,
  type TabId,
} from './rows';
import { moveSelection, firstSelectable, type MoveKey } from './selection';

const ROW_HEIGHT = 28;
const MAX_VISIBLE_ROWS = 12;
const OVERSCAN = 4;
const DEBOUNCE_MS = 80;
const BUSY_DELAY_MS = 150;
const ALL_FETCH_LIMIT = 20;
const TAB_FETCH_LIMIT = 200;
const SELECTION_MAX_CHARS = 100;
const RECENT_ACTIONS_KEY = 'goto.recentActions';
const RECENT_ACTIONS_MAX = 30;
const PALETTE_RECENT_KEY = 'shell.recentCommands';

export interface Popup {
  /** Opens the popup on a tab. When it is open already, it switches to the tab. */
  open(tab: TabId): void;
  isOpen(): boolean;
  currentTab(): TabId;
  close(): void;
  dispose(): void;
}

type IconNode = Parameters<typeof createElement>[0];

const CLASS_ICONS: Record<string, IconNode> = {
  class: Box,
  interface: CircleDot,
  enum: ListTree,
  record: Braces,
  annotation: AtSign,
  object: Cuboid,
  struct: Blocks,
  protocol: Diamond,
  actor: Workflow,
  extension: Puzzle,
  typeAlias: Type,
};

const SYMBOL_ICONS: Record<string, IconNode> = {
  method: SquareFunction,
  function: SquareFunction,
  constructor: Cog,
  field: Variable,
  variable: Variable,
  property: Key,
  enumCase: Hash,
};

const KIND_LABELS: Record<string, string> = {
  typeAlias: 'Type alias',
  enumCase: 'Enum case',
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Text with the matched characters in bold, built without innerHTML. */
function highlighted(text: string, indexes: readonly number[] | undefined): Node {
  if (!indexes?.length) return document.createTextNode(text);
  const frag = document.createDocumentFragment();
  const set = new Set(indexes);
  let i = 0;
  while (i < text.length) {
    const on = set.has(i);
    let j = i + 1;
    while (j < text.length && set.has(j) === on) j++;
    const part = text.slice(i, j);
    if (on) frag.append(h('b', { class: 'goto-hl' }, part));
    else frag.append(part);
    i = j;
  }
  return frag;
}

/** Indexes covered by `[start, end)` ranges. */
function rangeIndexes(ranges: readonly [number, number][], max: number): number[] {
  const out: number[] = [];
  for (const [s, e] of ranges) for (let i = s; i < e && i < max; i++) out.push(i);
  return out;
}

/** The layer of this workbench for popups. It is in the root element, so a hidden workbench never shows it. */
function findLayer(ctx: AppContext): HTMLElement | null {
  let el: HTMLElement | null = ctx.editors.active()?.view.dom ?? null;
  while (el) {
    const layer = el.querySelector<HTMLElement>(':scope > .shell-overlays');
    if (layer) return layer;
    el = el.parentElement;
  }
  const all = [...document.querySelectorAll<HTMLElement>('.shell-overlays')];
  return all.find((l) => l.getClientRects().length > 0) ?? null;
}

/** The first line of the editor selection, when it is one short line. */
function selectionQuery(ctx: AppContext): string | null {
  const view = ctx.editors.active()?.view;
  if (!view) return null;
  const sel = view.state.selection.main;
  if (sel.empty || sel.to - sel.from > SELECTION_MAX_CHARS * 4) return null;
  const text = view.state.sliceDoc(sel.from, sel.to);
  if (text.includes('\n') || text.includes('\r')) return null;
  const trimmed = text.trim();
  return trimmed && trimmed.length <= SELECTION_MAX_CHARS ? trimmed : null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createPopup(ctx: AppContext): Popup {
  const GROUPS: Group[] = ['classes', 'files', 'symbols', 'actions'];
  /** The last query of each tab. It stays after the popup closes. */
  const queries: Record<TabId, string> = { all: '', classes: '', files: '', symbols: '', actions: '', text: '' };
  let tab: TabId = 'all';

  // Open state. All of it is reset by close().
  let backdrop: HTMLElement | null = null;
  let layer: HTMLElement | null = null;
  let input!: HTMLInputElement;
  let list!: HTMLElement;
  let spacer!: HTMLElement;
  let statusEl!: HTMLElement;
  let busyEl!: HTMLElement;
  let menuEl!: HTMLElement;
  let filterBtn!: HTMLButtonElement;
  const tabButtons = new Map<TabId, HTMLElement>();
  let previousFocus: HTMLElement | null = null;

  let filter: GotoFilter = readFilter(ctx.workspace.globalState.get(FILTER_KEY));
  let groups: Record<Group, Row[]> = emptyGroups();
  let more: Partial<Record<Group, boolean>> = {};
  let textRows: Row[] = [];
  let rows: Row[] = [];
  let active = -1;
  let userMoved = false;
  let status: RunStatus = {};
  let pending = false;
  let lineTarget: { line: number; column?: number } | null = null;
  let run: SearchRun | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let busyTimer: ReturnType<typeof setTimeout> | undefined;
  const visible = new Map<number, HTMLElement>();

  function emptyGroups(): Record<Group, Row[]> {
    return { classes: [], files: [], symbols: [], actions: [] };
  }

  // ---- recent files -----------------------------------------------------------

  const fileOpened = ctx.bus.on('file:opened', ({ path }) => {
    const root = ctx.workspace.root;
    if (!root || path.startsWith('untitled:')) return;
    const rel = ctx.workspace.relative(path);
    if (rel === path) return; // outside the folder
    remember({ type: 'file', key: rel });
  });

  function remember(entry: RecentEntry): void {
    const list = readRecent(ctx.workspace.state.get(RECENT_KEY));
    ctx.workspace.state.set(RECENT_KEY, addRecent(list, entry));
  }

  function recentActionIds(): string[] {
    const mine = ctx.workspace.globalState.get<string[]>(RECENT_ACTIONS_KEY) ?? [];
    const palette = ctx.workspace.globalState.get<string[]>(PALETTE_RECENT_KEY) ?? [];
    return [...new Set([...mine, ...palette])];
  }

  function rememberAction(id: string): void {
    const mine = ctx.workspace.globalState.get<string[]>(RECENT_ACTIONS_KEY) ?? [];
    ctx.workspace.globalState.set(RECENT_ACTIONS_KEY, [id, ...mine.filter((x) => x !== id)].slice(0, RECENT_ACTIONS_MAX));
  }

  // ---- rows ---------------------------------------------------------------------

  function buildRows(): Row[] {
    if (tab === 'all') return groupAll(groups, 5, more);
    if (tab === 'text') return textRows;
    return groups[tab];
  }

  function setRows(next: Row[]): void {
    const previousKey = rows[active]?.key;
    rows = next;
    let idx = -1;
    if (userMoved && previousKey !== undefined) idx = rows.findIndex((r) => r.key === previousKey);
    if (idx < 0 || rows[idx]?.type === 'header') idx = firstSelectable(rows);
    active = idx;
    if (!userMoved) list.scrollTop = 0;
    resetRows();
    renderStatus();
  }

  function rebuild(): void {
    setRows(buildRows());
  }

  // ---- list rendering -----------------------------------------------------------

  function viewportHeight(): number {
    return Math.min(rows.length, MAX_VISIBLE_ROWS) * ROW_HEIGHT;
  }

  function resetRows(): void {
    for (const el of visible.values()) el.remove();
    visible.clear();
    spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
    list.style.height = `${viewportHeight()}px`;
    list.hidden = rows.length === 0;
    paint();
  }

  function paint(): void {
    const vh = viewportHeight();
    const top = list.scrollTop;
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(rows.length, Math.ceil((top + vh) / ROW_HEIGHT) + OVERSCAN);
    for (const [i, el] of visible) {
      if (i < start || i >= end) {
        el.remove();
        visible.delete(i);
      }
    }
    for (let i = start; i < end; i++) {
      if (visible.has(i)) continue;
      const el = buildRow(i);
      visible.set(i, el);
      spacer.append(el);
    }
  }

  function icon(node: IconNode, cls: string): HTMLElement {
    return h('span', { class: `goto-icon ${cls}` }, createElement(node));
  }

  function buildRow(i: number): HTMLElement {
    const row = rows[i];
    let el: HTMLElement;
    switch (row.type) {
      case 'header':
        el = h('div', { class: 'goto-row goto-header' }, row.title);
        break;
      case 'more':
        el = h(
          'div',
          { class: 'goto-row goto-more' },
          icon(ChevronRight, 'goto-k-muted'),
          h('span', { class: 'goto-name' }, row.title),
        );
        break;
      case 'findWindow':
        el = h(
          'div',
          { class: 'goto-row goto-more' },
          icon(TextSearch, 'goto-k-muted'),
          h('span', { class: 'goto-name' }, 'Open in Find Window'),
        );
        break;
      case 'class':
        el = h(
          'div',
          { class: 'goto-row' },
          icon(CLASS_ICONS[row.kind] ?? Box, `goto-k-${row.kind}`),
          h('span', { class: 'goto-name' }, highlighted(row.name, row.nameMatches)),
          row.container ? h('span', { class: 'goto-sub' }, highlighted(row.container, row.containerMatches)) : null,
          h('span', { class: 'goto-spacer' }),
          row.test ? h('span', { class: 'goto-tag' }, 'test') : null,
          h('span', { class: 'goto-badge' }, langBadge(row.lang)),
        );
        break;
      case 'symbol': {
        const callable = row.kind === 'method' || row.kind === 'function' || row.kind === 'constructor';
        el = h(
          'div',
          { class: 'goto-row' },
          icon(SYMBOL_ICONS[row.kind] ?? Variable, `goto-k-${row.kind}`),
          h('span', { class: 'goto-name' }, highlighted(row.name, row.nameMatches)),
          callable ? h('span', { class: 'goto-params' }, `(${row.params})`) : null,
          row.valueType ? h('span', { class: 'goto-params' }, `: ${row.valueType}`) : null,
          row.owner ? h('span', { class: 'goto-sub' }, row.owner) : null,
          h('span', { class: 'goto-spacer' }),
          row.test ? h('span', { class: 'goto-tag' }, 'test') : null,
          h('span', { class: 'goto-badge' }, langBadge(row.lang)),
        );
        break;
      }
      case 'file':
        el = h(
          'div',
          { class: 'goto-row' },
          h('span', { class: 'goto-icon' }, fileIcon(row.name)),
          h('span', { class: 'goto-name' }, highlighted(row.name, row.nameMatches)),
          row.folder ? h('span', { class: 'goto-sub' }, highlighted(row.folder, row.folderMatches)) : null,
        );
        break;
      case 'action':
        el = h(
          'div',
          { class: 'goto-row' },
          icon(Zap, 'goto-k-action'),
          h('span', { class: 'goto-name' }, highlighted(row.title, row.nameMatches)),
          row.category ? h('span', { class: 'goto-sub' }, row.category) : null,
          h('span', { class: 'goto-spacer' }),
          row.keyLabel ? h('span', { class: 'goto-key' }, row.keyLabel) : null,
        );
        break;
      case 'text':
        el = h(
          'div',
          { class: 'goto-row' },
          icon(Tag, 'goto-k-muted'),
          h('span', { class: 'goto-name goto-code' }, highlighted(row.text, rangeIndexes(row.ranges, row.text.length))),
          h('span', { class: 'goto-spacer' }),
          h('span', { class: 'goto-where' }, `${row.rel.slice(row.rel.lastIndexOf('/') + 1)}:${row.line}`),
        );
        break;
    }
    el.dataset.i = String(i);
    el.style.top = `${i * ROW_HEIGHT}px`;
    el.setAttribute('role', row.type === 'header' ? 'presentation' : 'option');
    if (row.type !== 'header') {
      el.classList.toggle('goto-active', i === active);
      el.setAttribute('aria-selected', String(i === active));
    }
    if (row.type === 'text') el.title = `${row.rel}:${row.line}`;
    return el;
  }

  function setActive(next: number, reveal = true): void {
    if (next < 0 || next === active) return;
    const prev = active;
    active = next;
    for (const [i, el] of visible) {
      if (i === prev || i === next) {
        el.classList.toggle('goto-active', i === next);
        el.setAttribute('aria-selected', String(i === next));
      }
    }
    if (reveal) {
      const top = next * ROW_HEIGHT;
      const vh = viewportHeight();
      // A header above the first row of a group stays visible when the selection moves up.
      const wantTop = rows[next - 1]?.type === 'header' ? top - ROW_HEIGHT : top;
      if (wantTop < list.scrollTop) list.scrollTop = Math.max(0, wantTop);
      else if (top + ROW_HEIGHT > list.scrollTop + vh) list.scrollTop = top + ROW_HEIGHT - vh;
      paint();
    }
  }

  function move(key: MoveKey): void {
    const next = moveSelection(rows, active, key, MAX_VISIBLE_ROWS - 1);
    userMoved = true;
    setActive(next);
  }

  // ---- status line -----------------------------------------------------------------

  function renderStatus(): void {
    const root = ctx.workspace.root;
    const results = rows.filter((r) => r.type !== 'header' && r.type !== 'more' && r.type !== 'findWindow').length;
    let text = '';
    let error = false;
    if (!root && tab !== 'actions') {
      text = 'Open a folder to search its files, classes and text.';
    } else if (status.error) {
      text = status.error;
      error = true;
    } else if (status.building && results === 0) {
      text = "Reading the project's files...";
    } else if (pending && results === 0) {
      text = '';
    } else if (results === 0) {
      if (tab === 'symbols' && !input.value.trim()) text = 'Type a name to search for symbols.';
      else if (tab === 'text' && input.value.trim().length < 2) text = 'Type at least 2 characters to search the text of the files.';
      else if (tab === 'all' && !input.value.trim()) text = 'Type to search classes, files, symbols and actions.';
      else if (tab === 'classes' && !input.value.trim()) text = 'Type a class name.';
      else text = 'No results';
    } else if (status.building) {
      text = "Reading the project's files... The list can grow.";
    } else if (tab !== 'all' && tab !== 'text' && more[tab]) {
      text = 'Showing the first results. Type more of the name to narrow them.';
    }
    statusEl.textContent = text;
    statusEl.hidden = text === '';
    statusEl.classList.toggle('goto-error', error);
  }

  // ---- searching ---------------------------------------------------------------------

  function schedule(immediate: boolean): void {
    clearTimeout(debounceTimer);
    if (immediate) startSearch();
    else debounceTimer = setTimeout(startSearch, DEBOUNCE_MS);
  }

  function startSearch(): void {
    if (!backdrop) return;
    run?.cancel();
    clearTimeout(busyTimer);
    const raw = input.value;
    queries[tab] = raw;
    const parsed = tab === 'actions' || tab === 'text' ? { name: raw } : parseLineSuffix(raw);
    lineTarget = 'line' in parsed && parsed.line ? { line: parsed.line, column: parsed.column } : null;
    userMoved = false;
    status = {};
    pending = true;
    busyTimer = setTimeout(() => busyEl.classList.add('goto-on'), BUSY_DELAY_MS);

    const mine = new SearchRun(
      { ctx, filter, query: parsed.name, recentActions: recentActionIds() },
      {
        group(group, groupRows, hasMore) {
          if (run !== mine || mine.stale) return;
          groups[group] = groupRows;
          more[group] = hasMore;
          rebuild();
        },
        text(next) {
          if (run !== mine || mine.stale) return;
          textRows = next;
          rebuild();
        },
        status(s) {
          if (run !== mine || mine.stale) return;
          status = { ...status, ...s };
          renderStatus();
        },
      },
    );
    run = mine;

    const tasks: Promise<unknown>[] = [];
    const limit = tab === 'all' ? ALL_FETCH_LIMIT : TAB_FETCH_LIMIT;
    if (tab === 'all' || tab === 'classes') tasks.push(mine.classes(limit));
    if (tab === 'all' || tab === 'files') tasks.push(mine.files(limit));
    if (tab === 'all' || tab === 'symbols') tasks.push(mine.symbols(limit));
    if (tab === 'actions' || (tab === 'all' && parsed.name.trim())) mine.actions(limit);
    else if (tab === 'all') groups.actions = [];
    if (tab === 'text') tasks.push(mine.text());
    // Actions answer at once, so show them without waiting for the others.
    if (tab === 'actions') {
      finish(mine);
      return;
    }
    Promise.allSettled(tasks).then(() => finish(mine));
  }

  function finish(mine: SearchRun): void {
    if (run !== mine || mine.stale) return;
    pending = false;
    clearTimeout(busyTimer);
    busyEl.classList.remove('goto-on');
    rebuild();
  }

  // ---- opening a row -----------------------------------------------------------------

  function openPath(path: string, line: number, column: number | undefined, background: boolean): void {
    const target = lineTarget;
    ctx.editors
      .openFile(path, { line: target?.line ?? line, column: target ? target.column : column, activate: !background })
      .catch((e) => ctx.ui.notify(`Cannot open ${ctx.workspace.relative(path)}: ${errorMessage(e)}`, { kind: 'error' }));
  }

  function accept(background: boolean): void {
    const row = rows[active];
    if (!row || row.type === 'header') return;
    switch (row.type) {
      case 'more':
        switchTab(row.group, true);
        return;
      case 'findWindow': {
        const query = row.query;
        close();
        ctx.commands.execute('search.findInFiles', { query }).catch((e) => ctx.ui.notify(`Cannot open Find in Files: ${errorMessage(e)}`, { kind: 'error' }));
        return;
      }
      case 'action': {
        const id = row.id;
        rememberAction(id);
        close();
        ctx.commands.execute(id).catch((e) => {
          console.error(`command ${id} failed`, e);
          ctx.ui.notify(`Command failed: ${errorMessage(e)}`, { kind: 'error' });
        });
        return;
      }
      case 'class': {
        remember(recentFromClassRow(row as ClassRow));
        close();
        openPath(row.path, row.line, row.column, background);
        return;
      }
      case 'symbol':
      case 'text':
        close();
        openPath(row.path, row.line, row.column, background);
        return;
      case 'file': {
        const root = ctx.workspace.root;
        close();
        if (root) openPath(joinPath(root, row.key), 1, undefined, background);
        return;
      }
    }
  }

  // ---- tabs and filter ---------------------------------------------------------------

  function switchTab(next: TabId, keepQuery = false): void {
    if (!backdrop) return;
    if (next !== tab) {
      queries[tab] = input.value;
      tab = next;
      if (!keepQuery) input.value = queries[tab];
      groups = emptyGroups();
      more = {};
      textRows = [];
      rows = [];
      active = -1;
      resetRows();
    }
    renderTabs();
    closeMenu();
    if (!keepQuery) input.select();
    schedule(true);
  }

  function renderTabs(): void {
    for (const [id, el] of tabButtons) {
      el.classList.toggle('goto-on', id === tab);
      el.setAttribute('aria-selected', String(id === tab));
    }
    const filterTab = tab === 'classes' || tab === 'symbols' ? tab : null;
    const on = filterTab !== null && isFilterActive(filter, filterTab);
    filterBtn.hidden = filterTab === null;
    filterBtn.classList.toggle('goto-on', on);
    filterBtn.title = on ? 'Filter (on)' : 'Filter';
  }

  function stepTab(delta: 1 | -1): void {
    const i = TAB_ORDER.indexOf(tab);
    switchTab(TAB_ORDER[(i + delta + TAB_ORDER.length) % TAB_ORDER.length]);
  }

  function saveFilter(next: GotoFilter): void {
    filter = next;
    ctx.workspace.globalState.set(FILTER_KEY, filter);
    renderTabs();
    renderMenu();
    schedule(true);
  }

  function menuItem(label: string, on: boolean, toggle: () => void): HTMLElement {
    const el = h(
      'div',
      { class: 'goto-menu-item' + (on ? ' goto-on' : ''), role: 'menuitemcheckbox', 'aria-checked': String(on) },
      h('span', { class: 'goto-check' }, on ? '✓' : ''),
      label,
    );
    el.addEventListener('click', toggle);
    return el;
  }

  function renderMenu(): void {
    menuEl.textContent = '';
    if (tab !== 'classes' && tab !== 'symbols') return;
    const kinds = tab === 'classes' ? CLASS_KINDS : SYMBOL_KINDS;
    const selected = tab === 'classes' ? filter.classKinds : filter.symbolKinds;
    menuEl.append(h('div', { class: 'goto-menu-title' }, 'Kinds'));
    for (const k of kinds) {
      menuEl.append(
        menuItem(kindLabel(k), selected.includes(k), () =>
          saveFilter(tab === 'classes' ? { ...filter, classKinds: toggleIn(filter.classKinds, k) } : { ...filter, symbolKinds: toggleIn(filter.symbolKinds, k) }),
        ),
      );
    }
    menuEl.append(h('div', { class: 'goto-menu-title' }, 'Languages'));
    for (const l of FILTER_LANGS) {
      menuEl.append(menuItem(l.label, filter.langs.includes(l.id), () => saveFilter({ ...filter, langs: toggleIn(filter.langs, l.id) })));
    }
    menuEl.append(h('div', { class: 'goto-menu-sep' }));
    menuEl.append(menuItem('Hide test code', filter.hideTests, () => saveFilter({ ...filter, hideTests: !filter.hideTests })));
    const reset = h('div', { class: 'goto-menu-item goto-menu-reset' }, h('span', { class: 'goto-check' }), 'Show all');
    reset.addEventListener('click', () => saveFilter({ classKinds: [], symbolKinds: [], langs: [], hideTests: false }));
    menuEl.append(reset);
  }

  function toggleMenu(): void {
    if (menuEl.hidden) {
      renderMenu();
      menuEl.hidden = false;
    } else {
      closeMenu();
    }
  }

  function closeMenu(): void {
    if (menuEl) menuEl.hidden = true;
  }

  // ---- open and close ---------------------------------------------------------------

  function open(want: TabId): void {
    if (backdrop) {
      if (want !== tab) switchTab(want);
      input.focus();
      return;
    }
    layer = findLayer(ctx);
    if (!layer) return;
    previousFocus = document.activeElement as HTMLElement | null;
    tab = want;
    filter = readFilter(ctx.workspace.globalState.get(FILTER_KEY));
    groups = emptyGroups();
    more = {};
    textRows = [];
    rows = [];
    active = -1;
    status = {};
    pending = false;

    input = h('input', {
      class: 'goto-input',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'Search everywhere',
      role: 'combobox',
      'aria-expanded': 'true',
    });
    busyEl = h('div', { class: 'goto-busy' });
    filterBtn = h('button', { class: 'goto-filter', type: 'button', title: 'Filter', 'aria-label': 'Filter' }, createElement(Funnel));
    filterBtn.addEventListener('click', toggleMenu);
    const tabsEl = h('div', { class: 'goto-tabs', role: 'tablist' });
    for (const id of TAB_ORDER) {
      const b = h('button', { class: 'goto-tab', type: 'button', role: 'tab' }, TAB_TITLES[id]);
      b.addEventListener('click', () => {
        switchTab(id);
        input.focus();
      });
      tabButtons.set(id, b);
      tabsEl.append(b);
    }
    menuEl = h('div', { class: 'goto-menu', role: 'menu' });
    menuEl.hidden = true;
    spacer = h('div', { class: 'goto-spacer-box' });
    list = h('div', { class: 'goto-list', role: 'listbox' }, spacer);
    statusEl = h('div', { class: 'goto-status' });
    statusEl.hidden = true;
    const box = h(
      'div',
      { class: 'goto-box', role: 'dialog', 'aria-label': 'Search Everywhere' },
      h('div', { class: 'goto-head' }, tabsEl, filterBtn),
      h('div', { class: 'goto-field' }, input, busyEl),
      menuEl,
      list,
      statusEl,
    );
    backdrop = h('div', { class: 'goto-backdrop' }, box);

    list.hidden = true;
    list.addEventListener('scroll', () => requestAnimationFrame(() => backdrop && paint()), { passive: true });
    // Clicks on the list and the menu keep the focus in the query field.
    list.addEventListener('mousedown', (e) => e.preventDefault());
    menuEl.addEventListener('mousedown', (e) => e.preventDefault());
    tabsEl.addEventListener('mousedown', (e) => e.preventDefault());
    filterBtn.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('pointermove', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.goto-row');
      if (!el) return;
      const i = Number(el.dataset.i);
      if (rows[i] && rows[i].type !== 'header' && i !== active) {
        userMoved = true;
        setActive(i, false);
      }
    });
    list.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.goto-row');
      if (!el) return;
      const i = Number(el.dataset.i);
      if (!rows[i] || rows[i].type === 'header') return;
      setActive(i, false);
      accept(e.shiftKey);
    });
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close();
    });
    input.addEventListener('input', () => {
      closeMenu();
      schedule(false);
    });
    input.addEventListener('keydown', onKeyDown);

    layer.append(backdrop);
    overlayOpened(layer);

    const selected = selectionQuery(ctx);
    input.value = selected ?? queries[tab];
    renderTabs();
    schedule(true);
    input.focus();
    input.select();
  }

  function onKeyDown(e: KeyboardEvent): void {
    // While an IME composes text (Japanese, Korean, Vietnamese), the keys belong to the IME.
    if (e.isComposing || e.keyCode === 229) return;
    const mod = e.metaKey || e.ctrlKey;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        move('down');
        break;
      case 'ArrowUp':
        move('up');
        break;
      case 'PageDown':
        move('pageDown');
        break;
      case 'PageUp':
        move('pageUp');
        break;
      case 'Home':
        // Plain Home and End move the text cursor, unless the field is empty.
        if (mod || !input.value) move('home');
        else handled = false;
        break;
      case 'End':
        if (mod || !input.value) move('end');
        else handled = false;
        break;
      case 'Enter':
        accept(e.shiftKey);
        break;
      case 'Escape':
        if (!menuEl.hidden) closeMenu();
        else close();
        break;
      case 'Tab':
        stepTab(e.shiftKey ? -1 : 1);
        break;
      default:
        if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'n' || e.key === 'p')) move(e.key === 'n' ? 'down' : 'up');
        else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function close(): void {
    if (!backdrop) return;
    queries[tab] = input.value;
    run?.cancel();
    run = null;
    clearTimeout(debounceTimer);
    clearTimeout(busyTimer);
    visible.clear();
    tabButtons.clear();
    const l = layer;
    backdrop.remove();
    backdrop = null;
    layer = null;
    if (l) overlayClosed(l);
    // The focus goes back to where it was. A file that opens after this takes the focus itself.
    const back = previousFocus;
    previousFocus = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  const deactivated = ctx.bus.on('workbench:deactivated', () => close());
  const changed = ctx.bus.on('workspace:will-change', () => {
    close();
    for (const k of Object.keys(queries) as TabId[]) queries[k] = '';
  });

  return {
    open,
    isOpen: () => backdrop !== null,
    currentTab: () => tab,
    close: () => close(),
    dispose() {
      close();
      fileOpened.dispose();
      deactivated.dispose();
      changed.dispose();
    },
  };
}

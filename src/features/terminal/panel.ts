// The Terminal panel: a strip of terminal tabs, and for each tab a tree of panes
// (side by side or above each other) with draggable dividers.

import { Columns2, createElement, Plus, Rows2, SquareTerminal, X } from 'lucide';
import { h } from '../../core/dom';
import type { AppContext, MenuItem, ViewDescriptor, ViewInstance } from '../../core/types';
import {
  closeLeaf,
  dragSizes,
  leaf,
  neighbour,
  paneAfterClose,
  setSizesAt,
  splitLeaf,
  type LayoutNode,
  type Split,
  type SplitDir,
} from './layout';
import { TerminalPane } from './pane';

export const VIEW_ID = 'terminal';

interface TabState {
  id: number;
  title: string;
  /** True after the user renamed the tab. The shell title does not change it then. */
  custom: boolean;
  root: LayoutNode;
  /** Id of the pane with the focus in this tab. */
  active: string;
  panes: Map<string, TerminalPane>;
  body: HTMLElement;
  tabEl: HTMLElement;
  titleEl: HTMLElement;
}

function splitAt(root: LayoutNode, path: number[]): Split | null {
  let node: LayoutNode = root;
  for (const i of path) {
    if (node.type !== 'split') return null;
    node = node.children[i];
  }
  return node.type === 'split' ? node : null;
}

export class TerminalPanel implements ViewInstance {
  private tabs: TabState[] = [];
  private current: TabState | null = null;
  private tabCounter = 0;
  private paneCounter = 0;
  private everHadTab = false;
  private visible = false;
  private disposed = false;

  private tabsEl = h('div', { class: 'term-tabs', role: 'tablist' });
  private bodies = h('div', { class: 'term-bodies' });
  private empty: HTMLElement;
  private subs: { dispose(): void }[] = [];

  constructor(
    private ctx: AppContext,
    private host: HTMLElement,
  ) {
    host.classList.add('term-root');
    const icon = (el: Element) => el;
    const button = (title: string, svg: Element, run: () => void) =>
      h('button', { class: 'term-icon-btn', title, 'aria-label': title, onclick: run }, icon(svg));
    const strip = h(
      'div',
      { class: 'term-strip' },
      this.tabsEl,
      button('New terminal', createElement(Plus), () => this.newTab()),
      h('span', { class: 'term-strip-spacer' }),
      button(`Split right (${ctx.commands.keyLabel('Mod-\\')})`, createElement(Columns2), () => this.split('row')),
      button(`Split down (${ctx.commands.keyLabel('Mod-Shift-\\')})`, createElement(Rows2), () => this.split('column')),
    );
    this.empty = h(
      'div',
      { class: 'term-empty', hidden: true },
      h('div', null, 'No terminal is open.'),
      h('button', { class: 'term-empty-btn', onclick: () => this.newTab() }, 'New terminal'),
    );
    host.append(strip, this.bodies, this.empty);

    this.subs.push(
      ctx.bus.on('settings:changed', () => this.allPanes().forEach((p) => p.applySettings())),
      // `data-theme` is set before this event, but the next frame is safe for the CSS values.
      ctx.bus.on('theme:changed', () => requestAnimationFrame(() => this.allPanes().forEach((p) => p.applyTheme()))),
      ctx.bus.on('workbench:activated', () => this.fitAll()),
    );
  }

  // --- Queries ---------------------------------------------------------------

  private allPanes(): TerminalPane[] {
    return this.tabs.flatMap((t) => [...t.panes.values()]);
  }

  tabCount(): number {
    return this.tabs.length;
  }

  /** True when the keyboard focus is inside the terminal panel. */
  hasFocus(): boolean {
    return this.host.contains(document.activeElement);
  }

  private activePane(tab = this.current): TerminalPane | null {
    return tab ? (tab.panes.get(tab.active) ?? null) : null;
  }

  // --- ViewInstance ----------------------------------------------------------

  onShow(): void {
    this.visible = true;
    // The first time the panel opens it starts one terminal.
    if (!this.everHadTab && this.tabs.length === 0) this.newTab();
    else this.fitAll();
  }

  onHide(): void {
    // The shells keep running while the panel is hidden.
    this.visible = false;
  }

  focus(): void {
    this.activePane()?.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subs.forEach((s) => s.dispose());
    this.subs = [];
    for (const tab of this.tabs) for (const pane of tab.panes.values()) pane.dispose();
    this.tabs = [];
    this.current = null;
  }

  private fitAll(): void {
    requestAnimationFrame(() => {
      if (this.current) for (const p of this.current.panes.values()) p.fitNow();
    });
  }

  // --- Tabs ------------------------------------------------------------------

  newTab(): void {
    if (this.disposed) return;
    this.everHadTab = true;
    const n = ++this.tabCounter;
    const titleEl = h('span', { class: 'term-tab-title' }, `Terminal ${n}`);
    const closeBtn = h(
      'button',
      { class: 'term-tab-close', title: 'Close terminal', 'aria-label': 'Close terminal', tabindex: -1 },
      createElement(X),
    );
    const tabEl = h('div', { class: 'term-tab', role: 'tab' }, createElement(SquareTerminal), titleEl, closeBtn);
    const body = h('div', { class: 'term-tab-body', hidden: true });
    const tab: TabState = {
      id: n,
      title: `Terminal ${n}`,
      custom: false,
      root: leaf(''),
      active: '',
      panes: new Map(),
      body,
      tabEl,
      titleEl,
    };
    const pane = this.createPane(tab);
    tab.root = leaf(pane.id);
    tab.active = pane.id;

    tabEl.addEventListener('click', () => this.activateTab(tab, true));
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.closeTab(tab);
      }
    });
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.startRename(tab);
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeTab(tab);
    });

    this.tabs.push(tab);
    this.tabsEl.append(tabEl);
    this.bodies.append(body);
    this.renderLayout(tab);
    this.activateTab(tab, true);
    this.startPane(pane, true);
  }

  private activateTab(tab: TabState, focus: boolean): void {
    this.current = tab;
    this.empty.hidden = true;
    for (const t of this.tabs) {
      const on = t === tab;
      t.body.hidden = !on;
      t.tabEl.classList.toggle('is-active', on);
      t.tabEl.setAttribute('aria-selected', String(on));
    }
    tab.tabEl.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this.refreshActive(tab);
    this.fitAll();
    if (focus) this.activePane(tab)?.focus();
  }

  closeTab(tab: TabState): void {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    const hadFocus = this.hasFocus();
    for (const pane of tab.panes.values()) pane.dispose();
    tab.panes.clear();
    tab.body.remove();
    tab.tabEl.remove();
    this.tabs.splice(index, 1);
    if (this.current === tab) {
      this.current = null;
      const next = this.tabs[index] ?? this.tabs[index - 1];
      if (next) this.activateTab(next, hadFocus);
      else this.empty.hidden = false;
    }
  }

  private startRename(tab: TabState): void {
    const input = h('input', { class: 'term-tab-rename', type: 'text', value: tab.title, spellcheck: 'false' });
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (commit && value) {
        tab.title = value;
        tab.custom = true;
      }
      tab.titleEl.textContent = tab.title;
      input.replaceWith(tab.titleEl);
      this.activePane(tab)?.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    tab.titleEl.replaceWith(input);
    input.focus();
    input.select();
  }

  private setTitle(tab: TabState, title: string): void {
    if (tab.custom) return;
    const clean = title.trim();
    if (!clean) return;
    tab.title = clean;
    tab.titleEl.textContent = clean;
    tab.tabEl.title = clean;
  }

  // --- Panes -----------------------------------------------------------------

  /**
   * The root of the open folder. At startup the panel can restore a terminal
   * before the folder is open; then wait for it (at most 2 s) so the shell does
   * not start in the home folder.
   */
  private workspaceRoot(): Promise<string> {
    const now = this.ctx.workspace.root;
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        sub.dispose();
        resolve(this.ctx.workspace.root ?? '');
      };
      const sub = this.ctx.bus.on('workspace:changed', done);
      const timer = setTimeout(done, 2000);
    });
  }

  private createPane(tab: TabState): TerminalPane {
    const id = `p${++this.paneCounter}`;
    const pane = new TerminalPane(id, {
      cwd: () => this.workspaceRoot(),
      settings: () => this.ctx.settings.all(),
      onFocus: (p) => {
        if (tab.active !== p.id && tab.panes.has(p.id)) {
          tab.active = p.id;
          this.refreshActive(tab);
        }
      },
      onTitle: (p, title) => {
        if (tab.active === p.id) this.setTitle(tab, title);
      },
      onCloseRequest: (p) => this.closePane(tab, p.id),
      onContextMenu: (p, e) => this.showMenu(tab, p, e),
      onError: (message) => this.ctx.ui.notify(message, { kind: 'error' }),
    });
    tab.panes.set(id, pane);
    return pane;
  }

  private startPane(pane: TerminalPane, focus: boolean): void {
    pane.start().then(
      () => {
        if (focus && !this.disposed && this.hasFocusTarget()) pane.focus();
      },
      (e) => console.error('[terminal] pane failed to start', e),
    );
  }

  /** The new pane takes the focus when the panel is shown. */
  private hasFocusTarget(): boolean {
    return this.visible || this.hasFocus();
  }

  split(dir: SplitDir): void {
    const tab = this.current;
    if (!tab) {
      this.newTab();
      return;
    }
    const pane = this.createPane(tab);
    tab.root = splitLeaf(tab.root, tab.active, dir, pane.id);
    tab.active = pane.id;
    this.renderLayout(tab);
    this.refreshActive(tab);
    this.startPane(pane, true);
  }

  closePane(tab = this.current, paneId = tab?.active): void {
    if (!tab || !paneId) return;
    const pane = tab.panes.get(paneId);
    if (!pane) return;
    const hadFocus = this.hasFocus();
    const next = paneAfterClose(tab.root, paneId);
    const root = closeLeaf(tab.root, paneId);
    pane.dispose();
    tab.panes.delete(paneId);
    if (!root || !next) {
      this.closeTab(tab);
      return;
    }
    tab.root = root;
    if (tab.active === paneId) tab.active = next;
    this.renderLayout(tab);
    this.refreshActive(tab);
    this.fitAll();
    if (hadFocus) this.activePane(tab)?.focus();
  }

  focusNeighbour(step: 1 | -1): void {
    const tab = this.current;
    if (!tab) return;
    tab.active = neighbour(tab.root, tab.active, step);
    this.refreshActive(tab);
    this.activePane(tab)?.focus();
  }

  clear(): void {
    this.activePane()?.clear();
  }

  private refreshActive(tab: TabState): void {
    for (const [id, pane] of tab.panes) pane.setActive(id === tab.active);
    tab.body.classList.toggle('has-split', tab.panes.size > 1);
  }

  private showMenu(tab: TabState, pane: TerminalPane, e: MouseEvent): void {
    const items: MenuItem[] = [
      { label: 'Copy', run: () => pane.copySelection(), disabled: !pane.hasSelection() },
      { label: 'Paste', run: () => void pane.paste() },
      { label: 'Select All', run: () => pane.selectAll() },
      { label: 'Clear', run: () => pane.clear(), keybinding: 'Mod-k', separatorBefore: true },
      { label: 'Split Right', run: () => this.split('row'), keybinding: 'Mod-\\', separatorBefore: true },
      { label: 'Split Down', run: () => this.split('column'), keybinding: 'Mod-Shift-\\' },
      { label: 'Close Pane', run: () => this.closePane(tab, pane.id), keybinding: 'Mod-w' },
    ];
    this.ctx.ui.contextMenu(e, items);
  }

  // --- Layout DOM ------------------------------------------------------------

  /** Builds the split containers again. The pane elements are moved, not created again. */
  private renderLayout(tab: TabState): void {
    const build = (node: LayoutNode, path: number[]): HTMLElement => {
      if (node.type === 'leaf') return tab.panes.get(node.id)!.el;
      const el = h('div', { class: `term-split term-split-${node.dir}` });
      node.children.forEach((child, i) => {
        const cell = h('div', { class: 'term-cell' });
        cell.style.flexGrow = String(node.sizes[i]);
        cell.append(build(child, [...path, i]));
        el.append(cell);
        if (i < node.children.length - 1) el.append(this.makeDivider(tab, el, node.dir, path, i));
      });
      return el;
    };
    tab.body.replaceChildren(build(tab.root, []));
    this.fitAll();
  }

  private makeDivider(tab: TabState, container: HTMLElement, dir: SplitDir, path: number[], index: number): HTMLElement {
    const divider = h('div', {
      class: `term-divider term-divider-${dir}`,
      role: 'separator',
      'aria-orientation': dir === 'row' ? 'vertical' : 'horizontal',
    });
    divider.addEventListener('pointerdown', (down) => {
      const split = splitAt(tab.root, path);
      if (!split) return;
      down.preventDefault();
      divider.setPointerCapture(down.pointerId);
      divider.classList.add('is-dragging');
      const rect = container.getBoundingClientRect();
      const total = dir === 'row' ? rect.width : rect.height;
      const start = dir === 'row' ? down.clientX : down.clientY;
      const startSizes = [...split.sizes];
      const cells = [...container.children].filter((c) => c.classList.contains('term-cell')) as HTMLElement[];
      let sizes = startSizes;
      const move = (e: PointerEvent) => {
        const now = dir === 'row' ? e.clientX : e.clientY;
        sizes = dragSizes(startSizes, index, total > 0 ? (now - start) / total : 0);
        sizes.forEach((s, i) => (cells[i].style.flexGrow = String(s)));
      };
      const up = () => {
        divider.releasePointerCapture(down.pointerId);
        divider.classList.remove('is-dragging');
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', up);
        divider.removeEventListener('pointercancel', up);
        tab.root = setSizesAt(tab.root, path, sizes);
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up);
      divider.addEventListener('pointercancel', up);
    });
    return divider;
  }
}

export function createTerminalView(ctx: AppContext, onCreate: (panel: TerminalPanel) => void): ViewDescriptor {
  return {
    id: VIEW_ID,
    title: 'Terminal',
    location: 'panel',
    order: 5,
    icon: () => createElement(SquareTerminal),
    activityBar: { command: 'terminal.toggle' },
    create(host) {
      const panel = new TerminalPanel(ctx, host);
      onCreate(panel);
      return panel;
    },
  };
}

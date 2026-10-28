// The Call Hierarchy bottom panel: a header, toggles and a virtualized tree.
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  History,
  Network,
  RefreshCw,
  X,
  createElement,
} from 'lucide';
import { h } from '../../core/dom';
import type { AppContext, ViewDescriptor, ViewInstance } from '../../core/types';
import { fileIcon } from '../../ui/file-icons';
import { CALLS_VIEW_ID, type CallHierarchyController } from './call-controller';
import type { CallRow } from './call-model';
import { segments, sourceLabel } from './model';
import './usages.css';

const ROW_HEIGHT = 22;
const OVERSCAN = 8;
const INDENT = 14;

function iconButton(title: string, icon: Parameters<typeof createElement>[0], label?: string): HTMLButtonElement {
  const b = h('button', { class: 'usages-btn', type: 'button', title, 'aria-label': title });
  b.append(createElement(icon));
  if (label) b.append(h('span', null, label));
  return b;
}

export class CallHierarchyView implements ViewInstance {
  private readonly info = h('div', { class: 'usages-info' });
  private readonly searchAgain = iconButton('Search again', RefreshCw, 'Search Again');
  private readonly historyButton = iconButton('Earlier roots', History, 'History');
  private readonly hideTest = h('button', { class: 'usages-btn', type: 'button', title: 'Hide callers in test code' }, 'Hide test code');
  private readonly expandButton = iconButton('Open all nodes to depth 3 (at most 500 nodes)', ChevronsUpDown, 'Expand All');
  private readonly cancelButton = iconButton('Stop Expand All', X, 'Cancel');
  private readonly progress = h('span', { class: 'usages-label' });
  private readonly collapseButton = iconButton('Collapse all', ChevronsDownUp, 'Collapse All');
  private readonly message = h('div', { class: 'usages-message' });
  private readonly scroller: HTMLElement;
  private readonly spacer = h('div', { class: 'usages-spacer' });
  private readonly rendered = new Map<number, HTMLElement>();
  private readonly resizeObserver: ResizeObserver;
  private readonly sub: { dispose(): void };
  private frame = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly c: CallHierarchyController,
    private readonly host: HTMLElement,
  ) {
    host.classList.add('usages-view');
    this.scroller = h('div', { class: 'usages-results', tabindex: '0', role: 'tree', 'aria-label': 'Call hierarchy' }, this.spacer);

    host.append(
      h('div', { class: 'usages-header' }, this.info, h('div', { class: 'usages-actions' }, this.searchAgain, this.historyButton)),
      h('div', { class: 'usages-bar' }, this.hideTest, this.expandButton, this.cancelButton, this.progress, this.collapseButton),
      h('div', { class: 'usages-body' }, this.scroller, this.message),
    );

    this.searchAgain.addEventListener('click', () => void c.searchAgain());
    this.historyButton.addEventListener('click', (e) => this.showHistory(e));
    this.hideTest.addEventListener('click', () => c.setFilters({ hideTest: !c.filters.hideTest }));
    this.expandButton.addEventListener('click', () => void c.expandAll());
    this.cancelButton.addEventListener('click', () => c.cancelExpand());
    this.collapseButton.addEventListener('click', () => c.collapseAll());

    this.scroller.addEventListener('scroll', this.schedule, { passive: true });
    this.scroller.addEventListener('click', (e) => this.onClick(e));
    this.scroller.addEventListener('keydown', (e) => this.onKey(e));
    this.resizeObserver = new ResizeObserver(this.schedule);
    this.resizeObserver.observe(this.scroller);

    this.sub = c.onChange((kind) => {
      if (kind === 'select') {
        this.updateSelection();
      } else {
        this.updateHeader();
        this.redrawAll();
      }
    });
    this.updateHeader();
    this.redrawAll();
  }

  onShow(): void {
    this.render();
  }

  focus(): void {
    this.scroller.focus();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.sub.dispose();
  }

  // --- Header ------------------------------------------------------------------

  private updateHeader(): void {
    const c = this.c;
    const tree = c.tree;
    const searching = c.status === 'searching';
    this.host.classList.toggle('usages-busy', searching);
    this.info.replaceChildren();
    if (tree) {
      const i = tree.root.item;
      if (i.kindWord) this.info.append(h('span', { class: 'usages-symbol-kind' }, i.kindWord));
      this.info.append(h('span', { class: 'usages-symbol-name' }, i.name));
      if (i.owner) this.info.append(h('span', { class: 'usages-owner' }, `in ${i.owner}`));
      this.info.append(
        h('span', { class: 'usages-count' }, searching ? 'Searching…' : `${tree.root.callers.length.toLocaleString('en-US')} ${tree.root.callers.length === 1 ? 'caller' : 'callers'}`),
        h('span', { class: 'usages-source' }, sourceLabel(tree.source)),
      );
      if (!tree.exact && tree.source === 'index') {
        this.info.append(h('span', { class: 'usages-note' }, 'Name only, may include other symbols'));
      }
    } else {
      this.info.append(h('span', { class: 'usages-symbol-name' }, 'Call Hierarchy'));
      if (searching) this.info.append(h('span', { class: 'usages-count' }, 'Searching…'));
    }
    this.searchAgain.disabled = !c.request || searching;
    this.historyButton.disabled = c.history.length === 0;
    this.hideTest.setAttribute('aria-pressed', String(c.filters.hideTest));
    this.expandButton.hidden = c.expanding;
    this.cancelButton.hidden = !c.expanding;
    this.progress.hidden = !c.expanding;
    this.progress.textContent = c.expanding ? `Opening… ${c.expandNodes} nodes` : '';
    this.expandButton.disabled = !tree;
    this.collapseButton.disabled = !tree;

    let text = '';
    let error = false;
    if (c.status === 'error') {
      text = c.error;
      error = true;
    } else if (c.status === 'idle') {
      text = `Put the cursor on a method and press ${this.ctx.commands.keyLabel('Mod-Shift-h')} to show its callers.`;
    }
    this.message.textContent = text;
    this.message.hidden = !text;
    this.message.classList.toggle('usages-error', error);
  }

  private showHistory(e: MouseEvent): void {
    this.ctx.ui.contextMenu(
      e,
      this.c.history.map((entry) => ({ label: entry.label, run: () => this.c.showHistory(entry.key) })),
    );
  }

  // --- Virtual list --------------------------------------------------------------

  private readonly schedule = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  };

  private redrawAll(): void {
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
    this.render();
  }

  private render(): void {
    const rows = this.c.rows;
    this.spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight || 300;
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(rows.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    for (const [i, el] of this.rendered) {
      if (i < start || i >= end) {
        el.remove();
        this.rendered.delete(i);
      }
    }
    for (let i = start; i < end; i++) {
      if (this.rendered.has(i)) continue;
      const el = this.makeRow(i, rows[i]!);
      this.rendered.set(i, el);
      this.spacer.append(el);
    }
  }

  private makeRow(index: number, row: CallRow): HTMLElement {
    const el = h('div', {
      class: 'usages-row',
      'data-index': index,
      role: 'treeitem',
      'aria-level': row.depth + 1,
      style: `top:${index * ROW_HEIGHT}px;padding-left:${8 + row.depth * INDENT}px`,
    });
    el.classList.toggle('usages-selected', row.id === this.c.selectedId);
    switch (row.kind) {
      case 'site': {
        el.classList.add('usages-match');
        const text = h('span', { class: 'usages-text' });
        for (const seg of segments(row.site.text, row.site.range)) {
          if (seg.hit) text.append(h('b', { class: 'usages-hit' }, seg.text));
          else text.append(seg.text);
        }
        el.title = `${this.c.rel(row.node.item.path)}:${row.site.line}`;
        el.append(h('span', { class: 'usages-line' }, String(row.site.line)), text);
        break;
      }
      case 'loading':
        el.classList.add('usages-status');
        el.append(h('span', { class: 'usages-spinner', role: 'progressbar', 'aria-label': 'Loading' }), 'Loading callers…');
        break;
      case 'error':
        el.classList.add('usages-status', 'usages-error');
        el.append(
          h('span', null, `Cannot load callers: ${row.text}`),
          h('button', { class: 'usages-link', type: 'button', 'data-retry': '1' }, 'Try Again'),
        );
        break;
      case 'group': {
        el.classList.add('usages-group');
        const chevron = h('span', { class: 'usages-chevron', 'data-chevron': '1' });
        chevron.append(createElement(row.open ? ChevronDown : ChevronRight));
        el.setAttribute('aria-expanded', String(row.open));
        el.append(chevron, h('span', { class: 'usages-group-label' }, row.label));
        break;
      }
      case 'note':
        el.classList.add('usages-status');
        el.append(row.text);
        break;
      case 'node': {
        const n = row.node;
        el.classList.add('usages-file');
        el.title = `${this.c.rel(n.item.path)}:${n.item.line}`;
        const chevron = h('span', { class: 'usages-chevron', 'data-chevron': '1' });
        if (!n.recursive) chevron.append(createElement(row.open ? ChevronDown : ChevronRight));
        if (!n.recursive) el.setAttribute('aria-expanded', String(row.open));
        el.append(chevron, fileIcon(n.item.path.split(/[\\/]/).pop() ?? ''), h('span', { class: 'usages-file-name' }, n.item.title));
        if (n.item.container) el.append(h('span', { class: 'usages-file-dir' }, n.item.container));
        if (n.test) el.append(h('span', { class: 'usages-tag' }, 'test'));
        if (!n.likely) el.append(h('span', { class: 'usages-tag', title: 'Only the name matches' }, 'same name'));
        if (n.recursive) el.append(h('span', { class: 'usages-tag usages-tag-warn', title: 'Already on the path to the root' }, 'recursive'));
        if (n.parent) el.append(h('span', { class: 'usages-badge', title: 'Number of calls' }, String(n.sites.length)));
      }
    }
    return el;
  }

  // --- Selection ---------------------------------------------------------------------

  private selectedIndex(): number {
    const id = this.c.selectedId;
    return id === null ? -1 : this.c.rows.findIndex((r) => r.id === id);
  }

  private updateSelection(): void {
    const index = this.selectedIndex();
    for (const [i, el] of this.rendered) el.classList.toggle('usages-selected', i === index);
    if (index < 0) return;
    const top = index * ROW_HEIGHT;
    const view = this.scroller.clientHeight;
    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > this.scroller.scrollTop + view) this.scroller.scrollTop = top + ROW_HEIGHT - view;
    this.render();
    this.rendered.get(index)?.classList.add('usages-selected');
  }

  private selectIndex(index: number): void {
    const rows = this.c.rows;
    if (!rows.length) return;
    this.c.select(rows[Math.min(Math.max(index, 0), rows.length - 1)]!.id);
  }

  // --- Mouse and keys ------------------------------------------------------------------

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const el = target.closest<HTMLElement>('.usages-row');
    if (!el) return;
    const row = this.c.rows[Number(el.dataset.index)];
    if (!row) return;
    this.c.select(row.id);
    if (row.kind === 'error') {
      if (target.closest('[data-retry]')) this.c.retry(row.node);
    } else if (row.kind === 'group') {
      this.c.setSameOpen(row.node, !row.open);
    } else if (row.kind === 'node' && target.closest('[data-chevron]')) {
      this.c.toggle(row.node);
    } else if (row.kind === 'node' || row.kind === 'site') {
      // One click opens a preview tab. A double click opens a normal tab and moves the focus to the editor.
      const double = e.detail >= 2;
      this.c.openRow(row, { preview: !double, focusEditor: double });
    }
  }

  private onKey(e: KeyboardEvent): void {
    const rows = this.c.rows;
    const index = this.selectedIndex();
    const row = rows[index];
    switch (e.key) {
      case 'ArrowDown':
        this.selectIndex(index < 0 ? 0 : index + 1);
        break;
      case 'ArrowUp':
        this.selectIndex(index < 0 ? 0 : index - 1);
        break;
      case 'Home':
        this.selectIndex(0);
        break;
      case 'End':
        this.selectIndex(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row?.kind === 'group') {
          if (!row.open) this.c.setSameOpen(row.node, true);
          else this.selectIndex(index + 1);
        } else if (row?.kind === 'node' && !row.node.recursive) {
          if (!row.open) this.c.setOpen(row.node, true);
          else this.selectIndex(index + 1);
        }
        break;
      case 'ArrowLeft': {
        if (!row) break;
        if (row.kind === 'node' && row.open) {
          this.c.setOpen(row.node, false);
        } else if (row.kind === 'group' && row.open) {
          this.c.setSameOpen(row.node, false);
        } else if (row.kind === 'node') {
          const p = row.node.parent;
          if (p) this.c.select(row.node.likely ? p.id : `${p.id}|same`);
        } else {
          this.c.select(row.node.id);
        }
        break;
      }
      case 'Enter':
        if (row?.kind === 'node' || row?.kind === 'site') this.c.openRow(row, { preview: false, focusEditor: true });
        else if (row?.kind === 'error') this.c.retry(row.node);
        else if (row?.kind === 'group') this.c.setSameOpen(row.node, !row.open);
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}

export function createCallHierarchyView(ctx: AppContext, c: CallHierarchyController): ViewDescriptor {
  return {
    id: CALLS_VIEW_ID,
    title: 'Call Hierarchy',
    icon: () => createElement(Network),
    location: 'panel',
    order: 16,
    create(host): ViewInstance {
      return new CallHierarchyView(ctx, c, host);
    },
  };
}

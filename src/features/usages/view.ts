// The Usages bottom panel: a header, a filter bar and a virtualized tree.
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  History,
  ListTree,
  RefreshCw,
  createElement,
} from 'lucide';
import { h } from '../../core/dom';
import type { AppContext, ViewDescriptor, ViewInstance } from '../../core/types';
import { fileIcon } from '../../ui/file-icons';
import { VIEW_ID, type UsagesController } from './controller';
import {
  describeSymbol,
  otherSource,
  segments,
  sourceLabel,
  summaryText,
  type GroupBy,
  type Row,
} from './model';
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

export class UsagesView implements ViewInstance {
  private readonly info = h('div', { class: 'usages-info' });
  private readonly searchAgain = iconButton('Search again', RefreshCw, 'Search Again');
  private readonly switchSource = iconButton('Search again with the other source', ArrowLeftRight);
  private readonly historyButton = iconButton('Earlier searches', History, 'History');
  private readonly groupButtons = new Map<GroupBy, HTMLButtonElement>();
  private readonly filterInput = h('input', {
    class: 'usages-filter',
    type: 'text',
    placeholder: 'Filter by file or text',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Filter usages',
  });
  private readonly message = h('div', { class: 'usages-message' });
  private readonly scroller: HTMLElement;
  private readonly spacer = h('div', { class: 'usages-spacer' });
  private readonly rendered = new Map<number, HTMLElement>();
  private readonly resizeObserver: ResizeObserver;
  private readonly sub: { dispose(): void };
  private frame = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly c: UsagesController,
    private readonly host: HTMLElement,
  ) {
    host.classList.add('usages-view');
    this.scroller = h('div', { class: 'usages-results', tabindex: '0', role: 'tree', 'aria-label': 'Usages' }, this.spacer);

    const group = h('div', { class: 'usages-group-toggle', role: 'group', 'aria-label': 'Group by' }, h('span', { class: 'usages-label' }, 'Group by'));
    for (const [by, label] of [['kind', 'Kind'], ['file', 'File']] as const) {
      const b = h('button', { class: 'usages-btn usages-seg', type: 'button', title: `Group by ${label.toLowerCase()}` }, label);
      b.addEventListener('click', () => c.setGroupBy(by));
      this.groupButtons.set(by, b);
      group.append(b);
    }
    const expand = iconButton('Expand all', ChevronsUpDown);
    const collapse = iconButton('Collapse all', ChevronsDownUp);
    expand.addEventListener('click', () => c.expandAll());
    collapse.addEventListener('click', () => c.collapseAll());

    host.append(
      h('div', { class: 'usages-header' }, this.info, h('div', { class: 'usages-actions' }, this.searchAgain, this.switchSource, this.historyButton)),
      h('div', { class: 'usages-bar' }, group, this.filterInput, expand, collapse),
      h('div', { class: 'usages-body' }, this.scroller, this.message),
    );

    this.searchAgain.addEventListener('click', () => void c.searchAgain());
    this.switchSource.addEventListener('click', () => void c.switchSource());
    this.historyButton.addEventListener('click', (e) => this.showHistory(e));

    this.filterInput.addEventListener('input', (e) => {
      if (!(e as InputEvent).isComposing) c.setFilter(this.filterInput.value);
    });
    this.filterInput.addEventListener('compositionend', () => c.setFilter(this.filterInput.value));
    this.filterInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.scroller.focus();
        if (this.selectedIndex() < 0 && this.c.rows.length) this.selectIndex(0);
      } else if (e.key === 'Escape' && this.filterInput.value) {
        this.filterInput.value = '';
        c.setFilter('');
      }
    });

    this.scroller.addEventListener('scroll', this.schedule, { passive: true });
    this.scroller.addEventListener('click', (e) => this.onClick(e));
    this.scroller.addEventListener('keydown', (e) => this.onKey(e));
    this.resizeObserver = new ResizeObserver(this.schedule);
    this.resizeObserver.observe(this.scroller);

    this.sub = c.onChange((kind) => {
      if (kind === 'result') {
        this.filterInput.value = c.filter;
        this.updateHeader();
        this.redrawAll();
      } else if (kind === 'rows') {
        this.updateHeader();
        this.redrawAll();
      } else {
        this.updateSelection();
      }
    });
    this.updateHeader();
    this.redrawAll();
  }

  // --- ViewInstance ------------------------------------------------------------

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
    const r = c.result;
    const searching = c.status === 'searching';
    this.info.replaceChildren();
    this.host.classList.toggle('usages-busy', searching);

    if (r) {
      const sym = describeSymbol(r.symbol, c.name);
      if (sym.kind) this.info.append(h('span', { class: 'usages-symbol-kind' }, sym.kind));
      this.info.append(h('span', { class: 'usages-symbol-name' }, sym.name || '(no name)'));
      if (sym.owner) this.info.append(h('span', { class: 'usages-owner' }, `in ${sym.owner}`));
      this.info.append(
        h('span', { class: 'usages-count', title: `${r.elapsedMs} ms` }, searching ? 'Searching…' : summaryText(r.files, r.truncated)),
        h('span', { class: 'usages-source' }, sourceLabel(r.source)),
      );
      if (!r.exact && r.source === 'index' && r.symbol) {
        this.info.append(
          h('span', { class: 'usages-note', title: 'Kestrel found this name in the code. Other symbols with the same name can be in the list.' }, 'Name only, may include other symbols'),
        );
      }
      if (r.fileOnly) {
        const all = h('button', { class: 'usages-link', type: 'button' }, 'Search all files');
        all.addEventListener('click', () => void c.searchAllFiles());
        this.info.append(h('span', { class: 'usages-note' }, 'This file only'), all);
      }
    } else if (c.status === 'searching') {
      this.info.append(h('span', { class: 'usages-symbol-name' }, c.name || 'Usages'), h('span', { class: 'usages-count' }, 'Searching…'));
    } else {
      this.info.append(h('span', { class: 'usages-symbol-name' }, 'Usages'));
    }

    this.searchAgain.disabled = !c.request || searching;
    this.switchSource.disabled = !r || searching;
    this.switchSource.title = r ? `Search again with the ${sourceLabel(otherSource(r.source))}` : 'Search again with the other source';
    this.switchSource.replaceChildren(createElement(ArrowLeftRight), h('span', null, r ? sourceLabel(otherSource(r.source)) : 'Other source'));
    this.historyButton.disabled = c.history.length === 0;
    for (const [by, b] of this.groupButtons) b.setAttribute('aria-pressed', String(c.groupBy === by));

    this.updateMessage();
  }

  private updateMessage(): void {
    const c = this.c;
    let text = '';
    let error = false;
    if (c.status === 'error') {
      text = c.error;
      error = true;
    } else if (c.status === 'idle') {
      text = `Put the cursor on a name and press ${this.ctx.commands.keyLabel('Alt-F7')} to find its usages.`;
    } else if (c.status === 'done' && c.result) {
      if (!c.result.symbol && c.result.files.length === 0) text = 'There is no name at this position.';
      else if (c.result.files.every((f) => f.matches.length === 0)) text = 'No usages found.';
      else if (c.tree && c.tree.leaves.length === 0) text = 'No usages match the filter.';
    }
    this.message.textContent = text;
    this.message.hidden = !text;
    this.message.classList.toggle('usages-error', error);
  }

  private showHistory(e: MouseEvent): void {
    const items = this.c.history.map((entry) => ({
      label: entry.label,
      run: () => this.c.showHistory(entry.key),
    }));
    this.ctx.ui.contextMenu(e, items);
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

  private makeRow(index: number, row: Row): HTMLElement {
    const node = row.node;
    const el = h('div', {
      class: 'usages-row',
      'data-index': index,
      'data-id': node.id,
      role: 'treeitem',
      'aria-level': row.depth + 1,
      style: `top:${index * ROW_HEIGHT}px;padding-left:${8 + row.depth * INDENT}px`,
    });
    el.classList.toggle('usages-selected', node.id === this.c.selectedId);
    if (node.type === 'match') {
      el.classList.add('usages-match');
      const text = h('span', { class: 'usages-text' });
      for (const seg of segments(node.match.text, node.match.range)) {
        if (seg.hit) text.append(h('b', { class: 'usages-hit' }, seg.text));
        else text.append(seg.text);
      }
      el.title = `${this.c.rel(node.path)}:${node.match.line}`;
      el.append(h('span', { class: 'usages-line' }, String(node.match.line)), text);
      return el;
    }
    el.setAttribute('aria-expanded', String(row.open));
    const chevron = h('span', { class: 'usages-chevron' });
    chevron.append(createElement(row.open ? ChevronDown : ChevronRight));
    if (node.type === 'group') {
      el.classList.add('usages-group');
      el.append(chevron, h('span', { class: 'usages-group-label' }, node.label));
      // The label of the "maybe" group already has the count.
      if (!node.maybe) el.append(h('span', { class: 'usages-badge' }, String(node.count)));
    } else {
      el.classList.add('usages-file');
      el.title = node.rel;
      el.append(
        chevron,
        fileIcon(node.name),
        h('span', { class: 'usages-file-name' }, node.name),
        h('span', { class: 'usages-file-dir' }, node.dir),
        h('span', { class: 'usages-badge' }, String(node.count)),
      );
    }
    return el;
  }

  // --- Selection -------------------------------------------------------------------

  private selectedIndex(): number {
    const id = this.c.selectedId;
    return id === null ? -1 : this.c.rows.findIndex((r) => r.node.id === id);
  }

  private updateSelection(): void {
    const index = this.selectedIndex();
    for (const [i, el] of this.rendered) el.classList.toggle('usages-selected', i === index);
    if (index >= 0) this.scrollTo(index);
  }

  private scrollTo(index: number): void {
    const top = index * ROW_HEIGHT;
    const view = this.scroller.clientHeight;
    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > this.scroller.scrollTop + view) this.scroller.scrollTop = top + ROW_HEIGHT - view;
    this.render();
    const el = this.rendered.get(index);
    el?.classList.add('usages-selected');
  }

  private selectIndex(index: number): void {
    const rows = this.c.rows;
    if (!rows.length) return;
    const i = Math.min(Math.max(index, 0), rows.length - 1);
    this.c.select(rows[i]!.node.id);
  }

  // --- Mouse and keys ---------------------------------------------------------------

  private onClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.usages-row');
    if (!el) return;
    const row = this.c.rows[Number(el.dataset.index)];
    if (!row) return;
    this.c.select(row.node.id);
    if (row.node.type === 'match') {
      // One click opens a preview tab. A double click opens a normal tab and moves the focus to the editor.
      const double = e.detail >= 2;
      void this.c.openMatch(row.node, { preview: !double, focusEditor: double });
    } else if (e.detail < 2) {
      this.c.toggle(row.node.id);
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
        if (index <= 0) this.filterInput.focus();
        else this.selectIndex(index - 1);
        break;
      case 'Home':
        this.selectIndex(0);
        break;
      case 'End':
        this.selectIndex(rows.length - 1);
        break;
      case 'ArrowRight':
        if (!row || row.node.type === 'match') break;
        if (!row.open) this.c.setOpen(row.node.id, true);
        else this.selectIndex(index + 1);
        break;
      case 'ArrowLeft': {
        if (!row) break;
        if (row.node.type !== 'match' && row.open) {
          this.c.setOpen(row.node.id, false);
        } else {
          const parentId = this.c.tree?.parent.get(row.node.id);
          if (parentId !== undefined) this.c.select(parentId);
        }
        break;
      }
      case 'Enter':
        if (!row) break;
        if (row.node.type === 'match') void this.c.openMatch(row.node, { preview: false, focusEditor: true });
        else this.c.toggle(row.node.id);
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}

export function createUsagesView(ctx: AppContext, c: UsagesController): ViewDescriptor {
  return {
    id: VIEW_ID,
    title: 'Usages',
    icon: () => createElement(ListTree),
    location: 'panel',
    order: 15,
    create(host): ViewInstance {
      return new UsagesView(ctx, c, host);
    },
  };
}

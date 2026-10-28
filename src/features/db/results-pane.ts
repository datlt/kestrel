// Shows a ResultsStore: one tab per result table plus the Messages tab.
// A SQL console and the bottom panel `db-results` both use it.

import type { AppContext } from '../../core/types';
import { h } from '../../core/dom';
import { formatDuration, rowCountNote } from './grid-data';
import type { ResultGrid } from './grid';
import { formatTime, messageSql, type ResultsStore } from './results-store';
import './db.css';

const MESSAGES = 'messages';

export class ResultsPane {
  private active: number | typeof MESSAGES = MESSAGES;
  private grids = new Map<number, { grid: ResultGrid | null; el: HTMLElement }>();
  private lastRun = -1;
  private lastFocusSeq = 0;
  private disposed = false;
  private readonly off: () => void;

  private readonly tabs = h('div', { class: 'db-rp-tabs', role: 'tablist' });
  private readonly note = h('span', { class: 'db-rp-note' });
  private readonly bodyEl = h('div', { class: 'db-rp-body' });
  private readonly messagesEl = h('div', { class: 'db-msgs', tabindex: '0' });
  private readonly emptyEl: HTMLElement;
  readonly root: HTMLElement;

  constructor(
    private readonly ctx: AppContext,
    host: HTMLElement,
    private readonly store: ResultsStore,
    emptyText: string,
  ) {
    this.emptyEl = h('div', { class: 'db-rp-empty' }, emptyText);
    this.bodyEl.append(this.messagesEl);
    this.root = h('div', { class: 'db-rp' }, h('div', { class: 'db-rp-head' }, this.tabs, h('span', { class: 'db-spacer' }), this.note), this.bodyEl);
    host.append(this.root);
    this.off = store.onChange(() => this.update());
    this.lastRun = store.runId;
    this.lastFocusSeq = store.focusSeq;
    this.update();
  }

  dispose(): void {
    this.disposed = true;
    this.off();
    for (const g of this.grids.values()) g.grid?.dispose();
    this.grids.clear();
    this.root.remove();
  }

  /** Call when the pane becomes visible again. */
  refresh(): void {
    this.grids.get(this.active as number)?.grid?.refresh();
  }

  private update(): void {
    if (this.disposed) return;
    const s = this.store;
    if (s.runId !== this.lastRun) {
      // A new run: old tables go.
      this.lastRun = s.runId;
      for (const g of this.grids.values()) {
        g.grid?.dispose();
        g.el.remove();
      }
      this.grids.clear();
      this.active = MESSAGES;
    }
    if (s.focusSeq !== this.lastFocusSeq) {
      this.lastFocusSeq = s.focusSeq;
      this.active = s.focus === 'results' && s.results.length > 0 ? s.results[0].id : MESSAGES;
    }
    if (this.active !== MESSAGES && !s.results.some((r) => r.id === this.active)) this.active = MESSAGES;
    this.renderTabs();
    this.renderBody();
  }

  private renderTabs(): void {
    const s = this.store;
    const frag = document.createDocumentFragment();
    for (const r of s.results) {
      const label = h('span', null, r.title);
      const count = h('span', { class: 'db-rp-count' }, r.result.kind === 'rows' ? r.result.rows.length.toLocaleString('en-US') : '');
      frag.append(this.tab(r.id, label, count, r.id === this.active));
    }
    const hasError = s.messages.some((m) => m.level === 'error');
    const last = s.messages[s.messages.length - 1];
    const dot = h('span', { class: `db-rp-dot${last?.level === 'error' ? ' is-error' : hasError ? ' is-old-error' : ''}` });
    frag.append(this.tab(MESSAGES, h('span', null, 'Messages'), dot, this.active === MESSAGES));
    this.tabs.replaceChildren(frag);
    const cur = s.results.find((r) => r.id === this.active);
    this.note.textContent = cur ? `${rowCountNote(cur.result.rows.length, cur.result.truncated)} in ${formatDuration(cur.result.elapsedMs)}` : '';
    this.note.classList.toggle('db-warn', !!cur?.result.truncated);
  }

  private tab(id: number | typeof MESSAGES, label: HTMLElement, extra: HTMLElement, selected: boolean): HTMLElement {
    const b = h('button', { class: 'db-rp-tab' + (selected ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': String(selected) }, label, extra);
    b.addEventListener('click', () => {
      this.active = id;
      this.renderTabs();
      this.renderBody();
    });
    return b;
  }

  private renderBody(): void {
    const s = this.store;
    // Grids for new results; hide all but the active one.
    for (const r of s.results) {
      if (this.grids.has(r.id)) continue;
      const el = h('div', { class: 'db-rp-grid' });
      this.bodyEl.append(el);
      const entry: { grid: ResultGrid | null; el: HTMLElement } = { grid: null, el };
      this.grids.set(r.id, entry);
      // The grid code is a separate chunk. It loads when the first result arrives.
      void import('./grid').then(({ ResultGrid }) => {
        if (this.disposed || this.grids.get(r.id) !== entry) return;
        entry.grid = new ResultGrid(this.ctx, el);
        entry.grid.setResult(r.result);
        if (r.id === this.active) entry.grid.refresh();
      });
    }
    for (const [id, g] of this.grids) {
      const show = id === this.active;
      g.el.hidden = !show;
      if (show) g.grid?.refresh();
    }
    this.messagesEl.hidden = this.active !== MESSAGES;
    if (this.active === MESSAGES) this.renderMessages();
  }

  private renderMessages(): void {
    const list = this.store.messages;
    if (list.length === 0) {
      this.messagesEl.replaceChildren(this.emptyEl);
      return;
    }
    const nearBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const m of list) {
      frag.append(
        h(
          'div',
          { class: `db-msg is-${m.level}` },
          h('span', { class: 'db-msg-time' }, formatTime(m.time)),
          h('span', { class: 'db-msg-sql', title: m.sql ?? '' }, messageSql(m.sql), m.where ? h('span', { class: 'db-faint' }, ` (${m.where})`) : null),
          h('span', { class: 'db-msg-text' }, m.text),
          h('span', { class: 'db-msg-time' }, m.elapsedMs == null ? '' : formatDuration(m.elapsedMs)),
        ),
      );
    }
    this.messagesEl.replaceChildren(frag);
    if (nearBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}

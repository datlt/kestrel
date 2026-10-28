// The result grid. Only the visible rows and columns are in the DOM, so a
// result with 50,000 rows scrolls smoothly. It has a sticky header with type
// tooltips, a row number column, resizable columns, client side sorting, cell
// and row selection with the keyboard, copy, export and a value viewer.
//
// The same technique as the CSV preview (src/features/preview/csv.ts).

import { h } from '../../core/dom';
import type { AppContext } from '../../core/types';
import { isMac, rafThrottle } from '../../core/util';
import type { DbResult, DbValue } from '../../ipc/db';
import { fsWriteFile } from '../../ipc/fs';
import {
  autoWidths,
  cellText,
  columnTooltip,
  formatDuration,
  rowCountNote,
  singleTable,
  sortOrder,
  toCsv,
  toInsert,
  toJson,
  toTsv,
} from './grid-data';
import { openValueViewer } from './value-viewer';
import './db.css';

const ROW_H = 22;
const HEAD_H = 26;
const OVER_ROWS = 6;
const OVER_COLS = 2;
const MIN_W = 24;
const MAX_W = 1200;
const FONT_PX = 13;

interface Selection {
  pos: number;
  col: number;
}

export class ResultGrid {
  private result: DbResult | null = null;
  private widths: number[] = [];
  private offsets = new Float64Array(1);
  private order: Uint32Array | null = null;
  private sort: { col: number; desc: boolean } | null = null;
  private sel: Selection | null = null;
  /** First and last selected row (positions, not source rows). */
  private range: { a: number; b: number } | null = null;
  private dirty = true;
  private lastHeader = '';
  private disposed = false;
  private cancelDrag: (() => void) | null = null;
  private closeViewer: (() => void) | null = null;
  private readonly rows = new Map<number, HTMLElement>();
  private readonly observer: ResizeObserver;

  private readonly header = h('div', { class: 'db-grid-header' });
  private readonly body = h('div', { class: 'db-grid-body' });
  private readonly sizer = h('div', { class: 'db-grid-sizer' }, this.header, this.body);
  private readonly viewport = h('div', { class: 'db-grid-viewport', tabindex: '0', role: 'grid' }, this.sizer);
  private readonly foot = h('div', { class: 'db-grid-foot' });
  private readonly empty = h('div', { class: 'db-grid-empty' });
  private readonly root = h('div', { class: 'db-grid' }, this.viewport, this.empty, this.foot);

  constructor(
    private readonly ctx: AppContext,
    host: HTMLElement,
  ) {
    host.append(this.root);
    this.empty.hidden = true;
    this.viewport.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.viewport.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.viewport.addEventListener('click', (e) => this.onClick(e));
    this.viewport.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.viewport.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.viewport.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.viewport.addEventListener('mouseover', (e) => this.onMouseOver(e));
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(this.viewport);
  }

  // --- Public ------------------------------------------------------------------------

  setResult(r: DbResult): void {
    this.result = r;
    this.sort = null;
    this.order = null;
    this.sel = null;
    this.range = null;
    this.widths = autoWidths(r.columns, r.rows, (t) => this.measure(t));
    this.computeOffsets();
    const note = rowCountNote(r.rows.length, r.truncated);
    this.foot.replaceChildren(
      h('span', { class: r.truncated ? 'db-warn' : '' }, note),
      h('span', { class: 'db-faint' }, formatDuration(r.elapsedMs)),
    );
    this.empty.textContent = r.rows.length === 0 ? 'No rows' : '';
    this.empty.hidden = r.rows.length > 0;
    this.viewport.hidden = r.rows.length === 0;
    this.invalidate();
  }

  /** Call when the grid becomes visible again. */
  refresh(): void {
    this.schedule();
  }

  focus(): void {
    this.viewport.focus({ preventScroll: true });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelDrag?.();
    this.closeViewer?.();
    this.observer.disconnect();
    this.root.remove();
  }

  // --- Model helpers -----------------------------------------------------------------------

  private get columns() {
    return this.result?.columns ?? [];
  }
  private get data(): DbValue[][] {
    return this.result?.rows ?? [];
  }
  private rowAt(pos: number): number {
    return this.order ? this.order[pos] : pos;
  }
  private valueAt(pos: number, col: number): DbValue {
    return this.data[this.rowAt(pos)]?.[col] ?? null;
  }
  private rnWidth(): number {
    return Math.max(36, String(Math.max(1, this.data.length)).length * 8 + 20);
  }
  private totalWidth(): number {
    return this.rnWidth() + this.offsets[this.columns.length];
  }

  private measure(text: string): number {
    this.ctxCanvas ??= document.createElement('canvas').getContext('2d');
    const g = this.ctxCanvas;
    if (!g) return text.length * 7.5;
    g.font = `${FONT_PX}px ${getComputedStyle(this.root).fontFamily || 'sans-serif'}`;
    return g.measureText(text).width;
  }
  private ctxCanvas: CanvasRenderingContext2D | null = null;

  private computeOffsets(): void {
    const n = this.columns.length;
    this.offsets = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) this.offsets[i + 1] = this.offsets[i] + (this.widths[i] ?? 100);
  }

  /** Index of the column that holds x (measured from the first data column). */
  private colAtX(x: number): number {
    const n = this.columns.length;
    if (n === 0) return 0;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // --- Drawing --------------------------------------------------------------------------------

  private readonly schedule = rafThrottle(() => {
    if (!this.disposed) this.render();
  });

  private invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  private render(): void {
    const r = this.result;
    const vh = this.viewport.clientHeight;
    const vw = this.viewport.clientWidth;
    if (!r || r.rows.length === 0 || vh === 0 || vw === 0) return;
    const count = r.rows.length;
    const w = this.totalWidth();
    this.sizer.style.width = `${w}px`;
    this.sizer.style.height = `${HEAD_H + count * ROW_H}px`;
    this.header.style.cssText = `width:${w}px;height:${HEAD_H}px;line-height:${HEAD_H}px`;
    this.body.style.cssText = `top:${HEAD_H}px;width:${w}px;height:${count * ROW_H}px`;

    const top = this.viewport.scrollTop;
    const r0 = Math.max(0, Math.floor((top - HEAD_H) / ROW_H) - OVER_ROWS);
    const r1 = Math.min(count, Math.ceil((top + vh - HEAD_H) / ROW_H) + OVER_ROWS);
    const sl = this.viewport.scrollLeft;
    const rn = this.rnWidth();
    const c0 = Math.max(0, this.colAtX(sl) - OVER_COLS);
    const c1 = Math.min(r.columns.length, this.colAtX(sl + vw - rn) + 1 + OVER_COLS);
    const colKey = `${c0}:${c1}`;

    if (this.dirty) {
      this.rows.clear();
      this.body.replaceChildren();
      this.lastHeader = '';
      this.dirty = false;
    }
    const headKey = `${colKey}:${this.sort?.col}:${this.sort?.desc}`;
    if (headKey !== this.lastHeader) {
      this.lastHeader = headKey;
      this.drawHeader(c0, c1);
    }
    for (const [pos, el] of this.rows) {
      if (pos < r0 || pos >= r1 || el.dataset.ck !== colKey) {
        el.remove();
        this.rows.delete(pos);
      }
    }
    for (let pos = r0; pos < r1; pos++) {
      if (this.rows.has(pos)) continue;
      const el = this.buildRow(pos, c0, c1, colKey);
      this.body.append(el);
      this.rows.set(pos, el);
    }
  }

  private buildRow(pos: number, c0: number, c1: number, colKey: string): HTMLElement {
    const cols = this.columns;
    const data = this.data[this.rowAt(pos)];
    const rn = this.rnWidth();
    const el = document.createElement('div');
    const inRange = this.inRange(pos);
    el.className = 'db-row' + (pos % 2 ? ' is-odd' : '') + (inRange ? ' is-rowsel' : '');
    el.dataset.p = String(pos);
    el.dataset.ck = colKey;
    el.setAttribute('role', 'row');
    el.style.cssText = `top:${pos * ROW_H}px;height:${ROW_H}px;line-height:${ROW_H}px;width:${this.totalWidth()}px`;
    const num = document.createElement('div');
    num.className = 'db-rn';
    num.style.width = `${rn}px`;
    num.textContent = String(pos + 1);
    el.append(num);
    for (let c = c0; c < c1; c++) {
      const v = data[c];
      const cell = document.createElement('div');
      let cls = 'db-cell';
      if (v === null) cls += ' db-null';
      if (cols[c].numeric) cls += ' db-num';
      if (this.sel && this.sel.pos === pos && this.sel.col === c) cls += ' is-selected';
      cell.className = cls;
      cell.dataset.c = String(c);
      cell.setAttribute('role', 'gridcell');
      cell.style.left = `${rn + this.offsets[c]}px`;
      cell.style.width = `${this.offsets[c + 1] - this.offsets[c]}px`;
      cell.textContent = v === null ? 'NULL' : cellText(v);
      el.append(cell);
    }
    return el;
  }

  private drawHeader(c0: number, c1: number): void {
    const rn = this.rnWidth();
    const frag = document.createDocumentFragment();
    const corner = document.createElement('div');
    corner.className = 'db-corner';
    corner.style.width = `${rn}px`;
    corner.textContent = '#';
    frag.append(corner);
    for (let c = c0; c < c1; c++) {
      const col = this.columns[c];
      const cell = document.createElement('div');
      cell.className = 'db-hcell' + (col.numeric ? ' db-num' : '');
      cell.dataset.c = String(c);
      cell.style.left = `${rn + this.offsets[c]}px`;
      cell.style.width = `${this.offsets[c + 1] - this.offsets[c]}px`;
      cell.title = columnTooltip(col);
      const label = document.createElement('span');
      label.className = 'db-hlabel';
      label.textContent = col.name;
      cell.append(label);
      if (this.sort && this.sort.col === c) {
        const arrow = document.createElement('span');
        arrow.className = 'db-sort';
        arrow.textContent = this.sort.desc ? '▼' : '▲';
        cell.append(arrow);
        cell.setAttribute('aria-sort', this.sort.desc ? 'descending' : 'ascending');
      }
      const grip = document.createElement('div');
      grip.className = 'db-grip';
      grip.title = 'Drag to change the width. Double-click to fit.';
      cell.append(grip);
      frag.append(cell);
    }
    this.header.replaceChildren(frag);
  }

  // --- Selection --------------------------------------------------------------------------------------

  private inRange(pos: number): boolean {
    if (!this.range) return false;
    const lo = Math.min(this.range.a, this.range.b);
    const hi = Math.max(this.range.a, this.range.b);
    return pos >= lo && pos <= hi;
  }

  private paintSelection(): void {
    for (const [pos, el] of this.rows) {
      el.classList.toggle('is-rowsel', this.inRange(pos));
      for (const cell of el.querySelectorAll<HTMLElement>('.db-cell')) {
        cell.classList.toggle('is-selected', !!this.sel && this.sel.pos === pos && Number(cell.dataset.c) === this.sel.col);
      }
    }
  }

  private select(pos: number, col: number, extend: boolean, reveal: boolean): void {
    const count = this.data.length;
    if (count === 0 || this.columns.length === 0) return;
    pos = Math.min(Math.max(0, pos), count - 1);
    col = Math.min(Math.max(0, col), this.columns.length - 1);
    this.range = extend && this.range ? { a: this.range.a, b: pos } : { a: pos, b: pos };
    this.sel = { pos, col };
    if (reveal) this.reveal(pos, col);
    this.paintSelection();
  }

  private reveal(pos: number, col: number): void {
    const vp = this.viewport;
    const rowTop = pos * ROW_H;
    const avail = vp.clientHeight - HEAD_H;
    if (rowTop < vp.scrollTop) vp.scrollTop = rowTop;
    else if (rowTop + ROW_H > vp.scrollTop + avail) vp.scrollTop = rowTop + ROW_H - avail;
    const dw = vp.clientWidth - this.rnWidth();
    const left = this.offsets[col];
    const right = this.offsets[col + 1];
    if (left < vp.scrollLeft) vp.scrollLeft = left;
    else if (right > vp.scrollLeft + dw) vp.scrollLeft = Math.min(left, right - dw);
  }

  /** Rows of the selection in screen order. */
  private selectedRows(): DbValue[][] {
    if (!this.range) return [];
    const lo = Math.min(this.range.a, this.range.b);
    const hi = Math.max(this.range.a, this.range.b);
    const out: DbValue[][] = [];
    for (let p = lo; p <= hi; p++) out.push(this.data[this.rowAt(p)]);
    return out;
  }

  private allRows(): DbValue[][] {
    return this.order ? Array.from(this.order, (i) => this.data[i]) : this.data;
  }

  // --- Copy and export ---------------------------------------------------------------------------------------

  private copy(text: string, what: string): void {
    navigator.clipboard.writeText(text).then(
      () => this.ctx.ui.notify(`Copied ${what}.`, { timeoutMs: 1500 }),
      () => this.ctx.ui.notify('Cannot copy to the clipboard.', { kind: 'warn' }),
    );
  }

  private copyCell(): void {
    if (!this.sel) return;
    const v = this.valueAt(this.sel.pos, this.sel.col);
    this.copy(v ?? '', 'the cell');
  }

  private copyRows(format: 'tsv' | 'tsv-header' | 'json' | 'insert'): void {
    const rows = this.selectedRows();
    if (!rows.length) return;
    const cols = this.columns;
    const label = rows.length === 1 ? 'the row' : `${rows.length} rows`;
    if (format === 'tsv') this.copy(toTsv(cols, rows), label);
    else if (format === 'tsv-header') this.copy(toTsv(cols, rows, true), label);
    else if (format === 'json') this.copy(toJson(cols, rows), label);
    else this.copy(toInsert(singleTable(cols), cols, rows), label);
  }

  private async exportCsv(): Promise<void> {
    if (!this.result) return;
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({ title: 'Export as CSV', defaultPath: 'result.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
      if (!path) return;
      const text = toCsv(this.columns, this.allRows());
      // A byte order mark helps Excel to read UTF-8.
      await fsWriteFile(path, text, { encoding: 'utf-8', bom: true, lineEnding: 'crlf', expectedMtimeMs: null });
      this.ctx.ui.notify(`Exported ${this.data.length.toLocaleString('en-US')} rows to ${path}`, { timeoutMs: 4000 });
    } catch (e) {
      this.ctx.ui.notify(`Could not export: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
    }
  }

  private openValue(): void {
    if (!this.sel) return;
    const col = this.columns[this.sel.col];
    this.closeViewer?.();
    this.closeViewer = openValueViewer(this.root, {
      title: col.name,
      value: this.valueAt(this.sel.pos, this.sel.col),
      json: col.type.toUpperCase() === 'JSON',
      copy: (t) => this.copy(t, 'the value'),
    });
  }

  // --- Sorting and width -------------------------------------------------------------------------------------------

  private toggleSort(col: number): void {
    if (!this.result) return;
    if (!this.sort || this.sort.col !== col) this.sort = { col, desc: false };
    else if (!this.sort.desc) this.sort = { col, desc: true };
    else this.sort = null;
    // Keep the selected source row selected.
    const keep = this.sel ? this.rowAt(this.sel.pos) : -1;
    this.order = this.sort ? sortOrder(this.data, this.sort.col, this.columns[this.sort.col].numeric, this.sort.desc) : null;
    if (keep >= 0 && this.sel) {
      let pos = keep;
      if (this.order) pos = this.order.indexOf(keep);
      this.sel = { pos, col: this.sel.col };
      this.range = { a: pos, b: pos };
    }
    this.invalidate();
  }

  private startResize(e: PointerEvent, col: number): void {
    e.preventDefault();
    e.stopPropagation();
    this.cancelDrag?.();
    const startX = e.clientX;
    const startW = this.widths[col] ?? 100;
    this.root.classList.add('is-resizing');
    const move = (ev: PointerEvent) => {
      this.widths[col] = Math.min(MAX_W, Math.max(MIN_W, startW + ev.clientX - startX));
      this.computeOffsets();
      this.invalidate();
    };
    const stop = () => {
      this.root.classList.remove('is-resizing');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
      this.cancelDrag = null;
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    this.cancelDrag = stop;
  }

  private fitColumn(col: number): void {
    const w = autoWidths([this.columns[col]], this.data.map((r) => [r[col]]), (t) => this.measure(t), { sample: 500, max: MAX_W });
    this.widths[col] = w[0];
    this.computeOffsets();
    this.invalidate();
  }

  // --- Events ------------------------------------------------------------------------------------------------------------

  private hit(target: EventTarget | null): { pos: number; col: number } | null {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>('.db-cell');
    const rowEl = el?.parentElement;
    if (!el || !rowEl || el.dataset.c === undefined || rowEl.dataset.p === undefined) return null;
    return { pos: Number(rowEl.dataset.p), col: Number(el.dataset.c) };
  }

  private onPointerDown(e: PointerEvent): void {
    const target = e.target as HTMLElement;
    const grip = target.closest<HTMLElement>('.db-grip');
    if (grip) {
      const c = Number(grip.parentElement?.dataset.c);
      if (e.button === 0 && !Number.isNaN(c)) this.startResize(e, c);
      return;
    }
    if (e.button !== 0) return;
    this.viewport.focus({ preventScroll: true });
    const hit = this.hit(target);
    if (hit) {
      this.select(hit.pos, hit.col, e.shiftKey, false);
      return;
    }
    const rn = target.closest<HTMLElement>('.db-rn');
    if (rn?.parentElement?.dataset.p !== undefined) {
      const pos = Number(rn.parentElement.dataset.p);
      this.select(pos, this.sel?.col ?? 0, e.shiftKey, false);
    }
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('.db-grip')) return;
    const head = target.closest<HTMLElement>('.db-hcell');
    if (head?.dataset.c !== undefined) this.toggleSort(Number(head.dataset.c));
  }

  private onDblClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const grip = target.closest<HTMLElement>('.db-grip');
    if (grip) {
      this.fitColumn(Number(grip.parentElement?.dataset.c));
      return;
    }
    if (this.hit(target)) this.openValue();
  }

  private onMouseOver(e: MouseEvent): void {
    const hit = this.hit(e.target);
    if (!hit) return;
    const el = e.target as HTMLElement;
    const cell = el.closest<HTMLElement>('.db-cell');
    if (!cell || cell.title) return;
    const v = this.valueAt(hit.pos, hit.col);
    if (v !== null && (v.length > cellText(v).length || cell.scrollWidth > cell.clientWidth)) cell.title = v.slice(0, 4000);
  }

  private onContextMenu(e: MouseEvent): void {
    const hit = this.hit(e.target);
    const rn = (e.target as HTMLElement).closest<HTMLElement>('.db-rn');
    if (!hit && !rn) return;
    e.preventDefault();
    if (hit && !this.inRange(hit.pos)) this.select(hit.pos, hit.col, false, false);
    else if (hit && this.sel) this.sel = { pos: this.sel.pos, col: hit.col };
    else if (rn?.parentElement?.dataset.p !== undefined && !this.inRange(Number(rn.parentElement.dataset.p))) {
      this.select(Number(rn.parentElement.dataset.p), 0, false, false);
    }
    const n = this.selectedRows().length;
    const rows = n > 1 ? 'Rows' : 'Row';
    this.ctx.ui.contextMenu(e, [
      { label: 'Copy Cell', keybinding: 'Mod-c', run: () => this.copyCell(), disabled: !this.sel },
      { label: `Copy ${rows} as TSV`, run: () => this.copyRows('tsv'), separatorBefore: true },
      { label: `Copy ${rows} as TSV with Header`, run: () => this.copyRows('tsv-header') },
      { label: `Copy ${rows} as JSON`, run: () => this.copyRows('json') },
      { label: `Copy ${rows} as INSERT Statements`, run: () => this.copyRows('insert') },
      { label: 'Open Value...', run: () => this.openValue(), separatorBefore: true, disabled: !this.sel },
      { label: 'Export All Rows as CSV...', run: () => void this.exportCsv() },
    ]);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 'c' && !e.shiftKey) {
      if (this.range && this.range.a !== this.range.b) this.copyRows('tsv');
      else this.copyCell();
      e.preventDefault();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && key === 'a') {
      if (this.data.length) {
        this.range = { a: 0, b: this.data.length - 1 };
        this.sel ??= { pos: 0, col: 0 };
        this.paintSelection();
      }
      e.preventDefault();
      return;
    }
    if (e.altKey || (!mod && e.metaKey) || (e.ctrlKey && !mod)) return;
    if (this.data.length === 0) return;
    const page = Math.max(1, Math.floor((this.viewport.clientHeight - HEAD_H) / ROW_H) - 1);
    const cur = this.sel ?? { pos: Math.floor(this.viewport.scrollTop / ROW_H), col: this.colAtX(this.viewport.scrollLeft) };
    const started = this.sel !== null;
    let next: Selection | null = null;
    switch (e.key) {
      case 'ArrowUp': next = { pos: cur.pos - (started ? 1 : 0), col: cur.col }; break;
      case 'ArrowDown': next = { pos: cur.pos + (started ? 1 : 0), col: cur.col }; break;
      case 'ArrowLeft': next = { pos: cur.pos, col: cur.col - (started ? 1 : 0) }; break;
      case 'ArrowRight': next = { pos: cur.pos, col: cur.col + (started ? 1 : 0) }; break;
      case 'PageUp': next = { pos: cur.pos - page, col: cur.col }; break;
      case 'PageDown': next = { pos: cur.pos + page, col: cur.col }; break;
      case 'Home': next = mod ? { pos: 0, col: 0 } : { pos: cur.pos, col: 0 }; break;
      case 'End': next = mod ? { pos: this.data.length - 1, col: this.columns.length - 1 } : { pos: cur.pos, col: this.columns.length - 1 }; break;
      case 'Enter':
        // Mod-Enter belongs to "Run" (it goes on to the command).
        if (mod) return;
        if (this.sel && !e.isComposing) {
          this.openValue();
          e.preventDefault();
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    this.select(next.pos, next.col, e.shiftKey, true);
  }
}

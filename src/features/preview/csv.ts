// CSV / TSV preview: a table with a sticky header, a row number column, column
// widths that the user can drag, sorting by header click, and virtual rows and
// columns, so files with 100k+ rows scroll smoothly.
//
// Only the rows and columns that are visible (plus a few more) are in the DOM.
// Very tall tables: browsers limit the height of an element. Above MAX_BODY_H the
// scroll bar is compressed (`k` below), so the scroll position maps to a row
// with a factor.

import { h } from '../../core/dom';
import type { AppContext, FileEditor, PreviewInstance } from '../../core/types';
import { isMac, rafThrottle } from '../../core/util';
import { CsvClient } from './csv-client';
import { cellText, columnLabel, delimiterForPath, type CsvTable, type Delimiter } from './csv-parse';
import { sortRows } from './csv-sort';
import { nextZoom } from './frame';
import { setPreviewInfo } from './status';
import './csv.css';
import './preview.css';

const BASE_ROW_H = 24;
const BASE_HEAD_H = 28;
const BASE_FONT = 13;
const OVER_ROWS = 6;
const OVER_COLS = 2;
const MAX_BODY_H = 8_000_000;
const MAX_CELL_CHARS = 500;
const MAX_TOOLTIP_CHARS = 4000;
const MIN_W = 48;
const MAX_W = 360;
const SAMPLE_ROWS = 200;
const BIG_SORT_ROWS = 50_000;

type Choice = Delimiter | 'auto';
const NAMES: Record<Delimiter, string> = { ',': 'Comma', ';': 'Semicolon', '\t': 'Tab', '|': 'Pipe' };
const CHOICES: Choice[] = ['auto', ',', ';', '\t', '|'];

interface Saved {
  delimiter?: Choice;
  header?: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function createCsvPreview(ctx: AppContext, host: HTMLElement, editor: FileEditor): PreviewInstance {
  const stateKey = `preview.csv:${editor.path}`;
  const saved = (ctx.workspace.state.get<Saved>(stateKey) ?? {}) as Saved;
  let choice: Choice = CHOICES.includes(saved.delimiter as Choice) ? (saved.delimiter as Choice) : 'auto';
  let headerRow = saved.header ?? true;
  const hint = delimiterForPath(editor.path);
  const client = new CsvClient();
  const owner = `csv:${editor.tabId}`;

  let text = '';
  let gotText = false;
  let table: CsvTable | null = null;
  let disposed = false;
  let active = ctx.tabs.active()?.id === editor.tabId;
  let parseSeq = 0;
  let scale = 1;
  let widths: number[] = [];
  let offsets = new Float64Array(1);
  let order: Uint32Array | null = null;
  let sort: { col: number; desc: boolean } | null = null;
  let sortToken = 0;
  let sel: { pos: number; col: number } | null = null;
  let dirty = true;
  /** True while the table only holds the first rows and the worker still reads. */
  let reading = false;
  let infoText = '';
  let readRows = 0;
  let layoutDone = false;
  let pendingLine: number | null = null;
  let suppressScrollUntil = 0;
  let cancelDrag: (() => void) | null = null;
  // Values from the last layout.
  let lk = 1;
  let lastHeader = '';
  const rows = new Map<number, HTMLElement>();

  // --- DOM -----------------------------------------------------------------
  const delimSelect = h('select', { class: 'csv-select', title: 'Delimiter' });
  for (const c of CHOICES) delimSelect.append(h('option', { value: c }, c === 'auto' ? 'Auto' : NAMES[c]));
  delimSelect.value = choice;
  const headerBtn = h('button', { class: 'preview-btn', type: 'button', title: 'The first row is a header' }, 'Header row');
  const info = h('span', { class: 'preview-note' });
  const toolbar = h(
    'div',
    { class: 'preview-toolbar' },
    h('span', { class: 'csv-label' }, 'Delimiter'),
    delimSelect,
    headerBtn,
    h('span', { class: 'preview-spacer' }),
    info,
  );
  const header = h('div', { class: 'csv-header' });
  const body = h('div', { class: 'csv-body' });
  const sizer = h('div', { class: 'csv-sizer' }, header, body);
  const viewport = h('div', { class: 'csv-viewport', tabindex: '0', role: 'grid' }, sizer);
  const empty = h('div', { class: 'csv-empty' }, 'No data');
  const root = h('div', { class: 'csv-root' }, toolbar, viewport, empty);
  root.style.setProperty('--csv-fs', `${BASE_FONT}px`);
  empty.hidden = true;
  host.append(root);
  headerBtn.setAttribute('aria-pressed', String(headerRow));

  // --- Model helpers -------------------------------------------------------
  const rowH = () => Math.round(BASE_ROW_H * scale);
  const headH = () => Math.round(BASE_HEAD_H * scale);
  const first = () => (headerRow ? 1 : 0);
  const dataCount = () => (table ? Math.max(0, table.rows - first()) : 0);
  const cols = () => table?.cols ?? 0;
  const rnWidth = () => Math.round((String(Math.max(1, dataCount())).length * 8 + 18) * scale);
  const totalWidth = () => rnWidth() + offsets[cols()];
  const rowAt = (pos: number) => (order ? order[pos] : first() + pos);

  function headerLabel(c: number): string {
    if (headerRow && table && table.rows > 0) return cellText(table, text, 0, c) || columnLabel(c);
    return columnLabel(c);
  }

  function computeOffsets(): void {
    const n = cols();
    offsets = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + (widths[i] ?? 100) * scale;
  }

  /** Index of the column that contains `x` (x is measured from the first data column). */
  function colAtX(x: number): number {
    const n = cols();
    if (n === 0) return 0;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function measureWidths(t: CsvTable): number[] {
    const g = document.createElement('canvas').getContext('2d');
    if (g) g.font = `${BASE_FONT}px ${getComputedStyle(root).fontFamily}`;
    const width = (s: string) => {
      const short = s.length > 80 ? s.slice(0, 80) : s;
      return g ? g.measureText(short.replace(/[\r\n\t]+/g, ' ')).width : short.length * 7;
    };
    const f = first();
    const sample = Math.min(Math.max(0, t.rows - f), t.cols > 100 ? 60 : SAMPLE_ROWS);
    const out: number[] = [];
    for (let c = 0; c < t.cols; c++) {
      let max = width(headerLabel(c)) + 16;
      for (let k = 0; k < sample; k++) max = Math.max(max, width(cellText(t, text, f + k, c)));
      out.push(Math.min(MAX_W, Math.max(MIN_W, Math.ceil(max) + 20)));
    }
    return out;
  }

  // --- Layout and drawing ----------------------------------------------------
  /** Sets the size of the scroll area. Returns false while the view is hidden. */
  function layout(): boolean {
    const vh = viewport.clientHeight;
    const vw = viewport.clientWidth;
    if (!table || vh === 0 || vw === 0) return false;
    const hh = headH();
    const totalH = dataCount() * rowH();
    const bodyH = Math.min(totalH, MAX_BODY_H);
    const d = vh - hh;
    lk = totalH > bodyH && bodyH > d ? (totalH - d) / (bodyH - d) : 1;
    const w = totalWidth();
    sizer.style.width = `${w}px`;
    sizer.style.height = `${hh + bodyH}px`;
    header.style.cssText = `width:${w}px;height:${hh}px;line-height:${hh}px`;
    body.style.cssText = `top:${hh}px;width:${w}px;height:${bodyH}px`;
    layoutDone = true;
    return true;
  }

  const vTop = () => viewport.scrollTop * lk;
  const setVTop = (v: number) => {
    viewport.scrollTop = v / lk;
  };
  const topPos = () => Math.max(0, Math.floor(vTop() / rowH()));

  function render(): void {
    if (disposed || !table || !layout()) return;
    const t = table;
    const vh = viewport.clientHeight;
    const vw = viewport.clientWidth;
    const rh = rowH();
    const hh = headH();
    const count = dataCount();
    const rn = rnWidth();
    const top = vTop();
    const offsetY = top - viewport.scrollTop;
    const r0 = Math.max(0, Math.floor((top - hh) / rh) - OVER_ROWS);
    const r1 = Math.min(count, Math.ceil((top + vh - hh) / rh) + OVER_ROWS);
    const sl = viewport.scrollLeft;
    const c0 = Math.max(0, colAtX(sl) - OVER_COLS);
    const c1 = Math.min(t.cols, colAtX(sl + vw - rn) + 1 + OVER_COLS);
    const colKey = `${c0}:${c1}`;

    if (dirty) {
      rows.clear();
      body.replaceChildren();
      lastHeader = '';
    }
    dirty = false;

    const headKey = `${colKey}:${sort?.col}:${sort?.desc}`;
    if (headKey !== lastHeader) {
      lastHeader = headKey;
      drawHeader(c0, c1);
    }

    for (const [pos, el] of rows) {
      if (pos < r0 || pos >= r1 || el.dataset.ck !== colKey) {
        el.remove();
        rows.delete(pos);
      }
    }
    for (let pos = r0; pos < r1; pos++) {
      let el = rows.get(pos);
      if (!el) {
        el = buildRow(pos, c0, c1, colKey);
        body.append(el);
        rows.set(pos, el);
      }
      if (lk !== 1) el.style.top = `${pos * rh - offsetY}px`;
    }
  }

  function buildRow(pos: number, c0: number, c1: number, colKey: string): HTMLElement {
    const t = table!;
    const rh = rowH();
    const rn = rnWidth();
    const row = rowAt(pos);
    const el = document.createElement('div');
    el.className = pos % 2 ? 'csv-row is-odd' : 'csv-row';
    el.dataset.p = String(pos);
    el.dataset.ck = colKey;
    el.setAttribute('role', 'row');
    el.style.cssText = `top:${pos * rh - (vTop() - viewport.scrollTop)}px;height:${rh}px;line-height:${rh}px;width:${totalWidth()}px`;
    const num = document.createElement('div');
    num.className = 'csv-rn';
    num.style.width = `${rn}px`;
    num.textContent = String(pos + 1);
    el.append(num);
    const n = Math.min(c1, t.cols);
    for (let c = c0; c < n; c++) {
      const s = cellText(t, text, row, c);
      const cell = document.createElement('div');
      cell.className = sel && sel.pos === pos && sel.col === c ? 'csv-cell is-selected' : 'csv-cell';
      cell.dataset.c = String(c);
      cell.setAttribute('role', 'gridcell');
      cell.style.left = `${rn + offsets[c]}px`;
      cell.style.width = `${offsets[c + 1] - offsets[c]}px`;
      if (s.length > MAX_CELL_CHARS) {
        cell.textContent = s.slice(0, MAX_CELL_CHARS) + '…';
        cell.dataset.t = '1';
      } else {
        cell.textContent = s;
      }
      el.append(cell);
    }
    return el;
  }

  function drawHeader(c0: number, c1: number): void {
    const t = table!;
    const rn = rnWidth();
    const frag = document.createDocumentFragment();
    const corner = document.createElement('div');
    corner.className = 'csv-corner';
    corner.style.width = `${rn}px`;
    corner.textContent = '#';
    frag.append(corner);
    for (let c = c0; c < Math.min(c1, t.cols); c++) {
      const cell = document.createElement('div');
      cell.className = 'csv-hcell';
      cell.dataset.c = String(c);
      cell.style.left = `${rn + offsets[c]}px`;
      cell.style.width = `${offsets[c + 1] - offsets[c]}px`;
      const label = document.createElement('span');
      label.className = 'csv-hlabel';
      label.textContent = headerLabel(c);
      cell.append(label);
      if (sort && sort.col === c) {
        const arrow = document.createElement('span');
        arrow.className = 'csv-sort';
        arrow.textContent = sort.desc ? '▼' : '▲';
        cell.append(arrow);
        cell.setAttribute('aria-sort', sort.desc ? 'descending' : 'ascending');
      }
      const grip = document.createElement('div');
      grip.className = 'csv-grip';
      grip.title = 'Drag to change the width';
      cell.append(grip);
      frag.append(cell);
    }
    header.replaceChildren(frag);
  }

  const schedule = rafThrottle(() => {
    if (disposed) return;
    applyPendingLine();
    render();
  });

  function invalidate(): void {
    dirty = true;
    schedule();
  }

  // --- Table updates -----------------------------------------------------------
  function updateInfo(): void {
    if (!table) {
      infoText = '';
    } else {
      infoText = reading
        ? `Reading rows… ${readRows.toLocaleString('en-US')}`
        : `${plural(dataCount(), 'row', 'rows')} × ${plural(table.cols, 'column', 'columns')}`;
    }
    info.textContent = infoText;
    const auto = delimSelect.options[0];
    auto.textContent = table && choice === 'auto' ? `Auto (${NAMES[table.delimiter]})` : 'Auto';
    refreshStatus();
  }

  function refreshStatus(): void {
    setPreviewInfo(ctx, owner, active && table && infoText ? infoText : null, editor.path);
  }

  function applyTable(t: CsvTable, keepWidths: boolean, sorted?: Uint32Array | null): void {
    // Keep the top row where it is: the scroll factor changes when the table grows.
    const topRow = table && layoutDone ? topPos() : -1;
    const oldLk = lk;
    table = t;
    if (!keepWidths || widths.length !== t.cols) {
      const measured = measureWidths(t);
      // A table that grows keeps the widths of the columns it already had.
      widths = keepWidths ? measured.map((w, c) => widths[c] ?? w) : measured;
    }
    if (sort && sort.col >= t.cols) sort = null;
    if (sorted !== undefined) order = sort ? sorted : null;
    else order = sort ? sortRows(t, text, first(), sort.col, sort.desc) : null;
    if (sel && (sel.pos >= dataCount() || sel.col >= t.cols)) sel = null;
    computeOffsets();
    const hasData = t.rows > 0;
    viewport.hidden = !hasData;
    empty.hidden = hasData;
    if (topRow >= 0 && layout()) {
      if (lk !== oldLk) {
        suppressScrollUntil = performance.now() + 250;
        setVTop(topRow * rowH());
      }
    }
    updateInfo();
    invalidate();
  }

  async function reparse(keepWidths: boolean, stream: boolean): Promise<void> {
    const seq = ++parseSeq;
    reading = false;
    if (!table) info.textContent = 'Parsing…';
    // Big texts show the first rows early. A table that is already on screen stays
    // until the new one is ready (an edit), so it does not flicker.
    let shown = false;
    const progress = stream
      ? {
          onPartial: (partial: CsvTable) => {
            if (disposed || seq !== parseSeq) return;
            reading = true;
            readRows = partial.rows;
            sort = null;
            applyTable(partial, shown || (keepWidths && table !== null && table.delimiter === partial.delimiter && widths.length > 0));
            shown = true;
          },
          onRows: (n: number) => {
            if (disposed || seq !== parseSeq) return;
            readRows = n;
            updateInfo();
          },
        }
      : undefined;
    const t = await client.parse(text, choice, hint, progress);
    if (disposed || seq !== parseSeq || !t) return;
    let sorted: Uint32Array | null | undefined;
    if (sort && sort.col < t.cols && t.rows > BIG_SORT_ROWS) {
      info.textContent = 'Sorting…';
      sorted = await client.sort(t, text, first(), sort.col, sort.desc);
      if (disposed || seq !== parseSeq) return;
      if (!sorted) sort = null;
    }
    reading = false;
    applyTable(t, keepWidths || shown, sorted);
  }

  function saveState(): void {
    ctx.workspace.state.set(stateKey, { delimiter: choice, header: headerRow } satisfies Saved);
  }

  // --- Selection ---------------------------------------------------------------
  function cellEl(pos: number, col: number): HTMLElement | null {
    return rows.get(pos)?.querySelector<HTMLElement>(`.csv-cell[data-c="${col}"]`) ?? null;
  }

  function select(pos: number, col: number, reveal: boolean): void {
    if (!table || dataCount() === 0) return;
    pos = Math.min(Math.max(0, pos), dataCount() - 1);
    col = Math.min(Math.max(0, col), table.cols - 1);
    if (sel) cellEl(sel.pos, sel.col)?.classList.remove('is-selected');
    sel = { pos, col };
    if (reveal) revealCell(pos, col);
    cellEl(pos, col)?.classList.add('is-selected');
  }

  function revealCell(pos: number, col: number): void {
    if (!layout()) return;
    const rh = rowH();
    const d = viewport.clientHeight - headH();
    const top = vTop();
    const rowTop = pos * rh;
    if (rowTop < top) setVTop(rowTop);
    else if (rowTop + rh > top + d) setVTop(rowTop + rh - d);
    const dw = viewport.clientWidth - rnWidth();
    const left = offsets[col];
    const right = offsets[col + 1];
    if (left < viewport.scrollLeft) viewport.scrollLeft = left;
    else if (right > viewport.scrollLeft + dw) viewport.scrollLeft = Math.min(left, right - dw);
  }

  function selectedText(): string | null {
    if (!sel || !table) return null;
    return cellText(table, text, rowAt(sel.pos), sel.col);
  }

  function copySelected(): boolean {
    const s = selectedText();
    if (s === null) return false;
    navigator.clipboard.writeText(s).catch(() => ctx.ui.notify('Cannot copy to the clipboard.', { kind: 'warn' }));
    return true;
  }

  // --- Sorting -----------------------------------------------------------------
  function toggleSort(col: number): void {
    if (!table) return;
    // The table is not complete yet: a sort would only cover the rows read so far.
    if (reading) return;
    if (!sort || sort.col !== col) sort = { col, desc: false };
    else if (!sort.desc) sort = { col, desc: true };
    else sort = null;
    const selectedRow = sel ? rowAt(sel.pos) : -1;
    const token = ++sortToken;
    const done = (next: Uint32Array | null) => {
      if (disposed || token !== sortToken || !table) return;
      order = next;
      if (sel) {
        const pos = posOfRow(selectedRow);
        sel = pos < 0 ? null : { pos, col: sel.col };
      }
      info.textContent = infoText;
      invalidate();
    };
    if (!sort) {
      done(null);
    } else if (table.rows > BIG_SORT_ROWS) {
      // Big tables sort in the worker. The old order stays on screen until the new one is ready.
      info.textContent = 'Sorting…';
      const want = sort;
      void client.sort(table, text, first(), want.col, want.desc).then((o) => {
        if (o) done(o);
        else if (!disposed && token === sortToken) info.textContent = infoText;
      });
    } else {
      done(sortRows(table, text, first(), sort.col, sort.desc));
    }
    lastHeader = '';
    schedule();
  }

  function posOfRow(row: number): number {
    if (!order) return row - first();
    for (let i = 0; i < order.length; i++) if (order[i] === row) return i;
    return -1;
  }

  // --- Column width drag ---------------------------------------------------------
  function startResize(e: PointerEvent, col: number): void {
    e.preventDefault();
    e.stopPropagation();
    cancelDrag?.();
    const startX = e.clientX;
    const startW = widths[col] ?? 100;
    root.classList.add('is-resizing');
    const move = (ev: PointerEvent) => {
      widths[col] = Math.min(1200, Math.max(24, startW + (ev.clientX - startX) / scale));
      computeOffsets();
      invalidate();
    };
    const stop = () => {
      root.classList.remove('is-resizing');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
      cancelDrag = null;
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    cancelDrag = stop;
  }

  // --- Events --------------------------------------------------------------------
  function cellOf(target: EventTarget | null): { el: HTMLElement; pos: number; col: number } | null {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>('.csv-cell');
    const rowEl = el?.parentElement;
    if (!el || !rowEl || el.dataset.c === undefined || rowEl.dataset.p === undefined) return null;
    return { el, pos: Number(rowEl.dataset.p), col: Number(el.dataset.c) };
  }

  viewport.addEventListener('pointerdown', (e) => {
    const target = e.target as HTMLElement;
    const grip = target.closest<HTMLElement>('.csv-grip');
    if (grip) {
      const c = Number(grip.parentElement?.dataset.c);
      if (e.button === 0 && !Number.isNaN(c)) startResize(e, c);
      return;
    }
    if (e.button !== 0) return;
    const hit = cellOf(target);
    viewport.focus({ preventScroll: true });
    if (hit) select(hit.pos, hit.col, false);
  });

  viewport.addEventListener('click', (e) => {
    const head = (e.target as HTMLElement).closest<HTMLElement>('.csv-hcell');
    if (head && head.dataset.c !== undefined && !(e.target as HTMLElement).closest('.csv-grip')) toggleSort(Number(head.dataset.c));
  });

  // Full text as a tooltip, only for cells that are cut.
  viewport.addEventListener('mouseover', (e) => {
    const target = e.target as HTMLElement;
    const hit = cellOf(target);
    if (hit) {
      if (hit.el.title || !table) return;
      if (hit.el.dataset.t || hit.el.scrollWidth > hit.el.clientWidth) {
        hit.el.title = cellText(table, text, rowAt(hit.pos), hit.col).slice(0, MAX_TOOLTIP_CHARS);
      }
      return;
    }
    const head = target.closest<HTMLElement>('.csv-hcell');
    const label = head?.querySelector<HTMLElement>('.csv-hlabel');
    if (head && label && !head.title && label.scrollWidth > label.clientWidth) head.title = label.textContent ?? '';
  });

  viewport.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
      if (copySelected()) e.preventDefault();
      return;
    }
    if (e.altKey || (!mod && e.metaKey) || (e.ctrlKey && !mod)) return;
    if (!table || dataCount() === 0) return;
    const page = Math.max(1, Math.floor((viewport.clientHeight - headH()) / rowH()) - 1);
    const cur = sel ?? { pos: topPos(), col: colAtX(viewport.scrollLeft) };
    let next: { pos: number; col: number } | null = null;
    switch (e.key) {
      case 'ArrowUp': next = { pos: cur.pos - (sel ? 1 : 0), col: cur.col }; break;
      case 'ArrowDown': next = { pos: cur.pos + (sel ? 1 : 0), col: cur.col }; break;
      case 'ArrowLeft': next = { pos: cur.pos, col: cur.col - (sel ? 1 : 0) }; break;
      case 'ArrowRight': next = { pos: cur.pos, col: cur.col + (sel ? 1 : 0) }; break;
      case 'PageUp': next = { pos: cur.pos - page, col: cur.col }; break;
      case 'PageDown': next = { pos: cur.pos + page, col: cur.col }; break;
      case 'Home': next = { pos: mod ? 0 : cur.pos, col: 0 }; break;
      case 'End': next = { pos: mod ? dataCount() - 1 : cur.pos, col: table.cols - 1 }; break;
      case 'Escape':
        if (sel) {
          cellEl(sel.pos, sel.col)?.classList.remove('is-selected');
          sel = null;
          e.preventDefault();
        }
        return;
      default: return;
    }
    e.preventDefault();
    select(next.pos, next.col, true);
  });

  viewport.addEventListener('copy', (e) => {
    const s = selectedText();
    if (s === null) return;
    e.clipboardData?.setData('text/plain', s);
    e.preventDefault();
  });

  const onScroll = rafThrottle(() => {
    if (disposed) return;
    render();
    // In split mode the code follows the table (not when sorted: the rows are in another order).
    if (performance.now() < suppressScrollUntil || sort || !table || editor.getMode() !== 'split') return;
    editor.revealLine(topPos() + first() + 1);
  });
  viewport.addEventListener('scroll', onScroll, { passive: true });

  delimSelect.addEventListener('change', () => {
    choice = delimSelect.value as Choice;
    saveState();
    sort = null;
    sel = null;
    void reparse(false, true);
  });
  headerBtn.addEventListener('click', () => {
    headerRow = !headerRow;
    headerBtn.setAttribute('aria-pressed', String(headerRow));
    saveState();
    sel = null;
    if (table) {
      sort = null;
      applyTable(table, false);
    }
  });

  // The size changes when the split bar moves, when the window changes, and when
  // a hidden workbench becomes visible again.
  const resizeObserver = new ResizeObserver(() => schedule());
  resizeObserver.observe(viewport);

  const subs = [
    ctx.bus.on('tab:activated', (e) => {
      active = e.tabId === editor.tabId;
      refreshStatus();
    }),
    ctx.bus.on('workbench:disposing', () => cleanup()),
  ];

  function applyPendingLine(): void {
    if (pendingLine === null || !table) return;
    if (sort) {
      pendingLine = null;
      return;
    }
    if (!layout()) return;
    const pos = Math.max(0, pendingLine - 1 - first());
    pendingLine = null;
    suppressScrollUntil = performance.now() + 250;
    setVTop(pos * rowH());
  }

  function cleanup(): void {
    if (disposed) return;
    disposed = true;
    cancelDrag?.();
    client.dispose();
    resizeObserver.disconnect();
    for (const s of subs) s.dispose();
    setPreviewInfo(ctx, owner, null);
    rows.clear();
    root.remove();
  }

  return {
    update(next) {
      if (disposed) return;
      if (gotText && next === text) return;
      gotText = true;
      text = next;
      // Parsing a very big text on every key press is wasteful. Wait a little more.
      // The first text streams. Later texts (edits) replace the table in one step.
      // The editor already waits longer before it sends a big text (`pushDelay`).
      void reparse(true, !table);
    },
    revealLine(line) {
      pendingLine = line;
      schedule();
    },
    zoom(step) {
      if (!table) return;
      const oldScale = scale;
      scale = nextZoom(scale, step);
      if (scale === oldScale) return;
      const pos = topPos();
      root.style.setProperty('--csv-fs', `${BASE_FONT * scale}px`);
      computeOffsets();
      if (layout()) {
        setVTop(pos * rowH());
        viewport.scrollLeft *= scale / oldScale;
      }
      invalidate();
    },
    dispose: cleanup,
  };
}

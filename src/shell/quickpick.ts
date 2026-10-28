// Quick pick: a search box with a virtualized list.
//
// Static items are filtered here with the fuzzy matcher. For a function, the
// shell calls it (debounced) on every query change and shows the result as it
// is. Only the visible rows are in the DOM, so thousands of rows stay fast.

import { h } from '../core/dom';
import type { QuickPickHandle, QuickPickItem, QuickPickOptions, UiService } from '../core/types';
import { fuzzyFilter } from './fuzzy';

const ROW_HEIGHT = 26;
const MAX_VISIBLE_ROWS = 12;
const OVERSCAN = 4;
const ASYNC_DEBOUNCE_MS = 60;
const BUSY_DELAY_MS = 150;

interface Row<T> {
  item: T;
  labelIndexes: number[];
  descriptionIndexes: number[];
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
    if (on) frag.append(h('b', { class: 'shell-qp-hl' }, part));
    else frag.append(part);
    i = j;
  }
  return frag;
}

/** `layer` is the overlay layer inside the root element of this shell. */
export function createQuickPick(layer: HTMLElement): { open: UiService['quickPick']; close(): void } {
  let closeActive: ((cancelled: boolean) => void) | null = null;

  function quickPick<T extends QuickPickItem>(opts: QuickPickOptions<T>): QuickPickHandle {
    closeActive?.(true);

    const previousFocus = document.activeElement as HTMLElement | null;
    const input = h('input', {
      class: 'shell-qp-input',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: opts.placeholder ?? '',
      role: 'combobox',
      'aria-expanded': 'true',
    });
    input.value = opts.value ?? '';
    const busy = h('div', { class: 'shell-qp-busy' });
    const spacer = h('div', { class: 'shell-qp-spacer' });
    const list = h('div', { class: 'shell-qp-list', role: 'listbox' }, spacer);
    const empty = h('div', { class: 'shell-qp-empty' }, opts.emptyText ?? 'No results');
    const box = h('div', { class: 'shell-qp' }, h('div', { class: 'shell-qp-head' }, input, busy), list, empty);
    const overlay = h('div', { class: 'shell-qp-backdrop' }, box);

    let rows: Row<T>[] = [];
    let active = 0;
    let loaded = false;
    let closed = false;
    let lastNotified: T | null | undefined;
    const visible = new Map<number, HTMLElement>();

    // ---- rendering -------------------------------------------------------

    function buildRow(i: number): HTMLElement {
      const row = rows[i];
      const it = row.item;
      let iconEl: Element | null = null;
      try {
        iconEl = it.icon?.() ?? null;
      } catch (err) {
        console.error('quick pick icon failed', err);
      }
      const el = h(
        'div',
        { class: 'shell-qp-row' + (i === active ? ' shell-active' : ''), role: 'option' },
        iconEl ? h('span', { class: 'shell-qp-icon' }, iconEl) : null,
        h('span', { class: 'shell-qp-label' }, highlighted(it.label, row.labelIndexes)),
        it.description ? h('span', { class: 'shell-qp-desc' }, highlighted(it.description, row.descriptionIndexes)) : null,
        it.detail ? h('span', { class: 'shell-qp-detail' }, it.detail) : null,
        it.hint ? h('span', { class: 'shell-qp-hint' }, it.hint) : null,
      );
      el.dataset.i = String(i);
      el.style.top = `${i * ROW_HEIGHT}px`;
      el.setAttribute('aria-selected', String(i === active));
      return el;
    }

    function viewportHeight(): number {
      return Math.min(rows.length, MAX_VISIBLE_ROWS) * ROW_HEIGHT;
    }

    function paint() {
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

    function resetRows() {
      for (const el of visible.values()) el.remove();
      visible.clear();
      spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
      list.style.height = `${viewportHeight()}px`;
      list.hidden = rows.length === 0;
      empty.hidden = !(loaded && rows.length === 0);
      paint();
    }

    function notifyActive() {
      const item = rows[active]?.item ?? null;
      if (item === lastNotified) return;
      lastNotified = item;
      opts.onActive?.(item);
    }

    function setActive(next: number, reveal = true) {
      if (!rows.length) return;
      const prev = active;
      active = next;
      for (const [i, el] of visible) {
        if (i === prev || i === next) {
          el.classList.toggle('shell-active', i === next);
          el.setAttribute('aria-selected', String(i === next));
        }
      }
      if (reveal) {
        const top = next * ROW_HEIGHT;
        const vh = viewportHeight();
        if (top < list.scrollTop) list.scrollTop = top;
        else if (top + ROW_HEIGHT > list.scrollTop + vh) list.scrollTop = top + ROW_HEIGHT - vh;
        paint();
      }
      notifyActive();
    }

    function setRows(next: Row<T>[], keepId?: string) {
      rows = next;
      loaded = true;
      let idx = 0;
      if (keepId !== undefined) {
        const found = rows.findIndex((r) => r.item.id === keepId);
        if (found >= 0) idx = found;
      }
      active = idx;
      list.scrollTop = Math.max(0, idx * ROW_HEIGHT - viewportHeight() / 2);
      resetRows();
      notifyActive();
    }

    // ---- items -----------------------------------------------------------

    let controller: AbortController | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let busyTimer: ReturnType<typeof setTimeout> | undefined;

    function filterStatic(items: T[], query: string, keepId?: string) {
      const scored = fuzzyFilter(items, query, (i) => i.label, (i) => i.description);
      setRows(
        scored.map((s) => ({
          item: s.item,
          labelIndexes: query ? s.labelIndexes : (s.item.labelHighlights ?? []),
          descriptionIndexes: query ? s.descriptionIndexes : (s.item.descriptionHighlights ?? []),
        })),
        keepId,
      );
    }

    function runAsync(fn: Extract<QuickPickOptions<T>['items'], Function>, query: string, keepId?: string) {
      controller?.abort();
      const ctl = new AbortController();
      controller = ctl;
      clearTimeout(busyTimer);
      busyTimer = setTimeout(() => busy.classList.add('shell-on'), BUSY_DELAY_MS);
      const finish = () => {
        clearTimeout(busyTimer);
        busy.classList.remove('shell-on');
      };
      Promise.resolve()
        .then(() => fn(query, ctl.signal))
        .then(
          (items) => {
            if (ctl.signal.aborted || closed) return;
            finish();
            setRows(
              items.map((item) => ({
                item,
                labelIndexes: item.labelHighlights ?? [],
                descriptionIndexes: item.descriptionHighlights ?? [],
              })),
              keepId,
            );
          },
          (err) => {
            if (ctl.signal.aborted || closed) return;
            finish();
            console.error('quick pick items failed', err);
            setRows([]);
          },
        );
    }

    function update(immediate: boolean, keepId?: string) {
      const query = input.value;
      const src = opts.items;
      if (typeof src !== 'function') {
        filterStatic(src, query, keepId);
        return;
      }
      clearTimeout(debounceTimer);
      if (immediate) runAsync(src, query, keepId);
      else debounceTimer = setTimeout(() => runAsync(src, query, keepId), ASYNC_DEBOUNCE_MS);
    }

    // ---- closing ---------------------------------------------------------

    function close(cancelled: boolean) {
      if (closed) return;
      closed = true;
      if (closeActive === close) closeActive = null;
      controller?.abort();
      clearTimeout(debounceTimer);
      clearTimeout(busyTimer);
      overlay.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      if (cancelled) opts.onCancel?.();
    }

    function accept() {
      const item = rows[active]?.item;
      if (!item) return;
      const query = input.value;
      close(false);
      opts.onAccept(item, query);
    }

    // ---- events ----------------------------------------------------------

    input.addEventListener('input', () => update(false));
    input.addEventListener('keydown', (e) => {
      // While an IME is composing text (Japanese, Korean, Vietnamese), the keys belong to the IME.
      if (e.isComposing || e.keyCode === 229) return;
      const n = rows.length;
      let handled = true;
      if (e.key === 'ArrowDown' || (e.ctrlKey && !e.metaKey && e.key === 'n')) {
        if (n) setActive((active + 1) % n);
      } else if (e.key === 'ArrowUp' || (e.ctrlKey && !e.metaKey && e.key === 'p')) {
        if (n) setActive((active - 1 + n) % n);
      } else if (e.key === 'PageDown') {
        if (n) setActive(Math.min(n - 1, active + MAX_VISIBLE_ROWS - 1));
      } else if (e.key === 'PageUp') {
        if (n) setActive(Math.max(0, active - MAX_VISIBLE_ROWS + 1));
      } else if (e.key === 'Enter') {
        accept();
      } else if (e.key === 'Escape') {
        close(true);
      } else if (e.key === 'Tab') {
        // Keep the focus in the box.
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    list.addEventListener('scroll', () => requestAnimationFrame(paint), { passive: true });
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('pointermove', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.shell-qp-row');
      if (!el) return;
      const i = Number(el.dataset.i);
      if (i !== active) setActive(i, false);
    });
    list.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.shell-qp-row');
      if (!el) return;
      setActive(Number(el.dataset.i), false);
      accept();
    });
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close(true);
    });

    closeActive = close;
    layer.append(overlay);
    list.hidden = true;
    empty.hidden = true;
    update(true);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    return {
      close: () => close(false),
      refresh: () => update(true, rows[active]?.item.id),
    };
  }

  return { open: quickPick, close: () => closeActive?.(true) };
}

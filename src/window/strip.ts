// The strip of workspace tabs. On macOS it sits in the title bar, on other
// systems it is the first row of the window. It only draws and reports user
// actions. It does not know about workbenches.

import { createElement, Folder, Plus, X } from 'lucide';
import { h } from '../core/dom';
import { isMac } from '../core/util';
import { showPopupMenu, type PopupItem } from './menu';
import './window.css';

export interface StripTab {
  id: string;
  name: string;
  /** Parent folder, only when another tab has the same name. */
  description: string;
  /** Full path, shown as tooltip. */
  tooltip: string;
  dirty: boolean;
  active: boolean;
}

export interface StripHandlers {
  activate(id: string): void;
  close(id: string): void;
  /** Called while the user drags: the tab now has this index. */
  move(id: string, index: number): void;
  contextItems(id: string): PopupItem[];
  plusItems(): Promise<PopupItem[]>;
}

export interface Strip {
  el: HTMLElement;
  render(tabs: StripTab[]): void;
  setFullscreen(on: boolean): void;
}

const DRAG_THRESHOLD = 4;

export function createStrip(handlers: StripHandlers): Strip {
  const tabsEl = h('div', { class: 'win-tabs' });
  const filler = h('div', { class: 'win-filler', 'data-tauri-drag-region': true });
  const plus = h(
    'button',
    { class: 'win-plus', title: 'New workspace tab', 'aria-label': 'New workspace tab', type: 'button' },
    createElement(Plus),
  );
  const el = h(
    'div',
    { class: `win-strip${isMac ? ' mac' : ''}`, 'data-tauri-drag-region': true },
    h('div', { class: 'win-inset', 'data-tauri-drag-region': true }),
    tabsEl,
    plus,
    filler,
  );

  plus.addEventListener('click', async () => {
    const r = plus.getBoundingClientRect();
    const items = await handlers.plusItems();
    showPopupMenu(r.left, r.bottom + 4, items, 220);
  });

  let dragging = false;
  let pending: StripTab[] | null = null;
  let last: StripTab[] = [];

  function render(tabs: StripTab[]) {
    last = tabs;
    // Do not rebuild the tabs under the pointer while the user drags one.
    if (dragging) {
      pending = tabs;
      return;
    }
    tabsEl.replaceChildren(...tabs.map(buildTab));
    tabsEl.querySelector('.win-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function buildTab(tab: StripTab): HTMLElement {
    const close = h(
      'span',
      { class: 'win-tab-close', title: 'Close', role: 'button', 'aria-label': 'Close workspace tab' },
      h('span', { class: 'win-tab-dot' }),
      createElement(X),
    );
    const node = h(
      'div',
      {
        class: `win-tab${tab.active ? ' active' : ''}${tab.dirty ? ' dirty' : ''}`,
        title: tab.tooltip,
        'data-id': tab.id,
        role: 'tab',
        'aria-selected': tab.active,
      },
      h('span', { class: 'win-tab-icon' }, createElement(Folder)),
      h('span', { class: 'win-tab-name' }, tab.name),
      tab.description ? h('span', { class: 'win-tab-desc' }, tab.description) : null,
      close,
    );

    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.close(tab.id);
    });
    node.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        handlers.close(tab.id);
      }
    });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showPopupMenu(e.clientX, e.clientY, handlers.contextItems(tab.id));
    });
    node.addEventListener('pointerdown', (e) => {
      if (e.button === 1) e.preventDefault(); // no auto scroll on middle click
      if (e.button !== 0) return;
      startPointer(e, node, tab.id);
    });
    return node;
  }

  // Click selects. A move of a few pixels starts a drag that reorders tabs.
  function startPointer(down: PointerEvent, node: HTMLElement, id: string) {
    const startX = down.clientX;
    const nodes = [...tabsEl.querySelectorAll<HTMLElement>('.win-tab')];
    const from = nodes.indexOf(node);
    const rects = nodes.map((n) => n.getBoundingClientRect());
    const width = rects[from].width;
    let started = false;
    let target = from;

    const apply = (dx: number) => {
      // Keep the dragged tab inside the tab area.
      const minDx = rects[0].left - rects[from].left;
      const maxDx = rects[rects.length - 1].right - rects[from].right;
      const x = Math.max(minDx, Math.min(maxDx, dx));
      node.style.transform = `translateX(${x}px)`;
      const center = rects[from].left + width / 2 + x;
      target = 0;
      rects.forEach((r, i) => {
        if (i !== from && r.left + r.width / 2 < center) target++;
      });
      nodes.forEach((n, i) => {
        if (i === from) return;
        let shift = 0;
        if (from < target && i > from && i <= target) shift = -width;
        if (from > target && i < from && i >= target) shift = width;
        n.style.transform = shift ? `translateX(${shift}px)` : '';
      });
    };

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      if (!started) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        started = true;
        dragging = true;
        node.classList.add('dragging');
        tabsEl.classList.add('reordering');
      }
      apply(dx);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!started) {
        handlers.activate(id);
        return;
      }
      dragging = false;
      tabsEl.classList.remove('reordering');
      if (target !== from) handlers.move(id, target);
      // Render again from the model: this also clears the transforms.
      const next = pending ?? last;
      pending = null;
      render(next);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  return {
    el,
    render,
    setFullscreen(on) {
      el.classList.toggle('fullscreen', on);
    },
  };
}

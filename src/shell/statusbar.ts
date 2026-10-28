// Status bar. Items are updated in place, so frequent changes (cursor
// position) do not rebuild the DOM.

import { h } from '../core/dom';
import type { StatusBar, StatusItem } from '../core/types';

interface Entry {
  item: StatusItem;
  el: HTMLElement;
}

export function createStatusBar(run: (command: string, args: unknown[]) => void) {
  const left = h('div', { class: 'shell-status-group shell-status-left' });
  const right = h('div', { class: 'shell-status-group shell-status-right' });
  const el = h('div', { class: 'shell-statusbar', role: 'status' }, left, right);
  const entries = new Map<string, Entry>();

  function reorder(align: 'left' | 'right') {
    const list = [...entries.values()].filter((e) => e.item.align === align);
    // Higher priority sits closer to the outer edge of the window.
    list.sort((a, b) => (align === 'left' ? b.item.priority - a.item.priority : a.item.priority - b.item.priority));
    (align === 'left' ? left : right).replaceChildren(...list.map((e) => e.el));
  }

  function paint(entry: Entry) {
    const { item, el } = entry;
    if (el.textContent !== item.text) el.textContent = item.text;
    el.hidden = item.text === '';
    if (item.tooltip) el.title = item.tooltip;
    else el.removeAttribute('title');
    el.classList.toggle('shell-clickable', !!item.command);
    el.setAttribute('role', item.command ? 'button' : 'note');
  }

  const api: StatusBar = {
    set(item) {
      const old = entries.get(item.id);
      if (old) {
        const orderChanged = old.item.align !== item.align || old.item.priority !== item.priority;
        const oldAlign = old.item.align;
        old.item = { ...item };
        paint(old);
        if (orderChanged) {
          reorder(item.align);
          if (oldAlign !== item.align) reorder(oldAlign);
        }
        return;
      }
      const node = h('div', { class: 'shell-status-item' });
      const entry: Entry = { item: { ...item }, el: node };
      node.addEventListener('click', () => {
        const cmd = entry.item.command;
        if (cmd) run(cmd, entry.item.args ?? []);
      });
      entries.set(item.id, entry);
      paint(entry);
      reorder(item.align);
    },
    remove(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entries.delete(id);
      entry.el.remove();
    },
  };

  return { api, el };
}

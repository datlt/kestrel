// Context menu. One menu at a time.

import { h } from '../core/dom';
import type { MenuItem } from '../core/types';
import { overlayClosed, overlayOpened } from './overlay-count';

/** `layer` is the overlay layer inside the root element of this shell. */
export function createMenu(keyLabel: (binding: string) => string, layer: HTMLElement) {
  let close: (() => void) | null = null;

  function open(x: number, y: number, items: MenuItem[]): void {
    close?.();
    if (!items.length) return;

    const previousFocus = document.activeElement as HTMLElement | null;
    const rows: { el: HTMLElement; item: MenuItem }[] = [];
    const menu = h('div', { class: 'shell-menu', role: 'menu', tabindex: '-1' });
    for (const item of items) {
      if (item.separatorBefore && rows.length) menu.append(h('div', { class: 'shell-menu-sep', role: 'separator' }));
      const el = h(
        'div',
        { class: 'shell-menu-item' + (item.disabled ? ' shell-disabled' : ''), role: 'menuitem' },
        h('span', { class: 'shell-menu-label' }, item.label),
        item.keybinding ? h('span', { class: 'shell-menu-key' }, keyLabel(item.keybinding)) : null,
      );
      if (item.disabled) el.setAttribute('aria-disabled', 'true');
      rows.push({ el, item });
      menu.append(el);
    }

    let active = -1;
    const setActive = (i: number) => {
      rows[active]?.el.classList.remove('shell-active');
      active = i;
      rows[active]?.el.classList.add('shell-active');
    };
    const enabled = () => rows.map((r, i) => (r.item.disabled ? -1 : i)).filter((i) => i >= 0);
    const move = (dir: 1 | -1) => {
      const list = enabled();
      if (!list.length) return;
      const pos = list.indexOf(active);
      const next = pos < 0 ? (dir === 1 ? 0 : list.length - 1) : (pos + dir + list.length) % list.length;
      setActive(list[next]);
    };

    const dispose = () => {
      if (close !== dispose) return;
      close = null;
      window.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('blur', dispose);
      window.removeEventListener('resize', dispose);
      window.removeEventListener('wheel', onOutside, true);
      menu.remove();
      overlayClosed(layer);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
    const onOutside = (e: Event) => {
      if (e.target instanceof Node && menu.contains(e.target)) return;
      dispose();
    };
    const run = (i: number) => {
      const row = rows[i];
      if (!row || row.item.disabled) return;
      dispose();
      row.item.run();
    };

    menu.addEventListener('pointermove', (e) => {
      const i = rows.findIndex((r) => r.el.contains(e.target as Node));
      if (i >= 0 && i !== active) setActive(i);
    });
    menu.addEventListener('pointerleave', () => setActive(-1));
    menu.addEventListener('click', (e) => {
      const i = rows.findIndex((r) => r.el.contains(e.target as Node));
      if (i >= 0) run(i);
    });
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    menu.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown':
          move(1);
          break;
        case 'ArrowUp':
          move(-1);
          break;
        case 'Home':
          setActive(enabled()[0] ?? -1);
          break;
        case 'End':
          setActive(enabled().at(-1) ?? -1);
          break;
        case 'Enter':
        case ' ':
          run(active);
          break;
        case 'Escape':
        case 'Tab':
          dispose();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    });

    close = dispose;
    menu.style.visibility = 'hidden';
    layer.append(menu);
    overlayOpened(layer);
    // x and y are window coordinates. The menu is positioned inside the layer,
    // so convert them and keep the menu inside the layer.
    const box = layer.getBoundingClientRect();
    const r = menu.getBoundingClientRect();
    const px = x - box.left;
    const py = y - box.top;
    const left = Math.max(4, Math.min(px, box.width - r.width - 4));
    const top = Math.max(4, py + r.height + 4 > box.height ? box.height - r.height - 4 : py);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = '';
    menu.focus({ preventScroll: true });

    window.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('wheel', onOutside, { capture: true, passive: true });
    window.addEventListener('blur', dispose);
    window.addEventListener('resize', dispose);
  }

  return {
    /** Opens at the mouse position of the event. */
    contextMenu(e: MouseEvent, items: MenuItem[]): void {
      e.preventDefault();
      open(e.clientX, e.clientY, items);
    },
    /** Opens at a screen position (for buttons). */
    openAt: open,
    /** Closes the open menu, if any. */
    close(): void {
      close?.();
    },
  };
}

// A small popup menu for the workspace tab strip. The strip belongs to the
// window, not to a workbench, so this menu lives in document.body.

import { h } from '../core/dom';

export interface PopupItem {
  label: string;
  run(): void;
  disabled?: boolean;
  separatorBefore?: boolean;
  /** Grey text on the right, for example the parent folder. */
  hint?: string;
}

let closeCurrent: (() => void) | null = null;

export function closePopupMenu(): void {
  closeCurrent?.();
}

/** Shows the menu at a screen position. `minWidth` is in px. */
export function showPopupMenu(x: number, y: number, items: PopupItem[], minWidth = 0): void {
  closePopupMenu();
  const menu = h('div', { class: 'win-menu', tabindex: -1, role: 'menu' });
  if (minWidth) menu.style.minWidth = `${minWidth}px`;
  const rows: HTMLElement[] = [];
  let selected = -1;

  const select = (i: number) => {
    rows[selected]?.classList.remove('selected');
    selected = i;
    rows[i]?.classList.add('selected');
  };
  const dispose = () => {
    menu.remove();
    window.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('blur', dispose);
    window.removeEventListener('resize', dispose);
    if (closeCurrent === dispose) closeCurrent = null;
  };
  const onOutside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) dispose();
  };
  const accept = (item: PopupItem) => {
    if (item.disabled) return;
    dispose();
    item.run();
  };

  items.forEach((item) => {
    if (item.separatorBefore) menu.append(h('div', { class: 'win-menu-sep' }));
    const row = h(
      'div',
      { class: `win-menu-item${item.disabled ? ' disabled' : ''}`, role: 'menuitem' },
      h('span', { class: 'win-menu-label' }, item.label),
      item.hint ? h('span', { class: 'win-menu-hint' }, item.hint) : null,
    );
    const index = rows.length;
    row.addEventListener('pointermove', () => select(index));
    row.addEventListener('click', () => accept(item));
    rows.push(row);
    menu.append(row);
  });

  menu.addEventListener('keydown', (e) => {
    const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    const pos = enabled.indexOf(selected);
    if (e.key === 'Escape') dispose();
    else if (e.key === 'ArrowDown') select(enabled[(pos + 1) % enabled.length]);
    else if (e.key === 'ArrowUp') select(enabled[(pos - 1 + enabled.length) % enabled.length]);
    else if (e.key === 'Enter' && selected >= 0) accept(items[selected]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  closeCurrent = dispose;
  menu.style.visibility = 'hidden';
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  menu.style.visibility = '';
  menu.focus({ preventScroll: true });
  window.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('blur', dispose);
  window.addEventListener('resize', dispose);
}

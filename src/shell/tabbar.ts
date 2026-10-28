// Tab bar: draws the tabs of the TabModel, drag to reorder, context menu.

import { Plus, Settings, X } from 'lucide';
import { h } from '../core/dom';
import { basename } from '../core/util';
import { fileIcon } from '../ui/file-icons';
import type { MenuItem } from '../core/types';
import { icon } from './icons';
import type { TabModel, TabRec } from './tabs';
import { parentFolderOf, pathOfTab } from './tabs';

interface TabEl {
  root: HTMLElement;
  title: HTMLElement;
  desc: HTMLElement;
}

/** File type icon for a tab id. The path is in the id for file, diff, image and history tabs. */
function tabIcon(id: string): Element {
  if (id.startsWith('settings:')) return icon(Settings);
  const path = pathOfTab(id);
  try {
    return fileIcon(path ? basename(path) : id);
  } catch (err) {
    console.error('tab icon failed', err);
    return document.createElement('span');
  }
}

export function createTabBar(
  model: TabModel,
  deps: {
    openMenu(x: number, y: number, items: MenuItem[]): void;
    notify(message: string, opts?: { kind?: 'info' | 'warn' | 'error' }): void;
    /** Runs a command by id. */
    run(commandId: string): void;
    /** Key label of a command (for example "⌘N"), or undefined. */
    keyLabelOf(commandId: string): string | undefined;
  },
) {
  const tabsEl = h('div', { class: 'shell-tabs', role: 'tablist' });
  const dropMark = h('div', { class: 'shell-tab-dropmark' });
  dropMark.hidden = true;
  const newBtn = h(
    'button',
    { class: 'shell-tabbar-new', tabindex: '-1', 'aria-label': 'New Draft', title: 'New Draft' },
    icon(Plus),
  );
  // Keep the focus where it is, and show the current key label in the tooltip.
  newBtn.addEventListener('mousedown', (e) => e.preventDefault());
  newBtn.addEventListener('mouseenter', () => {
    const key = deps.keyLabelOf('file.newDraft');
    newBtn.title = key ? `New Draft (${key})` : 'New Draft';
  });
  newBtn.addEventListener('click', () => deps.run('file.newDraft'));
  // The "+" button sits right after the last tab. When the tabs scroll, the
  // tab list shrinks and the button stays visible.
  const el = h('div', { class: 'shell-tabbar' }, tabsEl, newBtn, dropMark);
  const els = new Map<string, TabEl>();

  function build(rec: TabRec): TabEl {
    const title = h('span', { class: 'shell-tab-title' });
    const desc = h('span', { class: 'shell-tab-desc' });
    const close = h(
      'button',
      { class: 'shell-tab-close', tabindex: '-1', 'aria-label': 'Close', title: 'Close' },
      icon(X),
      h('span', { class: 'shell-tab-dot' }),
    );
    const root = h('div', { class: 'shell-tab', role: 'tab' }, h('span', { class: 'shell-tab-icon' }, tabIcon(rec.id)), title, desc, close);
    root.dataset.id = rec.id;
    return { root, title, desc };
  }

  function update(rec: TabRec, e: TabEl, titleCount: Map<string, number>, activeRec: unknown) {
    e.title.textContent = rec.title;
    const showDesc = (titleCount.get(rec.title) ?? 0) > 1;
    const desc = showDesc ? (rec.description ?? parentFolderOf(rec.id) ?? '') : '';
    e.desc.textContent = desc;
    e.desc.hidden = !desc;
    e.root.title = rec.input.tooltip ?? pathOfTab(rec.id) ?? rec.title;
    const isActive = rec === activeRec;
    e.root.classList.toggle('shell-active', isActive);
    e.root.classList.toggle('shell-dirty', rec.dirty);
    e.root.classList.toggle('shell-preview', rec.preview);
    e.root.setAttribute('aria-selected', String(isActive));
  }

  function revealActive() {
    const rec = model.active() as unknown as TabRec | null;
    const e = rec && els.get(rec.id);
    if (!e) return;
    const l = e.root.offsetLeft;
    const r = l + e.root.offsetWidth;
    if (l < tabsEl.scrollLeft) tabsEl.scrollLeft = l;
    else if (r > tabsEl.scrollLeft + tabsEl.clientWidth) tabsEl.scrollLeft = r - tabsEl.clientWidth;
  }

  function sync(order: boolean) {
    const recs = model.records();
    const activeRec = model.active();
    const titleCount = new Map<string, number>();
    for (const r of recs) titleCount.set(r.title, (titleCount.get(r.title) ?? 0) + 1);

    if (order) {
      const live = new Set(recs.map((r) => r.id));
      for (const id of els.keys()) if (!live.has(id)) els.delete(id);
    }
    const nodes: HTMLElement[] = [];
    for (const rec of recs) {
      let e = els.get(rec.id);
      if (!e) {
        e = build(rec);
        els.set(rec.id, e);
      }
      update(rec, e, titleCount, activeRec);
      nodes.push(e.root);
    }
    if (order) {
      const current = tabsEl.children;
      const same = current.length === nodes.length && nodes.every((n, i) => current[i] === n);
      if (!same) tabsEl.replaceChildren(...nodes);
    }
    el.hidden = recs.length === 0;
  }

  model.onDidChange((change) => {
    sync(change === 'list');
    if (change !== 'state') revealActive();
  });

  // ---- events ---------------------------------------------------------------

  const tabOf = (target: EventTarget | null): HTMLElement | null =>
    (target as HTMLElement | null)?.closest?.('.shell-tab') ?? null;

  // Keep the focus where it is (usually the editor) when the user clicks a tab.
  tabsEl.addEventListener('mousedown', (e) => e.preventDefault());

  tabsEl.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        tabsEl.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false },
  );

  tabsEl.addEventListener('click', (e) => {
    const tab = tabOf(e.target);
    if (!tab) return;
    if ((e.target as HTMLElement).closest('.shell-tab-close')) {
      void model.close(tab.dataset.id!);
    }
  });

  tabsEl.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tab = tabOf(e.target);
    if (tab) {
      e.preventDefault();
      void model.close(tab.dataset.id!);
    }
  });

  tabsEl.addEventListener('dblclick', (e) => {
    const tab = tabOf(e.target);
    if (tab && !(e.target as HTMLElement).closest('.shell-tab-close')) model.pin(tab.dataset.id!);
  });

  tabsEl.addEventListener('contextmenu', (e) => {
    const tab = tabOf(e.target);
    if (!tab) return;
    e.preventDefault();
    const id = tab.dataset.id!;
    const recs = model.records();
    const index = recs.findIndex((r) => r.id === id);
    const rec = recs[index];
    if (!rec) return;
    const path = pathOfTab(id);
    const items: MenuItem[] = [
      { label: 'Close', keybinding: 'Mod-w', run: () => void model.close(id) },
      { label: 'Close Others', disabled: recs.length < 2, run: () => void model.closeOthers(id) },
      { label: 'Close to the Right', disabled: index === recs.length - 1, run: () => void model.closeToRight(id) },
      { label: 'Close All', run: () => void model.closeAllUser() },
      {
        label: 'Copy Path',
        separatorBefore: true,
        disabled: !path,
        run: () => {
          navigator.clipboard.writeText(path!).catch(() => deps.notify('Could not copy to the clipboard.', { kind: 'error' }));
        },
      },
    ];
    if (rec.preview) items.push({ label: 'Keep Open', run: () => model.pin(id) });
    deps.openMenu(e.clientX, e.clientY, items);
  });

  // Drag to reorder. HTML5 drag and drop is not used: it does not work on
  // Windows when Tauri handles file drops. Pointer events work everywhere.
  let drag: { id: string; startX: number; pointerId: number; moved: boolean; dropIndex: number } | null = null;

  tabsEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const tab = tabOf(e.target);
    if (!tab || (e.target as HTMLElement).closest('.shell-tab-close')) return;
    const id = tab.dataset.id!;
    model.activate(id);
    model.focusActive();
    drag = { id, startX: e.clientX, pointerId: e.pointerId, moved: false, dropIndex: -1 };
  });

  function endDrag(apply: boolean) {
    if (!drag) return;
    const d = drag;
    drag = null;
    dropMark.hidden = true;
    els.get(d.id)?.root.classList.remove('shell-dragging');
    if (d.moved) {
      try {
        tabsEl.releasePointerCapture(d.pointerId);
      } catch {
        // The pointer is already released.
      }
      if (apply && d.dropIndex >= 0) model.move(d.id, d.dropIndex);
    }
  }

  tabsEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.startX) < 5) return;
      drag.moved = true;
      tabsEl.setPointerCapture(e.pointerId);
      els.get(drag.id)?.root.classList.add('shell-dragging');
    }
    const barRect = el.getBoundingClientRect();
    if (e.clientX < barRect.left + 28) tabsEl.scrollLeft -= 14;
    else if (e.clientX > barRect.right - 28) tabsEl.scrollLeft += 14;

    const others = model.records().filter((r) => r.id !== drag!.id);
    let index = 0;
    for (const r of others) {
      const rect = els.get(r.id)!.root.getBoundingClientRect();
      if (e.clientX > rect.left + rect.width / 2) index++;
    }
    drag.dropIndex = index;
    const ref = index === 0 ? others[0] : others[index - 1];
    if (ref) {
      const rect = els.get(ref.id)!.root.getBoundingClientRect();
      const x = (index === 0 ? rect.left : rect.right) - barRect.left;
      dropMark.style.left = `${Math.round(x) - 1}px`;
      dropMark.hidden = false;
    }
  });
  tabsEl.addEventListener('pointerup', () => endDrag(true));
  tabsEl.addEventListener('pointercancel', () => endDrag(false));
  const onBlur = () => endDrag(false);
  window.addEventListener('blur', onBlur);

  sync(true);
  return {
    el,
    dispose() {
      window.removeEventListener('blur', onBlur);
    },
  };
}

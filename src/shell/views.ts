// ViewRegistry: icons on the activity bar, the sidebar and the bottom panel.

import { X } from 'lucide';
import { h } from '../core/dom';
import type { ViewDescriptor, ViewInstance, ViewRegistry } from '../core/types';
import { icon } from './icons';
import type { LayoutStore } from './layout-state';

interface Rec {
  desc: ViewDescriptor;
  host: HTMLElement | null;
  instance: ViewInstance | null;
  badge: string | null;
  button: HTMLElement | null;
  badgeEl: HTMLElement | null;
  tab: HTMLElement | null;
}

export function createViews(store: LayoutStore) {
  const recs = new Map<string, Rec>();
  let mounted = false;
  let shown = new Set<string>();

  // ---- DOM (built early, filled when views register) --------------------
  const activityTop = h('div', { class: 'shell-activity-top' });
  const activityBottom = h('div', { class: 'shell-activity-bottom' });
  const activityBar = h('div', { class: 'shell-activitybar', role: 'toolbar', 'aria-orientation': 'vertical' }, activityTop, activityBottom);

  const sidebarTitle = h('div', { class: 'shell-sidebar-title' });
  const sidebarBody = h('div', { class: 'shell-sidebar-body' });
  const sidebar = h('div', { class: 'shell-sidebar' }, h('div', { class: 'shell-sidebar-header' }, sidebarTitle), sidebarBody);

  const panelTabs = h('div', { class: 'shell-panel-tabs', role: 'tablist' });
  const panelBody = h('div', { class: 'shell-panel-body' });
  const panelClose = h(
    'button',
    { class: 'shell-icon-btn', title: 'Close Panel', 'aria-label': 'Close Panel', onclick: () => store.patch({ panelVisible: false }) },
    icon(X),
  );
  const panel = h(
    'div',
    { class: 'shell-panel' },
    h('div', { class: 'shell-panel-header' }, panelTabs, h('div', { class: 'shell-panel-actions' }, panelClose)),
    panelBody,
  );

  // ---- helpers ------------------------------------------------------------
  function listFor(location: 'sidebar' | 'panel'): Rec[] {
    return [...recs.values()].filter((r) => r.desc.location === location).sort((a, b) => a.desc.order - b.desc.order);
  }

  function activeId(location: 'sidebar' | 'panel'): string | null {
    const wanted = location === 'sidebar' ? store.state.sidebarView : store.state.panelView;
    const list = listFor(location);
    if (wanted && list.some((r) => r.desc.id === wanted)) return wanted;
    return list[0]?.desc.id ?? null;
  }

  function ensureInstance(rec: Rec) {
    if (rec.instance || !mounted) return;
    rec.host = h('div', { class: 'shell-view-host', 'data-view': rec.desc.id });
    (rec.desc.location === 'sidebar' ? sidebarBody : panelBody).append(rec.host);
    try {
      rec.instance = rec.desc.create(rec.host);
    } catch (err) {
      console.error(`view ${rec.desc.id} failed to start`, err);
      rec.host.append(h('div', { class: 'shell-view-error' }, `The view "${rec.desc.title}" failed to start.`));
      rec.instance = {};
    }
  }

  function updateBadge(rec: Rec) {
    if (!rec.badgeEl) return;
    rec.badgeEl.textContent = rec.badge ?? '';
    rec.badgeEl.hidden = !rec.badge;
  }

  function rebuildActivity() {
    activityTop.replaceChildren();
    for (const rec of listFor('sidebar')) {
      const badgeEl = h('span', { class: 'shell-badge' });
      const glyph = rec.desc.icon();
      glyph.removeAttribute('width');
      glyph.removeAttribute('height');
      glyph.classList.add('shell-icon');
      const button = h(
        'button',
        { class: 'shell-activity-btn', title: rec.desc.title, 'aria-label': rec.desc.title, onclick: () => onActivityClick(rec.desc.id) },
        glyph,
        badgeEl,
      );
      rec.button = button;
      rec.badgeEl = badgeEl;
      updateBadge(rec);
      activityTop.append(button);
    }
  }

  function rebuildPanelTabs() {
    panelTabs.replaceChildren();
    for (const rec of listFor('panel')) {
      const badgeEl = h('span', { class: 'shell-badge shell-badge-inline' });
      const tab = h(
        'button',
        { class: 'shell-panel-tab', role: 'tab', onclick: () => api.show(rec.desc.id, { focus: true }) },
        rec.desc.title,
        badgeEl,
      );
      rec.tab = tab;
      rec.badgeEl = badgeEl;
      updateBadge(rec);
      panelTabs.append(tab);
    }
  }

  function onActivityClick(id: string) {
    if (shown.has(id)) store.patch({ sidebarVisible: false });
    else api.show(id);
  }

  /** Brings the DOM in line with the state. Calls onShow and onHide. */
  function render() {
    const sid = activeId('sidebar');
    const pid = activeId('panel');
    const next = new Set<string>();
    if (store.state.sidebarVisible && sid) next.add(sid);
    if (store.state.panelVisible && pid) next.add(pid);

    for (const id of shown) {
      if (next.has(id)) continue;
      const rec = recs.get(id);
      if (rec?.host) rec.host.hidden = true;
      rec?.instance?.onHide?.();
    }
    if (mounted) {
      for (const rec of recs.values()) {
        const id = rec.desc.id;
        const isActive = id === sid || id === pid;
        rec.button?.classList.toggle('shell-active', id === sid && store.state.sidebarVisible);
        rec.button?.setAttribute('aria-pressed', String(id === sid && store.state.sidebarVisible));
        rec.tab?.classList.toggle('shell-active', id === pid);
        rec.tab?.setAttribute('aria-selected', String(id === pid));
        if (rec.host && !isActive) rec.host.hidden = true;
      }
      for (const id of next) {
        const rec = recs.get(id)!;
        const wasShown = shown.has(id);
        ensureInstance(rec);
        if (rec.host) rec.host.hidden = false;
        if (!wasShown) rec.instance?.onShow?.();
      }
      sidebarTitle.textContent = sid ? (recs.get(sid)?.desc.title ?? '') : '';
    }
    shown = mounted ? next : new Set();
  }

  store.onChange(render);

  const api: ViewRegistry = {
    register(desc) {
      if (recs.has(desc.id)) console.warn(`view ${desc.id} registered twice; the new one wins`);
      const rec: Rec = { desc, host: null, instance: null, badge: null, button: null, badgeEl: null, tab: null };
      recs.set(desc.id, rec);
      if (mounted) {
        rebuildActivity();
        rebuildPanelTabs();
      }
      render();
      return {
        dispose() {
          if (recs.get(desc.id) !== rec) return;
          if (shown.has(desc.id)) rec.instance?.onHide?.();
          shown.delete(desc.id);
          rec.instance?.dispose?.();
          rec.host?.remove();
          recs.delete(desc.id);
          if (mounted) {
            rebuildActivity();
            rebuildPanelTabs();
          }
          render();
        },
      };
    },
    show(id, opts) {
      const rec = recs.get(id);
      if (!rec) return;
      if (rec.desc.location === 'sidebar') store.patch({ sidebarView: id, sidebarVisible: true });
      else store.patch({ panelView: id, panelVisible: true });
      if (opts?.focus) rec.instance?.focus?.();
    },
    isVisible: (id) => shown.has(id),
    setBadge(id, text) {
      const rec = recs.get(id);
      if (!rec) return;
      rec.badge = text || null;
      updateBadge(rec);
    },
    toggleSidebar(force) {
      store.patch({ sidebarVisible: force ?? !store.state.sidebarVisible });
    },
    togglePanel(force) {
      store.patch({ panelVisible: force ?? !store.state.panelVisible });
    },
  };

  /** Disposes every view instance that was created. Called when the workbench is disposed. */
  function disposeAll() {
    for (const rec of recs.values()) {
      try {
        rec.instance?.dispose?.();
      } catch (err) {
        console.error(`view ${rec.desc.id} failed to dispose`, err);
      }
      rec.instance = null;
      rec.host?.remove();
      rec.host = null;
    }
    shown = new Set();
  }

  return {
    api,
    dispose: disposeAll,
    activityBar,
    activityBottom,
    sidebar,
    panel,
    /** Called by mount(): from now on views are created when they are shown. */
    mount() {
      mounted = true;
      rebuildActivity();
      rebuildPanelTabs();
      shown = new Set();
      render();
    },
  };
}

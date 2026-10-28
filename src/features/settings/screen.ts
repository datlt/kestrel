// The Settings screen. One instance per tab. All state lives in the closure.
import { h } from '../../core/dom';
import { DEFAULT_SETTINGS } from '../../core/settings';
import type { AppContext, Disposable, Settings, TabContent } from '../../core/types';
import {
  jsonControl,
  listControl,
  dbConnectionsControl, lspTableControl,
  numberControl,
  selectControl,
  switchControl,
  textControl,
  type Control,
} from './controls';
import {
  OTHER_SECTION,
  SECTIONS,
  SETTING_DEFS,
  filterSettings,
  sameValue,
  type SectionDef,
  type SectionId,
  type SettingDef,
} from './schema';
import './settings.css';

interface Row {
  def: SettingDef;
  el: HTMLElement;
  control: Control;
  modified: HTMLElement;
  reset: HTMLButtonElement;
  readOnly: boolean;
}

const OPEN_JSON = 'workspace.openSettingsJson';

export function createSettingsScreen(ctx: AppContext, host: HTMLElement): TabContent {
  const disposables: Disposable[] = [];
  const rows = new Map<string, Row>();
  const otherRows = new Map<string, Row>();
  const sectionEls = new Map<SectionId, { box: HTMLElement; rows: HTMLElement; nav: HTMLButtonElement }>();
  let query = '';
  let disposed = false;

  const root = h('div', { class: 'settings-root', tabindex: '-1' });
  const search = h('input', {
    class: 'settings-search',
    type: 'search',
    placeholder: 'Search settings',
    'aria-label': 'Search settings',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Sections' });
  const content = h('div', { class: 'settings-content' });
  const empty = h('div', { class: 'settings-empty', hidden: true });
  const openJson = () => void ctx.commands.execute(OPEN_JSON);

  // ---- save and reset ------------------------------------------------------

  async function save(def: Pick<SettingDef, 'key' | 'title'>, value: unknown) {
    try {
      await ctx.settings.update({ [def.key]: value } as Partial<Settings>);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      ctx.ui.notify(`Could not save "${def.title}": ${reason}`, { kind: 'error' });
      refresh(); // Show the value that is really saved.
    }
  }

  // ---- rows ----------------------------------------------------------------

  function buildControl(def: SettingDef): Control {
    const commit = (v: unknown) => void save(def, v);
    switch (def.type) {
      case 'boolean':
        return switchControl(def.title, commit);
      case 'enum':
        return selectControl(def, commit);
      case 'number':
        return numberControl(def, commit);
      case 'text':
        return textControl(def, commit);
      case 'stringList':
        return listControl(def, commit);
      case 'lspServers':
        return lspTableControl(openJson);
      case 'dbConnections':
        return dbConnectionsControl(() => void ctx.commands.execute('db.showView'));
    }
  }

  function buildRow(def: SettingDef, control: Control, readOnly: boolean): Row {
    const modified = h('span', { class: 'settings-modified', title: 'This value differs from the default.' }, 'Modified');
    const reset = h('button', {
      class: 'settings-reset',
      type: 'button',
      title: 'Reset to default',
      'aria-label': `Reset ${def.title} to default`,
      onclick: () => void save(def, DEFAULT_SETTINGS[def.key]),
    }, '↺');
    const wide = def.type === 'stringList' || def.type === 'lspServers' || def.type === 'dbConnections' || readOnly;
    const info = h(
      'div',
      { class: 'settings-row-info' },
      h('div', { class: 'settings-row-head' }, h('span', { class: 'settings-title' }, def.title), modified),
      def.description ? h('div', { class: 'settings-desc' }, def.description) : null,
      def.note ? h('div', { class: 'settings-note' }, def.note) : null,
      h('code', { class: 'settings-key' }, def.key),
    );
    const side = h('div', { class: 'settings-row-control' }, control.el, readOnly ? null : reset);
    const el = h('div', { class: wide ? 'settings-row settings-row-wide' : 'settings-row', 'data-key': def.key }, info, side);
    return { def, el, control, modified, reset, readOnly };
  }

  function sync(row: Row, value: unknown) {
    row.control.set(value);
    if (row.readOnly) return;
    const isModified = !sameValue(value, DEFAULT_SETTINGS[row.def.key]);
    row.modified.hidden = !isModified;
    row.reset.style.visibility = isModified ? 'visible' : 'hidden';
    row.reset.tabIndex = isModified ? 0 : -1;
  }

  // ---- build the page ------------------------------------------------------

  function addSection(sec: SectionDef): void {
    const rowsEl = h('div', { class: 'settings-rows' });
    const box = h('section', { class: 'settings-section', 'data-section': sec.id }, h('h2', { class: 'settings-section-title' }, sec.title), rowsEl);
    const navBtn = h('button', {
      class: 'settings-nav-item',
      type: 'button',
      onclick: () => {
        // Show everything of this section, then scroll to it.
        box.scrollIntoView({ block: 'start' });
        setActiveNav(sec.id);
      },
    }, sec.title);
    nav.append(navBtn);
    content.append(box);
    sectionEls.set(sec.id, { box, rows: rowsEl, nav: navBtn });
  }

  for (const sec of SECTIONS) addSection(sec);
  addSection(OTHER_SECTION);

  for (const def of SETTING_DEFS) {
    const row = buildRow(def, buildControl(def), false);
    rows.set(def.key, row);
    sectionEls.get(def.section)!.rows.append(row.el);
  }

  // ---- refresh and filter --------------------------------------------------

  function otherKeys(all: Readonly<Settings>): string[] {
    return Object.keys(all).filter((k) => !rows.has(k));
  }

  function refresh() {
    if (disposed) return;
    const all = ctx.settings.all();
    for (const [key, row] of rows) sync(row, all[key as keyof Settings]);

    // Keys that this screen does not know are read-only JSON.
    const unknown = otherKeys(all);
    for (const [key, row] of otherRows) {
      if (!unknown.includes(key)) {
        row.el.remove();
        otherRows.delete(key);
      }
    }
    const otherBox = sectionEls.get('other')!;
    for (const key of unknown) {
      let row = otherRows.get(key);
      if (!row) {
        const def = { key: key as keyof Settings, title: key, description: '', section: 'other', type: 'text' } as SettingDef;
        row = buildRow(def, jsonControl(), true);
        otherRows.set(key, row);
        otherBox.rows.append(row.el);
      }
      row.control.set((all as Record<string, unknown>)[key]);
    }
    applyFilter();
  }

  function applyFilter() {
    const all = ctx.settings.all();
    const q = query.trim();
    const shown = new Set<HTMLElement>();
    const count = new Map<SectionId, number>();

    const known = SETTING_DEFS.filter((d) => !d.visibleWhen || d.visibleWhen(all));
    const others = [...otherRows.values()].map((r) => r.def);
    for (const d of filterSettings([...known, ...others], q)) {
      const row = rows.get(d.key) ?? otherRows.get(d.key);
      if (!row) continue;
      shown.add(row.el);
      count.set(d.section, (count.get(d.section) ?? 0) + 1);
    }
    for (const row of [...rows.values(), ...otherRows.values()]) row.el.hidden = !shown.has(row.el);

    let total = 0;
    for (const [id, s] of sectionEls) {
      const n = count.get(id) ?? 0;
      total += n;
      s.box.hidden = n === 0;
      s.nav.hidden = n === 0;
    }
    empty.hidden = total > 0;
    empty.textContent = `No settings match "${q}".`;
    updateActiveNav();
  }

  // ---- section list --------------------------------------------------------

  let activeNav: SectionId | null = null;
  function setActiveNav(id: SectionId) {
    activeNav = id;
    for (const [sid, s] of sectionEls) {
      s.nav.classList.toggle('settings-nav-active', sid === id);
      if (sid === id) s.nav.setAttribute('aria-current', 'true');
      else s.nav.removeAttribute('aria-current');
    }
  }
  function updateActiveNav() {
    const top = content.getBoundingClientRect().top + 24;
    let current: SectionId | null = null;
    for (const [id, s] of sectionEls) {
      if (s.box.hidden) continue;
      if (current === null) current = id;
      if (s.box.getBoundingClientRect().top <= top) current = id;
    }
    // At the bottom the last sections can be too short to reach the top.
    if (content.scrollTop + content.clientHeight >= content.scrollHeight - 2 && content.scrollTop > 0) {
      for (const [id, s] of sectionEls) if (!s.box.hidden) current = id;
    }
    if (current && current !== activeNav) setActiveNav(current);
  }
  content.addEventListener('scroll', updateActiveNav, { passive: true });

  // ---- layout --------------------------------------------------------------

  const footer = h(
    'div',
    { class: 'settings-footer' },
    h('button', { class: 'settings-link', type: 'button', onclick: openJson }, 'Open settings.json'),
  );
  const main = h('div', { class: 'settings-main' }, content, empty);
  root.append(
    h('header', { class: 'settings-header' }, search),
    h('div', { class: 'settings-body' }, nav, main),
    footer,
  );
  host.append(root);

  search.addEventListener('input', () => {
    query = search.value;
    applyFilter();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      search.value = '';
      query = '';
      applyFilter();
      e.stopPropagation();
    } else if (e.key === 'ArrowDown' && !e.isComposing) {
      const first = [...root.querySelectorAll<HTMLElement>('.settings-row:not([hidden]) :is(button,input,select)')].find(
        (el) => !el.classList.contains('settings-reset'),
      );
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  root.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });

  disposables.push(ctx.bus.on('settings:changed', refresh));
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const d of disposables.splice(0)) d.dispose();
    root.remove();
  };
  disposables.push(ctx.bus.on('workbench:disposing', dispose));

  refresh();
  setActiveNav('appearance');

  return {
    focus: () => search.focus(),
    dispose,
    onShow: () => updateActiveNav(),
  };
}

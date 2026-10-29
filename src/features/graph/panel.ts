// The settings panel of the graph (floating on the right). Sections fold like
// in Obsidian. A change calls `change` at once, the view saves it.

import { createElement, ChevronDown, ChevronRight, RotateCcw, X } from 'lucide';
import { h } from '../../core/dom';
import { debounce } from '../../core/util';
import { compileQuery } from './model';
import type { ColorBy, GraphOptions, GraphScope } from './types';

export interface PanelHandlers {
  change(patch: Partial<GraphOptions>): void;
  reset(): void;
  setFollow(follow: boolean): void;
  close(): void;
}

export interface SettingsPanel {
  el: HTMLElement;
  /** Shows new values in the controls. A control that has the focus keeps its text. */
  sync(o: GraphOptions, scope: GraphScope): void;
}

/** Colors for new groups. */
const GROUP_COLORS = ['#e5484d', '#f5a524', '#46a758', '#3e63dd', '#8e4ec6', '#12a594'];

interface Control {
  sync(o: GraphOptions, scope: GraphScope): void;
}

export function createSettingsPanel(handlers: PanelHandlers): SettingsPanel {
  const controls: Control[] = [];
  const el = h('div', { class: 'graph-panel', hidden: true });

  const closeBtn = h('button', { class: 'graph-btn graph-icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: () => handlers.close() });
  closeBtn.append(createElement(X));
  const resetBtn = h('button', { class: 'graph-btn graph-reset', type: 'button', title: 'Put the default options back', onclick: () => handlers.reset() });
  resetBtn.append(createElement(RotateCcw), 'Reset');
  el.append(h('div', { class: 'graph-panel-head' }, h('span', { class: 'graph-panel-title' }, 'Graph settings'), resetBtn, closeBtn));
  const scroll = h('div', { class: 'graph-panel-scroll' });
  el.append(scroll);

  function section(title: string, open: boolean, visible?: (scope: GraphScope) => boolean): HTMLElement {
    const body = h('div', { class: 'graph-section-body' });
    const chevron = h('span', { class: 'graph-chevron' });
    const head = h('button', { class: 'graph-section-head', type: 'button', 'aria-expanded': String(open) }, chevron, title);
    const box = h('div', { class: 'graph-section' }, head, body);
    const paint = (isOpen: boolean) => {
      head.setAttribute('aria-expanded', String(isOpen));
      chevron.replaceChildren(createElement(isOpen ? ChevronDown : ChevronRight));
      body.hidden = !isOpen;
    };
    paint(open);
    head.addEventListener('click', () => paint(head.getAttribute('aria-expanded') !== 'true'));
    if (visible) controls.push({ sync: (_o, scope) => (box.hidden = !visible(scope)) });
    scroll.append(box);
    return body;
  }

  function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return h('label', { class: 'graph-row', title: hint }, h('span', { class: 'graph-row-label' }, label), control);
  }

  function toggle<K extends keyof GraphOptions>(body: HTMLElement, label: string, key: K, hint?: string): void {
    const input = h('input', { type: 'checkbox', class: 'graph-switch' });
    input.addEventListener('change', () => handlers.change({ [key]: input.checked } as Partial<GraphOptions>));
    body.append(row(label, input, hint));
    controls.push({ sync: (o) => (input.checked = !!o[key]) });
  }

  function slider<K extends keyof GraphOptions>(body: HTMLElement, label: string, key: K, min: number, max: number, step: number, hint?: string): void {
    const input = h('input', { type: 'range', class: 'graph-slider', min, max, step });
    const value = h('span', { class: 'graph-value' });
    const show = () => (value.textContent = String(Math.round(Number(input.value) * 100) / 100));
    input.addEventListener('input', () => {
      show();
      handlers.change({ [key]: Number(input.value) } as Partial<GraphOptions>);
    });
    body.append(h('label', { class: 'graph-row graph-row-slider', title: hint }, h('span', { class: 'graph-row-label' }, label), value, input));
    controls.push({
      sync: (o) => {
        input.value = String(o[key]);
        show();
      },
    });
  }

  function select<K extends keyof GraphOptions>(body: HTMLElement, label: string, key: K, entries: [string, string][], hint?: string): void {
    const sel = h('select', { class: 'graph-select' });
    for (const [v, text] of entries) sel.append(h('option', { value: v }, text));
    sel.addEventListener('change', () => handlers.change({ [key]: sel.value } as Partial<GraphOptions>));
    body.append(row(label, sel, hint));
    controls.push({ sync: (o) => (sel.value = String(o[key])) });
  }

  // --- Filters
  const filters = section('Filters', true);
  const search = h('input', { type: 'text', class: 'graph-text', placeholder: 'Search files...', spellcheck: 'false', 'aria-label': 'Search files' });
  const searchError = h('div', { class: 'graph-field-error', hidden: true });
  const pushQuery = debounce((v: string) => handlers.change({ query: v }), 150);
  search.addEventListener('input', () => {
    const err = compileQuery(search.value).error;
    searchError.textContent = err ?? '';
    searchError.hidden = !err;
    pushQuery(search.value);
  });
  filters.append(search, searchError);
  controls.push({
    sync: (o) => {
      if (document.activeElement !== search) search.value = o.query;
      const err = compileQuery(o.query).error;
      searchError.textContent = err ?? '';
      searchError.hidden = !err;
    },
  });
  toggle(filters, 'Tags', 'showTags', 'Show a node for each tag');
  toggle(filters, 'Attachments', 'showAttachments', 'Show images, PDF and other files that notes link to');
  toggle(filters, 'Existing files only', 'existingOnly', 'Hide links to notes that do not exist');
  toggle(filters, 'Orphans', 'showOrphans', 'Show notes without links');

  // --- Groups
  const groups = section('Groups', false);
  const groupList = h('div', { class: 'graph-groups' });
  const newGroup = h('button', { class: 'graph-btn graph-wide', type: 'button' }, 'New group');
  groups.append(groupList, newGroup);
  let current: GraphOptions | null = null;
  let renderedCount = -1;
  const pushGroups = debounce((list: GraphOptions['groups']) => handlers.change({ groups: list }), 250);
  const editGroup = (i: number, patch: Partial<GraphOptions['groups'][number]>, wait: boolean) => {
    if (!current) return;
    const list = current.groups.map((g, k) => (k === i ? { ...g, ...patch } : g));
    current = { ...current, groups: list };
    if (wait) pushGroups(list);
    else handlers.change({ groups: list });
  };
  newGroup.addEventListener('click', () => {
    if (!current) return;
    const color = GROUP_COLORS[current.groups.length % GROUP_COLORS.length];
    handlers.change({ groups: [...current.groups, { query: '', color }] });
  });
  const groupRows: { query: HTMLInputElement; color: HTMLInputElement; error: HTMLElement }[] = [];
  function renderGroups(o: GraphOptions): void {
    groupList.replaceChildren();
    groupRows.length = 0;
    o.groups.forEach((g, i) => {
      const query = h('input', { type: 'text', class: 'graph-text', placeholder: 'Search files... (tag:#api)', spellcheck: 'false', 'aria-label': 'Group search' });
      query.value = g.query;
      const color = h('input', { type: 'color', class: 'graph-color', title: 'Color', 'aria-label': 'Group color' });
      color.value = /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : '#888888';
      const del = h('button', { class: 'graph-btn graph-icon-btn', type: 'button', title: 'Delete group', 'aria-label': 'Delete group' });
      del.append(createElement(X));
      const error = h('div', { class: 'graph-field-error', hidden: true });
      query.addEventListener('input', () => {
        const err = compileQuery(query.value).error;
        error.textContent = err ?? '';
        error.hidden = !err;
        editGroup(i, { query: query.value }, true);
      });
      color.addEventListener('input', () => editGroup(i, { color: color.value }, true));
      del.addEventListener('click', () => {
        if (!current) return;
        handlers.change({ groups: current.groups.filter((_, k) => k !== i) });
      });
      groupRows.push({ query, color, error });
      groupList.append(h('div', { class: 'graph-group' }, h('div', { class: 'graph-group-line' }, query, color, del), error));
    });
  }
  controls.push({
    sync: (o) => {
      current = o;
      if (renderedCount !== o.groups.length) {
        renderedCount = o.groups.length;
        renderGroups(o);
      } else {
        o.groups.forEach((g, i) => {
          const r = groupRows[i];
          if (document.activeElement !== r.query) r.query.value = g.query;
          if (document.activeElement !== r.color && /^#[0-9a-f]{6}$/i.test(g.color)) r.color.value = g.color;
        });
      }
    },
  });

  // --- Display
  const display = section('Display', false);
  toggle(display, 'Arrows', 'arrows');
  select(display, 'Label', 'labelBy', [
    ['name', 'File name'],
    ['title', 'Title'],
  ]);
  slider(display, 'Text fade', 'textFade', -3, 3, 0.1, 'Higher: labels show only when you zoom in more');
  slider(display, 'Node size', 'nodeSize', 0.2, 3, 0.05);
  slider(display, 'Link thickness', 'linkThickness', 0.2, 3, 0.05);
  slider(display, 'Bundling', 'bundling', 0, 1, 0.05, 'Radial and tree layouts: bend links along the folder tree');

  // --- Forces
  const forces = section('Forces', false);
  slider(forces, 'Center', 'centerForce', 0, 1, 0.01, 'Pull to the middle');
  slider(forces, 'Repel', 'repelForce', 0, 20, 0.1, 'How strongly nodes push each other away');
  slider(forces, 'Link force', 'linkForce', 0, 1, 0.01);
  slider(forces, 'Link distance', 'linkDistance', 30, 500, 1);
  slider(forces, 'Folder pull', 'folderPull', 0, 1, 0.01, 'How strongly notes gather in the middle of their folder');

  // --- Folders
  const folders = section('Folders', true);
  toggle(folders, 'Show folders', 'showFolders', 'Show a node for each folder');
  toggle(folders, 'Folder outlines', 'folderOutlines', 'Draw an outline around the notes of each folder');
  select(folders, 'Color by', 'colorBy', [
    ['folder', 'Folder'],
    ['tag', 'Tag'],
    ['none', 'None'],
  ] satisfies [ColorBy, string][]);
  slider(folders, 'Color depth', 'colorDepth', 1, 4, 1, '1 colors by the folders in the root, 2 by their sub folders, and so on');

  // --- Local graph
  const local = section('Local graph', true, (scope) => scope.kind === 'local');
  slider(local, 'Depth', 'depth', 1, 5, 1, 'Steps from the center note');
  toggle(local, 'Incoming links', 'incoming');
  toggle(local, 'Outgoing links', 'outgoing');
  toggle(local, 'Neighbor links', 'neighborLinks', 'Show links between the neighbors too');
  const follow = h('input', { type: 'checkbox', class: 'graph-switch' });
  follow.addEventListener('change', () => handlers.setFollow(follow.checked));
  local.append(row('Follow active note', follow, 'Move the center when you open another note'));
  controls.push({ sync: (_o, scope) => (follow.checked = scope.kind === 'local' && scope.follow) });

  return {
    el,
    sync(o, scope) {
      for (const c of controls) c.sync(o, scope);
    },
  };
}

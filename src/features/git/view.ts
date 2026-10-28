// Sidebar view: branch, compare base, and the list of changed files in groups.
// The list is virtualized: only the visible rows are in the DOM.

import {
  createElement,
  ChevronDown,
  ChevronRight,
  GitBranch,
  RefreshCw,
} from 'lucide';
import type { AppContext, ViewInstance } from '../../core/types';
import { h } from '../../core/dom';
import { basename, dirname, rafThrottle } from '../../core/util';
import { fileIcon } from '../../ui/file-icons';
import { diffTabId, diffTabInput } from './diff-tab';
import type { ChangeItem, Group, GitService } from './service';
import './git.css';

const ROW_H = 22;
const OVERSCAN = 8;

const GROUP_TITLE: Record<Group, string> = {
  conflicts: 'Merge Conflicts',
  staged: 'Staged Changes',
  changes: 'Changes',
  untracked: 'Untracked',
};
const GROUP_ORDER: Group[] = ['conflicts', 'staged', 'changes', 'untracked'];

type Row = { type: 'group'; group: Group; count: number; collapsed: boolean } | { type: 'file'; item: ChangeItem };

export function createGitView(ctx: AppContext, svc: GitService, host: HTMLElement): ViewInstance {
  const collapsed = new Set<Group>(ctx.workspace.state.get<Group[]>('git.collapsed') ?? []);
  let rows: Row[] = [];
  let selected = -1;

  const branchEl = h('span', { class: 'git-branch-name' });
  const baseBtn = h('button', {
    class: 'git-base',
    type: 'button',
    title: 'Choose what to compare with',
    onclick: () => void ctx.commands.execute('git.compareWithBranch'),
  });
  const refreshBtn = h(
    'button',
    { class: 'git-btn', type: 'button', title: 'Refresh', onclick: () => void svc.refresh() },
    createElement(RefreshCw),
  );
  const header = h(
    'div',
    { class: 'git-header' },
    h('div', { class: 'git-header-row' }, createElement(GitBranch), branchEl, h('span', { class: 'git-spacer' }), refreshBtn),
    baseBtn,
  );
  const spacer = h('div', { class: 'git-spacer-box' });
  const rowsEl = h('div', { class: 'git-rows' });
  const scroller = h('div', { class: 'git-list', tabindex: '0' }, spacer, rowsEl);
  const message = h('div', { class: 'git-message' });
  host.classList.add('git-view');
  host.append(header, scroller, message);

  function buildRows() {
    const model = svc.model;
    rows = [];
    if (!model) return;
    for (const g of GROUP_ORDER) {
      const items = model.items.filter((i) => i.group === g);
      if (items.length === 0) continue;
      const isCollapsed = collapsed.has(g);
      rows.push({ type: 'group', group: g, count: items.length, collapsed: isCollapsed });
      if (!isCollapsed) for (const item of items) rows.push({ type: 'file', item });
    }
  }

  function rowEl(row: Row, index: number): HTMLElement {
    const top = `top:${index * ROW_H}px`;
    if (row.type === 'group') {
      return h(
        'div',
        { class: 'git-row git-group', 'data-index': index, style: top },
        createElement(row.collapsed ? ChevronRight : ChevronDown),
        h('span', { class: 'git-group-title' }, GROUP_TITLE[row.group]),
        h('span', { class: 'git-count' }, row.count),
      );
    }
    const it = row.item;
    const dir = dirname(it.path);
    const tip = it.origPath ? `${it.origPath} -> ${it.path}` : it.path;
    return h(
      'div',
      {
        class: `git-row git-file git-s-${it.status}${index === selected ? ' git-selected' : ''}`,
        'data-index': index,
        style: top,
        title: tip,
      },
      fileIcon(basename(it.path)),
      h('span', { class: 'git-file-name' }, basename(it.path)),
      h('span', { class: 'git-file-dir' }, it.origPath ? `${basename(it.origPath)} -> ${dir}` : dir),
      h('span', { class: 'git-letter' }, it.letter),
    );
  }

  const paint = rafThrottle(() => {
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW_H) + OVERSCAN);
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(rowEl(rows[i], i));
    rowsEl.replaceChildren(frag);
  });

  function renderHeader() {
    const m = svc.model;
    if (!m) {
      branchEl.textContent = '';
      baseBtn.style.display = 'none';
      return;
    }
    const where = m.branch ?? (m.head ? `HEAD (${m.head.slice(0, 7)})` : 'No commits yet');
    let text = where;
    if (m.ahead) text += ` ↑${m.ahead}`;
    if (m.behind) text += ` ↓${m.behind}`;
    branchEl.textContent = text;
    branchEl.title = m.upstream ? `${where}, upstream ${m.upstream}` : where;
    baseBtn.style.display = '';
    baseBtn.textContent = m.baseName === 'HEAD' ? 'Working tree vs HEAD' : `Working tree vs ${m.baseName} (merge base)`;
  }

  function render() {
    buildRows();
    renderHeader();
    refreshBtn.classList.toggle('git-spinning', svc.loading);
    spacer.style.height = `${rows.length * ROW_H}px`;
    let text = '';
    if (!ctx.workspace.root) text = 'Open a folder to see git changes.';
    else if (!svc.enabled) text = 'Git is turned off (setting git.enabled).';
    else if (svc.problem === 'not_a_repo') text = 'This folder is not a git repository.';
    else if (svc.problem === 'git_missing') text = 'git was not found. Install git and restart Kestrel.';
    else if (svc.problem) text = svc.problem;
    else if (!svc.model) text = svc.loading ? 'Loading...' : '';
    else if (rows.length === 0) text = 'No changes.';
    message.textContent = text;
    message.style.display = text ? '' : 'none';
    if (selected >= rows.length) selected = rows.length - 1;
    paint();
  }

  function openItem(item: ChangeItem, pin: boolean) {
    if (item.group === 'conflicts') {
      void ctx.editors.openFile(item.abs, { preview: !pin });
      return;
    }
    const m = svc.model;
    const base = m?.baseName ?? 'HEAD';
    const params = { base, path: item.abs, origPath: item.origPath };
    ctx.tabs.open(diffTabInput(ctx, svc, params), { preview: !pin });
    if (pin) ctx.tabs.pin(diffTabId(params));
  }

  function activate(index: number, pin: boolean) {
    const row = rows[index];
    if (!row) return;
    selected = index;
    if (row.type === 'group') {
      if (collapsed.has(row.group)) collapsed.delete(row.group);
      else collapsed.add(row.group);
      ctx.workspace.state.set('git.collapsed', [...collapsed]);
      render();
    } else {
      openItem(row.item, pin);
      paint();
    }
  }

  const indexOf = (e: Event) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
    return el ? Number(el.dataset.index) : -1;
  };
  scroller.addEventListener('click', (e) => {
    const i = indexOf(e);
    if (i >= 0) activate(i, false);
  });
  scroller.addEventListener('dblclick', (e) => {
    const i = indexOf(e);
    if (i >= 0 && rows[i]?.type === 'file') activate(i, true);
  });
  scroller.addEventListener('scroll', paint, { passive: true });
  scroller.addEventListener('keydown', (e) => {
    let next = selected;
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, selected + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, selected - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      if (selected >= 0) activate(selected, e.key === 'Enter' && e.shiftKey);
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    selected = next;
    const top = next * ROW_H;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW_H - scroller.clientHeight;
    paint();
  });
  const resize = new ResizeObserver(() => requestAnimationFrame(() => paint()));
  resize.observe(scroller);

  const sub = svc.onChange(render);
  // The collapsed groups belong to one folder. Read them again when the folder changes.
  const wsSub = ctx.bus.on('workspace:changed', () => {
    collapsed.clear();
    for (const g of ctx.workspace.state.get<Group[]>('git.collapsed') ?? []) collapsed.add(g);
    selected = -1;
    render();
  });
  render();

  return {
    onShow() {
      paint();
      if (!svc.model && !svc.loading) void svc.refresh();
    },
    focus: () => scroller.focus(),
    dispose() {
      sub.dispose();
      wsSub.dispose();
      resize.disconnect();
      host.replaceChildren();
    },
  };
}

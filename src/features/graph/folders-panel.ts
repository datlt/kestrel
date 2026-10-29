// The folders panel (on the left): the folder tree with a color dot, the note
// count, an eye button (hide) and a collapse button. Only the rows in view are
// in the DOM, so a project with thousands of folders stays fast.

import { ChevronDown, ChevronRight, createElement, Eye, EyeOff, Minimize2, X } from 'lucide';
import { h } from '../../core/dom';
import { rafThrottle } from '../../core/util';
import { defaultExpanded, flattenFolders } from './folder-rows';
import type { FolderRow } from './folder-rows';
import type { FolderNode, FolderState } from './types';

export interface FoldersHandlers {
  /** The pointer is over a folder row (rel path), or left the list (null). */
  hover(rel: string | null): void;
  /** Click on a row: zoom to the nodes of the folder. */
  click(rel: string): void;
  toggleHidden(rel: string): void;
  toggleCollapsed(rel: string): void;
  close(): void;
}

export interface FoldersPanel {
  el: HTMLElement;
  /** New folder tree (null: none) and the state of the folders. */
  set(root: FolderNode | null, state: FolderState): void;
}

const ROW_HEIGHT = 24;

export function createFoldersPanel(handlers: FoldersHandlers): FoldersPanel {
  const el = h('div', { class: 'graph-folders', hidden: true });
  const closeBtn = h('button', { class: 'graph-btn graph-icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: () => handlers.close() });
  closeBtn.append(createElement(X));
  el.append(h('div', { class: 'graph-panel-head' }, h('span', { class: 'graph-panel-title' }, 'Folders'), closeBtn));
  const scroller = h('div', { class: 'graph-folders-scroll' });
  const spacer = h('div', { class: 'graph-folders-spacer' });
  const rowsHost = h('div', { class: 'graph-folders-rows' });
  spacer.append(rowsHost);
  scroller.append(spacer);
  el.append(scroller);

  let root: FolderNode | null = null;
  let state: FolderState = { collapsed: [], hidden: [] };
  let expanded = new Set<string>();
  let rows: FolderRow[] = [];

  function paint(): void {
    spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
    const top = scroller.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 3);
    const last = Math.min(rows.length, Math.ceil((top + (scroller.clientHeight || 400)) / ROW_HEIGHT) + 3);
    const hidden = new Set(state.hidden);
    const collapsed = new Set(state.collapsed);
    const out: HTMLElement[] = [];
    for (let i = first; i < last; i++) {
      const { node, level, expanded: open } = rows[i];
      const isRoot = node.rel === '';
      const caret = h('span', { class: 'graph-folder-caret', 'data-action': 'expand' });
      if (node.children.length) caret.append(createElement(open ? ChevronDown : ChevronRight));
      const dot = h('span', { class: 'graph-folder-dot', style: node.color ? `background:${node.color}` : '' });
      const eye = h('button', { class: 'graph-folder-btn', type: 'button', 'data-action': 'hide', title: hidden.has(node.rel) ? 'Show this folder' : 'Hide this folder', 'aria-label': 'Hide folder', hidden: isRoot });
      eye.append(createElement(hidden.has(node.rel) ? EyeOff : Eye));
      const fold = h('button', { class: 'graph-folder-btn', type: 'button', 'data-action': 'collapse', title: collapsed.has(node.rel) ? 'Expand into notes' : 'Collapse into one node', 'aria-label': 'Collapse folder', hidden: isRoot });
      fold.append(createElement(Minimize2));
      const row = h(
        'div',
        { class: 'graph-folder-row', 'data-rel': node.rel, style: `top:${i * ROW_HEIGHT}px;height:${ROW_HEIGHT}px;padding-left:${6 + level * 14}px`, title: node.path },
        caret,
        dot,
        h('span', { class: 'graph-folder-name' }, node.name),
        h('span', { class: 'graph-folder-count' }, String(node.totalNotes)),
        eye,
        fold,
      );
      row.classList.toggle('is-hidden', hidden.has(node.rel));
      row.classList.toggle('is-collapsed', collapsed.has(node.rel));
      out.push(row);
    }
    rowsHost.replaceChildren(...out);
  }

  function rebuildRows(): void {
    rows = root ? flattenFolders(root, expanded) : [];
    paint();
  }

  scroller.addEventListener('scroll', rafThrottle(paint));
  const onHover = (e: Event) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.graph-folder-row');
    handlers.hover(row ? (row.dataset.rel ?? '') : null);
  };
  rowsHost.addEventListener('pointerover', onHover);
  scroller.addEventListener('pointerleave', () => handlers.hover(null));
  rowsHost.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>('.graph-folder-row');
    if (!row) return;
    const rel = row.dataset.rel ?? '';
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'expand') {
      if (expanded.has(rel)) expanded.delete(rel);
      else expanded.add(rel);
      rebuildRows();
    } else if (action === 'hide') handlers.toggleHidden(rel);
    else if (action === 'collapse') handlers.toggleCollapsed(rel);
    else handlers.click(rel);
  });

  return {
    el,
    set(next, nextState) {
      state = nextState;
      if (next !== root) {
        const first = root === null || root.path !== next?.path;
        root = next;
        if (first && next) expanded = defaultExpanded(next);
        rebuildRows();
      } else {
        paint();
      }
    },
  };
}

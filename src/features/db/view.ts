// The Database view in the sidebar: connections, databases, objects, columns.
// The list is virtualized, so thousands of tables stay fast. The tree uses its
// own "meta" session per connection (see hub.ts). It connects when you first
// open a connection.

import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Columns3,
  createElement,
  Database,
  Eye,
  Folder,
  Key,
  ListTree,
  Plus,
  RefreshCw,
  SquareFunction,
  Terminal,
  Zap,
} from 'lucide';
import { h } from '../../core/dom';
import type { MenuItem, ViewInstance } from '../../core/types';
import { rafThrottle } from '../../core/util';
import { dbColumns, dbDatabases, dbIndexes, dbObjects, dbPasswordDelete, type DbObjectKind } from '../../ipc/db';
import { describeError } from './errors';
import { copyName, removeConnection, upsertConnection } from './form-model';
import type { DbHub } from './hub';
import { connTabId, connTabInput, ddlTabInput, openConsole } from './tabs';
import {
  collectOpen,
  connectionNode,
  databaseNodes,
  expandable,
  flatten,
  groupNodes,
  reset,
  selectTopSql,
  tableChildren,
  visibleDatabases,
  type Row,
  type TreeNode,
} from './tree-model';
import './db.css';

const ROW_H = 22;
const OVERSCAN = 8;

const OBJECT_ICON: Record<DbObjectKind, Parameters<typeof createElement>[0]> = {
  table: Columns3,
  view: Eye,
  procedure: Terminal,
  function: SquareFunction,
  trigger: Zap,
};

export function createDatabaseView(hub: DbHub, host: HTMLElement): ViewInstance {
  const ctx = hub.ctx;
  let roots: TreeNode[] = [];
  let rows: Row[] = [];
  let selectedId: string | null = null;
  let disposed = false;
  /** Database names as the server sent them, so the system schema setting can apply without a new request. */
  const rawDatabases = new Map<string, string[]>();
  let lastConnections = '';

  // --- DOM ---
  const btn = (icon: Parameters<typeof createElement>[0], title: string, run: () => void) =>
    h('button', { class: 'db-btn db-icon-btn', type: 'button', title, 'aria-label': title, onclick: run }, createElement(icon));
  const toolbar = h(
    'div',
    { class: 'db-tree-toolbar' },
    h('span', { class: 'db-tree-title' }, 'Connections'),
    h('span', { class: 'db-spacer' }),
    btn(Plus, 'Add Connection', () => void ctx.commands.execute('db.addConnection')),
    btn(RefreshCw, 'Refresh', () => refreshAll()),
    btn(ChevronsDownUp, 'Collapse All', () => collapseAll()),
  );
  const spacer = h('div', { class: 'db-tree-spacer' });
  const rowsEl = h('div', { class: 'db-tree-rows' });
  const scroller = h('div', { class: 'db-tree-list', tabindex: '0', role: 'tree' }, spacer, rowsEl);
  const message = h('div', { class: 'db-tree-message' });
  host.classList.add('db-tree');
  host.append(toolbar, message, scroller);

  // --- Nodes ---
  function buildRoots() {
    const old = new Map(roots.map((r) => [r.id, r]));
    roots = hub.connections().map((c) => {
      const prev = old.get(`c:${c.id}`);
      // Same settings: keep the loaded tree. Changed settings: start again.
      if (prev && JSON.stringify(prev.config) === JSON.stringify(c)) return prev;
      if (prev) hub.closeMeta(c.id);
      return connectionNode(c);
    });
    for (const [id] of old) if (!roots.some((r) => r.id === id)) hub.closeMeta(id.slice(2));
  }

  function find(id: string): TreeNode | null {
    let found: TreeNode | null = null;
    const walk = (n: TreeNode) => {
      if (n.id === id) found = n;
      else n.children?.forEach(walk);
    };
    roots.forEach(walk);
    return found;
  }

  const paint = rafThrottle(() => {
    if (disposed) return;
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW_H) + OVERSCAN);
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(rowEl(rows[i], i));
    rowsEl.replaceChildren(frag);
  });

  function render() {
    if (disposed) return;
    rows = flatten(roots);
    spacer.style.height = `${rows.length * ROW_H}px`;
    message.textContent = roots.length === 0 ? 'No connections yet. Click + to add a MySQL connection.' : '';
    message.hidden = roots.length > 0;
    paint();
  }

  function rowEl(row: Row, index: number): HTMLElement {
    const style = `top:${index * ROW_H}px;padding-left:${6 + row.depth * 14}px`;
    if (row.type === 'loading') return h('div', { class: 'db-tree-row db-faint', style }, h('span', { class: 'db-chev' }), 'Loading...');
    if (row.type === 'empty') return h('div', { class: 'db-tree-row db-faint', style }, h('span', { class: 'db-chev' }), '(empty)');
    if (row.type === 'error') {
      const retry = h('button', { class: 'db-link', type: 'button', onclick: () => void load(row.parent) }, 'Retry');
      return h('div', { class: 'db-tree-row db-tree-error', style, title: row.message }, h('span', { class: 'db-chev' }), h('span', { class: 'db-tree-error-text' }, row.message), retry);
    }
    const n = row.node;
    const can = expandable(n);
    const chev = h('span', { class: 'db-chev', 'data-toggle': can ? '1' : null }, can ? createElement(n.expanded ? ChevronDown : ChevronRight) : null);
    let icon: Element;
    if (n.kind === 'connection') icon = h('span', { class: 'db-dot', style: n.config?.color ? `background:${n.config.color}` : '' });
    else if (n.kind === 'database') icon = createElement(Database);
    else if (n.kind === 'group') icon = createElement(Folder);
    else if (n.kind === 'object') icon = createElement(OBJECT_ICON[n.objectKind ?? 'table']);
    else if (n.kind === 'index') icon = createElement(ListTree);
    else icon = createElement(n.tags?.includes('PRI') ? Key : Columns3);
    icon.classList.add('db-tree-icon');
    const el = h(
      'div',
      {
        class: `db-tree-row${n.id === selectedId ? ' is-selected' : ''}${n.kind === 'column' || n.kind === 'index' ? ' is-leaf' : ''}`,
        style,
        'data-id': n.id,
        role: 'treeitem',
        'aria-expanded': can ? String(n.expanded) : null,
        title: n.kind === 'connection' && n.config ? `${n.config.user}@${n.config.host}:${n.config.port}` : n.detail ? `${n.label}  ${n.detail}` : n.label,
      },
      chev,
      icon,
      h('span', { class: 'db-tree-label' }, n.label),
      n.detail ? h('span', { class: 'db-tree-detail' }, n.detail) : null,
    );
    for (const t of n.tags ?? []) el.append(h('span', { class: 'db-tag' }, t));
    if (n.kind === 'connection' && n.config) {
      if (n.config.production) el.append(h('span', { class: 'db-badge db-badge-prod', title: 'Production connection' }, 'PROD'));
      if (n.config.readOnly) el.append(h('span', { class: 'db-badge', title: 'Read-only connection' }, 'READ-ONLY'));
    }
    return el;
  }

  // --- Loading ---
  async function load(node: TreeNode): Promise<void> {
    node.state = 'loading';
    node.error = undefined;
    render();
    try {
      const meta = hub.meta(node.connId, host);
      if (node.kind === 'connection') {
        const names = await meta.run((sid) => dbDatabases(sid));
        rawDatabases.set(node.connId, names);
        node.children = databaseNodes(node.connId, visibleDatabases(names, ctx.settings.get('db.showSystemSchemas')));
      } else if (node.kind === 'database' && node.database) {
        const db = node.database;
        const objs = await meta.run((sid) => dbObjects(sid, db));
        node.children = groupNodes(node.connId, db, objs);
      } else if (node.kind === 'object' && node.database && node.name) {
        const { database, name } = node;
        // One session answers one call at a time, so the calls run one after the other.
        const [cols, idx] = await meta.run(async (sid) => {
          const c = await dbColumns(sid, database, name);
          const i = await dbIndexes(sid, database, name).catch(() => []);
          return [c, i] as const;
        });
        node.children = tableChildren(node.connId, database, name, cols, idx);
      }
      node.state = 'idle';
    } catch (e) {
      node.state = 'error';
      node.error = describeError(e).text;
    }
    render();
  }

  function toggle(node: TreeNode, force?: boolean): void {
    if (!expandable(node)) return;
    node.expanded = force ?? !node.expanded;
    if (node.expanded && node.children === undefined && node.state !== 'loading') void load(node);
    else render();
  }

  async function loadTree(node: TreeNode, open: Set<string>): Promise<void> {
    await load(node);
    for (const c of node.children ?? []) {
      if (disposed) return;
      if (open.has(c.id) && expandable(c)) {
        c.expanded = true;
        await loadTree(c, open);
      }
    }
  }

  async function refreshNode(node: TreeNode): Promise<void> {
    const open = collectOpen([node]);
    reset(node);
    if (node.kind === 'connection') hub.closeMeta(node.connId);
    if (node.expanded && expandable(node)) await loadTree(node, open);
    else render();
  }

  function refreshAll(): void {
    for (const r of roots) if (r.children !== undefined || r.state === 'error') void refreshNode(r);
  }

  function collapseAll(): void {
    const walk = (n: TreeNode) => {
      n.expanded = false;
      n.children?.forEach(walk);
    };
    roots.forEach(walk);
    scroller.scrollTop = 0;
    render();
  }

  // --- Connection actions ---
  async function saveConnections(list: ReturnType<typeof hub.connections>): Promise<boolean> {
    try {
      await ctx.settings.update({ 'db.connections': list });
      return true;
    } catch (e) {
      ctx.ui.notify(`Could not save the connections: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
      return false;
    }
  }

  async function duplicate(connId: string) {
    const src = hub.find(connId);
    if (!src) return;
    const list = hub.connections();
    const copy = { ...src, id: crypto.randomUUID(), name: copyName(src.name, list.map((c) => c.name)) };
    if (await saveConnections(upsertConnection(list, copy))) {
      ctx.ui.notify('The password is not copied. Enter it in the new connection.', { timeoutMs: 4000 });
      ctx.tabs.open(connTabInput(hub, copy.id));
    }
  }

  async function remove(connId: string) {
    const src = hub.find(connId);
    if (!src) return;
    const answer = await ctx.ui.confirm({
      title: `Delete the connection "${src.name}"?`,
      message: 'The saved password is removed from the keychain too. Open consoles keep their text.',
      buttons: ['Delete', 'Cancel'],
    });
    if (answer !== 'Delete') return;
    if (!(await saveConnections(removeConnection(hub.connections(), connId)))) return;
    hub.closeMeta(connId);
    await dbPasswordDelete(connId).catch(() => undefined);
    const tab = ctx.tabs.get(connTabId(connId));
    if (tab) void ctx.tabs.close(tab.id, { force: true });
  }

  const copyText = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => ctx.ui.notify('Copied.', { timeoutMs: 1200 }),
      () => ctx.ui.notify('Cannot copy to the clipboard.', { kind: 'warn' }),
    );

  function showDdl(n: TreeNode) {
    if (n.kind !== 'object' || !n.database || !n.name || !n.objectKind) return;
    ctx.tabs.open(ddlTabInput(hub, { connId: n.connId, database: n.database, name: n.name, kind: n.objectKind }));
  }

  function menuFor(n: TreeNode): MenuItem[] {
    const items: MenuItem[] = [];
    const refresh: MenuItem = { label: 'Refresh', run: () => void refreshNode(n), disabled: !expandable(n), separatorBefore: true };
    const copy: MenuItem = { label: 'Copy Name', run: () => void copyText(n.name ?? n.database ?? n.label), separatorBefore: true };
    switch (n.kind) {
      case 'connection':
        items.push(
          { label: 'New SQL Console', run: () => openConsole(hub, { connId: n.connId }) },
          refresh,
          { label: 'Disconnect', run: () => { n.expanded = false; reset(n); hub.closeMeta(n.connId); render(); } },
          { label: 'Edit Connection', run: () => ctx.tabs.open(connTabInput(hub, n.connId)), separatorBefore: true },
          { label: 'Duplicate Connection', run: () => void duplicate(n.connId) },
          { label: 'Delete Connection', run: () => void remove(n.connId) },
          { label: 'Copy Name', run: () => void copyText(n.label), separatorBefore: true },
        );
        break;
      case 'database':
        items.push({ label: 'New SQL Console', run: () => openConsole(hub, { connId: n.connId, database: n.database }) }, refresh, copy);
        break;
      case 'object': {
        const table = n.objectKind === 'table' || n.objectKind === 'view';
        if (table && n.database && n.name) {
          items.push({
            label: 'Select Top 100',
            run: () => openConsole(hub, { connId: n.connId, database: n.database, text: selectTopSql(n.database!, n.name!), autoRun: true }),
          });
          items.push({ label: 'New SQL Console', run: () => openConsole(hub, { connId: n.connId, database: n.database }) });
        }
        items.push({ label: 'Show DDL', run: () => showDdl(n), separatorBefore: table });
        if (table) items.push(refresh);
        items.push(copy);
        break;
      }
      case 'group':
        items.push({ label: 'Refresh', run: () => void refreshNode(findParentDatabase(n) ?? n), disabled: false });
        break;
      default:
        items.push({ label: 'Copy Name', run: () => void copyText(n.label) });
    }
    return items;
  }

  /** A group reloads together with its database, because the counts come from there. */
  function findParentDatabase(group: TreeNode): TreeNode | null {
    return find(`d:${group.connId}/${group.database}`);
  }

  // --- Events ---
  const indexOf = (e: Event) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
    return el?.dataset.id ? find(el.dataset.id) : null;
  };
  scroller.addEventListener('click', (e) => {
    const n = indexOf(e);
    if (!n) return;
    selectedId = n.id;
    if ((e.target as HTMLElement).closest('[data-toggle]')) toggle(n);
    else paint();
  });
  scroller.addEventListener('dblclick', (e) => {
    const n = indexOf(e);
    if (n && !(e.target as HTMLElement).closest('[data-toggle]')) toggle(n);
  });
  scroller.addEventListener('contextmenu', (e) => {
    const n = indexOf(e);
    if (!n) return;
    e.preventDefault();
    selectedId = n.id;
    paint();
    ctx.ui.contextMenu(e, menuFor(n));
  });
  scroller.addEventListener('scroll', paint, { passive: true });
  scroller.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const i = rows.findIndex((r) => r.type === 'node' && r.node.id === selectedId);
    const cur = i >= 0 ? (rows[i] as Extract<Row, { type: 'node' }>) : null;
    const move = (to: number) => {
      const target = Math.min(rows.length - 1, Math.max(0, to));
      // Skip rows that are not nodes (loading, error).
      let t = target;
      const dir = to >= i ? 1 : -1;
      while (t >= 0 && t < rows.length && rows[t].type !== 'node') t += dir;
      const r = rows[t];
      if (r && r.type === 'node') {
        selectedId = r.node.id;
        const top = t * ROW_H;
        if (top < scroller.scrollTop) scroller.scrollTop = top;
        else if (top + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW_H - scroller.clientHeight;
        paint();
      }
    };
    switch (e.key) {
      case 'ArrowDown': move(i + 1); break;
      case 'ArrowUp': move(i < 0 ? 0 : i - 1); break;
      case 'ArrowRight':
        if (cur && expandable(cur.node)) {
          if (!cur.node.expanded) toggle(cur.node, true);
          else move(i + 1);
        }
        break;
      case 'ArrowLeft':
        if (cur && cur.node.expanded) toggle(cur.node, false);
        else if (cur) {
          for (let j = i - 1; j >= 0; j--) {
            const r = rows[j];
            if (r.type === 'node' && r.depth < cur.depth) {
              move(j);
              break;
            }
          }
        }
        break;
      case 'Enter':
      case ' ':
        if (cur) toggle(cur.node);
        break;
      case 'F5':
        if (cur) void refreshNode(cur.node);
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  // --- Settings ---
  lastConnections = JSON.stringify(hub.connections());
  const sub = ctx.bus.on('settings:changed', (e) => {
    const now = JSON.stringify(e.settings['db.connections']);
    if (now !== lastConnections) {
      lastConnections = now;
      buildRoots();
      render();
    }
    if (e.settings['db.showSystemSchemas'] !== e.previous['db.showSystemSchemas']) {
      for (const r of roots) {
        const names = rawDatabases.get(r.connId);
        if (!names || r.children == null) continue;
        const open = collectOpen(r.children);
        const kids = databaseNodes(r.connId, visibleDatabases(names, e.settings['db.showSystemSchemas']));
        for (const k of kids) {
          const old = r.children.find((o) => o.id === k.id);
          if (old) Object.assign(k, { expanded: old.expanded, state: old.state, children: old.children, error: old.error });
          else if (open.has(k.id)) k.expanded = false;
        }
        r.children = kids;
      }
      render();
    }
  });

  hub.tree = {
    refresh: refreshAll,
    collapseAll,
    selected() {
      const n = selectedId ? find(selectedId) : null;
      return n ? { connId: n.connId, database: n.database, name: n.name, objectKind: n.objectKind } : null;
    },
  };

  buildRoots();
  render();

  return {
    onShow() {
      paint();
    },
    focus() {
      scroller.focus();
    },
    dispose() {
      disposed = true;
      sub.dispose();
      if (hub.tree) hub.tree = null;
    },
  };
}

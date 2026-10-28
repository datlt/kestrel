// Database feature (MySQL and Trino): sidebar view, connection form, SQL consoles, result
// grid, DDL tab, `.sql` file support and commands. Spec: docs/DESIGN.md 9.3.
//
// All state lives in one `DbHub` per workbench (never at module level). The
// heavy parts (console, grid, form, tree) load with `import()` when needed.

import { createElement, Database, Table2 } from 'lucide';
import type { AppContext, QuickPickItem } from '../../core/types';
import { lazyView } from '../lazy-view';
import { DbHub } from './hub';
import { ideaFilesChanged } from './idea-model';
import { sqlFileExtension } from './file-ext';
import { connTabInput, ddlTabInput, openConsole, restoreConnTab, restoreConsoleTab, restoreDdlTab } from './tabs';

/** Registers the Database view, SQL consoles and the database commands. */
export function initDb(ctx: AppContext): void {
  const hub = new DbHub(ctx);

  // --- Views, tabs, editor extension --------------------------------------------------
  ctx.views.register({
    id: 'database',
    title: 'Database',
    icon: () => createElement(Database),
    location: 'sidebar',
    order: 40,
    create: (host) => lazyView(host, async () => (await import('./view')).createDatabaseView(hub, host)),
  });
  ctx.views.register({
    id: 'db-results',
    title: 'SQL Results',
    icon: () => createElement(Table2),
    location: 'panel',
    order: 30,
    create: (host) => lazyView(host, async () => (await import('./panel')).createResultsPanel(hub, host)),
  });
  ctx.tabs.registerKind('sql-console', (data) => restoreConsoleTab(hub, data));
  ctx.tabs.registerKind('db-connection', (data) => restoreConnTab(hub, data));
  ctx.tabs.registerKind('db-ddl', (data) => restoreDdlTab(hub, data));
  ctx.editors.registerExtension((editor) => (editor.languageId === 'sql' ? sqlFileExtension(hub, editor) : null));

  // --- Status bar and end of life ---------------------------------------------------------
  const refreshStatus = () => {
    hub.refreshStatus();
    hub.refreshFileStatus();
  };
  ctx.bus.on('tab:activated', refreshStatus);
  ctx.bus.on('tabs:changed', refreshStatus);
  ctx.bus.on('settings:changed', (e) => {
    if (e.settings['db.connections'] !== e.previous['db.connections']) refreshStatus();
    if (e.settings['db.idea.enabled'] !== e.previous['db.idea.enabled']) void hub.idea.load();
  });

  // --- IntelliJ data sources of the open folder -------------------------------------------
  // Rust reads the files (no password goes to the frontend). Reload when they change.
  let ideaTimer: ReturnType<typeof setTimeout> | null = null;
  const reloadIdea = () => {
    if (ideaTimer) clearTimeout(ideaTimer);
    ideaTimer = setTimeout(() => {
      ideaTimer = null;
      void hub.idea.load();
    }, 300);
  };
  ctx.bus.on('fs:changed', (e) => {
    // Events of other folders (other workspace tabs) are not ours.
    if (e.root !== ctx.workspace.root || !hub.idea.enabled()) return;
    if (e.rescan || ideaFilesChanged(e.root, e.paths)) reloadIdea();
  });
  // Pickers and the status bar show IntelliJ connections once the list is read.
  hub.idea.onChange(() => {
    hub.refreshStatus();
    hub.refreshFileStatus();
  });
  if (ctx.workspace.root) void hub.idea.ready();
  // Ask nothing here: the server rolls back open transactions when a connection closes.
  ctx.bus.on('workbench:disposing', () => {
    if (ideaTimer) clearTimeout(ideaTimer);
    hub.disposeAll();
  });
  ctx.bus.on('workspace:will-change', () => {
    hub.idea.reset();
    hub.disposeAll();
  });
  ctx.bus.on('workspace:changed', () => {
    hub.reopen();
    void hub.idea.load();
    refreshStatus();
  });

  // --- Commands ---------------------------------------------------------------------------------
  /** The console or SQL file that commands act on. A SQL file gets its runner on first use. */
  const target = async () => {
    const t = hub.activeTarget();
    if (t) return t;
    const ed = ctx.editors.active();
    if (ed?.languageId === 'sql') return (await import('./sql-file')).targetFor(hub, ed);
    return null;
  };
  const withTarget = (fn: (t: NonNullable<Awaited<ReturnType<typeof target>>>) => unknown) => async () => {
    const t = await target();
    if (!t) {
      ctx.ui.notify('Open a SQL console or a .sql file first.', { kind: 'info', timeoutMs: 3000 });
      return;
    }
    await fn(t);
  };
  const sqlActive = () => hub.sqlActive();

  const addConnection = () => {
    ctx.tabs.open(connTabInput(hub, crypto.randomUUID()));
  };

  const newConsole = (connId?: unknown) => {
    const list = hub.allConnections();
    if (list.length === 0) {
      ctx.ui.notify('There are no connections yet.', {
        kind: 'info',
        actions: [{ label: 'Add Connection', run: addConnection }],
      });
      return;
    }
    const given = typeof connId === 'string' && hub.find(connId) ? connId : null;
    const selected = hub.tree?.selected()?.connId;
    const tab = ctx.tabs.active();
    const fromTab = tab?.input.kind === 'sql-console' ? (tab.input.serialize?.() as { connId?: string } | null)?.connId : undefined;
    const pick = given ?? (selected && hub.find(selected) ? selected : null) ?? (fromTab && hub.find(fromTab) ? fromTab : null) ?? (list.length === 1 ? list[0].id : null);
    if (pick) {
      openConsole(hub, { connId: pick });
      return;
    }
    const items: QuickPickItem[] = list.map((c) => ({ id: c.id, label: c.name, description: `${c.user}@${c.host}:${c.port}`, detail: [c.source ? 'IntelliJ' : '', c.production ? 'Production' : ''].filter(Boolean).join(', ') || undefined }));
    ctx.ui.quickPick({ placeholder: 'Open a SQL console on...', items, onAccept: (item) => openConsole(hub, { connId: item.id }) });
  };

  const showDdl = () => {
    const sel = hub.tree?.selected();
    const kind = sel?.objectKind;
    if (sel && sel.database && sel.name && kind && ['table', 'view', 'procedure', 'function', 'trigger'].includes(kind)) {
      ctx.tabs.open(ddlTabInput(hub, { connId: sel.connId, database: sel.database, name: sel.name, kind: kind as 'table' }));
      return;
    }
    ctx.views.show('database', { focus: true });
    ctx.ui.notify('Select a table, view, procedure, function or trigger in the Database view, then run this command again.', { kind: 'info' });
  };

  /** Generate SELECT / Copy SELECT for the table that is selected in the Database view. */
  const selectAction = (what: 'generate' | 'copy') => () => {
    if (hub.tree?.selectAction(what)) return;
    ctx.views.show('database', { focus: true });
    ctx.ui.notify('Select a table or a view in the Database view, then run this command again.', { kind: 'info' });
  };

  ctx.commands.registerMany([
    { id: 'db.newConsole', title: 'New SQL Console', category: 'Database', keybinding: 'Mod-Alt-n', run: newConsole },
    { id: 'db.addConnection', title: 'Add Connection', category: 'Database', run: addConnection },
    { id: 'db.run', title: 'Run Statement', category: 'Database', keybinding: 'Mod-Enter', when: sqlActive, run: withTarget((t) => t.run()) },
    { id: 'db.runScript', title: 'Run Script', category: 'Database', keybinding: 'Mod-Shift-Enter', when: sqlActive, run: withTarget((t) => t.runScript()) },
    {
      id: 'db.cancel',
      title: 'Cancel Running Statement',
      category: 'Database',
      keybinding: 'Mod-.',
      when: () => hub.activeTarget()?.isRunning() === true,
      run: () => hub.activeTarget()?.cancel(),
    },
    { id: 'db.commit', title: 'Commit Transaction', category: 'Database', when: sqlActive, run: withTarget((t) => t.commit()) },
    { id: 'db.rollback', title: 'Roll Back Transaction', category: 'Database', when: sqlActive, run: withTarget((t) => t.rollback()) },
    { id: 'db.toggleAutocommit', title: 'Toggle Auto-commit', category: 'Database', when: sqlActive, run: withTarget((t) => t.toggleAutocommit()) },
    { id: 'db.showDdl', title: 'Show DDL of the Selected Object', category: 'Database', run: showDdl },
    { id: 'db.generateSelect', title: 'Generate SELECT for the Selected Table', category: 'Database', run: selectAction('generate') },
    { id: 'db.copySelect', title: 'Copy SELECT for the Selected Table', category: 'Database', run: selectAction('copy') },
    {
      id: 'db.refresh',
      title: 'Refresh Database View',
      category: 'Database',
      run: async () => {
        hub.tree?.refresh();
        await hub.activeTarget()?.refresh();
      },
    },
    { id: 'db.showView', title: 'Show Database View', category: 'Database', keybinding: 'Ctrl-Shift-d', run: () => ctx.views.show('database', { focus: true }) },
    // Used by the status bar item `db.connection`.
    {
      id: 'db.pickConnection',
      title: 'Choose Connection for SQL File',
      category: 'Database',
      hidden: true,
      when: () => ctx.editors.active()?.languageId === 'sql',
      run: async () => {
        const ed = ctx.editors.active();
        if (ed) await (await import('./sql-file')).targetFor(hub, ed).pickConnection();
      },
    },
  ]);
}

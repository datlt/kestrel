// The SQL console tab: editor, toolbar, results. One console = one session
// (connected when the user runs something). Loaded with `import()` when the
// first console tab is shown.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { MySQL, sql, StandardSQL } from '@codemirror/lang-sql';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { Check, createElement, FastForward, Play, Square, Undo2 } from 'lucide';
import { h } from '../../core/dom';
import { debounce } from '../../core/util';
import type { Disposable, QuickPickItem, TabContent } from '../../core/types';
import { dbCompletionSchema, dbDatabases } from '../../ipc/db';
import { describeError } from './errors';
import { isIdeaId } from './idea-model';
import type { DbHub, RunTarget } from './hub';
import { SqlRunner } from './runner';
import { ResultsPane } from './results-pane';
import { ResultsStore } from './results-store';
import { splitStatements, statementAt, type Stmt } from './split';
import { consoleTabId, consoleTitle, type ConsoleSpec } from './tabs';
import { appendLine, isTrinoConfig, visibleDatabases } from './tree-model';
import './db.css';

const MAX_SAVED_TEXT = 200_000;
const HEIGHT_KEY = 'db.resultsHeight';

function iconBtn(icon: Parameters<typeof createElement>[0], label: string, title: string, onclick: () => void): HTMLButtonElement {
  return h('button', { class: 'db-btn db-tool', type: 'button', title, onclick }, createElement(icon), h('span', null, label));
}

export class ConsoleContent implements TabContent, RunTarget {
  readonly kind = 'console' as const;
  private readonly tabId: string;
  private connId: string | null;
  private readonly store = new ResultsStore();
  private readonly runner: SqlRunner;
  private readonly pane: ResultsPane;
  private readonly view: EditorView;
  private readonly sqlComp = new Compartment();
  private readonly subs: Disposable[] = [];
  private disposed = false;
  private schemaToken = 0;
  private lastDb: string | null = null;
  private lastTitle = '';
  private databaseList: Promise<string[]> | null = null;
  /** Table and column names for completion (from the last `loadSchema`). */
  private schemaMap: Record<string, string[]> | undefined;
  /** The SQL dialect that the editor uses now: `mysql` or `trino`. */
  private dialectNow: 'mysql' | 'trino' = 'mysql';

  private readonly root = h('div', { class: 'db-console' });
  private readonly prodBar = h('div', { class: 'db-prodbar' }, 'PRODUCTION');
  private readonly connBtn = h('button', { class: 'db-btn db-pick', type: 'button', title: 'Choose the connection', onclick: () => this.pickConnection() });
  private readonly dbBtn = h('button', { class: 'db-btn db-pick', type: 'button', title: 'Choose the database', onclick: () => this.pickDatabase() });
  private readonly runBtn = iconBtn(Play, 'Run', 'Run the selection or the statement at the cursor', () => void this.run());
  private readonly scriptBtn = iconBtn(FastForward, 'Run Script', 'Run all statements one by one. It stops at the first error.', () => void this.runScript());
  private readonly cancelBtn = iconBtn(Square, 'Cancel', 'Stop the running statement', () => this.cancel());
  private readonly txSep = h('span', { class: 'db-sep' });
  private readonly acBtn = h('button', { class: 'db-btn db-switch', type: 'button', role: 'switch', title: 'Auto-commit', onclick: () => void this.toggleAutocommit() }, 'Auto-commit');
  private readonly commitBtn = iconBtn(Check, 'Commit', 'Commit the transaction', () => void this.commit());
  private readonly rollbackBtn = iconBtn(Undo2, 'Rollback', 'Roll back the transaction', () => void this.rollback());
  private readonly txBadge = h('span', { class: 'db-badge db-badge-tx', title: 'A transaction is open on the server' }, 'TRANSACTION');
  private readonly limitEl = h('span', { class: 'db-faint', title: 'Rows per result. Change it in the setting db.maxRows.' });
  private readonly stateEl = h('span', { class: 'db-faint db-state' });

  constructor(
    private readonly hub: DbHub,
    private readonly spec: ConsoleSpec,
    host: HTMLElement,
  ) {
    const ctx = hub.ctx;
    this.connId = spec.connId;
    this.tabId = consoleTabId(spec.idConn ?? spec.connId, spec.n);
    this.runner = new SqlRunner({
      hub,
      store: this.store,
      getConfig: () => (this.connId ? (hub.find(this.connId) ?? null) : null),
      modalHost: () => this.root,
      onState: () => this.sync(),
    });
    this.runner.database = spec.database ?? this.config()?.database ?? null;
    this.lastDb = this.runner.database;
    this.dialectNow = this.dialectName();

    // --- Editor ---
    const editorHost = h('div', { class: 'db-editor' });
    const resizer = h('div', { class: 'db-resizer', role: 'separator', 'aria-orientation': 'horizontal', title: 'Drag to resize' });
    const resultsHost = h('div', { class: 'db-results' });
    const savedHeight = ctx.workspace.globalState.get<number>(HEIGHT_KEY);
    resultsHost.style.height = `${Math.max(80, savedHeight ?? 260)}px`;

    this.view = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc: spec.text ?? '',
        extensions: [
          Prec.highest(
            keymap.of([
              { key: 'Mod-Enter', run: () => (void this.run(), true) },
              { key: 'Mod-Shift-Enter', run: () => (void this.runScript(), true) },
            ]),
          ),
          // The console text is part of the session. Tell the workspace to save it a moment after edits.
          EditorView.updateListener.of((u) => {
            if (u.docChanged) this.scheduleSessionSave();
          }),
          lineNumbers(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
          this.sqlComp.of(this.sqlExtension()),
          ctx.editors.highlightExtension(),
          placeholder(`Write SQL here. ${ctx.commands.keyLabel('Mod-Enter')} runs the statement at the cursor.`),
          EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
        ],
      }),
    });

    this.pane = new ResultsPane(ctx, resultsHost, this.store, 'No messages yet.');
    this.initResizer(resizer, resultsHost);

    const toolbar = h(
      'div',
      { class: 'db-toolbar', role: 'toolbar' },
      this.connBtn,
      this.dbBtn,
      h('span', { class: 'db-sep' }),
      this.runBtn,
      this.scriptBtn,
      this.cancelBtn,
      this.txSep,
      this.acBtn,
      this.commitBtn,
      this.rollbackBtn,
      this.txBadge,
      h('span', { class: 'db-spacer' }),
      this.limitEl,
      this.stateEl,
    );
    this.root.append(this.prodBar, toolbar, editorHost, resizer, resultsHost);
    host.append(this.root);

    hub.consoles.set(this.tabId, this);
    this.subs.push(
      ctx.bus.on('settings:changed', () => this.sync()),
      // A restored console on an IntelliJ connection finds its connection when the list arrives.
      hub.idea.onChange(() => this.sync()),
      { dispose: hub.onLoginChange(() => this.sync()) },
    );
    this.sync();
    if (spec.selectText) this.view.dispatch({ selection: { anchor: 0, head: this.view.state.doc.length } });
    if (spec.autoRun) void this.runScript();
  }

  // --- TabContent ---------------------------------------------------------------------

  focus(): void {
    this.hub.touchConsole(this.tabId);
    this.view.focus();
  }

  onShow(): void {
    this.hub.touchConsole(this.tabId);
    this.hub.refreshStatus();
    this.pane.refresh();
    this.view.requestMeasure();
  }

  onHide(): void {
    this.hub.refreshStatus();
  }

  /** An open transaction counts as unsaved work. The shell then asks Save (commit), Don't Save (roll back) or Cancel. */
  isDirty(): boolean {
    return this.runner.inTransaction;
  }

  async save(): Promise<boolean> {
    return this.runner.commit();
  }

  /** Closing with an open transaction: ask Commit, Rollback or Cancel. */
  private readonly scheduleSessionSave = debounce(() => {
    if (!this.disposed) this.hub.ctx.bus.emit('tabs:changed', {});
  }, 1000);

  async confirmClose(): Promise<boolean> {
    if (!this.runner.inTransaction) return true;
    const answer = await this.hub.ctx.ui.confirm({
      title: 'This console has an open transaction.',
      message: 'Commit or roll back the changes before you close it.',
      buttons: ['Commit', 'Rollback', 'Cancel'],
    });
    if (answer === 'Commit') return this.runner.commit();
    if (answer === 'Rollback') return this.runner.rollback();
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduleSessionSave.cancel();
    this.subs.forEach((s) => s.dispose());
    this.hub.consoles.delete(this.tabId);
    // Closing the session rolls back an open transaction on the server.
    this.runner.dispose();
    this.pane.dispose();
    this.view.destroy();
    this.root.remove();
    this.hub.refreshStatus();
  }

  serializeState(): ConsoleSpec & { idConn: string } {
    const text = this.view.state.doc.toString();
    return {
      connId: this.connId ?? this.spec.connId,
      idConn: this.spec.idConn ?? this.spec.connId,
      connName: this.config()?.name ?? this.spec.connName,
      n: this.spec.n,
      text: text.length > MAX_SAVED_TEXT ? text.slice(0, MAX_SAVED_TEXT) : text,
      database: this.runner.database,
    };
  }

  // --- RunTarget ------------------------------------------------------------------------------

  private config() {
    return this.connId ? this.hub.find(this.connId) : undefined;
  }

  isRunning(): boolean {
    return this.runner.running;
  }

  inTransaction(): boolean {
    return this.runner.inTransaction;
  }

  status(): { text: string; tooltip: string } {
    const c = this.config();
    const r = this.runner;
    const name = c?.name ?? 'No connection';
    const parts = [name];
    if (r.database) parts.push(r.database);
    let text = `DB: ${parts.join(' / ')}`;
    if (r.inTransaction) text += ' [TX]';
    else if (!r.autocommit && r.supportsTransactions()) text += ' [manual commit]';
    const tx = r.supportsTransactions() ? ` ${r.inTransaction ? 'A transaction is open.' : 'No open transaction.'}` : '';
    const tooltip = r.connected
      ? `Connected to ${name}, ${this.engineName()} ${r.info?.serverVersion ?? ''}.${tx}`
      : `${name}: not connected. The console connects when you run a statement.`;
    return { text, tooltip };
  }

  /** The statements to run: the selection, or the statement at the cursor. */
  private currentStatements(): Stmt[] {
    const doc = this.view.state.doc;
    const sel = this.view.state.selection.main;
    if (!sel.empty) {
      const base = sel.from;
      return splitStatements(doc.sliceString(sel.from, sel.to)).map((s) => ({ text: s.text, from: s.from + base, to: s.to + base, end: s.end + base }));
    }
    const s = statementAt(doc.toString(), sel.head);
    return s ? [s] : [];
  }

  connectionId(): string | null {
    return this.connId;
  }

  /** Adds `text` as a new last line, selects it and focuses the editor. It does not run it. */
  appendSql(text: string): void {
    const doc = this.view.state.doc.toString();
    const a = appendLine(doc, text);
    this.view.dispatch({
      changes: { from: a.at, insert: a.insert },
      selection: { anchor: a.from, head: a.to },
      scrollIntoView: true,
    });
    this.hub.touchConsole(this.tabId);
    this.view.focus();
    // The tab can become visible just after this call. Focus once more then.
    requestAnimationFrame(() => {
      if (!this.disposed) this.view.focus();
    });
  }

  async run(): Promise<void> {
    this.hub.touchConsole(this.tabId);
    await this.runner.run(this.currentStatements(), this.view.state.doc.toString());
  }

  async runScript(): Promise<void> {
    this.hub.touchConsole(this.tabId);
    const text = this.view.state.doc.toString();
    await this.runner.run(splitStatements(text), text);
  }

  cancel(): void {
    this.runner.cancel();
  }

  async commit(): Promise<void> {
    await this.runner.commit();
  }

  async rollback(): Promise<void> {
    await this.runner.rollback();
  }

  async toggleAutocommit(): Promise<void> {
    await this.runner.setAutocommit(!this.runner.autocommit);
  }

  async refresh(): Promise<void> {
    this.databaseList = null;
    await this.loadSchema();
  }

  // --- Toolbar --------------------------------------------------------------------------------------

  private sync(): void {
    if (this.disposed) return;
    const r = this.runner;
    const c = this.config();
    const busy = r.running || r.connecting;
    this.prodBar.hidden = !c?.production;
    this.root.classList.toggle('is-production', !!c?.production);
    this.connBtn.replaceChildren(
      h('span', { class: 'db-dot', style: c?.color ? `background:${c.color}` : '' }),
      h('span', { class: 'db-pick-text' }, c ? c.name : this.connId ? (isIdeaId(this.connId) ? '(IntelliJ connection)' : '(deleted connection)') : 'Choose connection'),
    );
    if (c?.readOnly) this.connBtn.append(h('span', { class: 'db-badge' }, 'READ-ONLY'));
    const trino = isTrinoConfig(c);
    this.dbBtn.replaceChildren(h('span', { class: 'db-pick-text' }, r.database ?? (trino ? '(no schema)' : '(no database)')));
    this.dbBtn.title = trino ? 'Choose the schema' : 'Choose the database';
    // Trino has no transactions: hide the controls for them.
    const tx = r.supportsTransactions();
    for (const el of [this.txSep, this.acBtn, this.commitBtn, this.rollbackBtn]) el.hidden = !tx;
    const waiting = !!this.connId && this.hub.loginWaiting(this.connId);
    this.runBtn.disabled = busy;
    this.scriptBtn.disabled = busy;
    this.cancelBtn.hidden = !r.running && !waiting;
    this.cancelBtn.title = waiting ? 'Stop waiting for the login' : 'Stop the running statement';
    this.acBtn.setAttribute('aria-checked', String(r.autocommit));
    this.acBtn.classList.toggle('is-on', r.autocommit);
    this.acBtn.disabled = r.running;
    this.commitBtn.disabled = !r.inTransaction || r.running;
    this.rollbackBtn.disabled = !r.inTransaction || r.running;
    this.txBadge.hidden = !tx || !r.inTransaction;
    this.limitEl.textContent = `Limit ${this.hub.ctx.settings.get('db.maxRows').toLocaleString('en-US')} rows`;
    this.stateEl.textContent = waiting
      ? 'Waiting for login in your browser…'
      : r.connecting
        ? 'Connecting...'
        : r.running
          ? 'Running...'
          : r.connected
            ? `${this.engineName()} ${r.info?.serverVersion ?? ''}`
            : 'Not connected';
    // A new dialect can arrive after a restored console finds its IntelliJ connection.
    if (this.dialectName() !== this.dialectNow) this.applyDialect();

    const title = consoleTitle(c?.name ?? 'Console', this.spec.n);
    const desc = r.database ?? '';
    if (title + desc !== this.lastTitle) {
      this.lastTitle = title + desc;
      this.hub.ctx.tabs.setTitle(this.tabId, title, desc || undefined);
    }
    this.hub.ctx.tabs.setDirty(this.tabId, r.inTransaction);
    this.hub.refreshStatus();

    if (r.database !== this.lastDb || (r.connected && !this.schemaLoaded)) {
      this.lastDb = r.database;
      void this.loadSchema();
    }
  }

  private schemaLoaded = false;
  private defaultSchema: string | undefined;

  private dialectName(): 'mysql' | 'trino' {
    return isTrinoConfig(this.config()) ? 'trino' : 'mysql';
  }

  private engineName(): string {
    return this.dialectName() === 'trino' ? 'Trino' : 'MySQL';
  }

  /** The `sql()` extension for the current engine, with the names for completion when we have them. */
  private sqlExtension() {
    const dialect = this.dialectName() === 'trino' ? StandardSQL : MySQL;
    return this.schemaMap ? sql({ dialect, schema: this.schemaMap, defaultSchema: this.defaultSchema, upperCaseKeywords: true }) : sql({ dialect, upperCaseKeywords: true });
  }

  private applyDialect(): void {
    this.dialectNow = this.dialectName();
    this.view.dispatch({ effects: this.sqlComp.reconfigure(this.sqlExtension()) });
  }

  /** Reads table and column names for completion. Needs a connected console. */
  private async loadSchema(): Promise<void> {
    const db = this.runner.database;
    if (!this.connId || !db || !this.runner.connected) return;
    this.schemaLoaded = true;
    const token = ++this.schemaToken;
    try {
      const map = await this.hub.meta(this.connId, this.root).run((sid) => dbCompletionSchema(sid, db));
      if (this.disposed || token !== this.schemaToken) return;
      this.schemaMap = map;
      this.defaultSchema = db;
      this.applyDialect();
    } catch (e) {
      // Completion is optional. A short note in Messages is enough.
      const d = describeError(e);
      if (d.kind !== 'cancelled') this.store.addMessage({ sql: null, where: null, level: 'warn', text: `Could not load names for completion: ${d.text}`, elapsedMs: null });
    }
  }

  // --- Pickers ----------------------------------------------------------------------------------------------

  private pickConnection(): void {
    const items: QuickPickItem[] = this.hub.allConnections().map((c) => ({
      id: c.id,
      label: c.name,
      description: c.id === this.connId ? 'current' : `${c.user}@${c.host}:${c.port}`,
      detail: [c.source ? 'IntelliJ' : '', c.production ? 'Production' : ''].filter(Boolean).join(', ') || undefined,
    }));
    if (items.length === 0) {
      this.hub.ctx.ui.notify('There are no connections yet. Add one in the Database view.', { kind: 'info' });
      return;
    }
    this.hub.ctx.ui.quickPick({
      placeholder: 'Choose a connection for this console',
      items,
      onAccept: (item) => void this.setConnection(item.id),
      onCancel: () => this.view.focus(),
    });
  }

  private async setConnection(id: string): Promise<void> {
    const ctx = this.hub.ctx;
    const next = this.hub.find(id);
    if (!next || id === this.connId) return;
    if (this.runner.running) {
      ctx.ui.notify('A statement is running. Cancel it before you change the connection.', { kind: 'warn' });
      return;
    }
    if (this.runner.inTransaction) {
      const answer = await ctx.ui.confirm({
        title: 'Change the connection?',
        message: 'This console has an open transaction. It will be rolled back.',
        buttons: ['Roll Back and Change', 'Cancel'],
      });
      if (answer !== 'Roll Back and Change') return;
    }
    this.runner.disconnect();
    this.connId = id;
    this.runner.database = next.database ?? null;
    this.runner.autocommit = true;
    this.databaseList = null;
    this.schemaLoaded = false;
    this.schemaToken++;
    this.schemaMap = undefined;
    this.applyDialect();
    this.lastDb = this.runner.database;
    this.sync();
    this.view.focus();
  }

  private pickDatabase(): void {
    const ctx = this.hub.ctx;
    if (!this.connId || !this.config()) {
      ctx.ui.notify('Choose a connection first.', { kind: 'warn' });
      return;
    }
    const connId = this.connId;
    const showSystem = ctx.settings.get('db.showSystemSchemas');
    this.databaseList ??= this.hub.meta(connId, this.root).run((sid) => dbDatabases(sid));
    const list = this.databaseList;
    list.catch((e) => {
      this.databaseList = null;
      ctx.ui.notify(`Could not read the databases: ${describeError(e).text}`, { kind: 'error' });
    });
    ctx.ui.quickPick({
      placeholder: this.dialectName() === 'trino' ? 'Choose a schema (USE)' : 'Choose a database (USE)',
      emptyText: this.dialectName() === 'trino' ? 'No schemas' : 'No databases',
      items: async (query) => {
        const all = await list.catch(() => [] as string[]);
        const shown = new Set(visibleDatabases(all, showSystem));
        if (this.runner.database) shown.add(this.runner.database);
        const q = query.trim().toLowerCase();
        return all
          .filter((n) => shown.has(n) && n.toLowerCase().includes(q))
          .map((n) => ({ id: n, label: n, description: n === this.runner.database ? 'current' : undefined }));
      },
      onAccept: (item) => {
        void this.runner.setDatabase(item.id);
        this.view.focus();
      },
      onCancel: () => this.view.focus(),
    });
  }

  // --- Results area size ----------------------------------------------------------------------------------------------

  private initResizer(bar: HTMLElement, target: HTMLElement): void {
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = target.getBoundingClientRect().height;
      const max = () => Math.max(120, this.root.clientHeight - 140);
      bar.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const hgt = Math.min(max(), Math.max(60, startH - (ev.clientY - startY)));
        target.style.height = `${hgt}px`;
      };
      const stop = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', stop);
        bar.removeEventListener('pointercancel', stop);
        this.hub.ctx.workspace.globalState.set(HEIGHT_KEY, Math.round(target.getBoundingClientRect().height));
        this.pane.refresh();
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', stop);
      bar.addEventListener('pointercancel', stop);
    });
  }
}

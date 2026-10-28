// Runs statements on one session. A SQL console and a SQL file each own one
// runner. The runner connects when the user runs something (never earlier),
// keeps the transaction state and writes results and messages to a store.
//
// Rules (DESIGN 9.3, "Safety"):
// - It asks before writes and before UPDATE or DELETE without WHERE.
// - When the connection is lost it tells the user and offers "Reconnect".
//   It never runs a statement again by itself.

import type { DbConnectionConfig, DbExecResult, DbSessionInfo, DbTxState } from '../../ipc/db';
import { dbCancel, dbCommit, dbExecute, dbRollback, dbSetAutocommit, dbUse } from '../../ipc/db';
import { describeError } from './errors';
import type { DbHub } from './hub';
import { resultMessage, type ResultsStore } from './results-store';
import { needsConfirmation } from './safety';
import { lineOf, oneLine, type Stmt } from './split';

export interface RunnerOptions {
  hub: DbHub;
  store: ResultsStore;
  getConfig(): DbConnectionConfig | null;
  /** An element inside the workbench that can hold a dialog. */
  modalHost(): HTMLElement;
  /** Called after every change of the state (for toolbars and the status bar). */
  onState(): void;
  /** Called when a run ended (the SQL file shows the bottom panel). */
  onRunEnd?(hadError: boolean): void;
}

export class SqlRunner {
  sessionId: string | null = null;
  info: DbSessionInfo | null = null;
  /** The current database, or the one to use at the next connect. */
  database: string | null = null;
  /** The current mode, or the mode to set at the next connect. */
  autocommit = true;
  inTransaction = false;
  running = false;
  connecting = false;
  private closed = false;

  constructor(private readonly o: RunnerOptions) {}

  private get ctx() {
    return this.o.hub.ctx;
  }

  get connected(): boolean {
    return this.sessionId !== null;
  }

  // --- Session ----------------------------------------------------------------------

  async ensureSession(): Promise<boolean> {
    if (this.sessionId) return true;
    if (this.connecting) return false;
    const config = this.o.getConfig();
    if (!config) {
      this.ctx.ui.notify('Choose a connection first.', { kind: 'warn' });
      return false;
    }
    this.connecting = true;
    this.o.onState();
    try {
      const info = await this.o.hub.connect(config, this.o.modalHost());
      if (this.closed) {
        this.o.hub.disconnect(info.sessionId);
        return false;
      }
      this.sessionId = info.sessionId;
      this.info = info;
      this.inTransaction = false;
      const wanted = this.database;
      if (wanted && wanted !== info.database) await dbUse(info.sessionId, wanted);
      else this.database = info.database;
      if (!this.autocommit) await dbSetAutocommit(info.sessionId, false);
      else this.autocommit = info.autocommit;
      return true;
    } catch (e) {
      const d = describeError(e);
      // The session exists but the setup failed: keep it, but tell the user.
      if (this.sessionId && d.kind !== 'cancelled') {
        this.database = this.info?.database ?? null;
        this.fail(null, d.text);
      } else if (d.kind !== 'cancelled') {
        this.fail(null, d.text);
        this.ctx.ui.notify(`Could not connect to ${config.name}: ${d.text}`, { kind: 'error' });
      }
      return this.sessionId !== null;
    } finally {
      this.connecting = false;
      this.o.onState();
    }
  }

  /** Closes the session. The server rolls back an open transaction. */
  disconnect(): void {
    const sid = this.sessionId;
    this.sessionId = null;
    this.info = null;
    this.inTransaction = false;
    if (sid) this.o.hub.disconnect(sid);
    this.o.onState();
  }

  async reconnect(): Promise<void> {
    this.disconnect();
    if (await this.ensureSession()) {
      this.o.store.addMessage({ sql: null, where: null, level: 'info', text: 'Reconnected. No statement was run again.', elapsedMs: null });
    }
  }

  dispose(): void {
    this.closed = true;
    this.disconnect();
  }

  // --- State ------------------------------------------------------------------------------

  private applyTx(t: DbTxState) {
    this.autocommit = t.autocommit;
    this.inTransaction = t.inTransaction;
  }

  private applyExec(r: DbExecResult) {
    this.applyTx(r);
    this.database = r.database;
  }

  async setDatabase(db: string): Promise<void> {
    if (this.running) {
      this.ctx.ui.notify('A statement is running. Wait for it or cancel it first.', { kind: 'warn' });
      return;
    }
    if (!this.sessionId) {
      this.database = db;
      this.o.onState();
      return;
    }
    try {
      await dbUse(this.sessionId, db);
      this.database = db;
    } catch (e) {
      this.handleSideError(e, `Could not switch to database ${db}`);
    }
    this.o.onState();
  }

  async setAutocommit(on: boolean): Promise<void> {
    if (this.running) {
      this.ctx.ui.notify('A statement is running. Wait for it or cancel it first.', { kind: 'warn' });
      return;
    }
    if (!this.sessionId) {
      this.autocommit = on;
      this.o.onState();
      return;
    }
    try {
      this.applyTx(await dbSetAutocommit(this.sessionId, on));
    } catch (e) {
      this.handleSideError(e, 'Could not change auto-commit');
    }
    this.o.onState();
  }

  async commit(): Promise<boolean> {
    return this.endTransaction('Commit', dbCommit);
  }

  async rollback(): Promise<boolean> {
    return this.endTransaction('Rollback', dbRollback);
  }

  private async endTransaction(label: string, call: (sid: string) => Promise<DbTxState>): Promise<boolean> {
    if (!this.sessionId) return false;
    if (this.running) {
      this.ctx.ui.notify('A statement is running. Wait for it or cancel it first.', { kind: 'warn' });
      return false;
    }
    const started = Date.now();
    try {
      this.applyTx(await call(this.sessionId));
      this.o.store.addMessage({ sql: label.toUpperCase(), where: null, level: 'ok', text: `${label} done`, elapsedMs: Date.now() - started });
      this.o.onState();
      return true;
    } catch (e) {
      this.handleSideError(e, `${label} failed`);
      this.o.onState();
      return false;
    }
  }

  cancel(): void {
    if (this.running && this.sessionId) void dbCancel(this.sessionId).catch(() => undefined);
  }

  // --- Running ----------------------------------------------------------------------------

  /**
   * Runs the statements one after the other and stops at the first error.
   * `src` is the full text the offsets of the statements point into.
   */
  async run(stmts: Stmt[], src: string): Promise<void> {
    if (this.running || this.connecting) {
      this.ctx.ui.notify('A statement is already running. Wait for it or cancel it first.', { kind: 'warn' });
      return;
    }
    if (stmts.length === 0) {
      this.ctx.ui.notify('There is no statement to run.', { kind: 'info', timeoutMs: 2500 });
      return;
    }
    const config = this.o.getConfig();
    if (!config) {
      this.ctx.ui.notify('Choose a connection first.', { kind: 'warn' });
      return;
    }
    const ask = needsConfirmation({
      statements: stmts,
      production: config.production,
      readOnly: config.readOnly,
      confirmWrites: this.ctx.settings.get('db.confirmWrites'),
    });
    if (ask) {
      const answer = await this.ctx.ui.confirm({ title: ask.title, message: ask.message, buttons: ['Run', 'Cancel'] });
      if (answer !== 'Run') return;
    }
    if (!(await this.ensureSession())) return;

    const store = this.o.store;
    const maxRows = this.ctx.settings.get('db.maxRows');
    this.running = true;
    store.beginRun(config.name);
    this.o.onState();
    let hadError = false;
    for (let i = 0; i < stmts.length; i++) {
      const sid = this.sessionId;
      if (this.closed || !sid) break;
      const s = stmts[i];
      const where = `line ${lineOf(src, s.from)}`;
      try {
        const r = await dbExecute(sid, s.text, maxRows);
        this.applyExec(r);
        this.report(s, where, r);
      } catch (e) {
        hadError = true;
        this.reportError(e, s, where);
        if (stmts.length > 1) {
          store.addMessage({ sql: null, where: null, level: 'warn', text: `Script stopped at statement ${i + 1} of ${stmts.length}.`, elapsedMs: null });
        }
        break;
      }
      this.o.onState();
    }
    this.running = false;
    store.finishRun(hadError);
    this.o.onState();
    this.o.onRunEnd?.(hadError);
  }

  private report(s: Stmt, where: string, r: DbExecResult) {
    const store = this.o.store;
    const sql = oneLine(s.text, 120);
    if (r.results.length === 0) {
      store.addMessage({ sql, where, level: 'ok', text: 'OK', elapsedMs: r.elapsedMs });
      return;
    }
    for (const res of r.results) {
      const m = resultMessage(res);
      store.addMessage({ sql, where, level: m.level, text: m.text, elapsedMs: res.elapsedMs || r.elapsedMs });
      if (res.kind === 'rows' && !store.addResult(s.text, res)) {
        store.addMessage({ sql: null, where: null, level: 'warn', text: 'Too many result tables. The next ones are not shown.', elapsedMs: null });
      }
    }
  }

  private reportError(e: unknown, s: Stmt, where: string) {
    const d = describeError(e);
    const store = this.o.store;
    const sql = oneLine(s.text, 120);
    if (d.kind === 'cancelled') {
      store.addMessage({ sql, where, level: 'warn', text: 'Cancelled.', elapsedMs: null });
      return;
    }
    store.addMessage({ sql, where, level: 'error', text: d.text, elapsedMs: null });
    if (d.kind === 'lost') this.connectionLost();
    else if (d.kind === 'busy') {
      this.ctx.ui.notify('The connection is busy with another statement. Wait for it or cancel it.', { kind: 'warn' });
    }
  }

  /** The server closed the connection. Nothing runs again until the user decides. */
  private connectionLost() {
    const hadTx = this.inTransaction;
    this.sessionId = null;
    this.info = null;
    this.inTransaction = false;
    if (hadTx) {
      this.o.store.addMessage({ sql: null, where: null, level: 'error', text: 'The open transaction was rolled back by the server.', elapsedMs: null });
    }
    this.ctx.ui.notify('The connection to the database was lost. The statement was not run again.', {
      kind: 'error',
      actions: [{ label: 'Reconnect', run: () => void this.reconnect() }],
    });
  }

  private fail(sql: string | null, text: string) {
    this.o.store.addMessage({ sql, where: null, level: 'error', text, elapsedMs: null });
    this.o.onRunEnd?.(true);
  }

  /** Errors of commit, rollback, USE and auto-commit changes. */
  private handleSideError(e: unknown, what: string) {
    const d = describeError(e);
    this.o.store.addMessage({ sql: null, where: null, level: 'error', text: `${what}: ${d.text}`, elapsedMs: null });
    if (d.kind === 'lost') this.connectionLost();
    else if (d.kind === 'busy') this.ctx.ui.notify('The connection is busy. Wait for the running statement or cancel it.', { kind: 'warn' });
    else this.ctx.ui.notify(`${what}: ${d.text}`, { kind: 'error' });
  }
}

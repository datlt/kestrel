// State of the database feature for ONE workbench (workspace tab). It lives in
// the closure of `initDb`, never at module level (DESIGN 8.1, rule 1).
//
// The hub owns:
// - passwords that the user typed in this workbench (memory only),
// - one "meta" session per connection (used by the tree, the pickers,
//   completion and DDL; it is separate from console sessions, see `db_busy`),
// - the list of consoles and SQL file runners, so commands find the active one.

import type { AppContext, FileEditor } from '../../core/types';
import {
  dbConnect,
  dbDisconnect,
  dbPasswordExists,
  type DbConnectionConfig,
  type DbSessionInfo,
} from '../../ipc/db';
import { IpcError } from '../../ipc/invoke';
import { describeError, isAuthError } from './errors';
import { IdeaSources } from './idea';
import { isIdeaId } from './idea-model';
import { ResultsStore } from './results-store';

/** What a console or a SQL file offers to the commands. */
export interface RunTarget {
  readonly kind: 'console' | 'file';
  run(): Promise<void>;
  runScript(): Promise<void>;
  cancel(): void;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  toggleAutocommit(): Promise<void>;
  /** Reload the database list and the completion schema. */
  refresh(): Promise<void>;
  isRunning(): boolean;
  inTransaction(): boolean;
  /** Text for the status bar. */
  status(): { text: string; tooltip: string };
  dispose?(): void;
}

/** What the Database view offers to the commands. */
export interface TreeApi {
  refresh(): void;
  collapseAll(): void;
  /** The selected node, or null. */
  selected(): { connId: string; database?: string; name?: string; objectKind?: string } | null;
}

/** Talks to the server through one session that is shared by all schema calls. */
export class MetaSession {
  private sid: string | null = null;
  private opening: Promise<string> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly hub: DbHub,
    readonly connId: string,
    public host: HTMLElement,
  ) {}

  private async ensure(): Promise<string> {
    if (this.sid) return this.sid;
    if (!this.opening) {
      // An IntelliJ connection exists only after its list was read.
      if (isIdeaId(this.connId)) await this.hub.idea.ready();
      if (this.opening) return this.opening;
      const config = this.hub.find(this.connId);
      if (!config) throw new IpcError('not_found', 'This connection does not exist any more.', 'db_connect');
      this.opening = this.hub
        .connect(config, this.host)
        .then((info) => {
          if (this.closed) {
            this.hub.disconnect(info.sessionId);
            throw new IpcError('cancelled', 'The connection was closed.', 'db_connect');
          }
          this.sid = info.sessionId;
          return info.sessionId;
        })
        .finally(() => {
          this.opening = null;
        });
    }
    return this.opening;
  }

  /** Runs one schema call. Calls run one after the other, so the server never answers `db_busy`. */
  run<T>(fn: (sessionId: string) => Promise<T>): Promise<T> {
    const job = this.queue.then(
      () => this.attempt(fn),
      () => this.attempt(fn),
    );
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async attempt<T>(fn: (sessionId: string) => Promise<T>): Promise<T> {
    let lostOnce = false;
    for (let busy = 0; ; ) {
      const sid = await this.ensure();
      try {
        return await fn(sid);
      } catch (e) {
        const kind = describeError(e).kind;
        if (kind === 'lost' && !lostOnce) {
          // Reading the schema again is safe, so we reconnect once.
          lostOnce = true;
          this.sid = null;
          continue;
        }
        if (kind === 'busy' && busy < 3) {
          busy++;
          await new Promise((r) => setTimeout(r, 250 * busy));
          continue;
        }
        throw e;
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.sid) this.hub.disconnect(this.sid);
    this.sid = null;
  }
}

export class DbHub {
  /** Passwords typed in this workbench. Never saved. */
  private readonly passwords = new Map<string, string>();
  private readonly asking = new Map<string, Promise<string | null>>();
  private readonly metas = new Map<string, MetaSession>();
  private readonly sessions = new Set<string>();
  readonly consoles = new Map<string, RunTarget>();
  readonly fileTargets = new Map<FileEditor, RunTarget>();
  /** Results of SQL files, shown in the bottom panel. */
  readonly panelStore = new ResultsStore();
  tree: TreeApi | null = null;
  private disposed = false;
  /** Connections that must not ask for a password (automatic connect of IntelliJ sources). */
  private readonly quiet = new Set<string>();
  /** The data sources of the IntelliJ project in the open folder. */
  readonly idea: IdeaSources;

  constructor(readonly ctx: AppContext) {
    this.idea = new IdeaSources(ctx);
  }

  // --- Connections -----------------------------------------------------------------

  /** The connections saved in the settings. Only these can be edited and saved. */
  connections(): DbConnectionConfig[] {
    return this.ctx.settings.get('db.connections') ?? [];
  }

  /** IntelliJ connections (supported ones, in file order) and then the saved connections. For pickers. */
  allConnections(): DbConnectionConfig[] {
    return [...this.idea.configs(), ...this.connections()];
  }

  /** A saved connection or an IntelliJ connection (`idea:<uuid>`) by id. */
  find(id: string): DbConnectionConfig | undefined {
    if (isIdeaId(id)) return this.idea.find(id);
    return this.connections().find((c) => c.id === id);
  }

  /** Marks a connection as "do not ask for a password". Call `allowAsking` when the attempt ends. */
  denyAsking(id: string): void {
    this.quiet.add(id);
  }

  allowAsking(id: string): void {
    this.quiet.delete(id);
  }

  setPassword(id: string, password: string | null): void {
    if (password) this.passwords.set(id, password);
    else this.passwords.delete(id);
  }

  getPassword(id: string): string | null {
    return this.passwords.get(id) ?? null;
  }

  /**
   * Opens a session. When the server refuses the login and no password is
   * saved in the keychain, it asks for the password (a small dialog inside
   * `host`) and tries again.
   */
  async connect(config: DbConnectionConfig, host: HTMLElement): Promise<DbSessionInfo> {
    let password = this.passwords.get(config.id) ?? null;
    for (;;) {
      try {
        const info = await dbConnect({ config, password });
        if (this.disposed) {
          void dbDisconnect(info.sessionId).catch(() => undefined);
          throw new IpcError('cancelled', 'The workspace tab was closed.', 'db_connect');
        }
        this.sessions.add(info.sessionId);
        if (password !== null) this.passwords.set(config.id, password);
        return info;
      } catch (e) {
        if (!isAuthError(e) || this.quiet.has(config.id)) throw e;
        // A wrong password in the keychain must be fixed in the connection form.
        if (password === null && (await dbPasswordExists(config.id).catch(() => false))) throw e;
        this.passwords.delete(config.id);
        const typed = await this.askPassword(config, host, describeError(e).text);
        if (typed === null) throw new IpcError('cancelled', 'Password entry was cancelled.', 'db_connect');
        password = typed;
      }
    }
  }

  private askPassword(config: DbConnectionConfig, host: HTMLElement, error: string): Promise<string | null> {
    // Two sessions of one connection (console and tree) ask only once.
    const pending = this.asking.get(config.id);
    if (pending) return pending;
    const p = import('./modal')
      .then((m) =>
        m.askPassword(host, {
          title: `Password for ${config.name}`,
          detail: `${config.user}@${config.host}:${config.port}`,
          error,
        }),
      )
      .finally(() => this.asking.delete(config.id));
    this.asking.set(config.id, p);
    return p;
  }

  disconnect(sessionId: string): void {
    this.sessions.delete(sessionId);
    void dbDisconnect(sessionId).catch(() => undefined);
  }

  meta(connId: string, host: HTMLElement): MetaSession {
    let m = this.metas.get(connId);
    if (!m) {
      m = new MetaSession(this, connId, host);
      this.metas.set(connId, m);
    }
    m.host = host;
    return m;
  }

  /** Drops the meta session (the connection changed or was deleted). */
  closeMeta(connId: string): void {
    this.metas.get(connId)?.close();
    this.metas.delete(connId);
  }

  // --- Active target and status bar ----------------------------------------------------

  activeTarget(): RunTarget | null {
    const tab = this.ctx.tabs.active();
    if (tab?.input.kind === 'sql-console') return this.consoles.get(tab.id) ?? null;
    const ed = this.ctx.editors.active();
    return ed ? (this.fileTargets.get(ed) ?? null) : null;
  }

  /** True when the active tab is a SQL console or a SQL file. */
  sqlActive(): boolean {
    const tab = this.ctx.tabs.active();
    if (tab?.input.kind === 'sql-console') return true;
    return this.ctx.editors.active()?.languageId === 'sql';
  }

  refreshStatus(): void {
    const tab = this.ctx.tabs.active();
    const console = tab?.input.kind === 'sql-console' ? this.consoles.get(tab.id) : null;
    if (console) {
      const s = console.status();
      this.ctx.status.set({ id: 'db.status', align: 'left', priority: 60, text: s.text, tooltip: s.tooltip, command: 'db.showView' });
    } else {
      this.ctx.status.remove('db.status');
    }
  }

  /** The status bar item of the active `.sql` file: the connection that Mod-Enter uses. */
  refreshFileStatus(): void {
    const ed = this.ctx.editors.active();
    if (!ed || ed.languageId !== 'sql') {
      this.ctx.status.remove('db.connection');
      return;
    }
    const id = this.fileConnection(ed.path);
    const conn = id ? this.find(id) : undefined;
    const target = this.fileTargets.get(ed);
    const text = conn ? `DB: ${conn.name}${target?.inTransaction() ? ' [TX]' : ''}` : 'DB: no connection';
    this.ctx.status.set({
      id: 'db.connection',
      align: 'right',
      priority: 50,
      text,
      tooltip: conn ? `Mod-Enter runs the statement at the cursor on ${conn.name}. Click to change.` : 'Click to choose the connection for this SQL file.',
      command: 'db.pickConnection',
    });
  }

  // --- Files with SQL: the chosen connection is remembered per file ---------------------

  fileConnection(path: string): string | null {
    const map = this.ctx.workspace.state.get<Record<string, string>>('db.fileConnections') ?? {};
    return map[path] ?? null;
  }

  setFileConnection(path: string, connId: string): void {
    const map = { ...(this.ctx.workspace.state.get<Record<string, string>>('db.fileConnections') ?? {}) };
    map[path] = connId;
    this.ctx.workspace.state.set('db.fileConnections', map);
  }

  // --- End of life ----------------------------------------------------------------------

  /**
   * Disconnects every session of this workbench. It asks nothing: the server
   * rolls back open transactions when the connection closes.
   */
  disposeAll(): void {
    this.disposed = true;
    for (const m of this.metas.values()) m.close();
    this.metas.clear();
    for (const sid of [...this.sessions]) this.disconnect(sid);
    this.passwords.clear();
    this.ctx.status.remove('db.status');
    this.ctx.status.remove('db.connection');
  }

  /** The workspace changes but the workbench stays: allow new sessions again afterwards. */
  reopen(): void {
    this.disposed = false;
  }
}

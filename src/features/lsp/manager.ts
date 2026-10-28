// Owns the sessions (one language server per server id and project root).
// This file does not import the library at run time. `runtime.ts` is loaded later with `import()`.
import type { Extension } from '@codemirror/state';
import type { AppContext, Disposable, FileEditor, LspServerConfig } from '../../core/types';
import { dirname, isInside } from '../../core/util';
import { isIpcError } from '../../ipc/invoke';
import { lspFindRoot, lspStart, lspStop, type LspEvent } from '../../ipc/lsp';
import { DiagnosticsStore } from './problems';
import { Session } from './session';
import { lspLanguageId, pathToUri } from './uri';

type Runtime = typeof import('./runtime');

export interface ServerMatch {
  id: string;
  config: LspServerConfig;
}

/** Install hints, by program name. */
const INSTALL_HINTS: Record<string, string> = {
  'kotlin-lsp': 'Install the JetBrains Kotlin language server: brew install JetBrains/utils/kotlin-lsp',
  jdtls: 'Install the Eclipse Java language server: brew install jdtls',
  'typescript-language-server': 'Install it with: npm i -g typescript typescript-language-server',
  'sourcekit-lsp': 'Install Xcode, or the Swift toolchain from swift.org. Both include sourcekit-lsp.',
};

function programName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat)$/i, '');
}

export class LspManager {
  readonly diagnostics = new DiagnosticsStore();
  /** Session of each open file path (set when the file got the LSP extension). */
  private byPath = new Map<string, Session>();
  private sessions = new Map<string, Session>();
  private creating = new Map<string, Promise<Session>>();
  private runtime: Runtime | null = null;
  private runtimePromise: Promise<Runtime> | null = null;
  private missingNotified = new Set<string>();
  private changeListeners = new Set<() => void>();
  private logListeners = new Set<(s: Session) => void>();
  /** Grows each time `stopAll` runs. A session that was being created before that must not start. */
  private epoch = 0;

  constructor(private readonly ctx: AppContext) {}

  // --- lookups ---------------------------------------------------------------

  /** The first enabled server that handles this language. */
  match(languageId: string): ServerMatch | null {
    if (!this.ctx.settings.get('lsp.enabled')) return null;
    const servers = this.ctx.settings.get('lsp.servers') ?? {};
    for (const [id, config] of Object.entries(servers)) {
      if (config && config.enabled !== false && config.command?.length && config.languages?.includes(languageId)) {
        return { id, config };
      }
    }
    return null;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  sessionOfPath(path: string): Session | undefined {
    return this.byPath.get(path);
  }

  /** The session of the active file, or the first session that is ready. */
  currentSession(): Session | null {
    const active = this.ctx.editors.active();
    const own = active && this.byPath.get(active.path);
    if (own) return own;
    return this.list().find((s) => s.state === 'ready') ?? null;
  }

  get loaded(): Runtime | null {
    return this.runtime;
  }

  // --- events ----------------------------------------------------------------

  onChange(fn: () => void): Disposable {
    this.changeListeners.add(fn);
    return { dispose: () => this.changeListeners.delete(fn) };
  }

  onLog(fn: (s: Session) => void): Disposable {
    this.logListeners.add(fn);
    return { dispose: () => this.logListeners.delete(fn) };
  }

  private changed(): void {
    for (const fn of [...this.changeListeners]) fn();
  }

  log(session: Session, lines: string[]): void {
    session.addLogs(lines);
    for (const fn of [...this.logListeners]) fn(session);
  }

  // --- editor extension ------------------------------------------------------

  /**
   * Extension for a file editor, or null when no server fits.
   * It returns without waiting for the server to start. The editor works at once,
   * and LSP features begin to work when the server is ready.
   */
  async extensionFor(editor: FileEditor): Promise<Extension | null> {
    if (editor.path.startsWith('untitled:')) return null;
    const match = this.match(editor.languageId);
    if (!match) return null;
    const epoch = this.epoch;
    const session = await this.sessionFor(editor.path, match).catch((e) => {
      if (epoch !== this.epoch) return null; // The folder changed while we waited.
      throw e;
    });
    if (!session || !this.runtime || epoch !== this.epoch) return null;
    this.byPath.set(editor.path, session);
    this.changed();
    return this.runtime.editorExtension(session, pathToUri(editor.path), lspLanguageId(editor.languageId), this.ctx);
  }

  fileClosed(path: string): void {
    if (this.byPath.delete(path)) this.changed();
  }

  private async findRoot(path: string, match: ServerMatch): Promise<string | null> {
    const workspaceRoot = this.ctx.workspace.root;
    const markers = match.config.rootMarkers ?? [];
    if (workspaceRoot && isInside(path, workspaceRoot)) {
      if (markers.length === 0) return workspaceRoot;
      return (await lspFindRoot(path, markers, workspaceRoot).catch(() => null)) ?? workspaceRoot;
    }
    if (workspaceRoot) {
      // A file outside the folder (for example a library source). Use a server that runs already.
      return this.list().find((s) => s.serverId === match.id && s.state !== 'stopped')?.root ?? null;
    }
    // No folder is open. The folder of the file is the limit.
    const dir = dirname(path);
    if (!dir) return null;
    return (await lspFindRoot(path, markers, dir).catch(() => null)) ?? dir;
  }

  private async sessionFor(path: string, match: ServerMatch): Promise<Session | null> {
    const epoch = this.epoch;
    const root = await this.findRoot(path, match);
    if (!root || epoch !== this.epoch) return null;
    const id = `${match.id}\n${root}`;
    const existing = this.sessions.get(id);
    if (existing) return existing;
    let pending = this.creating.get(id);
    if (!pending) {
      pending = this.create(id, match, root).finally(() => this.creating.delete(id));
      this.creating.set(id, pending);
    }
    return pending;
  }

  private loadRuntime(): Promise<Runtime> {
    this.runtimePromise ??= import('./runtime').then((rt) => (this.runtime = rt));
    return this.runtimePromise;
  }

  private async create(id: string, match: ServerMatch, root: string): Promise<Session> {
    const epoch = this.epoch;
    const rt = await this.loadRuntime();
    // The folder changed or LSP was turned off while the library loaded. Do not start a server for the old folder.
    if (epoch !== this.epoch) throw new Error('The language server was stopped before it started.');
    const session = new Session(id, match.id, root, match.config, (s, e) => this.onSendError(s, e));
    session.client = rt.createClient(session, this.ctx, this);
    this.sessions.set(id, session);
    this.changed();
    void this.boot(session);
    return session;
  }

  // --- process life ----------------------------------------------------------

  private setState(s: Session, state: Session['state'], message = ''): void {
    s.state = state;
    s.message = message;
    this.changed();
  }

  private async boot(s: Session): Promise<void> {
    const gen = ++s.generation;
    const config = this.ctx.settings.get('lsp.servers')?.[s.serverId] ?? s.config;
    s.config = config;
    s.missing = false;
    this.setState(s, 'starting');
    this.log(s, [`Starting ${config.command.join(' ')} in ${s.root}`]);
    try {
      const { key } = await lspStart({
        serverId: s.serverId,
        root: s.root,
        command: config.command,
        env: config.env,
        onMessage: (m) => {
          if (gen === s.generation) s.transport.deliver(m);
        },
        onEvent: (e) => this.onEvent(s, gen, e),
      });
      if (gen !== s.generation) {
        void lspStop(key).catch(() => {});
        return;
      }
      s.key = key;
      s.transport.attach(key);
      const initializing = s.client.connect(s.transport).initializing;
      initializing.then(
        () => {
          if (gen === s.generation) this.setState(s, 'ready');
        },
        (e) => {
          if (gen === s.generation) this.fail(s, `The server did not start: ${errorMessage(e)}`);
        },
      );
    } catch (e) {
      if (gen !== s.generation) return;
      if (isIpcError(e, 'server_missing')) {
        s.missing = true;
        this.setState(s, 'error', `\`${s.program}\` is not installed.`);
        this.notifyMissing(s);
      } else {
        this.fail(s, `Cannot start ${s.program}: ${errorMessage(e)}`);
      }
    }
  }

  private fail(s: Session, message: string): void {
    this.log(s, [message]);
    this.setState(s, 'error', message);
    this.ctx.ui.notify(`${s.serverId}: ${message}`, {
      kind: 'error',
      actions: [
        { label: 'Restart', run: () => void this.restart(s) },
        { label: 'Show output', run: () => this.ctx.views.show('lsp-output') },
      ],
    });
  }

  private onEvent(s: Session, gen: number, e: LspEvent): void {
    if (e.kind === 'stderr') {
      this.log(s, e.lines);
      return;
    }
    if (gen !== s.generation) return;
    s.key = null;
    s.transport.detach();
    this.diagnostics.clearSession(s.id);
    if (e.stopped) {
      this.setState(s, 'stopped');
      return;
    }
    const how = e.signal != null ? `signal ${e.signal}` : `code ${e.code ?? '?'}`;
    this.fail(s, `The language server stopped (${how}).`);
  }

  private onSendError(s: Session, e: unknown): void {
    this.log(s, [`Cannot send to the server: ${errorMessage(e)}`]);
  }

  private notifyMissing(s: Session): void {
    const name = programName(s.program);
    if (this.missingNotified.has(name)) return;
    this.missingNotified.add(name);
    const hint = INSTALL_HINTS[name] ?? `Install \`${name}\` and make sure it is in your PATH.`;
    this.ctx.ui.notify(`Language server \`${name}\` was not found. ${hint}`, { kind: 'warn', timeoutMs: 0 });
  }

  /** Stops the process and starts it again. Open editors keep their extension. */
  async restart(s: Session): Promise<void> {
    if (!this.sessions.has(s.id)) return;
    const key = s.key;
    s.generation++;
    s.key = null;
    s.transport.detach();
    if (key) await lspStop(key).catch(() => {});
    if (s.client.connected) s.client.disconnect();
    this.diagnostics.clearSession(s.id);
    this.runtime?.clearEditorDiagnostics(s);
    this.log(s, ['--- restart ---']);
    await this.boot(s);
  }

  async restartAll(): Promise<void> {
    await Promise.all(this.list().map((s) => this.restart(s)));
  }

  /** Drops all listeners. Call after `stopAll` when the workbench is removed. */
  dispose(): void {
    this.changeListeners.clear();
    this.logListeners.clear();
    this.missingNotified.clear();
  }

  /** Stops every server. The folder changes, or the user turned LSP off. */
  async stopAll(): Promise<void> {
    const sessions = this.list();
    this.epoch++;
    this.sessions.clear();
    this.byPath.clear();
    this.diagnostics.clearAll();
    await Promise.all(
      sessions.map(async (s) => {
        const key = s.key;
        s.generation++;
        s.key = null;
        s.transport.detach();
        s.state = 'stopped';
        if (s.client?.connected) s.client.disconnect();
        if (key) await lspStop(key).catch(() => {});
      }),
    );
    this.changed();
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e);
}

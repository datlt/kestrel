// The IntelliJ data sources of the open folder, for ONE workbench.
// The list comes from Rust (`db_idea_list`). It has no passwords.
// One `IdeaSources` lives in the `DbHub`, never at module level.

import type { AppContext, Disposable } from '../../core/types';
import { dbIdeaList, type DbConnectionConfig, type DbIdeaDataSource } from '../../ipc/db';
import { describeError } from './errors';
import { isIdeaId } from './idea-model';

export class IdeaSources {
  private list: DbIdeaDataSource[] = [];
  private file: string | null = null;
  private errorText: string | null = null;
  /** The root the current list belongs to. */
  private loadedRoot: string | null = null;
  private pending: Promise<void> | null = null;
  private token = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ctx: AppContext) {}

  /** The setting is on and a folder is open. */
  enabled(): boolean {
    return this.ctx.settings.get('db.idea.enabled') !== false && this.ctx.workspace.root !== null;
  }

  autoConnect(): boolean {
    return this.enabled() && this.ctx.settings.get('db.idea.autoConnect') === true;
  }

  /** The folder has a dataSources.xml (or reading it failed, then the view shows the error). */
  present(): boolean {
    return this.enabled() && this.loadedRoot === this.ctx.workspace.root && (this.file !== null || this.errorText !== null);
  }

  error(): string | null {
    return this.errorText;
  }

  sources(): readonly DbIdeaDataSource[] {
    return this.present() ? this.list : [];
  }

  /** Connections that Kestrel can use, in file order. */
  configs(): DbConnectionConfig[] {
    return this.sources()
      .filter((s) => s.supported)
      .map((s) => s.config);
  }

  find(id: string): DbConnectionConfig | undefined {
    if (!isIdeaId(id)) return undefined;
    return this.sources().find((s) => s.config.id === id)?.config;
  }

  onChange(cb: () => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => void this.listeners.delete(cb) };
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }

  /** Forget the list (the folder changes or the setting is off). */
  reset(): void {
    this.token++;
    this.list = [];
    this.file = null;
    this.errorText = null;
    this.loadedRoot = null;
    this.pending = null;
    this.emit();
  }

  /** Reads the files again. It never rejects: an error goes to `error()`. */
  load(): Promise<void> {
    const root = this.ctx.workspace.root;
    if (!this.enabled() || !root) {
      this.reset();
      return Promise.resolve();
    }
    const token = ++this.token;
    const p = dbIdeaList(root).then(
      (res) => {
        if (token !== this.token) return;
        this.list = res.sources;
        this.file = res.file;
        this.errorText = null;
        this.loadedRoot = root;
        this.emit();
      },
      (e) => {
        if (token !== this.token) return;
        this.list = [];
        this.file = null;
        this.errorText = describeError(e).text;
        this.loadedRoot = root;
        this.emit();
      },
    );
    this.pending = p;
    return p;
  }

  /** Waits for the first load. A console that comes back after a restart needs its connection by id. */
  ready(): Promise<void> {
    if (!this.enabled()) return Promise.resolve();
    return this.pending ?? this.load();
  }
}

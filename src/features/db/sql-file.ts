// Runs SQL from a `.sql` file (or any editor with the language `sql`).
// One runner per editor. Results go to the bottom panel view `db-results`.
// Loaded with `import()` the first time the user runs something.

import type { FileEditor, QuickPickItem } from '../../core/types';
import type { DbHub, RunTarget } from './hub';
import { SqlRunner } from './runner';
import { splitStatements, statementAt, type Stmt } from './split';

export class SqlFileTarget implements RunTarget {
  readonly kind = 'file' as const;
  private readonly runner: SqlRunner;

  constructor(
    private readonly hub: DbHub,
    private readonly editor: FileEditor,
  ) {
    this.runner = new SqlRunner({
      hub,
      store: hub.panelStore,
      getConfig: () => {
        const id = hub.fileConnection(editor.path);
        return (id ? hub.find(id) : undefined) ?? null;
      },
      modalHost: () => editor.view.dom,
      onState: () => hub.refreshFileStatus(),
      // Show the results (or the error) in the bottom panel.
      onRunEnd: () => hub.ctx.views.show('db-results'),
    });
  }

  isRunning(): boolean {
    return this.runner.running;
  }

  inTransaction(): boolean {
    return this.runner.inTransaction;
  }

  status(): { text: string; tooltip: string } {
    const id = this.hub.fileConnection(this.editor.path);
    const name = (id ? this.hub.find(id)?.name : null) ?? 'No connection';
    return { text: `DB: ${name}${this.runner.inTransaction ? ' [TX]' : ''}`, tooltip: name };
  }

  /** Makes sure a connection is chosen. Asks with a quick pick when there is none. */
  private async ensureConnection(): Promise<boolean> {
    const id = this.hub.fileConnection(this.editor.path);
    // An IntelliJ connection exists only after its list was read.
    if (id) await this.hub.idea.ready();
    if (id && this.hub.find(id)) return true;
    return this.pickConnection();
  }

  /** Quick pick of connections. Resolves true when the user chose one. */
  pickConnection(): Promise<boolean> {
    const ctx = this.hub.ctx;
    const current = this.hub.fileConnection(this.editor.path);
    const items: QuickPickItem[] = this.hub.allConnections().map((c) => ({
      id: c.id,
      label: c.name,
      description: c.id === current ? 'current' : `${c.user}@${c.host}:${c.port}`,
      detail: [c.source ? 'IntelliJ' : '', c.production ? 'Production' : ''].filter(Boolean).join(', ') || undefined,
    }));
    if (items.length === 0) {
      ctx.ui.notify('There are no connections yet. Add one first.', {
        kind: 'info',
        actions: [{ label: 'Add Connection', run: () => void ctx.commands.execute('db.addConnection') }],
      });
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let accepted = false;
      ctx.ui.quickPick({
        placeholder: 'Choose the connection for this SQL file',
        items,
        onAccept: (item) => {
          accepted = true;
          void this.setConnection(item.id).then(() => resolve(true));
        },
        onCancel: () => {
          if (!accepted) resolve(false);
          this.editor.focus();
        },
      });
    });
  }

  private async setConnection(id: string): Promise<void> {
    const ctx = this.hub.ctx;
    const old = this.hub.fileConnection(this.editor.path);
    if (old === id) return;
    if (this.runner.running) {
      ctx.ui.notify('A statement is running. Cancel it before you change the connection.', { kind: 'warn' });
      return;
    }
    if (this.runner.inTransaction) {
      const answer = await ctx.ui.confirm({
        title: 'Change the connection?',
        message: 'This file has an open transaction. It will be rolled back.',
        buttons: ['Roll Back and Change', 'Cancel'],
      });
      if (answer !== 'Roll Back and Change') return;
    }
    this.runner.disconnect();
    this.runner.database = this.hub.find(id)?.database ?? null;
    this.runner.autocommit = true;
    this.hub.setFileConnection(this.editor.path, id);
    this.hub.refreshFileStatus();
  }

  private statements(): Stmt[] {
    const state = this.editor.view.state;
    const sel = state.selection.main;
    if (!sel.empty) {
      const base = sel.from;
      return splitStatements(state.doc.sliceString(sel.from, sel.to)).map((s) => ({ text: s.text, from: s.from + base, to: s.to + base, end: s.end + base }));
    }
    const s = statementAt(state.doc.toString(), sel.head);
    return s ? [s] : [];
  }

  async run(): Promise<void> {
    if (!(await this.ensureConnection())) return;
    await this.runner.run(this.statements(), this.editor.view.state.doc.toString());
  }

  async runScript(): Promise<void> {
    if (!(await this.ensureConnection())) return;
    const text = this.editor.view.state.doc.toString();
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
    // Nothing is cached for a SQL file.
  }

  dispose(): void {
    this.runner.dispose();
  }
}

/** The runner of an editor. Created on first use. */
export function targetFor(hub: DbHub, editor: FileEditor): SqlFileTarget {
  let t = hub.fileTargets.get(editor) as SqlFileTarget | undefined;
  if (!t) {
    t = new SqlFileTarget(hub, editor);
    hub.fileTargets.set(editor, t);
  }
  return t;
}

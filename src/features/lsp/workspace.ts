// The workspace of one LSP client: which files are open, and how other files get opened.
// This file imports the library at run time, so only the lazy `runtime.ts` loads it.
import { LSPPlugin, Workspace, type LSPClient, type WorkspaceFile } from '@codemirror/lsp-client';
import type { ChangeSet, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { AppContext } from '../../core/types';
import { normalizeUri, uriToPath } from './uri';

interface OpenFile extends WorkspaceFile {
  view: EditorView;
  /** URI in the normal form, for lookups. */
  key: string;
}

export class KestrelWorkspace extends Workspace {
  files: OpenFile[] = [];
  private versions = new Map<string, number>();
  private waiters = new Map<string, ((file: WorkspaceFile | null) => void)[]>();

  constructor(
    client: LSPClient,
    private readonly ctx: AppContext,
  ) {
    super(client);
  }

  override getFile(uri: string): OpenFile | null {
    const key = normalizeUri(uri);
    return this.files.find((f) => f.key === key) ?? null;
  }

  private nextVersion(key: string): number {
    const v = (this.versions.get(key) ?? -1) + 1;
    this.versions.set(key, v);
    return v;
  }

  syncFiles() {
    const result: { file: OpenFile; prevDoc: Text; changes: ChangeSet }[] = [];
    for (const file of this.files) {
      const plugin = LSPPlugin.get(file.view);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (changes.empty) continue;
      result.push({ file, changes, prevDoc: file.doc });
      file.doc = file.view.state.doc;
      file.version = this.nextVersion(file.key);
      plugin.clear();
    }
    return result;
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    const key = normalizeUri(uri);
    const old = this.getFile(uri);
    if (old) {
      // The editor was created again for the same file. Start the file from new.
      this.files = this.files.filter((f) => f !== old);
      this.client.didClose(old.uri);
    }
    const file: OpenFile = {
      uri,
      key,
      languageId,
      version: this.nextVersion(key),
      doc: view.state.doc,
      view,
      getView: () => file.view,
    };
    this.files.push(file);
    this.client.didOpen(file);
    for (const resolve of this.waiters.get(key) ?? []) resolve(file);
    this.waiters.delete(key);
  }

  closeFile(uri: string, view: EditorView): void {
    const file = this.getFile(uri);
    // A newer editor took over this file already: keep it.
    if (!file || file.view !== view) return;
    this.files = this.files.filter((f) => f !== file);
    this.client.didClose(file.uri);
  }

  /** Opens the file in a background tab when it is not open, and waits until the editor is ready. */
  override async requestFile(uri: string): Promise<WorkspaceFile | null> {
    const open = this.getFile(uri);
    if (open) return open;
    const path = uriToPath(uri);
    if (!path) return null;
    const editor = await this.ctx.editors.openFile(path, { activate: false });
    if (!editor) return null;
    return this.waitFor(uri, 4000);
  }

  /** Opens the file in front of the user (go to definition in another file). */
  override async displayFile(uri: string): Promise<EditorView | null> {
    const path = uriToPath(uri);
    if (!path) return null;
    const editor = await this.ctx.editors.openFile(path);
    return editor?.view ?? null;
  }

  private waitFor(uri: string, timeoutMs: number): Promise<WorkspaceFile | null> {
    const key = normalizeUri(uri);
    const existing = this.getFile(uri);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const list = this.waiters.get(key) ?? [];
      const done = (f: WorkspaceFile | null) => {
        clearTimeout(timer);
        resolve(f);
      };
      const timer = setTimeout(() => {
        const rest = (this.waiters.get(key) ?? []).filter((w) => w !== done);
        if (rest.length) this.waiters.set(key, rest);
        else this.waiters.delete(key);
        resolve(null);
      }, timeoutMs);
      list.push(done);
      this.waiters.set(key, list);
    });
  }

  /** Used when the server restarts: forget old diagnostics in all open editors. */
  views(): EditorView[] {
    return this.files.map((f) => f.view);
  }
}

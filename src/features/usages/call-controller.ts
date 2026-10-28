// State and loading logic of the Call Hierarchy panel, one instance per workbench.
import type { AppContext, Disposable } from '../../core/types';
import { codeCallers, codeCancel, newCodeRequestId } from '../../ipc/code';
import { uriToPath } from '../lsp/uri';
import {
  EXPAND_MAX_NODES,
  collapseAll,
  createTree,
  edgeFromCaller,
  edgesFromLsp,
  expandAll,
  flattenCalls,
  itemFromLsp,
  itemFromTarget,
  revealNode,
  setCallers,
  canOpen,
  type CallEdge,
  type CallItem,
  type CallNode,
  type CallRow,
  type CallTree,
  type Filters,
  type LspCallItem,
  type LspIncomingCall,
} from './call-model';
import type { SearchRequest } from './controller';
import { readLineTexts } from './lines';
import { HISTORY_SIZE, pushHistory, withTimeout, type HistoryEntry, type UsageSource } from './model';

export const CALLS_VIEW_ID = 'call-hierarchy';
const MAX_RESULTS = 5000;
const LSP_TIMEOUT_MS = 10_000;

interface Stored {
  request: SearchRequest;
  tree: CallTree;
}

interface LspAnswer {
  item: LspCallItem;
  calls: LspIncomingCall[];
}

export type CallChange = 'tree' | 'rows' | 'select';

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

export class CallHierarchyController {
  status: 'idle' | 'searching' | 'done' | 'error' = 'idle';
  error = '';
  request: SearchRequest | null = null;
  tree: CallTree | null = null;
  filters: Filters = { hideTest: false };
  history: HistoryEntry<Stored>[] = [];
  selectedId: string | null = null;
  rows: CallRow[] = [];
  expanding = false;
  expandNodes = 0;

  private gen = 0;
  private cache = new Map<string, CallEdge[]>();
  private readonly pending = new Set<number>();
  private expandCancelled = false;
  private readonly listeners = new Set<(kind: CallChange) => void>();

  constructor(private readonly ctx: AppContext) {}

  onChange(fn: (kind: CallChange) => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private emit(kind: CallChange): void {
    for (const fn of [...this.listeners]) fn(kind);
  }

  dispose(): void {
    this.cancelAll();
    this.listeners.clear();
  }

  private folder(path: string): string {
    const rel = this.ctx.workspace.relative(path).replace(/\\/g, '/');
    const i = rel.lastIndexOf('/');
    return i < 0 ? '' : rel.slice(0, i);
  }

  rel(path: string): string {
    return this.ctx.workspace.relative(path).replace(/\\/g, '/');
  }

  /** Stops the open requests and makes late answers useless. */
  private cancelAll(): void {
    this.gen++;
    this.expandCancelled = true;
    this.expanding = false;
    for (const id of this.pending) codeCancel(id).catch(() => {});
    this.pending.clear();
  }

  // --- Root --------------------------------------------------------------------------

  async show(req: SearchRequest): Promise<void> {
    this.cancelAll();
    this.cache.clear();
    const gen = this.gen;
    this.request = req;
    this.status = 'searching';
    this.error = '';
    this.emit('tree');
    this.ctx.views.show(CALLS_VIEW_ID, { focus: true });
    try {
      const tree = await this.fetchRoot(req);
      if (gen !== this.gen) return;
      this.tree = tree;
      this.status = 'done';
      this.selectedId = null;
      this.history = pushHistory(
        this.history,
        { key: tree.root.item.key, label: tree.root.item.title, data: { request: req, tree } },
        HISTORY_SIZE,
      );
      this.refresh('tree');
    } catch (e) {
      if (gen !== this.gen) return;
      this.status = 'error';
      this.error = errorText(e);
      this.tree = null;
      this.rows = [];
      this.emit('tree');
      this.ctx.ui.notify(`Call hierarchy failed: ${this.error}`, { kind: 'error' });
    }
  }

  searchAgain(): Promise<void> {
    return this.request ? this.show(this.request) : Promise.resolve();
  }

  showHistory(key: string): void {
    const entry = this.history.find((e) => e.key === key);
    if (!entry) return;
    this.cancelAll();
    this.request = entry.data.request;
    this.tree = entry.data.tree;
    // Nodes that were loading when we left must load again.
    const reset = (n: CallNode) => {
      if (n.load === 'loading') n.load = 'idle';
      n.callers.forEach(reset);
    };
    reset(this.tree.root);
    this.status = 'done';
    this.selectedId = null;
    this.ctx.views.show(CALLS_VIEW_ID, { focus: true });
    this.refresh('tree');
    for (const n of this.openUnloaded()) void this.load(n);
  }

  private openUnloaded(): CallNode[] {
    const out: CallNode[] = [];
    const walk = (n: CallNode) => {
      if (n.open && canOpen(n) && n.load === 'idle') out.push(n);
      if (n.open) for (const k of n.callers) if (k.likely || n.sameOpen) walk(k);
    };
    if (this.tree) walk(this.tree.root);
    return out;
  }

  private async fetchRoot(req: SearchRequest): Promise<CallTree> {
    const swift = /\.swift$/i.test(req.path);
    if (!swift && this.ctx.commands.get('lsp.incomingCalls')) {
      try {
        const answer = (await withTimeout(
          this.ctx.commands.execute('lsp.incomingCalls', { path: req.path, line: req.line, column: req.column }) as Promise<LspAnswer | null>,
          LSP_TIMEOUT_MS,
        )) as LspAnswer | null;
        if (answer?.item) {
          const item = itemFromLsp(answer.item, uriToPath, (p) => this.folder(p));
          if (item) {
            const edges = await this.lspEdges(answer.calls);
            const tree = createTree(item, 'lsp', true);
            setCallers(tree.root, edges);
            this.cache.set(`lsp|${item.key}`, edges);
            return tree;
          }
        }
      } catch {
        // Use the index.
      }
    }
    const editor = this.ctx.editors.get(req.path);
    const id = newCodeRequestId();
    this.pending.add(id);
    try {
      const result = await codeCallers(id, {
        root: this.ctx.workspace.root ?? req.path.replace(/[\\/][^\\/]*$/, ''),
        at: { path: req.path, line: req.line, column: req.column, text: editor?.isDirty() ? editor.getText() : undefined },
        maxResults: MAX_RESULTS,
      });
      if (!result.target) throw new Error('There is no method, constructor, function or property at this position.');
      const item = itemFromTarget(result.target, this.folder(result.target.path));
      const edges = result.callers.map((c) => edgeFromCaller(c, (p) => this.folder(p)));
      const tree = createTree(item, 'index', result.exact);
      setCallers(tree.root, edges);
      this.cache.set(`index|${item.key}`, edges);
      return tree;
    } finally {
      this.pending.delete(id);
    }
  }

  private async lspEdges(calls: LspIncomingCall[]): Promise<CallEdge[]> {
    const wanted: { path: string; line: number }[] = [];
    for (const c of calls) {
      const path = uriToPath(c.from.uri);
      if (path === null) continue;
      for (const r of c.fromRanges) wanted.push({ path, line: r.start.line });
    }
    const text = await readLineTexts(this.ctx, wanted);
    return edgesFromLsp(calls, uriToPath, (p) => this.folder(p), text);
  }

  // --- Callers of a node ---------------------------------------------------------------

  private async fetchCallers(source: UsageSource, item: CallItem): Promise<CallEdge[]> {
    const cacheKey = `${source}|${item.key}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;
    let edges: CallEdge[];
    if (source === 'lsp') {
      const answer = (await withTimeout(
        this.ctx.commands.execute('lsp.incomingCalls', { item: item.lsp }) as Promise<LspAnswer | null>,
        LSP_TIMEOUT_MS,
      )) as LspAnswer | null;
      if (!answer) throw new Error('The language server did not answer.');
      edges = await this.lspEdges(answer.calls);
    } else {
      if (!item.index) throw new Error('No data for this method.');
      const id = newCodeRequestId();
      this.pending.add(id);
      try {
        const result = await codeCallers(id, {
          root: this.ctx.workspace.root ?? item.path.replace(/[\\/][^\\/]*$/, ''),
          target: item.index,
          maxResults: MAX_RESULTS,
        });
        edges = result.callers.map((c) => edgeFromCaller(c, (p) => this.folder(p)));
      } finally {
        this.pending.delete(id);
      }
    }
    this.cache.set(cacheKey, edges);
    return edges;
  }

  /** Loads the callers of a node. Does nothing when they are loaded or loading. */
  async load(node: CallNode): Promise<void> {
    const tree = this.tree;
    if (!tree || node.load === 'loading' || node.load === 'loaded') return;
    const gen = this.gen;
    node.load = 'loading';
    node.error = '';
    this.refresh('rows');
    try {
      const edges = await this.fetchCallers(tree.source, node.item);
      if (gen !== this.gen) return;
      setCallers(node, edges);
    } catch (e) {
      if (gen !== this.gen) return;
      node.load = 'error';
      node.error = errorText(e);
    }
    this.refresh('rows');
  }

  retry(node: CallNode): void {
    if (node.load === 'error') {
      node.load = 'idle';
      void this.load(node);
    }
  }

  // --- Tree state ------------------------------------------------------------------------

  private refresh(kind: CallChange): void {
    this.rows = this.tree ? flattenCalls(this.tree, this.filters) : [];
    if (this.selectedId && !this.rows.some((r) => r.id === this.selectedId)) this.selectedId = null;
    this.emit(kind);
  }

  setFilters(patch: Partial<Filters>): void {
    this.filters = { ...this.filters, ...patch };
    this.refresh('rows');
  }

  setOpen(node: CallNode, open: boolean): void {
    if (!canOpen(node) || node.open === open) return;
    node.open = open;
    if (open && node.load === 'idle') void this.load(node);
    this.refresh('rows');
  }

  /** Opens or closes the group "Same name, maybe other methods" of a node. */
  setSameOpen(node: CallNode, open: boolean): void {
    if (node.sameOpen === open) return;
    node.sameOpen = open;
    this.refresh('rows');
  }

  toggle(node: CallNode): void {
    this.setOpen(node, !node.open);
  }

  collapseAll(): void {
    if (!this.tree) return;
    collapseAll(this.tree);
    this.refresh('rows');
  }

  /** Opens every node to depth 3, at most 500 nodes. */
  async expandAll(): Promise<void> {
    const tree = this.tree;
    if (!tree || this.expanding) return;
    const gen = this.gen;
    this.expandCancelled = false;
    this.expanding = true;
    this.expandNodes = 1;
    this.emit('rows');
    const result = await expandAll(tree, this.filters, (n) => this.load(n), {
      cancelled: () => this.expandCancelled || gen !== this.gen,
      onProgress: (n) => {
        this.expandNodes = n;
        this.refresh('rows');
      },
    });
    if (gen !== this.gen) return;
    this.expanding = false;
    this.refresh('rows');
    if (result.limited) this.ctx.ui.notify(`Expand All stopped at ${EXPAND_MAX_NODES} nodes.`);
  }

  cancelExpand(): void {
    this.expandCancelled = true;
  }

  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit('select');
  }

  reveal(node: CallNode): void {
    revealNode(node);
    this.selectedId = node.id;
    this.refresh('select');
  }

  // --- Opening code ------------------------------------------------------------------------

  async openAt(
    path: string,
    line: number,
    column: number,
    length: number,
    opts: { preview: boolean; focusEditor: boolean },
  ): Promise<void> {
    let editor;
    try {
      editor = await this.ctx.editors.openFile(path, { line, column, preview: opts.preview });
    } catch (e) {
      this.ctx.ui.notify(`Cannot open ${this.rel(path)}: ${errorText(e)}`, { kind: 'error' });
      return;
    }
    if (!editor) return;
    const doc = editor.view.state.doc;
    const text = doc.line(Math.min(Math.max(line, 1), doc.lines));
    const from = Math.min(text.from + Math.max(column - 1, 0), text.to);
    const to = Math.min(from + Math.max(length, 0), text.to);
    editor.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    if (opts.focusEditor) editor.focus();
  }

  openRow(row: CallRow, opts: { preview: boolean; focusEditor: boolean }): void {
    if (row.kind === 'node') {
      const i = row.node.item;
      void this.openAt(i.path, i.line, i.column, i.nameLength, opts);
    } else if (row.kind === 'site') {
      const s = row.site;
      void this.openAt(row.node.item.path, s.line, s.column, s.range[1] - s.range[0], opts);
    }
  }
}

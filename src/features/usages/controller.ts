// State and search logic of the Usages panel, one instance per workbench.
// The view only draws what the controller holds.
import type { AppContext, Disposable } from '../../core/types';
import { codeCancel, codeUsages, newCodeRequestId } from '../../ipc/code';
import { lspReadLines } from '../../ipc/lsp';
import { uriToPath } from '../lsp/uri';
import {
  Expansion,
  HISTORY_SIZE,
  buildTree,
  flatten,
  lspToResult,
  nameColumn,
  otherSource,
  pushHistory,
  stepMatch,
  withTimeout,
  wordAt,
  type GroupBy,
  type HistoryEntry,
  type LspHit,
  type MatchNode,
  type Row,
  type Tree,
  type UsageSet,
  type UsageSource,
} from './model';

export const VIEW_ID = 'usages';
const MAX_RESULTS = 5000;
const LSP_TIMEOUT_MS = 10_000;

export interface SearchRequest {
  /** Absolute path, 1-based line, 1-based column (UTF-16 units). */
  path: string;
  line: number;
  column: number;
  /** `auto`: the language server first, or the index first for Swift. */
  source?: UsageSource | 'auto';
  /** Index only: also search other files for local names. */
  wide?: boolean;
}

interface Stored {
  request: SearchRequest;
  result: UsageSet;
}

/** What changed: the whole result, only the rows (filter, open nodes), or only the selection. */
export type ChangeKind = 'result' | 'rows' | 'select';

interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

const NOT_READY = 'No language server is ready for this file.';

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export class UsagesController {
  status: 'idle' | 'searching' | 'done' | 'error' = 'idle';
  error = '';
  request: SearchRequest | null = null;
  result: UsageSet | null = null;
  /** Name for the header while the search runs. */
  name = '';
  groupBy: GroupBy = 'kind';
  filter = '';
  history: HistoryEntry<Stored>[] = [];
  selectedId: string | null = null;
  tree: Tree | null = null;
  expansion = new Expansion();
  rows: Row[] = [];

  private seq = 0;
  private indexId: number | null = null;
  private readonly listeners = new Set<(kind: ChangeKind) => void>();

  constructor(private readonly ctx: AppContext) {}

  onChange(fn: (kind: ChangeKind) => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private emit(kind: ChangeKind): void {
    for (const fn of [...this.listeners]) fn(kind);
  }

  dispose(): void {
    this.seq++;
    this.cancelIndex();
    this.listeners.clear();
  }

  rel(path: string): string {
    return this.ctx.workspace.relative(path).replace(/\\/g, '/');
  }

  // --- Search -------------------------------------------------------------------

  /** Runs a search and shows the panel. Resolves with the result, or null when it failed. */
  async find(req: SearchRequest): Promise<UsageSet | null> {
    return this.run(req, false);
  }

  searchAgain(): Promise<UsageSet | null> {
    return this.request ? this.run(this.request, false) : Promise.resolve(null);
  }

  /** Searches again with the other source. A failure keeps the old result. */
  switchSource(): Promise<UsageSet | null> {
    if (!this.request || !this.result) return Promise.resolve(null);
    return this.run({ ...this.request, source: otherSource(this.result.source), wide: undefined }, true);
  }

  /** For local names: also look in other files (index only). */
  searchAllFiles(): Promise<UsageSet | null> {
    if (!this.request) return Promise.resolve(null);
    return this.run({ ...this.request, source: 'index', wide: true }, true);
  }

  private async run(req: SearchRequest, keepOldOnError: boolean): Promise<UsageSet | null> {
    const seq = ++this.seq;
    this.cancelIndex();
    const before = { status: this.status, error: this.error, request: this.request, name: this.name };
    this.status = 'searching';
    this.error = '';
    this.request = req;
    this.name = this.nameAt(req);
    this.emit('result');
    this.ctx.views.show(VIEW_ID, { focus: true });
    try {
      const result = await this.compute(req);
      if (seq !== this.seq) return null;
      this.showResult(req, result);
      this.remember(req, result);
      return result;
    } catch (e) {
      if (seq !== this.seq) return null;
      const message = errorText(e);
      if (keepOldOnError && this.result) {
        // Show the old result again and tell the user why the new search did not work.
        this.request = before.request;
        this.name = before.name;
        this.status = before.status;
        this.error = before.error;
        this.emit('result');
        this.ctx.ui.notify(message, { kind: 'warn' });
      } else {
        this.status = 'error';
        this.error = message;
        this.result = null;
        this.tree = null;
        this.rows = [];
        this.emit('result');
        this.ctx.ui.notify(`Find usages failed: ${message}`, { kind: 'error' });
      }
      return null;
    }
  }

  private async compute(req: SearchRequest): Promise<UsageSet> {
    const explicit = req.source && req.source !== 'auto' ? req.source : null;
    const swift = /\.swift$/i.test(req.path);
    const order: UsageSource[] = explicit ? [explicit] : swift ? ['index', 'lsp'] : ['lsp', 'index'];
    let fallback: UsageSet | null = null;
    let lastError: unknown = null;
    for (const source of order) {
      const last = source === order[order.length - 1];
      try {
        const result = source === 'lsp' ? await this.viaLsp(req) : await this.viaIndex(req);
        if (!result) {
          if (explicit) throw new Error(NOT_READY);
          continue;
        }
        if (explicit || result.total > 0 || last) return result;
        fallback ??= result;
      } catch (e) {
        if (explicit) throw e;
        lastError = e;
      }
    }
    if (fallback) return fallback;
    throw lastError ?? new Error('No answer.');
  }

  private cancelIndex(): void {
    const id = this.indexId;
    this.indexId = null;
    if (id !== null) codeCancel(id).catch(() => {});
  }

  private async viaIndex(req: SearchRequest): Promise<UsageSet> {
    const { path } = req;
    const editor = this.ctx.editors.get(path);
    const id = newCodeRequestId();
    this.indexId = id;
    try {
      const result = await codeUsages(id, {
        root: this.ctx.workspace.root ?? path.replace(/[\\/][^\\/]*$/, ''),
        path,
        line: req.line,
        column: req.column,
        text: editor?.isDirty() ? editor.getText() : undefined,
        wide: req.wide || undefined,
        maxResults: MAX_RESULTS,
      });
      return { ...result, source: 'index' };
    } finally {
      if (this.indexId === id) this.indexId = null;
    }
  }

  /** null: no language server is ready for the file, or it did not answer in time. */
  private async viaLsp(req: SearchRequest): Promise<UsageSet | null> {
    if (!this.ctx.commands.get('lsp.referencesAt')) return null;
    const started = performance.now();
    let locations: LspLocation[] | null;
    try {
      locations = (await withTimeout(
        this.ctx.commands.execute('lsp.referencesAt', { path: req.path, line: req.line, column: req.column }) as Promise<
          LspLocation[] | null
        >,
        LSP_TIMEOUT_MS,
      )) as LspLocation[] | null;
    } catch (e) {
      if (req.source === 'lsp') throw e;
      return null;
    }
    if (!locations) return null;
    const hits: LspHit[] = [];
    for (const loc of locations.slice(0, MAX_RESULTS + 1)) {
      const path = uriToPath(loc.uri);
      if (path === null) continue;
      hits.push({
        path,
        line: loc.range.start.line,
        character: loc.range.start.character,
        endLine: loc.range.end.line,
        endCharacter: loc.range.end.character,
      });
    }
    const texts = await this.readLines(hits);
    const name = this.nameAt(req);
    return lspToResult(hits, req, (p, l) => texts.get(p)?.get(l) ?? '', name, Math.round(performance.now() - started), MAX_RESULTS);
  }

  /** Text of the lines of all hits: from the open editor, else from disk. */
  private async readLines(hits: LspHit[]): Promise<Map<string, Map<number, string>>> {
    const out = new Map<string, Map<number, string>>();
    const need = new Map<string, Set<number>>();
    for (const h of hits) {
      const editor = this.ctx.editors.get(h.path);
      if (editor) {
        const doc = editor.view.state.doc;
        let m = out.get(h.path);
        if (!m) out.set(h.path, (m = new Map()));
        m.set(h.line, h.line + 1 <= doc.lines ? doc.line(h.line + 1).text : '');
      } else {
        let s = need.get(h.path);
        if (!s) need.set(h.path, (s = new Set()));
        s.add(h.line);
      }
    }
    if (need.size) {
      const requests = [...need.entries()].map(([path, lines]) => ({ path, lines: [...lines].sort((a, b) => a - b) }));
      try {
        const result = await lspReadLines(requests);
        requests.forEach((r, i) => out.set(r.path, new Map(r.lines.map((l, j) => [l, result[i]?.[j] ?? '']))));
      } catch {
        // The list still works without the line text.
      }
    }
    return out;
  }

  /** The name at the position, from the open editor. Empty when the file is not open. */
  private nameAt(req: SearchRequest): string {
    const editor = this.ctx.editors.get(req.path);
    if (!editor) return '';
    const doc = editor.view.state.doc;
    if (req.line < 1 || req.line > doc.lines) return '';
    const text = doc.line(req.line).text;
    const w = wordAt(text, req.column - 1);
    return w ? text.slice(w.from, w.to) : '';
  }

  // --- Result and history ---------------------------------------------------------

  private showResult(req: SearchRequest, result: UsageSet): void {
    this.request = { ...req, source: result.source };
    this.result = result;
    this.status = 'done';
    this.error = '';
    this.selectedId = null;
    this.expansion = new Expansion(this.filter.trim() !== '');
    this.rebuild();
    this.emit('result');
  }

  private remember(req: SearchRequest, result: UsageSet): void {
    const name = result.symbol?.name || this.name || 'name';
    const entry: HistoryEntry<Stored> = {
      key: `${req.path}:${req.line}:${req.column}`,
      label: `${name}  ${baseName(req.path)}:${req.line}`,
      data: { request: { ...req, source: result.source }, result },
    };
    this.history = pushHistory(this.history, entry, HISTORY_SIZE);
    this.emit('result');
  }

  /** Shows an earlier search again, without searching. */
  showHistory(key: string): void {
    const entry = this.history.find((e) => e.key === key);
    if (!entry) return;
    this.seq++;
    this.cancelIndex();
    this.name = entry.label;
    this.showResult(entry.data.request, entry.data.result);
    this.ctx.views.show(VIEW_ID, { focus: true });
  }

  // --- Tree ---------------------------------------------------------------------

  private rebuild(): void {
    if (!this.result) {
      this.tree = null;
      this.rows = [];
      return;
    }
    this.tree = buildTree(this.result.files, { groupBy: this.groupBy, filter: this.filter, rel: (p) => this.rel(p) });
    if (this.selectedId && !this.tree.byId.has(this.selectedId)) this.selectedId = null;
    this.rows = flatten(this.tree, this.expansion);
  }

  private refreshRows(kind: ChangeKind = 'rows'): void {
    if (this.tree) this.rows = flatten(this.tree, this.expansion);
    this.emit(kind);
  }

  setGroupBy(groupBy: GroupBy): void {
    if (groupBy === this.groupBy) return;
    this.groupBy = groupBy;
    this.expansion = new Expansion(this.filter.trim() !== '');
    this.rebuild();
    this.emit('rows');
  }

  setFilter(filter: string): void {
    if (filter === this.filter) return;
    this.filter = filter;
    this.expansion = new Expansion(filter.trim() !== '');
    this.rebuild();
    this.emit('rows');
  }

  toggle(id: string): void {
    const node = this.tree?.byId.get(id);
    if (!node || node.type === 'match') return;
    this.expansion.toggle(node);
    this.refreshRows();
  }

  setOpen(id: string, open: boolean): void {
    const node = this.tree?.byId.get(id);
    if (!node || node.type === 'match') return;
    this.expansion.set(id, open);
    this.refreshRows();
  }

  expandAll(): void {
    if (!this.tree) return;
    this.expansion.expandAll(this.tree);
    this.refreshRows();
  }

  collapseAll(): void {
    if (!this.tree) return;
    this.expansion.collapseAll(this.tree);
    this.refreshRows();
  }

  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit('select');
  }

  /** Selects a match and opens its parents so the row is visible. */
  reveal(id: string): void {
    if (this.tree) this.expansion.reveal(this.tree, id);
    this.selectedId = id;
    this.refreshRows('select');
  }

  // --- Opening matches -----------------------------------------------------------

  async openMatch(node: MatchNode, opts: { preview: boolean; focusEditor: boolean }): Promise<void> {
    const m = node.match;
    let editor;
    try {
      editor = await this.ctx.editors.openFile(node.path, { line: m.line, column: m.column, preview: opts.preview });
    } catch (e) {
      this.ctx.ui.notify(`Cannot open ${this.rel(node.path)}: ${errorText(e)}`, { kind: 'error' });
      return;
    }
    if (!editor) return;
    const doc = editor.view.state.doc;
    const line = doc.line(Math.min(Math.max(m.line, 1), doc.lines));
    const from = Math.min(line.from + Math.max(m.column - 1, 0), line.to);
    const to = Math.min(from + Math.max(m.range[1] - m.range[0], 0), line.to);
    editor.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    if (opts.focusEditor) editor.focus();
  }

  /** F4 and Shift-F4: the next or previous match in the editor, and in the panel. */
  step(dir: 1 | -1): void {
    const tree = this.tree;
    if (!tree || !tree.leaves.length) {
      this.ctx.ui.notify('No usages to go through. Run Find Usages first.');
      return;
    }
    const node = stepMatch(tree.leaves, this.selectedId, dir);
    if (!node) return;
    this.reveal(node.id);
    void this.openMatch(node, { preview: true, focusEditor: true });
  }

  hasResult(): boolean {
    return !!this.tree && this.tree.leaves.length > 0;
  }
}

/** The position for a search that starts at the cursor of an editor. */
export function cursorRequest(ctx: AppContext): SearchRequest | null {
  const editor = ctx.editors.active();
  if (!editor) return null;
  const doc = editor.view.state.doc;
  const head = editor.view.state.selection.main.head;
  const line = doc.lineAt(head);
  return { path: editor.path, line: line.number, column: nameColumn(line.text, head - line.from + 1) };
}

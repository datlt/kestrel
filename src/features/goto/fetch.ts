// Loads the results of one search: the code index, the file index, language
// servers, commands and text search. One `SearchRun` is one query. When the
// user types again, `cancel()` stops it and its late answers are ignored.

import type { AppContext } from '../../core/types';
import { codeCancel, codeFindSymbols, codeFindTypes, newCodeRequestId } from '../../ipc/code';
import { searchCancel, searchFiles, searchText, type FileMatches } from '../../ipc/search';
import { indexAllowed, indexRequestOptions, lspAllowed, passesFilter, type GotoFilter } from './filter';
import { mergeResults, textTabRows } from './merge';
import { applyRecentBonus, readRecent, recentRanks, RECENT_KEY } from './recent';
import {
  classRowFromHit,
  classRowFromRecent,
  fileRowFromHit,
  lspClassRows,
  lspSymbolRows,
  matchActions,
  symbolRowFromHit,
  textRowsFromFiles,
  type ActionInput,
  type ActionRow,
  type ClassRow,
  type FileRow,
  type Group,
  type LspHitLike,
  type Row,
  type SymbolRow,
} from './rows';

export const LSP_QUERY_COMMAND = 'lsp.workspaceSymbolsQuery';
export const TEXT_MIN_CHARS = 2;
export const TEXT_MAX_MATCHES = 100;

export interface RunStatus {
  /** The index of the project is still being built. */
  building?: boolean;
  error?: string;
}

export interface RunSink {
  /** New rows of a group. `more` is true when the group has more rows than it got. */
  group(group: Group, rows: Row[], more: boolean): void;
  /** The rows of the Text tab (the matching lines and the "Open in Find Window" row). */
  text(rows: Row[]): void;
  status(s: RunStatus): void;
}

export interface RunOptions {
  ctx: AppContext;
  filter: GotoFilter;
  /** The query without a `:line` ending. */
  query: string;
  /** The ids of the commands that ran lately, newest first. */
  recentActions: readonly string[];
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

function isCancelled(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'cancelled';
}

export class SearchRun {
  private dead = false;
  private readonly codeIds = new Set<number>();
  private textId: number | null = null;

  constructor(
    private readonly o: RunOptions,
    private readonly sink: RunSink,
  ) {}

  get stale(): boolean {
    return this.dead;
  }

  cancel(): void {
    if (this.dead) return;
    this.dead = true;
    for (const id of this.codeIds) codeCancel(id).catch(() => {});
    this.codeIds.clear();
    if (this.textId !== null) searchCancel(this.textId).catch(() => {});
  }

  private get root(): string | null {
    return this.o.ctx.workspace.root;
  }

  private fail(e: unknown): void {
    if (this.dead || isCancelled(e)) return;
    console.warn('search everywhere failed', e);
    this.sink.status({ error: errorText(e) });
  }

  // --- classes -----------------------------------------------------------------

  async classes(limit: number): Promise<void> {
    const { ctx, filter, query } = this.o;
    const root = this.root;
    if (!root) return;
    const recent = readRecent(ctx.workspace.state.get(RECENT_KEY));
    if (!query.trim()) {
      const rows = recent
        .filter((e) => e.type === 'class')
        .map(classRowFromRecent)
        .filter((r) => passesFilter(filter, 'classes', r));
      this.sink.group('classes', rows.slice(0, limit), rows.length > limit);
      return;
    }
    const ranks = recentRanks(recent, 'class');
    let index: ClassRow[] = [];
    let lsp: ClassRow[] = [];
    let truncated = false;
    const emit = () => {
      if (this.dead) return;
      const merged = mergeResults(applyRecentBonus(index, (r) => r.key, ranks), lsp);
      this.sink.group('classes', merged.slice(0, limit), truncated || merged.length > limit);
    };
    const tasks: Promise<void>[] = [];
    if (indexAllowed(filter)) {
      tasks.push(
        this.callIndex(
          (id) =>
            codeFindTypes(id, { root, query, limit: filter.classKinds.length ? 300 : Math.max(limit, 100), ...indexRequestOptions(filter) }),
          (res) => {
            index = res.items.map((h) => classRowFromHit(h, root)).filter((r) => passesFilter(filter, 'classes', r));
            truncated = res.truncated;
            emit();
          },
          () => this.classes(limit),
        ),
      );
    }
    if (lspAllowed(filter)) {
      tasks.push(
        this.callLsp(query, (hits) => {
          lsp = lspClassRows(hits, query).filter((r) => passesFilter(filter, 'classes', r));
          emit();
        }),
      );
    }
    await Promise.all(tasks);
  }

  // --- symbols -----------------------------------------------------------------

  async symbols(limit: number): Promise<void> {
    const { filter, query } = this.o;
    const root = this.root;
    if (!root || !query.trim()) {
      if (root) this.sink.group('symbols', [], false);
      return;
    }
    let index: SymbolRow[] = [];
    let lsp: SymbolRow[] = [];
    let truncated = false;
    const emit = () => {
      if (this.dead) return;
      const merged = mergeResults(index, lsp);
      this.sink.group('symbols', merged.slice(0, limit), truncated || merged.length > limit);
    };
    const tasks: Promise<void>[] = [];
    if (indexAllowed(filter)) {
      tasks.push(
        this.callIndex(
          (id) =>
            codeFindSymbols(id, { root, query, limit: filter.symbolKinds.length ? 300 : Math.max(limit, 100), ...indexRequestOptions(filter) }),
          (res) => {
            index = res.items.map((h) => symbolRowFromHit(h, root)).filter((r) => passesFilter(filter, 'symbols', r));
            truncated = res.truncated;
            emit();
          },
          () => this.symbols(limit),
        ),
      );
    }
    if (lspAllowed(filter)) {
      tasks.push(
        this.callLsp(query, (hits) => {
          lsp = lspSymbolRows(hits, query).filter((r) => passesFilter(filter, 'symbols', r));
          emit();
        }),
      );
    }
    await Promise.all(tasks);
  }

  // --- files -------------------------------------------------------------------

  async files(limit: number): Promise<void> {
    const { ctx, query } = this.o;
    const root = this.root;
    if (!root) return;
    const q = query.trim();
    const ranks = recentRanks(readRecent(ctx.workspace.state.get(RECENT_KEY)), 'file');
    try {
      const res = await searchFiles(root, q, Math.max(limit, 100));
      if (this.dead) return;
      if (res.state === 'building' && res.items.length === 0) {
        this.sink.status({ building: true });
        this.sink.group('files', [], false);
        // Ask again while the file index builds.
        await new Promise((r) => setTimeout(r, 400));
        if (!this.dead) await this.files(limit);
        return;
      }
      let rows: FileRow[] = res.items.map(fileRowFromHit);
      if (!q) {
        // Recent files first, then the rest of the index.
        const recent = [...ranks.keys()].map((rel) => fileRowFromHit({ path: rel, indices: [] }));
        const seen = new Set(recent.map((r) => r.key));
        rows = [...recent, ...rows.filter((r) => !seen.has(r.key))];
      } else {
        rows = applyRecentBonus(rows, (r) => r.key, ranks);
      }
      this.sink.status({ building: res.state === 'building' });
      this.sink.group('files', rows.slice(0, limit), rows.length > limit);
    } catch (e) {
      this.fail(e);
    }
  }

  // --- actions -----------------------------------------------------------------

  actions(limit: number): void {
    const { ctx, query, recentActions } = this.o;
    const inputs: ActionInput[] = [];
    for (const c of ctx.commands.list()) {
      if (c.hidden) continue;
      try {
        if (c.when && !c.when()) continue;
      } catch {
        continue;
      }
      const binding = Array.isArray(c.keybinding) ? c.keybinding[0] : c.keybinding;
      inputs.push({ id: c.id, title: c.title, category: c.category, keyLabel: binding ? ctx.commands.keyLabel(binding) : undefined });
    }
    const rows: ActionRow[] = matchActions(inputs, query, recentActions);
    this.sink.group('actions', rows.slice(0, limit), rows.length > limit);
  }

  // --- text --------------------------------------------------------------------

  async text(): Promise<void> {
    const { ctx, query } = this.o;
    const root = this.root;
    if (!root) return;
    if (query.trim().length < TEXT_MIN_CHARS) {
      this.sink.text([]);
      return;
    }
    const files: FileMatches[] = [];
    const publish = () => {
      if (this.dead) return;
      const rows = textRowsFromFiles(files, (p) => ctx.workspace.relative(p), TEXT_MAX_MATCHES);
      this.sink.text(textTabRows(rows, query));
    };
    try {
      const id = await searchText(
        root,
        { query, regex: false, matchCase: false, wholeWord: false, include: [], exclude: [], maxResults: TEXT_MAX_MATCHES },
        (e) => {
          if (this.dead) return;
          if (e.type === 'batch') {
            files.push(...e.files);
            publish();
          } else if (e.type === 'error') {
            this.sink.status({ error: e.message });
          } else {
            publish();
          }
        },
      );
      this.textId = id;
      if (this.dead) searchCancel(id).catch(() => {});
    } catch (e) {
      this.fail(e);
    }
  }

  // --- helpers -----------------------------------------------------------------

  /**
   * Calls a code index request. While the index builds, it shows the status and
   * asks again after a short time (`again`).
   */
  private async callIndex<T extends { index: { state: string } }>(
    call: (id: number) => Promise<T>,
    done: (res: T) => void,
    again: () => Promise<void>,
  ): Promise<void> {
    const id = newCodeRequestId();
    this.codeIds.add(id);
    try {
      const res = await call(id);
      if (this.dead) return;
      const building = res.index.state === 'building';
      this.sink.status({ building });
      done(res);
      if (building) {
        // The index grows while it builds. Ask again until it is ready.
        await new Promise((r) => setTimeout(r, 500));
        if (!this.dead) await again();
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.codeIds.delete(id);
    }
  }

  /** Asks the language servers. Without the command or without a ready server this does nothing. */
  private async callLsp(query: string, done: (hits: LspHitLike[]) => void): Promise<void> {
    const { ctx } = this.o;
    if (!ctx.commands.get(LSP_QUERY_COMMAND)) return;
    try {
      const hits = (await ctx.commands.execute(LSP_QUERY_COMMAND, { query: query.trim(), root: this.root ?? undefined })) as LspHitLike[] | null;
      if (this.dead || !Array.isArray(hits) || hits.length === 0) return;
      done(hits);
    } catch (e) {
      if (!this.dead) console.warn('workspace symbols failed', e);
    }
  }
}

// The rows of the Search Everywhere list, and the functions that build them
// from the answers of Rust and the language servers. No DOM here.

import type { SymbolHit, TypeHit } from '../../ipc/code';
import type { FileMatches } from '../../ipc/search';
import { fuzzyFilter, fuzzyMatch } from '../../shell/fuzzy';
import { classKey, type RecentClass } from './recent';
import { isTestPath, langOfPath, lspClassKind, lspSymbolKind } from './lsp-map';

export type Group = 'classes' | 'files' | 'symbols' | 'actions';
export type TabId = 'all' | Group | 'text';

export const GROUP_TITLES: Record<Group, string> = {
  classes: 'Classes',
  files: 'Files',
  symbols: 'Symbols',
  actions: 'Actions',
};

export const TAB_TITLES: Record<TabId, string> = {
  all: 'All',
  classes: 'Classes',
  files: 'Files',
  symbols: 'Symbols',
  actions: 'Actions',
  text: 'Text',
};

export const TAB_ORDER: TabId[] = ['all', 'classes', 'files', 'symbols', 'actions', 'text'];

export interface ClassRow {
  type: 'class';
  key: string;
  name: string;
  nameMatches: number[];
  container: string;
  containerMatches: number[];
  kind: string;
  lang: string;
  /** Absolute path. */
  path: string;
  line: number;
  column: number;
  test: boolean;
  /** True for a row that a language server found. */
  lsp: boolean;
}

export interface SymbolRow {
  type: 'symbol';
  key: string;
  name: string;
  nameMatches: number[];
  params: string;
  valueType: string;
  owner: string;
  kind: string;
  lang: string;
  path: string;
  line: number;
  column: number;
  test: boolean;
  lsp: boolean;
}

export interface FileRow {
  type: 'file';
  /** Path relative to the folder. */
  key: string;
  name: string;
  folder: string;
  nameMatches: number[];
  folderMatches: number[];
}

export interface ActionRow {
  type: 'action';
  key: string;
  /** Command id. */
  id: string;
  title: string;
  category: string;
  keyLabel: string;
  nameMatches: number[];
}

export interface TextRow {
  type: 'text';
  key: string;
  /** Absolute path. */
  path: string;
  rel: string;
  line: number;
  column: number;
  text: string;
  ranges: [number, number][];
}

export interface HeaderRow {
  type: 'header';
  key: string;
  group: Group;
  title: string;
}

/** "More" at the end of a group in the All tab. It switches to the tab of the group. */
export interface MoreRow {
  type: 'more';
  key: string;
  group: Group;
  title: string;
}

/** "Open in Find Window" at the end of the Text tab. */
export interface FindWindowRow {
  type: 'findWindow';
  key: string;
  query: string;
}

export type ResultRow = ClassRow | SymbolRow | FileRow | ActionRow | TextRow;
export type Row = ResultRow | HeaderRow | MoreRow | FindWindowRow;

// --- paths -------------------------------------------------------------------

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** The contract says "absolute", but a relative path is joined to the root to be safe. */
export function absolutePath(root: string, p: string): string {
  if (isAbsolutePath(p)) return p;
  return `${root.replace(/[\\/]+$/, '')}/${p.replace(/^\.?\//, '')}`;
}

// --- rows from answers -----------------------------------------------------------

export function classRowFromHit(hit: TypeHit, root: string): ClassRow {
  const path = absolutePath(root, hit.path);
  return {
    type: 'class',
    key: classKey(path, hit.name),
    name: hit.name,
    nameMatches: hit.nameMatches ?? [],
    container: hit.container ?? '',
    containerMatches: hit.containerMatches ?? [],
    kind: hit.kind,
    lang: hit.lang,
    path,
    line: hit.line,
    column: hit.column,
    test: !!hit.test,
    lsp: false,
  };
}

export function symbolRowFromHit(hit: SymbolHit, root: string): SymbolRow {
  const path = absolutePath(root, hit.path);
  return {
    type: 'symbol',
    key: `${path}:${hit.line}:${hit.column}#${hit.name}`,
    name: hit.name,
    nameMatches: hit.nameMatches ?? [],
    params: hit.params ?? '',
    valueType: hit.type ?? '',
    owner: hit.ownerName || hit.owner || '',
    kind: hit.kind,
    lang: hit.lang,
    path,
    line: hit.line,
    column: hit.column,
    test: !!hit.test,
    lsp: false,
  };
}

export function classRowFromRecent(r: RecentClass): ClassRow {
  return {
    type: 'class',
    key: r.key,
    name: r.name,
    nameMatches: [],
    container: r.container,
    containerMatches: [],
    kind: r.kind,
    lang: r.lang,
    path: r.path,
    line: r.line,
    column: r.column,
    test: r.test,
    lsp: false,
  };
}

export function recentFromClassRow(row: ClassRow): RecentClass {
  return {
    type: 'class',
    key: row.key,
    name: row.name,
    container: row.container,
    kind: row.kind,
    lang: row.lang,
    path: row.path,
    line: row.line,
    column: row.column,
    test: row.test,
  };
}

/** A file row from a path relative to the folder and the matched indexes in that path. */
export function fileRowFromHit(hit: { path: string; indices: number[] }): FileRow {
  const slash = hit.path.lastIndexOf('/');
  return {
    type: 'file',
    key: hit.path,
    name: hit.path.slice(slash + 1),
    folder: slash > 0 ? hit.path.slice(0, slash) : '',
    nameMatches: hit.indices.filter((i) => i > slash).map((i) => i - slash - 1),
    folderMatches: hit.indices.filter((i) => i < slash),
  };
}

/** The minimal shape of a language server hit (see `LspSymbolHit` in the lsp feature). */
export interface LspHitLike {
  name: string;
  kind: number;
  containerName?: string;
  path: string;
  line: number;
  column: number;
}

function matchesOf(query: string, name: string): number[] {
  const q = query.replace(/[\s*.#]/g, '');
  if (!q) return [];
  return fuzzyMatch(q, name)?.indexes ?? [];
}

/** Class-like results of language servers as class rows. Other kinds are dropped. */
export function lspClassRows(hits: readonly LspHitLike[], query: string): ClassRow[] {
  const out: ClassRow[] = [];
  for (const h of hits) {
    const kind = lspClassKind(h.kind);
    if (!kind) continue;
    out.push({
      type: 'class',
      key: classKey(h.path, h.name),
      name: h.name,
      nameMatches: matchesOf(query, h.name),
      container: h.containerName ?? '',
      containerMatches: [],
      kind,
      lang: langOfPath(h.path),
      path: h.path,
      line: h.line,
      column: h.column,
      test: isTestPath(h.path),
      lsp: true,
    });
  }
  return out;
}

/** Function, method and field results of language servers as symbol rows. */
export function lspSymbolRows(hits: readonly LspHitLike[], query: string): SymbolRow[] {
  const out: SymbolRow[] = [];
  for (const h of hits) {
    const kind = lspSymbolKind(h.kind);
    if (!kind) continue;
    out.push({
      type: 'symbol',
      key: `${h.path}:${h.line}:${h.column}#${h.name}`,
      name: h.name,
      nameMatches: matchesOf(query, h.name),
      params: '',
      valueType: '',
      owner: h.containerName ?? '',
      kind,
      lang: langOfPath(h.path),
      path: h.path,
      line: h.line,
      column: h.column,
      test: isTestPath(h.path),
      lsp: true,
    });
  }
  return out;
}

/** Text rows from the batches of `searchText`. One row per matching line. */
export function textRowsFromFiles(files: readonly FileMatches[], relative: (path: string) => string, max: number): TextRow[] {
  const out: TextRow[] = [];
  for (const f of files) {
    const rel = relative(f.path);
    for (const m of f.matches) {
      if (out.length >= max) return out;
      const first = m.ranges[0];
      out.push({
        type: 'text',
        key: `${f.path}:${m.line}:${first ? first[0] : 0}`,
        path: f.path,
        rel,
        line: m.line,
        column: m.offset + (first ? first[0] : 0) + 1,
        text: m.text,
        ranges: m.ranges,
      });
    }
  }
  return out;
}

// --- actions -----------------------------------------------------------------

export interface ActionInput {
  id: string;
  title: string;
  category?: string;
  keyLabel?: string;
}

/**
 * Actions that match the query, best first. With an empty query all actions
 * come back: the recent ones first (`recentIds`, newest first), then by title.
 */
export function matchActions(actions: readonly ActionInput[], query: string, recentIds: readonly string[] = []): ActionRow[] {
  const toRow = (a: ActionInput, nameMatches: number[]): ActionRow => ({
    type: 'action',
    key: a.id,
    id: a.id,
    title: a.title,
    category: a.category ?? '',
    keyLabel: a.keyLabel ?? '',
    nameMatches,
  });
  const q = query.trim();
  if (!q) {
    const rank = new Map(recentIds.map((id, i) => [id, i]));
    return [...actions]
      .sort((a, b) => {
        const ra = rank.get(a.id);
        const rb = rank.get(b.id);
        if (ra !== undefined || rb !== undefined) return (ra ?? Infinity) - (rb ?? Infinity);
        return a.title.localeCompare(b.title);
      })
      .map((a) => toRow(a, []));
  }
  const scored = fuzzyFilter(
    actions,
    q,
    (a) => a.title,
    (a) => a.category,
  );
  const rank = new Map(recentIds.map((id, i) => [id, i]));
  // A command that the user ran lately gets a small push, as for classes.
  const rows = scored.map((s, i) => {
    const r = rank.get(s.item.id);
    return { s, i, pos: r === undefined ? i : i - (r < 5 ? 3 : 1) };
  });
  rows.sort((a, b) => a.pos - b.pos || a.i - b.i);
  return rows.map(({ s }) => toRow(s.item, s.labelIndexes));
}

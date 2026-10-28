// Pure logic of the Usages panel: grouping, filter, tree rows, next and previous.
// No DOM and no imports at run time, so the tests run in Node.
import type { UsageFile, UsageKind, UsageMatch, UsagesResult, UsageSymbol } from '../../ipc/code';

/** Where the usages came from. */
export type UsageSource = 'lsp' | 'index';

export type UsageSet = UsagesResult & { source: UsageSource };

export type GroupBy = 'kind' | 'file';

/** Order and names of the groups when the tree is grouped by kind. */
export const KIND_ORDER: readonly { kind: UsageKind; label: string }[] = [
  { kind: 'declaration', label: 'Declaration' },
  { kind: 'import', label: 'Imports' },
  { kind: 'supertype', label: 'Supertypes' },
  { kind: 'instantiation', label: 'New instances' },
  { kind: 'type', label: 'Type uses' },
  { kind: 'call', label: 'Calls' },
  { kind: 'reference', label: 'Other uses' },
];

export const MAYBE_GROUP_ID = 'maybe';

// --- Tree -----------------------------------------------------------------------

export interface MatchNode {
  type: 'match';
  id: string;
  path: string;
  match: UsageMatch;
}

export interface FileNode {
  type: 'file';
  id: string;
  path: string;
  /** Path relative to the workspace, with `/`. */
  rel: string;
  name: string;
  dir: string;
  count: number;
  children: MatchNode[];
}

export interface GroupNode {
  type: 'group';
  id: string;
  label: string;
  count: number;
  /** The group of files that only share the name. */
  maybe: boolean;
  children: FileNode[];
}

export type TreeNode = GroupNode | FileNode | MatchNode;

export interface Tree {
  roots: (GroupNode | FileNode)[];
  /** All matches in the order of the tree. */
  leaves: MatchNode[];
  /** Id of a node to the id of its parent (roots have no entry). */
  parent: Map<string, string>;
  byId: Map<string, TreeNode>;
}

export interface BuildOptions {
  groupBy: GroupBy;
  filter: string;
  /** Path relative to the workspace root. */
  rel: (path: string) => string;
}

function splitPath(path: string): { name: string; dir: string } {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortMatches(matches: UsageMatch[]): UsageMatch[] {
  return [...matches].sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Every word of the filter must be in the relative path or in the line text (not case sensitive). */
export function matchesFilter(rel: string, text: string, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${rel}\n${text}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Keeps the matches that pass the filter. Files without a match are dropped. */
export function filterFiles(files: UsageFile[], filter: string, rel: (path: string) => string): UsageFile[] {
  if (!filter.trim()) return files;
  const out: UsageFile[] = [];
  for (const f of files) {
    const r = rel(f.path);
    const matches = f.matches.filter((m) => matchesFilter(r, m.text, filter));
    if (matches.length) out.push({ ...f, matches });
  }
  return out;
}

export function countUsages(files: UsageFile[]): { matches: number; files: number } {
  let matches = 0;
  let count = 0;
  for (const f of files) {
    if (!f.matches.length) continue;
    matches += f.matches.length;
    count++;
  }
  return { matches, files: count };
}

export function matchId(path: string, m: UsageMatch): string {
  return `m|${path}|${m.line}|${m.column}`;
}

/** Builds the groups, files and matches that the panel shows. */
export function buildTree(files: UsageFile[], opts: BuildOptions): Tree {
  const shown = filterFiles(files, opts.filter, opts.rel).filter((f) => f.matches.length > 0);
  const sorted = shown
    .map((f) => ({ f, rel: opts.rel(f.path).replace(/\\/g, '/') }))
    .sort((a, b) => compareText(a.rel, b.rel));

  const tree: Tree = { roots: [], leaves: [], parent: new Map(), byId: new Map() };

  const addFile = (idPrefix: string, f: UsageFile, rel: string, matches: UsageMatch[]): FileNode => {
    const { name } = splitPath(f.path);
    const relDir = splitPath(rel).dir;
    const node: FileNode = {
      type: 'file',
      id: `${idPrefix}|${f.path}`,
      path: f.path,
      rel,
      name,
      dir: relDir || (rel === f.path ? splitPath(f.path).dir : ''),
      count: matches.length,
      children: sortMatches(matches).map((m) => ({ type: 'match', id: matchId(f.path, m), path: f.path, match: m })),
    };
    tree.byId.set(node.id, node);
    for (const c of node.children) {
      tree.byId.set(c.id, c);
      tree.parent.set(c.id, node.id);
      tree.leaves.push(c);
    }
    return node;
  };

  const likely = sorted.filter((x) => x.f.likely);
  const maybe = sorted.filter((x) => !x.f.likely);

  if (opts.groupBy === 'file') {
    for (const x of likely) {
      const node = addFile('f', x.f, x.rel, x.f.matches);
      tree.roots.push(node);
      tree.byId.set(node.id, node);
    }
  } else {
    for (const { kind, label } of KIND_ORDER) {
      const children: FileNode[] = [];
      const id = `kind:${kind}`;
      for (const x of likely) {
        const matches = x.f.matches.filter((m) => m.kind === kind);
        if (matches.length) children.push(addFile(id, x.f, x.rel, matches));
      }
      if (!children.length) continue;
      const group: GroupNode = {
        type: 'group',
        id,
        label,
        count: children.reduce((n, c) => n + c.count, 0),
        maybe: false,
        children,
      };
      tree.roots.push(group);
      tree.byId.set(id, group);
      for (const c of children) tree.parent.set(c.id, id);
    }
  }

  if (maybe.length) {
    const children = maybe.map((x) => addFile(MAYBE_GROUP_ID, x.f, x.rel, x.f.matches));
    const group: GroupNode = {
      type: 'group',
      id: MAYBE_GROUP_ID,
      label: `Same name, maybe other symbols (${children.reduce((n, c) => n + c.count, 0)})`,
      count: children.reduce((n, c) => n + c.count, 0),
      maybe: true,
      children,
    };
    tree.roots.push(group);
    tree.byId.set(group.id, group);
    for (const c of children) tree.parent.set(c.id, group.id);
  }

  // In by-file mode the files of roots were added to byId already. Make sure every file is known.
  for (const root of tree.roots) tree.byId.set(root.id, root);
  return tree;
}

// --- Open and closed nodes ------------------------------------------------------

/**
 * Which nodes are open. Groups and files are open at first, except the group
 * "same name, maybe other symbols". While a filter is active that group opens too,
 * so the user sees what the filter found.
 */
export class Expansion {
  private readonly state = new Map<string, boolean>();

  constructor(public filterActive = false) {}

  isOpen(node: TreeNode): boolean {
    if (node.type === 'match') return true;
    const set = this.state.get(node.id);
    if (set !== undefined) return set;
    if (node.type === 'group' && node.maybe) return this.filterActive;
    return true;
  }

  set(id: string, open: boolean): void {
    this.state.set(id, open);
  }

  toggle(node: TreeNode): void {
    if (node.type !== 'match') this.state.set(node.id, !this.isOpen(node));
  }

  expandAll(tree: Tree): void {
    for (const node of tree.byId.values()) if (node.type !== 'match') this.state.set(node.id, true);
  }

  collapseAll(tree: Tree): void {
    for (const node of tree.byId.values()) if (node.type !== 'match') this.state.set(node.id, false);
  }

  /** Opens all parents of a node. Returns true when something changed. */
  reveal(tree: Tree, id: string): boolean {
    let changed = false;
    let p = tree.parent.get(id);
    while (p !== undefined) {
      const node = tree.byId.get(p);
      if (node && !this.isOpen(node)) {
        this.state.set(p, true);
        changed = true;
      }
      p = tree.parent.get(p);
    }
    return changed;
  }
}

export interface Row {
  node: TreeNode;
  depth: number;
  open: boolean;
}

/** The rows the panel shows, in order. Closed nodes hide their children. */
export function flatten(tree: Tree, expansion: Expansion): Row[] {
  const rows: Row[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    const open = expansion.isOpen(node);
    rows.push({ node, depth, open });
    if (node.type === 'match' || !open) return;
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of tree.roots) walk(root, 0);
  return rows;
}

/** The parent row of a row index, or -1. */
export function parentIndex(rows: Row[], tree: Tree, index: number): number {
  const parentId = tree.parent.get(rows[index]?.node.id ?? '');
  if (parentId === undefined) return -1;
  return rows.findIndex((r) => r.node.id === parentId);
}

// --- Next and previous ------------------------------------------------------------

/** The match after or before the current one. Wraps around. null when the list is empty. */
export function stepMatch(order: MatchNode[], currentId: string | null, dir: 1 | -1): MatchNode | null {
  if (!order.length) return null;
  const i = currentId === null ? -1 : order.findIndex((m) => m.id === currentId);
  if (i < 0) return dir === 1 ? order[0]! : order[order.length - 1]!;
  return order[(i + dir + order.length) % order.length]!;
}

// --- Text -----------------------------------------------------------------------

export interface Segment {
  text: string;
  hit: boolean;
}

/** Splits a line in the text before the name, the name and the text after it. */
export function segments(text: string, range: [number, number]): Segment[] {
  const from = Math.min(Math.max(range[0], 0), text.length);
  const to = Math.min(Math.max(range[1], from), text.length);
  const out: Segment[] = [];
  if (from > 0) out.push({ text: text.slice(0, from), hit: false });
  if (to > from) out.push({ text: text.slice(from, to), hit: true });
  if (to < text.length) out.push({ text: text.slice(to), hit: false });
  if (!out.length) out.push({ text, hit: false });
  return out;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "42 usages in 12 files". */
export function summaryText(files: UsageFile[], truncated: boolean): string {
  const c = countUsages(files);
  if (!c.matches) return 'No usages found';
  const text = `${plural(c.matches, 'usage')} in ${plural(c.files, 'file')}`;
  return truncated ? `${text} (limit reached)` : text;
}

export function sourceLabel(source: UsageSource): string {
  return source === 'lsp' ? 'Language server' : 'Kestrel index';
}

export function otherSource(source: UsageSource): UsageSource {
  return source === 'lsp' ? 'index' : 'lsp';
}

const SYMBOL_WORDS: Record<UsageSymbol['kind'], string> = {
  type: 'type',
  member: 'member',
  topLevel: 'top-level',
  local: 'local',
  unknown: '',
};

/** Words for `UsageSymbol.detail`. Kinds that are not listed show as they are (`class`, `struct`). */
const DETAIL_WORDS: Record<string, string> = {
  typeAlias: 'type alias',
  enumCase: 'enum case',
  function: 'function',
  variable: 'variable',
  parameter: 'parameter',
};

/** Name and kind of the symbol for the header: `class FooService`, `method save` in `Owner`. */
export function describeSymbol(
  symbol: UsageSymbol | null,
  fallbackName: string,
): { kind: string; name: string; owner: string } {
  if (!symbol) return { kind: '', name: fallbackName, owner: '' };
  return {
    kind: symbol.detail ? (DETAIL_WORDS[symbol.detail] ?? symbol.detail) : SYMBOL_WORDS[symbol.kind],
    name: symbol.name || fallbackName,
    owner: symbol.kind === 'member' || symbol.kind === 'topLevel' ? (symbol.owner ?? '') : '',
  };
}

// --- Position and name ------------------------------------------------------------

const WORD = /[\p{L}\p{N}_$]/u;

/** The name at a column (0-based, UTF-16). A cursor right after a name counts as on the name. */
export function wordAt(line: string, col: number): { from: number; to: number } | null {
  const isWord = (i: number) => i >= 0 && i < line.length && WORD.test(String.fromCodePoint(line.codePointAt(i)!));
  let at = col;
  if (!isWord(at)) {
    if (isWord(at - 1)) at -= 1;
    else return null;
  }
  let from = at;
  let to = at + 1;
  while (isWord(from - 1)) from--;
  while (isWord(to)) to++;
  return { from, to };
}

/**
 * Column (1-based) to send for a cursor column (1-based). When the cursor is right
 * after a name, the column moves into the name.
 */
export function nameColumn(line: string, column: number): number {
  const w = wordAt(line, column - 1);
  if (!w) return column;
  return Math.min(Math.max(column, w.from + 1), w.to);
}

// --- History ------------------------------------------------------------------------

export interface HistoryEntry<T> {
  key: string;
  label: string;
  data: T;
}

export const HISTORY_SIZE = 10;

/** Puts an entry first. An older entry with the same key goes away. */
export function pushHistory<T>(list: HistoryEntry<T>[], entry: HistoryEntry<T>, max = HISTORY_SIZE): HistoryEntry<T>[] {
  return [entry, ...list.filter((e) => e.key !== entry.key)].slice(0, max);
}

// --- Language server answer to our model ----------------------------------------------

/** A location of the server, with the URI already turned into a path. Lines and characters start at 0. */
export interface LspHit {
  path: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

/** Cuts a long line around the name. The range moves with the text. */
export function cutLine(
  text: string,
  start: number,
  end: number,
  max = 240,
): { text: string; range: [number, number] } {
  if (text.length <= max) return { text, range: [start, end] };
  const from = Math.max(0, start - 80);
  const to = Math.min(text.length, from + max);
  const head = from > 0 ? '…' : '';
  const tail = to < text.length ? '…' : '';
  return {
    text: head + text.slice(from, to) + tail,
    range: [head.length + Math.min(start, to) - from, head.length + Math.min(end, to) - from],
  };
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Builds the result model from the locations of `textDocument/references`.
 * `at` is the position of the request (1-based). A location that covers it is the
 * declaration, all others are references. A line that starts with `import ` is an import.
 */
export function lspToResult(
  hits: LspHit[],
  at: { path: string; line: number; column: number },
  lineText: (path: string, line: number) => string,
  name: string,
  elapsedMs: number,
  max = 5000,
): UsageSet {
  const seen = new Set<string>();
  const byPath = new Map<string, UsageMatch[]>();
  let total = 0;
  let truncated = false;
  for (const hit of hits) {
    const key = `${hit.path}|${hit.line}|${hit.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (total >= max) {
      truncated = true;
      break;
    }
    const raw = lineText(hit.path, hit.line);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    const end = hit.endLine === hit.line ? hit.endCharacter : raw.length;
    const start = Math.min(Math.max(hit.character - lead, 0), trimmed.length);
    const stop = Math.min(Math.max(end - lead, start), trimmed.length);
    const cut = cutLine(trimmed, start, stop);
    const covers =
      normPath(hit.path) === normPath(at.path) &&
      hit.line + 1 === at.line &&
      at.column - 1 >= hit.character &&
      at.column - 1 <= end;
    const kind: UsageKind = covers ? 'declaration' : /^import\s/.test(trimmed) ? 'import' : 'reference';
    const match: UsageMatch = { line: hit.line + 1, column: hit.character + 1, text: cut.text, range: cut.range, kind };
    const list = byPath.get(hit.path);
    if (list) list.push(match);
    else byPath.set(hit.path, [match]);
    total++;
  }
  const files: UsageFile[] = [...byPath.entries()].map(([path, matches]) => ({ path, likely: true, matches }));
  const first = files[0]?.matches[0];
  const symbolName = name || (first ? first.text.slice(first.range[0], first.range[1]) : '');
  return {
    symbol: { name: symbolName, kind: 'unknown', lang: null },
    files,
    total,
    truncated,
    exact: true,
    fileOnly: false,
    elapsedMs,
    source: 'lsp',
  };
}

// --- Time limit ------------------------------------------------------------------------

/** Rejects with `Error('timeout')` when the promise needs more than `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

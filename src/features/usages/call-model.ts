// Pure logic of the Call Hierarchy panel: the lazy caller tree, the filters,
// "Expand All" with its limits, the rows, and the mapping from language server answers.
// No DOM, so the tests run in Node.
import type { CallSite, CallTarget, CallerNode } from '../../ipc/code';
import { cutLine, type UsageSource } from './model';

// --- Items ------------------------------------------------------------------------

/** A method, constructor or other code that is in the tree. */
export interface CallItem {
  /** Same key for the same method. Used for the cache and to find recursion. */
  key: string;
  name: string;
  /** `method`, `constructor`, `function`, `property`, `initializer` ... */
  kindWord: string;
  /** Simple name of the type that declares it. Empty for top-level code. */
  owner: string;
  /** Package or folder, shown in grey. */
  container: string;
  /** `Type.method(params)`. */
  title: string;
  path: string;
  line: number;
  column: number;
  /** Length of the name, to select it in the editor. */
  nameLength: number;
  /** The raw item for the index, to ask for its callers. */
  index?: CallTarget;
  /** The raw LSP `CallHierarchyItem`, to ask for its callers. */
  lsp?: unknown;
}

export interface CallEdge {
  item: CallItem;
  sites: CallSite[];
  likely: boolean;
  test: boolean;
}

function lastSegment(qualified: string): string {
  const i = qualified.lastIndexOf('.');
  return i < 0 ? qualified : qualified.slice(i + 1);
}

function parentSegments(qualified: string): string {
  const i = qualified.lastIndexOf('.');
  return i < 0 ? '' : qualified.slice(0, i);
}

/** Item for a target of the code index. `folder` is shown when the type has no package. */
export function itemFromTarget(t: CallTarget, folder: string): CallItem {
  const owner = lastSegment(t.owner);
  let title: string;
  switch (t.kind) {
    case 'constructor':
      title = `${owner || t.name}(${t.params})`;
      break;
    case 'initializer':
      title = owner ? `${owner} (initializer)` : `${t.name} (initializer)`;
      break;
    case 'property':
      title = owner ? `${owner}.${t.name}` : t.name;
      break;
    default:
      title = `${owner ? `${owner}.` : ''}${t.name}(${t.params})`;
  }
  return {
    key: `${t.owner}#${t.name}#${t.kind}(${t.params})@${t.path}`,
    name: t.name,
    kindWord: t.kind,
    owner,
    container: parentSegments(t.owner) || folder,
    title,
    path: t.path,
    line: t.line,
    column: t.column,
    nameLength: t.name.length,
    index: t,
  };
}

export function edgeFromCaller(c: CallerNode, folder: (path: string) => string): CallEdge {
  return { item: itemFromTarget(c.caller, folder(c.caller.path)), sites: c.sites, likely: c.likely, test: c.test };
}

// --- Language server answers ---------------------------------------------------------

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspCallItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}
export interface LspIncomingCall {
  from: LspCallItem;
  fromRanges: LspRange[];
}

const SYMBOL_WORDS: Record<number, string> = {
  5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 12: 'function', 13: 'variable', 22: 'enum member',
};

/** Words that mark a file as test code. Same idea as `CallerNode.test`. */
export function isTestPath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/');
  const file = parts.pop() ?? '';
  if (parts.some((p) => /^(test|tests|androidTest|testByKotest|__tests__|spec)$/i.test(p) || /^test[A-Z]/.test(p))) return true;
  return /(Test|Tests|Spec)\.[A-Za-z]+$/.test(file) || /\.(test|spec)\.[a-z]+$/.test(file);
}

/**
 * The item of a language server. `lineText(path, line0)` gives the text of a line,
 * for the name length. `pathOf` turns the URI into a path (null: not a file).
 */
export function itemFromLsp(
  it: LspCallItem,
  pathOf: (uri: string) => string | null,
  folder: (path: string) => string,
): CallItem | null {
  const path = pathOf(it.uri);
  if (path === null) return null;
  const sel = it.selectionRange ?? it.range;
  const word = SYMBOL_WORDS[it.kind] ?? 'method';
  // Servers write `save(Foo)`, `save`, or `Foo.save`. We show what they send.
  const name = it.name.replace(/\(.*$/, '').split('.').pop() ?? it.name;
  return {
    key: `${path}#${sel.start.line}:${sel.start.character}`,
    name,
    kindWord: word,
    owner: it.detail && /^[\w.$]+$/.test(it.detail) ? lastSegment(it.detail) : '',
    container: it.detail && !/^[\w.$]+$/.test(it.detail) ? it.detail : folder(path),
    title: it.name,
    path,
    line: sel.start.line + 1,
    column: sel.start.character + 1,
    nameLength: Math.max(sel.end.character - sel.start.character, 1),
    lsp: it,
  };
}

/** Edges for `callHierarchy/incomingCalls`. `lineText` gives a line (0-based) of a file. */
export function edgesFromLsp(
  calls: LspIncomingCall[],
  pathOf: (uri: string) => string | null,
  folder: (path: string) => string,
  lineText: (path: string, line: number) => string,
): CallEdge[] {
  const out: CallEdge[] = [];
  for (const call of calls) {
    const item = itemFromLsp(call.from, pathOf, folder);
    if (!item) continue;
    const sites: CallSite[] = call.fromRanges.map((r) => {
      const raw = lineText(item.path, r.start.line);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      const end = r.end.line === r.start.line ? r.end.character : raw.length;
      const start = Math.min(Math.max(r.start.character - lead, 0), text.length);
      const stop = Math.min(Math.max(end - lead, start), text.length);
      const cut = cutLine(text, start, stop);
      return { line: r.start.line + 1, column: r.start.character + 1, text: cut.text, range: cut.range };
    });
    sites.sort((a, b) => a.line - b.line || a.column - b.column);
    out.push({ item, sites, likely: true, test: isTestPath(item.path) });
  }
  out.sort((a, b) => (a.item.path < b.item.path ? -1 : a.item.path > b.item.path ? 1 : a.item.line - b.item.line));
  return out;
}

// --- Tree -----------------------------------------------------------------------------

export type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

export interface CallNode {
  id: string;
  item: CallItem;
  parent: CallNode | null;
  /** 0 for the root. */
  depth: number;
  sites: CallSite[];
  likely: boolean;
  test: boolean;
  /** The same method is already on the path to the root. Such a node has no children. */
  recursive: boolean;
  open: boolean;
  /** The group "Same name, maybe other methods" under this node is open. */
  sameOpen: boolean;
  load: LoadState;
  error: string;
  callers: CallNode[];
}

export interface CallTree {
  source: UsageSource;
  root: CallNode;
  /** False when the index only matched names. */
  exact: boolean;
}

export interface Filters {
  hideTest: boolean;
}

function makeNode(item: CallItem, parent: CallNode | null, id: string): CallNode {
  return {
    id, item, parent, depth: parent ? parent.depth + 1 : 0, sites: [], likely: true, test: false,
    recursive: false, open: false, sameOpen: false, load: 'idle', error: '', callers: [],
  };
}

export function createTree(item: CallItem, source: UsageSource, exact: boolean): CallTree {
  const root = makeNode(item, null, 'root');
  root.open = true;
  return { source, root, exact };
}

/** True when `item` is the node or one of its parents. */
export function onPath(node: CallNode, key: string): boolean {
  for (let n: CallNode | null = node; n; n = n.parent) if (n.item.key === key) return true;
  return false;
}

/** Sets the callers of a node. A caller that is on the path to the root is marked recursive. */
export function setCallers(node: CallNode, edges: CallEdge[]): void {
  const used = new Set<string>();
  node.callers = edges.map((e) => {
    let id = `${node.id}/${e.item.key}`;
    for (let n = 2; used.has(id); n++) id = `${node.id}/${e.item.key}~${n}`;
    used.add(id);
    const c = makeNode(e.item, node, id);
    c.sites = e.sites;
    c.likely = e.likely;
    c.test = e.test;
    c.recursive = onPath(node, e.item.key);
    return c;
  });
  node.load = 'loaded';
  node.error = '';
}

/** The callers that are shown as normal rows: likely ones, without test code when it is hidden. */
export function visibleCallers(node: CallNode, f: Filters): CallNode[] {
  return node.callers.filter((c) => c.likely && !(f.hideTest && c.test));
}

/** The callers in the group "Same name, maybe other methods". */
export function sameNameCallers(node: CallNode, f: Filters): CallNode[] {
  return node.callers.filter((c) => !c.likely && !(f.hideTest && c.test));
}

export function sameGroupId(node: CallNode): string {
  return `${node.id}|same`;
}

/** A node can open when it is not recursive. */
export function canOpen(node: CallNode): boolean {
  return !node.recursive;
}

export function findNode(tree: CallTree, id: string): CallNode | null {
  const walk = (n: CallNode): CallNode | null => {
    if (n.id === id) return n;
    for (const c of n.callers) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  return walk(tree.root);
}

export function countNodes(tree: CallTree): number {
  const walk = (n: CallNode): number => n.callers.reduce((s, c) => s + walk(c), 1);
  return walk(tree.root);
}

// --- Rows ------------------------------------------------------------------------------

export type CallRow =
  | { kind: 'node'; id: string; node: CallNode; depth: number; open: boolean }
  | { kind: 'group'; id: string; node: CallNode; depth: number; open: boolean; count: number; label: string }
  | { kind: 'site'; id: string; node: CallNode; site: CallSite; depth: number }
  | { kind: 'loading'; id: string; node: CallNode; depth: number }
  | { kind: 'error'; id: string; node: CallNode; depth: number; text: string }
  | { kind: 'note'; id: string; node: CallNode; depth: number; text: string };

/** The rows to show. Children of a closed or recursive node are not listed. */
export function flattenCalls(tree: CallTree, f: Filters): CallRow[] {
  const rows: CallRow[] = [];
  const walk = (n: CallNode, depth: number): void => {
    const open = n.open && canOpen(n);
    rows.push({ kind: 'node', id: n.id, node: n, depth, open });
    if (!open) return;
    const d = depth + 1;
    if (n.load === 'loading' || n.load === 'idle') {
      rows.push({ kind: 'loading', id: `${n.id}|status`, node: n, depth: d });
      return;
    }
    if (n.load === 'error') {
      rows.push({ kind: 'error', id: `${n.id}|status`, node: n, depth: d, text: n.error });
      return;
    }
    n.sites.forEach((site, i) => rows.push({ kind: 'site', id: `${n.id}|s${i}`, node: n, site, depth: d }));
    const shown = visibleCallers(n, f);
    for (const c of shown) walk(c, d);
    const same = sameNameCallers(n, f);
    if (!shown.length) {
      let text = 'No callers found.';
      if (n.callers.some((c) => c.likely)) text = 'The filters hide all direct callers.';
      else if (n.callers.length) text = 'No direct callers found.';
      rows.push({ kind: 'note', id: `${n.id}|status`, node: n, depth: d, text });
    }
    if (same.length) {
      rows.push({
        kind: 'group', id: sameGroupId(n), node: n, depth: d, open: n.sameOpen, count: same.length,
        label: `Same name, maybe other methods (${same.length})`,
      });
      if (n.sameOpen) for (const c of same) walk(c, d + 1);
    }
  };
  walk(tree.root, 0);
  return rows;
}

/** Close every node except the root. */
export function collapseAll(tree: CallTree): void {
  const walk = (n: CallNode): void => {
    n.open = n === tree.root;
    n.sameOpen = false;
    n.callers.forEach(walk);
  };
  walk(tree.root);
}

/** Opens all parents of a node. */
export function revealNode(node: CallNode): void {
  for (let c = node, p = node.parent; p; c = p, p = p.parent) {
    p.open = true;
    if (!c.likely) p.sameOpen = true;
  }
}

export const EXPAND_DEPTH = 3;
export const EXPAND_MAX_NODES = 500;

/**
 * Opens every node down to `maxDepth`, loading the callers that are not loaded yet.
 * It counts the nodes it shows and stops adding after `maxNodes`. `load` must set
 * the state of the node (`loaded` or `error`). Nodes load in small batches.
 */
export async function expandAll(
  tree: CallTree,
  filters: Filters,
  load: (node: CallNode) => Promise<void>,
  opts: { maxDepth?: number; maxNodes?: number; batch?: number; cancelled: () => boolean; onProgress?: (nodes: number) => void },
): Promise<{ nodes: number; limited: boolean }> {
  const maxDepth = opts.maxDepth ?? EXPAND_DEPTH;
  const maxNodes = opts.maxNodes ?? EXPAND_MAX_NODES;
  const batch = opts.batch ?? 4;
  let count = 1;
  let limited = false;
  let level: CallNode[] = [tree.root];
  while (level.length && !opts.cancelled()) {
    const next: CallNode[] = [];
    const todo = level.filter((n) => canOpen(n) && n.depth < maxDepth);
    for (let i = 0; i < todo.length && !opts.cancelled(); i += batch) {
      const chunk = todo.slice(i, i + batch);
      await Promise.all(chunk.map((n) => (n.load === 'loaded' ? Promise.resolve() : load(n))));
      if (opts.cancelled()) break;
      for (const n of chunk) {
        if (n.load !== 'loaded') continue;
        n.open = true;
        for (const c of visibleCallers(n, filters)) {
          if (count >= maxNodes) {
            limited = true;
            continue;
          }
          count++;
          next.push(c);
        }
      }
      opts.onProgress?.(count);
    }
    level = next;
  }
  return { nodes: count, limited };
}

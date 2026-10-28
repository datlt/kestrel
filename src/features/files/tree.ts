// Tree model of the explorer. It has no DOM code. It loads one folder level at a time.

import type { DirEntry } from '../../ipc/fs';
import { dirname, joinPath } from '../../core/util';

export interface TreeNode {
  /** Name of the folder or file. For a compact row: the name of the deepest folder. */
  name: string;
  /** Absolute path. For a compact row: the deepest folder. The row acts on this path. */
  path: string;
  /** Path relative to the root, with `/` separators. Also the deepest folder for a compact row. */
  rel: string;
  /** Compact row: names of all joined folders, top folder first. */
  chain: string[] | null;
  chainStyle: 'slash' | 'dot';
  /** Compact row: absolute paths of all joined folders, top folder first. The last one is `path`. */
  chainPaths: string[];
  isDir: boolean;
  isSymlink: boolean;
  ignored: boolean;
  /** Root children have depth 0. */
  depth: number;
  parent: TreeNode | null;
  expanded: boolean;
  /** null until the folder is loaded. */
  children: TreeNode[] | null;
  loading: boolean;
  /** Matches `files.exclude`. Hidden nodes are not listed. */
  hidden: boolean;
  /** A temporary row where the user types the name of a new file or folder. */
  pending?: 'file' | 'dir';
}

export interface TreeDeps {
  list(dir: string, root: string): Promise<DirEntry[]>;
  isExcluded(rel: string): boolean;
  /** Called for load errors the user should see. */
  onError(message: string, path: string): void;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class TreeModel {
  root: TreeNode | null = null;
  /** The visible rows, top to bottom. */
  rows: TreeNode[] = [];
  /** All loaded nodes by absolute path. */
  readonly byPath = new Map<string, TreeNode>();
  /** Folders that are inside a compact row but not its deepest folder, mapped to that row. */
  readonly chainIndex = new Map<string, TreeNode>();
  onChange: () => void = () => {};
  private generation = 0;
  private loads = new Map<string, Promise<void>>();

  constructor(private deps: TreeDeps) {}

  async setRoot(path: string | null): Promise<void> {
    const gen = ++this.generation;
    this.byPath.clear();
    this.chainIndex.clear();
    this.loads.clear();
    this.rows = [];
    if (path === null) {
      this.root = null;
      this.onChange();
      return;
    }
    this.root = {
      name: path,
      path,
      rel: '',
      chain: null,
      chainStyle: 'slash',
      chainPaths: [],
      isDir: true,
      isSymlink: false,
      ignored: false,
      depth: -1,
      parent: null,
      expanded: true,
      children: null,
      loading: false,
      hidden: false,
    };
    this.byPath.set(path, this.root);
    this.onChange();
    await this.load(this.root);
    if (gen === this.generation) this.rebuild();
  }

  /** Re-applies `files.exclude` to all loaded nodes. */
  applyExclude(): void {
    for (const n of this.byPath.values()) {
      if (!n.parent) continue;
      // A compact row is hidden by its top folder.
      const rel = n.chain ? (n.parent.rel ? `${n.parent.rel}/${n.chain[0]}` : n.chain[0]) : n.rel;
      n.hidden = this.deps.isExcluded(rel);
    }
    this.rebuild();
  }

  rebuild(): void {
    const rows: TreeNode[] = [];
    const walk = (n: TreeNode) => {
      for (const c of n.children ?? []) {
        if (c.hidden) continue;
        rows.push(c);
        if (c.isDir && c.expanded && c.children) walk(c);
      }
    };
    if (this.root) walk(this.root);
    this.rows = rows;
    this.onChange();
  }

  /** The node of a folder. A folder inside a compact row gives the row. */
  nodeAt(path: string): TreeNode | undefined {
    return this.byPath.get(path) ?? this.chainIndex.get(path);
  }

  /** True when a change in this folder can change the tree (a known folder or a folder inside a compact row). */
  knows(path: string): boolean {
    return this.byPath.has(path) || this.chainIndex.has(path);
  }

  /** Path of the deepest folder of a listed entry. */
  private static deepestPath(e: DirEntry): string {
    return e.compact?.length ? joinPath(e.path, ...e.compact) : e.path;
  }

  private makeNode(parent: TreeNode, e: DirEntry): TreeNode {
    const topRel = parent.rel ? `${parent.rel}/${e.name}` : e.name;
    const names = e.compact?.length ? [e.name, ...e.compact] : null;
    const rel = names ? (parent.rel ? `${parent.rel}/${names.join('/')}` : names.join('/')) : topRel;
    const chainPaths = names ? names.map((_, i) => (i === 0 ? e.path : joinPath(e.path, ...names.slice(1, i + 1)))) : [];
    return {
      name: names ? names[names.length - 1] : e.name,
      path: TreeModel.deepestPath(e),
      rel,
      chain: names,
      chainStyle: e.compactStyle ?? 'slash',
      chainPaths,
      isDir: e.isDir,
      isSymlink: e.isSymlink,
      ignored: e.ignored,
      depth: parent.depth + 1,
      parent,
      expanded: false,
      children: null,
      loading: false,
      hidden: this.deps.isExcluded(topRel),
    };
  }

  private forget(n: TreeNode): void {
    this.byPath.delete(n.path);
    for (const p of n.chainPaths) if (this.chainIndex.get(p) === n) this.chainIndex.delete(p);
    for (const c of n.children ?? []) this.forget(c);
  }

  /** Reads the folder and merges the result into the node. Known nodes keep their state. */
  private load(node: TreeNode): Promise<void> {
    const running = this.loads.get(node.path);
    if (running) return running;
    const gen = this.generation;
    const root = this.root!.path;
    node.loading = true;
    const p = (async () => {
      let entries: DirEntry[];
      try {
        entries = await this.deps.list(node.path, root);
      } catch (e) {
        if (gen === this.generation) {
          // A folder that was deleted meanwhile is not an error. The parent refresh removes it.
          const code = (e as { code?: string }).code;
          if (code !== 'not_found') this.deps.onError(errorText(e), node.path);
          if (node !== this.root) node.expanded = false;
        }
        return;
      } finally {
        node.loading = false;
        this.loads.delete(node.path);
      }
      if (gen !== this.generation) return;
      const old = new Map<string, TreeNode>();
      for (const c of node.children ?? []) old.set(c.path, c);
      const next: TreeNode[] = [];
      for (const e of entries) {
        const deepest = TreeModel.deepestPath(e);
        const known = old.get(deepest);
        if (known && known.isDir === e.isDir) {
          known.ignored = e.ignored;
          known.isSymlink = e.isSymlink;
          next.push(known);
          old.delete(deepest);
        } else {
          const n = this.makeNode(node, e);
          this.byPath.set(n.path, n);
          for (const p of n.chainPaths.slice(0, -1)) this.chainIndex.set(p, n);
          next.push(n);
        }
      }
      for (const gone of old.values()) {
        if (gone.pending) next.unshift(gone);
        else this.forget(gone);
      }
      node.children = next;
    })();
    this.loads.set(node.path, p);
    return p;
  }

  async expand(node: TreeNode): Promise<void> {
    if (!node.isDir) return;
    node.expanded = true;
    if (node.children) {
      this.rebuild();
      return;
    }
    this.onChange();
    await this.load(node);
    this.rebuild();
  }

  collapse(node: TreeNode): void {
    node.expanded = false;
    this.rebuild();
  }

  async toggle(node: TreeNode): Promise<void> {
    if (node.expanded) this.collapse(node);
    else await this.expand(node);
  }

  collapseAll(): void {
    for (const n of this.byPath.values()) if (n !== this.root) n.expanded = false;
    this.rebuild();
  }

  /** Reloads these folders (only the ones that are loaded). */
  async refresh(dirs: Iterable<string>): Promise<void> {
    const jobs: Promise<void>[] = [];
    // Folders of compact rows: the row may need a new chain, so the listed parent is read again afterwards.
    const parents = new Set<TreeNode>();
    for (const d of dirs) {
      const n = this.byPath.get(d);
      if (n && n.isDir && n.children && (n === this.root || this.isShown(n))) jobs.push(this.load(n));
      const row = n?.chain ? n : this.chainIndex.get(d);
      if (row?.parent && row.parent.children && (row.parent === this.root || this.isShown(row.parent))) parents.add(row.parent);
    }
    if (!jobs.length && !parents.size) return;
    await Promise.all(jobs);
    // Read the parents after the rows, so the old row is not replaced while it loads.
    await Promise.all([...parents].map((p) => this.load(p)));
    this.rebuild();
  }

  /** Reloads the root and every expanded folder. */
  async refreshAll(): Promise<void> {
    const dirs: string[] = [];
    for (const n of this.byPath.values()) if (n.isDir && n.children && (n === this.root || n.expanded)) dirs.push(n.path);
    await this.refresh(dirs);
  }

  /** True when every parent of the node is expanded. */
  private isShown(n: TreeNode): boolean {
    for (let p = n.parent; p; p = p.parent) if (!p.expanded) return false;
    return true;
  }

  /** Paths of the expanded folders, relative to the root. */
  expandedPaths(): string[] {
    const out: string[] = [];
    for (const n of this.byPath.values()) {
      if (n === this.root || !n.isDir || !n.expanded) continue;
      out.push(n.rel);
      // The folders inside a compact row are open too. Saving them keeps the state when the setting changes.
      if (n.chain) {
        const base = n.parent?.rel ?? '';
        for (let k = 1; k < n.chain.length; k++) out.push([base, ...n.chain.slice(0, k)].filter(Boolean).join('/'));
      }
    }
    return out.sort();
  }

  /** Expands saved folders level by level. Folders that no longer exist are skipped. */
  async restoreExpanded(rels: string[]): Promise<void> {
    if (!this.root) return;
    const gen = this.generation;
    const byDepth = new Map<number, string[]>();
    for (const r of rels) {
      const d = r.split('/').length;
      byDepth.set(d, [...(byDepth.get(d) ?? []), r]);
    }
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      const jobs: Promise<void>[] = [];
      for (const rel of byDepth.get(depth)!) {
        const n = this.nodeAt(joinPath(this.root.path, ...rel.split('/')));
        if (n && n.isDir && n.parent?.expanded) {
          n.expanded = true;
          if (!n.children) jobs.push(this.load(n));
        }
      }
      await Promise.all(jobs);
      if (gen !== this.generation) return;
    }
    this.rebuild();
  }

  /** Expands the parents of `path` (loading them) and returns the node, if it exists. */
  async reveal(path: string): Promise<TreeNode | null> {
    if (!this.root) return null;
    const gen = this.generation;
    // Paths that are not loaded yet, outermost first.
    const chain: string[] = [];
    let known = path;
    while (!this.nodeAt(known)) {
      chain.unshift(known);
      const up = dirname(known);
      if (!up || up === known) return null;
      known = up;
    }
    let cur = this.nodeAt(known)!;
    for (const p of chain) {
      cur.expanded = true;
      if (!cur.children) await this.load(cur);
      // A folder inside a compact row gives the row itself.
      let next = this.nodeAt(p);
      if (!next) {
        await this.load(cur);
        next = this.nodeAt(p);
      }
      if (gen !== this.generation || !next) return null;
      cur = next;
    }
    for (let q = cur.parent; q; q = q.parent) q.expanded = true;
    this.rebuild();
    return cur;
  }

  // --- Create rows ----------------------------------------------------------

  /** Adds the temporary row for a new file or folder at the top of `folder`. */
  addPending(folder: TreeNode, kind: 'file' | 'dir'): TreeNode {
    const ph: TreeNode = {
      name: '',
      path: joinPath(folder.path, '\u0000pending'),
      rel: '',
      chain: null,
      chainStyle: 'slash',
      chainPaths: [],
      isDir: kind === 'dir',
      isSymlink: false,
      ignored: false,
      depth: folder.depth + 1,
      parent: folder,
      expanded: false,
      children: null,
      loading: false,
      hidden: false,
      pending: kind,
    };
    folder.expanded = true;
    folder.children = [ph, ...(folder.children ?? [])];
    this.rebuild();
    return ph;
  }

  removePending(ph: TreeNode): void {
    const p = ph.parent;
    if (p?.children) p.children = p.children.filter((c) => c !== ph);
    this.rebuild();
  }
}

// Rows of the folders panel. Pure functions.

import type { FolderNode } from './types';

export interface FolderRow {
  node: FolderNode;
  /** Indent level in the panel (the first row is 0). */
  level: number;
  expanded: boolean;
}

/** Folders that are open in the panel at first: the first row and the folders directly below it. */
export function defaultExpanded(root: FolderNode): Set<string> {
  const set = new Set<string>([root.rel]);
  for (const c of root.children) set.add(c.rel);
  return set;
}

/** The rows to show. A folder shows its children only when its rel path is in `expanded`. */
export function flattenFolders(root: FolderNode, expanded: ReadonlySet<string>): FolderRow[] {
  const rows: FolderRow[] = [];
  const walk = (node: FolderNode, level: number) => {
    const open = expanded.has(node.rel) && node.children.length > 0;
    rows.push({ node, level, expanded: open });
    if (open) for (const c of node.children) walk(c, level + 1);
  };
  walk(root, 0);
  return rows;
}

/** Finds a folder by its absolute path. */
export function findFolder(root: FolderNode, path: string): FolderNode | null {
  if (root.path === path) return root;
  for (const c of root.children) {
    const hit = findFolder(c, path);
    if (hit) return hit;
  }
  return null;
}

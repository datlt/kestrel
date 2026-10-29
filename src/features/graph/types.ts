// Graph View of markdown files (docs/DESIGN.md, section 14). Owner: integrator (contract).
//
// The model (`model/**`, pure functions, no DOM) turns the `NoteGraph` from
// Rust into the `VisibleGraph` that the view (`view.ts`, `render.ts`, the
// simulation worker) draws. Both sides use only the types of this file and the
// functions that `model/index.ts` exports.

import type { NoteGraph, NoteNode } from '../../ipc/notes';

export type { NoteGraph, NoteNode };

/** `force`: free layout like Obsidian. `radial`: the folder tree as circles. `tree`: the folder tree from left to right. */
export type GraphLayout = 'force' | 'radial' | 'tree';

export type ColorBy = 'folder' | 'tag' | 'none';

/** Like the color groups of Obsidian: notes that match `query` get `color`. The first matching group wins. */
export interface ColorGroup {
  query: string;
  /** CSS color, `#rrggbb`. */
  color: string;
}

/** Options of one graph tab. The last used options are kept in `globalState` (`OPTIONS_KEY`) for the next graph. */
export interface GraphOptions {
  layout: GraphLayout;

  // Filters
  /** Search filter (see `compileQuery`). Nodes that do not match are hidden. */
  query: string;
  showTags: boolean;
  showAttachments: boolean;
  /** Hide `missing` nodes (links to notes that do not exist). */
  existingOnly: boolean;
  /** Show nodes without links. */
  showOrphans: boolean;

  // Folders
  /** Show folder nodes and the tree edges (file to folder, folder to parent folder). Always on in the `radial` and `tree` layouts. */
  showFolders: boolean;
  /** `force` layout: draw an outline around the nodes of each folder, nested like the folders. */
  folderOutlines: boolean;
  /** `force` layout: 0 to 1, how strong nodes are pulled to the center of their folder. */
  folderPull: number;

  // Colors
  colorBy: ColorBy;
  /** 1 to 4. With `colorBy: 'folder'`, folders at this depth (1 = the folders in the root) give the colors. */
  colorDepth: number;
  groups: ColorGroup[];

  // Display
  arrows: boolean;
  labelBy: 'name' | 'title';
  /** -3 to 3, like Obsidian "Text fade threshold": higher shows labels only when zoomed in more. */
  textFade: number;
  /** 0.2 to 3. */
  nodeSize: number;
  /** 0.2 to 3. */
  linkThickness: number;
  /** 0 to 1. `radial` and `tree` layouts: 0 draws straight links, 1 bends them along the folder tree. */
  bundling: number;

  // Forces (`force` layout)
  /** 0 to 1. */
  centerForce: number;
  /** 0 to 20. */
  repelForce: number;
  /** 0 to 1. */
  linkForce: number;
  /** 30 to 500. */
  linkDistance: number;

  // Local graph
  /** 1 to 5: steps from the center note. */
  depth: number;
  incoming: boolean;
  outgoing: boolean;
  /** Show the links between the neighbors too, not only the links on the way from the center. */
  neighborLinks: boolean;
}

/** Folders that the user collapsed (one node for the folder) or hid. Rel paths, `''` is the root (it cannot be collapsed or hidden). */
export interface FolderState {
  collapsed: string[];
  hidden: string[];
}

/**
 * `project`: every note of the root.
 * `folder`: the notes under `path` (absolute), and the nodes they link to.
 * `local`: one note and its neighbors up to `options.depth`. With `follow`, the
 * center is the note of the active editor and changes with it (`path` is the last one).
 */
export type GraphScope =
  | { kind: 'project' }
  | { kind: 'folder'; path: string }
  | { kind: 'local'; path: string | null; follow: boolean };

/** Saved in the session (tab `serialize`). */
export interface GraphTabState {
  scope: GraphScope;
  options: GraphOptions;
  folders: FolderState;
  /** Camera: center and zoom, null for "fit". */
  camera: { x: number; y: number; zoom: number } | null;
}

// --- Folder tree --------------------------------------------------------------

export interface FolderNode {
  /** Rel path of the folder, `''` for the root. */
  rel: string;
  /** Folder name; the root has the name of the root folder. */
  name: string;
  /** Absolute path. */
  path: string;
  /** 0 for the root. */
  depth: number;
  /** Sorted by name (case-insensitive, then by code point). */
  children: FolderNode[];
  /** Notes directly in this folder. */
  notes: number;
  /** Notes in this folder and below. */
  totalNotes: number;
  /** Color with `colorBy: 'folder'` and the given depth, null when the folder is above that depth. */
  color: string | null;
}

// --- What the view draws --------------------------------------------------------

export type VNodeKind = 'note' | 'attachment' | 'missing' | 'tag' | 'folder';

export interface VNode {
  /**
   * Stable id; the view keeps positions by id when the data changes.
   * Files: `n:<rel>`. Folders: `f:<rel>` (`f:` is the root). Tags: `t:<tag in lower case>`.
   */
  id: string;
  kind: VNodeKind;
  /** Text under the node: the name (or title with `labelBy: 'title'`), `#tag`, or the folder name. */
  label: string;
  /** Absolute path for files and folders, null for tags. */
  path: string | null;
  /** Rel path for files and folders, the tag for tags. */
  rel: string;
  /** Id of the folder that holds this node (`f:<rel>`), also when folder nodes are not shown. Null for the root folder and tags. */
  parent: string | null;
  /** Depth in the folder tree: the root folder 0, a file in the root 1. Tags 0. */
  depth: number;
  /** Link and tag edges at this node (tree edges do not count). */
  degree: number;
  /** CSS color, or null for the theme color of the kind. */
  color: string | null;
  /** A collapsed folder: the notes inside it (all depths). Other nodes: 1. */
  weight: number;
  /** A folder that the user collapsed. */
  collapsed: boolean;
  /** The center of a local graph, or the note of the active editor. */
  active: boolean;
  /** Index in `NoteGraph.nodes`, -1 for folders and tags. */
  source: number;
}

/** `link`: links in the text. `tree`: a file or folder to its folder. `tag`: a note to its tag. */
export type VEdgeKind = 'link' | 'tree' | 'tag';

export interface VEdge {
  /** Index in `VisibleGraph.nodes`. For `tree` edges: the child. */
  source: number;
  /** Index in `VisibleGraph.nodes`. For `tree` edges: the folder. */
  target: number;
  kind: VEdgeKind;
  /** Links in the text (summed when a folder is collapsed). 1 for tree and tag edges. */
  count: number;
  /** At least one of the links is an embed. */
  embed: boolean;
  /** `link` edges: there are links in both directions. One edge stands for both (arrows at both ends). */
  both: boolean;
}

export interface GraphStats {
  /** Notes drawn (notes inside collapsed folders count). */
  notes: number;
  /** Notes in the scope before the filters. */
  scopeNotes: number;
  /** Link edges drawn. */
  links: number;
}

export interface VisibleGraph {
  /** Folders come before the nodes inside them (a parent folder always has a lower index than its children). */
  nodes: VNode[];
  edges: VEdge[];
  stats: GraphStats;
  /** Why the graph is empty, for the empty view ("Open a markdown file to see its local graph."), else null. */
  emptyReason: string | null;
}

export interface BuildInput {
  graph: NoteGraph;
  tree: FolderNode;
  options: GraphOptions;
  folders: FolderState;
  scope: GraphScope;
  /** Absolute path of the file of the active editor, or null. */
  activePath: string | null;
  theme: 'light' | 'dark';
}

/** A polygon around the nodes of one folder (`force` layout with `folderOutlines`). */
export interface FolderHull {
  /** `f:<rel>`. */
  id: string;
  depth: number;
  label: string;
  color: string | null;
  /** x, y, x, y, ... in graph coordinates, in drawing order. */
  points: number[];
}

/** A compiled search filter. */
export interface CompiledQuery {
  /** True when the text has no terms (everything matches). */
  empty: boolean;
  /** Error text for a broken query (for example an unclosed quote or a bad regex), else null. With an error, `test` matches everything. */
  error: string | null;
  test(node: NoteNode): boolean;
}

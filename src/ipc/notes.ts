// IPC for the note index: the Graph View of markdown files (like Obsidian) and
// the wiki links of the markdown preview. Owner: integrator (contract).
// Rust side: src-tauri/src/cmd/notes.rs and crates/kestrel-notes. See docs/DESIGN.md, section 14.
//
// Paths are absolute. `rel` paths are relative to the root and use `/`.
// Lines are 1-based.

import { invoke } from './invoke';

// --- Index -------------------------------------------------------------------

export interface NoteIndexStatus {
  /** `none`: not built yet. The first `notesGraph` or `notesResolve` call builds it. */
  state: 'none' | 'building' | 'ready';
  /** Markdown files in the index. */
  notes: number;
  /** Other files that notes can link to (images, PDF ...). */
  files: number;
  /** Time of the last full build. */
  buildMs: number;
}

/** Does not start a build. */
export function notesIndexStatus(root: string): Promise<NoteIndexStatus> {
  return invoke<NoteIndexStatus>('notes_index_status', { root });
}

/**
 * Tells the index about changed, new or deleted files (absolute paths, any
 * type: a new image can resolve a link). `rescan` reads the whole folder
 * again. Does nothing when the index of this root was not built yet.
 */
export function notesIndexUpdate(root: string, paths: string[], rescan: boolean): Promise<void> {
  return invoke<void>('notes_index_update', { root, paths, rescan });
}

/** Frees the index of this root for this window (call it when the folder closes). */
export function notesIndexDrop(root: string): Promise<void> {
  return invoke<void>('notes_index_drop', { root });
}

/** Stops a running `notesGraph` call. It then rejects with code `cancelled`. */
export function notesCancel(id: number): Promise<void> {
  return invoke<void>('notes_cancel', { id });
}

// --- Graph -------------------------------------------------------------------

/**
 * `note`: a markdown file (`.md`, `.markdown`, `.mdx`).
 * `attachment`: another file inside the root that a note links to.
 * `missing`: a link target that does not exist. Its `path` is where the note
 * would be created (DESIGN.md 14.2).
 */
export type NoteNodeKind = 'note' | 'attachment' | 'missing';

export interface NoteNode {
  kind: NoteNodeKind;
  /** Absolute path. */
  path: string;
  /** Path relative to the root, with `/`. Example: `docs/api/Auth.md`. */
  rel: string;
  /** File name without the markdown extension (`Auth`). Attachments keep the extension (`logo.png`). */
  name: string;
  /** Front matter `title`, else the first level 1 heading, else null. Notes only. */
  title: string | null;
  /** Tags without `#`, from the text and the front matter. Nested tags keep `/` (`project/kestrel`). No duplicates (case-insensitive), first spelling wins. */
  tags: string[];
  /** Front matter `aliases` (or `alias`). */
  aliases: string[];
  /** Bytes. 0 for `missing`. */
  size: number;
  /** Last change time in ms since the epoch. 0 for `missing`. */
  mtimeMs: number;
}

export interface NoteLink {
  /** Index in `NoteGraph.nodes` of the note that has the link. Always a `note`. */
  from: number;
  /** Index in `NoteGraph.nodes` of the target. Never equal to `from` (links to the same note are dropped). */
  to: number;
  /** Links from `from` to `to` in the text (at least 1). */
  count: number;
  /** How many of them are embeds (`![[x]]`, `![](x)`). */
  embeds: number;
  /** Line of the first of these links in `from`. */
  line: number;
}

export interface NoteGraph {
  /** The normalized root. */
  root: string;
  /** Notes sorted by `rel`, then attachments sorted by `rel`, then missing nodes sorted by `rel`. */
  nodes: NoteNode[];
  /** At most one entry per (from, to) pair, sorted by `from`, then `to`. */
  links: NoteLink[];
  /** True when the root has more notes than the index keeps (20,000). The first ones by path are kept. */
  truncated: boolean;
  /** Time to build this answer (not the index). */
  elapsedMs: number;
}

/** The whole graph of the root. Builds the index on the first call and waits while it builds. */
export function notesGraph(id: number, root: string): Promise<NoteGraph> {
  return invoke<NoteGraph>('notes_graph', { id, root });
}

// --- Links of the preview ----------------------------------------------------

export interface ResolvedLink {
  /** Absolute path of the target. For a target that does not exist: where it would be created. */
  path: string;
  exists: boolean;
  kind: NoteNodeKind;
  /** The part after `#` without `^` (a heading or a block id), else null. */
  heading: string | null;
  /** True when the part after `#` started with `^` (a block id). */
  block: boolean;
}

/**
 * Resolves one link of the note `from` like the graph does. `target` is the
 * text inside `[[ ]]` (with `#heading` and `|alias`, without `!`) when
 * `wiki` is true, else the destination of a markdown link (percent-encoded or
 * not). Returns null for external URLs and for links to a heading of the same note.
 */
export function notesResolve(root: string, from: string, target: string, wiki: boolean): Promise<ResolvedLink | null> {
  return invoke<ResolvedLink | null>('notes_resolve', { root, from, target, wiki });
}

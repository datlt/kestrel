// IPC for the search feature. Owner: search agent.
// Rust side: src-tauri/src/cmd/search.rs.

import { Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from './invoke';

// --- File index (quick open) -------------------------------------------

export interface FileHit {
  /** Path relative to the root, with `/` separators. */
  path: string;
  /** Matched positions in `path`. They are JavaScript string indexes (UTF-16). */
  indices: number[];
}

export type IndexState = 'building' | 'ready';

export interface IndexStatus {
  state: IndexState;
  /** Files in the index. While the first build runs: files found so far. */
  count: number;
}

export interface FileQueryResult extends IndexStatus {
  items: FileHit[];
}

/** Fuzzy search in the file index. An empty query returns the first files. Starts the index when needed. */
export function searchFiles(root: string, query: string, limit: number): Promise<FileQueryResult> {
  return invoke<FileQueryResult>('search_files', { root, query, limit });
}

/** Starts the index when it does not exist yet. */
export function searchIndexStatus(root: string): Promise<IndexStatus> {
  return invoke<IndexStatus>('search_index_status', { root });
}

/** Tells the index about changed files (absolute paths). `rescan` rebuilds the whole index. */
export function searchIndexUpdate(root: string, paths: string[], rescan: boolean): Promise<IndexStatus> {
  return invoke<IndexStatus>('search_index_update', { root, paths, rescan });
}

/** Called when an index build ends (for any root). */
export function onIndexReady(fn: (e: { root: string; count: number }) => void): Promise<UnlistenFn> {
  return listen<{ root: string; count: number }>('kestrel://search-index', (e) => fn(e.payload));
}

// --- Text search ---------------------------------------------------------

export interface TextSearchOptions {
  query: string;
  regex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  include: string[];
  exclude: string[];
  /** 0 = no limit. */
  maxResults: number;
}

export interface LineMatch {
  /** 1-based. */
  line: number;
  /** Line text without leading white space. Long lines are cut around the first match. */
  text: string;
  /** `[start, end)` in UTF-16 units of `text`. */
  ranges: [number, number][];
  /** UTF-16 units removed from the start of the real line. Column = offset + ranges[i][0] + 1. */
  offset: number;
}

export interface FileMatches {
  /** Absolute path. */
  path: string;
  matches: LineMatch[];
}

export interface TextSearchSummary {
  totalMatches: number;
  filesWithMatches: number;
  truncated: boolean;
  cancelled: boolean;
  elapsedMs: number;
}

export type TextSearchEvent =
  | { type: 'batch'; files: FileMatches[] }
  | ({ type: 'done' } & TextSearchSummary)
  | { type: 'error'; code: string; message: string };

/**
 * Starts a text search. Events arrive through `onEvent` (batches, then `done`
 * or `error`). Returns the id for `searchCancel`.
 */
export async function searchText(
  root: string,
  options: TextSearchOptions,
  onEvent: (e: TextSearchEvent) => void,
): Promise<number> {
  const channel = new Channel<TextSearchEvent>();
  channel.onmessage = onEvent;
  return invoke<number>('search_text', { root, options, channel });
}

export function searchCancel(id: number): Promise<void> {
  return invoke<void>('search_cancel', { id });
}

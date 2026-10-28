// IPC for files and workspaces. Owner: files feature.
// The editor engine uses fsReadFile, fsWriteFile and fsStat. Keep their
// signatures. The files feature adds its other wrappers below them.

import type { LineEnding } from '../core/types';
import { invoke } from './invoke';

export interface ReadFileResult {
  /** Decoded text (always UTF-16 in JS). Empty when `binary` or `tooLarge`. */
  text: string;
  /** encoding_rs name in lower case, for example `utf-8` or `shift_jis`. */
  encoding: string;
  bom: boolean;
  /** Most common line ending in the file (`lf` for files without line breaks). */
  lineEnding: LineEnding;
  /** True when the file mixes line endings. */
  mixedLineEndings: boolean;
  mtimeMs: number;
  size: number;
  readonly: boolean;
  /** NUL bytes found in the first 8 KB. `text` is empty. */
  binary: boolean;
  /** size > maxBytes. `text` is empty. */
  tooLarge: boolean;
  /** Some bytes were not valid in `encoding` and became U+FFFD. Saving would change them. */
  lossy: boolean;
}

type ReadHeader = Omit<ReadFileResult, 'text'>;

/**
 * Reads and decodes a text file.
 *
 * Rust command `fs_read_file(path, encoding?, maxBytes)` returns raw bytes
 * (fast for big files): [u32 little-endian header length][header JSON][UTF-8 text].
 * `encoding`: force this encoding. Default: BOM, then UTF-8 if valid, then detection.
 */
export async function fsReadFile(path: string, opts: { encoding?: string | null; maxBytes: number }): Promise<ReadFileResult> {
  const buf = await invoke<ArrayBuffer>('fs_read_file', {
    path,
    encoding: opts.encoding ?? null,
    maxBytes: opts.maxBytes,
  });
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const decoder = new TextDecoder('utf-8');
  const header = JSON.parse(decoder.decode(new Uint8Array(buf, 4, headerLen))) as ReadHeader;
  const text = decoder.decode(new Uint8Array(buf, 4 + headerLen));
  return { ...header, text };
}

export interface WriteFileOptions {
  encoding: string;
  bom: boolean;
  lineEnding: LineEnding;
  /**
   * mtime the editor saw when it loaded the file. If the file on disk has
   * another mtime, Rust fails with code `conflict`. Pass null to overwrite.
   */
  expectedMtimeMs: number | null;
}

export interface WriteFileResult {
  mtimeMs: number;
  size: number;
}

/**
 * Saves text. `text` uses `\n` line breaks; Rust converts them to `lineEnding`
 * and encodes the text to `encoding` (code `unmappable` when that fails).
 *
 * Rust command `fs_write_file` takes a raw body (the UTF-8 text) and headers:
 * x-path (URI-encoded), x-encoding, x-bom ("1"/"0"), x-line-ending,
 * x-expected-mtime (number or empty).
 */
export function fsWriteFile(path: string, text: string, opts: WriteFileOptions): Promise<WriteFileResult> {
  return invoke<WriteFileResult>('fs_write_file', new TextEncoder().encode(text), {
    headers: {
      'x-path': encodeURIComponent(path),
      'x-encoding': opts.encoding,
      'x-bom': opts.bom ? '1' : '0',
      'x-line-ending': opts.lineEnding,
      'x-expected-mtime': opts.expectedMtimeMs == null ? '' : String(opts.expectedMtimeMs),
    },
  });
}

export interface StatResult {
  exists: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  readonly: boolean;
}

/** Never fails for a missing file: returns `exists: false`. */
export const fsStat = (path: string) => invoke<StatResult>('fs_stat', { path });

// --- Folders and file operations --------------------------------------------

export interface DirEntry {
  name: string;
  /** Absolute native path. */
  path: string;
  /** True for folders and for links to folders. */
  isDir: boolean;
  isSymlink: boolean;
  /** Matched by a .gitignore rule. For a compact row: the state of the deepest folder. */
  ignored: boolean;
  /**
   * Only with `compact: true`. Names of the folders below this one that the row
   * joins with it. Entry `src` with `["main", "java"]` is the row `src/main/java`.
   * `path` and `name` stay those of the top folder. Missing when nothing is joined.
   */
  compact?: string[];
  /** `slash` (`src/main/java`) or `dot` (`com.example.app`, inside a Java source root). */
  compactStyle?: 'slash' | 'dot';
}

export interface ListDirOptions {
  /** Join a folder with its only child folder (Rust looks ahead). */
  compact?: boolean;
  /** `files.exclude` globs. Excluded entries do not count for joining. */
  exclude?: string[];
}

/**
 * One folder level. Folders first, then files, natural case-insensitive order.
 * `root` is the workspace root. Rust command: `fs_list_dir(dir, root, compact?, exclude?)`.
 */
export const fsListDir = (dir: string, root: string, opts: ListDirOptions = {}) =>
  invoke<DirEntry[]>('fs_list_dir', { dir, root, compact: opts.compact ?? false, exclude: opts.exclude ?? null });

/** Creates an empty file and its missing parent folders. Fails with `already_exists`. */
export const fsCreateFile = (path: string) => invoke<void>('fs_create_file', { path });

export const fsCreateDir = (path: string) => invoke<void>('fs_create_dir', { path });

export const fsRename = (from: string, to: string) => invoke<void>('fs_rename', { from, to });

/** Moves to the trash. `permanent: true` deletes for good. */
export const fsDelete = (path: string, permanent = false) => invoke<void>('fs_delete', { path, permanent });

// --- Workspace ---------------------------------------------------------------

export interface WsOpenResult {
  root: string;
  name: string;
}

/**
 * Adds `root` to the folders of this window and starts its watcher. A window can
 * have several roots (one per workspace tab). Events: `kestrel://fs-changed` with `root`.
 */
export const wsOpen = (root: string) => invoke<WsOpenResult>('ws_open', { root });

/** Stops the watcher of one root of this window. Without `root`, closes all roots of the window. */
export const wsClose = (root?: string) => invoke<void>('ws_close', { root: root ?? null });

/** Opens a new window. Returns its label. */
export const wsNewWindow = (root?: string | null) => invoke<string>('ws_new_window', { root: root ?? null });

export interface LaunchTarget {
  kind: 'folder' | 'file';
  path: string;
}

/** Folder or file from the command line. Only the main window gets a value. */
export const wsLaunchArgs = () => invoke<LaunchTarget | null>('ws_launch_args');

export interface RecentFolderInfo {
  path: string;
  name: string;
  lastOpenedMs: number;
}

/** Recent folders, newest first. Folders that no longer exist are left out. */
export const wsRecentList = () => invoke<RecentFolderInfo[]>('ws_recent_list');

export const wsRecentRemove = (path: string) => invoke<void>('ws_recent_remove', { path });

/** Saved session of a folder. `null` when there is none. */
export const wsSessionLoad = (root: string) => invoke<unknown>('ws_session_load', { root });

export const wsSessionSave = (root: string, session: unknown) => invoke<void>('ws_session_save', { root, session });

export const wsGlobalLoad = () => invoke<Record<string, unknown>>('ws_global_load');

/** Merges keys into the global state. A `null` value removes the key. */
export const wsGlobalPatch = (patch: Record<string, unknown>) => invoke<void>('ws_global_patch', { patch });

// IPC for the git feature. Owner: git agent.
//
// All paths in results are relative to the repository top level and use `/`.
// `root` is any folder inside the repo (normally the workspace root). Rust
// runs the `git` program for each call. Errors: `git_missing`, `not_a_repo`,
// `cancelled` (a newer `gitStatus` call replaced this one), `invalid_input`.

import { invoke } from './invoke';

export interface BranchInfo {
  /** Branch name. null when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  /** Commit hash of HEAD. null in a repo without commits. */
  head: string | null;
  /** For example `origin/main`. */
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface RepoInfo extends BranchInfo {
  /** Absolute native path of the repo top level. */
  topLevel: string;
}

export type EntryKind = 'ordinary' | 'renamed' | 'copied' | 'unmerged' | 'untracked';

export interface StatusEntry {
  path: string;
  /** Old path of a rename or copy. */
  origPath: string | null;
  kind: EntryKind;
  /** Letter in the index: M A D R C T U, or `.` for none. */
  index: string;
  /** Letter in the working tree: M A D R C T U, or `.` for none. */
  worktree: string;
  /** Similarity of a rename or copy (0 to 100). */
  score: number | null;
  /** Index differs from HEAD. */
  staged: boolean;
  /** Working tree differs from index. */
  unstaged: boolean;
}

export interface GitStatus extends BranchInfo {
  topLevel: string;
  entries: StatusEntry[];
}

export interface DiffEntry {
  /** A, M, D, R, C or T. */
  status: string;
  score: number | null;
  path: string;
  origPath: string | null;
}

export interface GitBranch {
  /** Short name: `main`, `origin/main`. */
  name: string;
  remote: boolean;
  current: boolean;
  sha: string;
}

export const gitRepoInfo = (root: string) => invoke<RepoInfo>('git_repo_info', { root });

/**
 * One status at a time per window and root. A newer call cancels the older
 * one, and the older promise rejects with code `cancelled`.
 */
export const gitStatus = (root: string) => invoke<GitStatus>('git_status', { root });

export const gitDiffNames = (root: string, base: string, target?: string | null) =>
  invoke<DiffEntry[]>('git_diff_names', { root, base, target: target ?? null });

/** Fails with code `not_found` when there is no common ancestor. */
export const gitMergeBase = (root: string, a: string, b: string) => invoke<string>('git_merge_base', { root, a, b });

/** Current branch first, then local, then remote. */
export const gitBranches = (root: string) => invoke<GitBranch[]>('git_branches', { root });

export interface GitShowResult {
  /** False when the path does not exist at that revision (not an error). */
  exists: boolean;
  /** UTF-8 text (invalid bytes become U+FFFD). Empty when the file does not exist. */
  text: string;
  /** NUL bytes in the first 8 KB. `text` is empty. */
  binary: boolean;
  /** `maxBytes` was given and the file is bigger. `text` is empty. */
  tooLarge: boolean;
  size: number;
}

/**
 * Reads a file at a revision. `rev` is `HEAD`, a branch, a commit, or `:0` for
 * the index. `path` is relative to the repo top level. Pass `maxBytes` to skip
 * decoding big files.
 *
 * Rust command `git_show(root, rev, path)` returns raw bytes: one flag byte
 * (1 = file exists, 0 = it does not) followed by the file content.
 */
export async function gitShow(root: string, rev: string, path: string, maxBytes = Infinity): Promise<GitShowResult> {
  const buf = await invoke<ArrayBuffer>('git_show', { root, rev, path });
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0 || bytes[0] === 0) return { exists: false, text: '', binary: false, tooLarge: false, size: 0 };
  const body = bytes.subarray(1);
  const size = body.length;
  if (body.subarray(0, 8192).includes(0)) return { exists: true, text: '', binary: true, tooLarge: false, size };
  if (size > maxBytes) return { exists: true, text: '', binary: false, tooLarge: true, size };
  return { exists: true, text: new TextDecoder('utf-8').decode(body), binary: false, tooLarge: false, size };
}

export interface GitLogEntry {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Seconds since the Unix epoch. */
  authorTime: number;
  subject: string;
  body: string;
  /** Path of the file in this commit (differs from the asked path after a rename). Empty for `gitCommitInfo`. */
  path: string;
  /** Old path when this commit renamed or copied the file. */
  origPath: string | null;
}

/**
 * Commits that changed a file, newest first, following renames (`git log --follow`).
 * `path` is relative to the repo top level. Use `skip` and `limit` to page.
 * An empty repo or an unknown file gives an empty list.
 */
export const gitLog = (root: string, path: string, limit: number, skip: number) =>
  invoke<GitLogEntry[]>('git_log', { root, path, limit, skip });

/** One commit with its full message. Fails when the commit does not exist. */
export const gitCommitInfo = (root: string, sha: string) => invoke<GitLogEntry>('git_commit_info', { root, sha });

export interface GitBlameRange {
  /** First line of the range, 1-based, in the file as it is now. */
  startLine: number;
  lineCount: number;
  sha: string;
  author: string;
  authorEmail: string;
  /** Seconds since the Unix epoch. 0 when not committed. */
  authorTime: number;
  summary: string;
  previousSha: string | null;
  previousPath: string | null;
  /** The lines are in no commit yet (sha is all zeros). */
  uncommitted: boolean;
  boundary: boolean;
  /** Path of the file in that commit. */
  path: string;
}

/**
 * Blame of a file. Pass `contents` (the editor text) when the editor has
 * unsaved changes: git then blames that text, and changed lines are
 * "uncommitted". Fails with `not_found` when the file is not tracked.
 */
export const gitBlame = (root: string, path: string, contents?: string | null) =>
  invoke<GitBlameRange[]>('git_blame', { root, path, contents: contents ?? null });

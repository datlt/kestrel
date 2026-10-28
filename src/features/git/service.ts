// Git state of the open folder: one place that runs status, keeps the result
// and tells everybody (view, status bar, gutter, explorer) when it changes.

import type { AppContext, Disposable, GitFileStatus } from '../../core/types';
import { debounce, isInside, joinPath } from '../../core/util';
import { isIpcError } from '../../ipc/invoke';
import {
  gitDiffNames,
  gitMergeBase,
  gitRepoInfo,
  gitStatus,
  type BranchInfo,
  type StatusEntry,
} from '../../ipc/git';

export type Group = 'conflicts' | 'staged' | 'changes' | 'untracked';

export interface ChangeItem {
  /** Group + path, unique in the list. */
  key: string;
  group: Group;
  /** Relative to the repo top level, with `/`. */
  path: string;
  abs: string;
  /** Old path of a rename (relative to the top level). */
  origPath: string | null;
  /** One letter: M A D R C T U ? */
  letter: string;
  status: GitFileStatus;
}

export interface GitModel extends BranchInfo {
  topLevel: string;
  /** `HEAD` or the name of the branch we compare with. */
  baseName: string;
  /** Revision used for diffs: `HEAD` or the merge base commit. */
  baseRev: string;
  items: ChangeItem[];
  /** Number of different files. */
  count: number;
  /** Absolute path to status, for the `git:decorations` event. */
  decorations: Record<string, GitFileStatus>;
}

const BASE_KEY = 'git.base';

export class GitService {
  model: GitModel | null = null;
  /** Set when git cannot be used here: `git_missing`, `not_a_repo`, or an error text. */
  problem: string | null = null;
  loading = false;
  /** Commit to select when a history tab opens or shows (path to sha). */
  readonly historySelect = new Map<string, string>();

  private listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;
  private again = false;
  private mergeBases = new Map<string, string>();
  private warnedMissing = false;
  /** Called by the owner after each status. */
  onStatus: ((m: GitModel | null) => void) | null = null;

  /** Refresh after a short pause. Many events in a row cause one run. */
  readonly scheduleRefresh = debounce(() => void this.refresh(), 300);

  constructor(private ctx: AppContext) {}

  get root(): string | null {
    return this.ctx.workspace.root;
  }

  get enabled(): boolean {
    return this.ctx.settings.get('git.enabled');
  }

  /** Name of the compare branch, or `HEAD`. */
  get baseName(): string {
    return this.ctx.workspace.state.get<string>(BASE_KEY) || 'HEAD';
  }

  setBase(name: string | null): void {
    this.ctx.workspace.state.set(BASE_KEY, name && name !== 'HEAD' ? name : null);
    void this.refresh();
  }

  onChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private emit() {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        console.error('git listener', e);
      }
    }
  }

  /** Absolute path of a repo-relative path. */
  toAbs(rel: string, top = this.model?.topLevel): string {
    return top ? joinPath(top, rel) : rel;
  }

  /** Repo-relative path (with `/`) of an absolute path, or null when it is outside the repo. */
  toRel(abs: string, top = this.model?.topLevel): string | null {
    if (!top || !isInside(abs, top)) return null;
    const a = abs.replace(/\\/g, '/');
    const t = top.replace(/\\/g, '/').replace(/\/+$/, '');
    return a.length > t.length ? a.slice(t.length + 1) : null;
  }

  /** Top level of the repo. Asks Rust when no status has arrived yet. */
  async topLevel(): Promise<string | null> {
    if (this.model) return this.model.topLevel;
    const root = this.root;
    if (!root) return null;
    try {
      return (await gitRepoInfo(root)).topLevel;
    } catch {
      return null;
    }
  }

  /** Revision to diff against. For a branch name it is the merge base with HEAD. */
  async resolveBase(name: string): Promise<string> {
    const root = this.root;
    if (!root || name === 'HEAD') return 'HEAD';
    const head = this.model?.head ?? '';
    const key = `${head}:${name}`;
    const cached = this.mergeBases.get(key);
    if (cached) return cached;
    try {
      const sha = await gitMergeBase(root, 'HEAD', name);
      if (this.mergeBases.size > 50) this.mergeBases.clear();
      this.mergeBases.set(key, sha);
      return sha;
    } catch {
      return name;
    }
  }

  /**
   * Runs a status. At most one runs at a time. Calls that arrive while one is
   * running share one more run after it. The old model stays until new data arrives.
   */
  refresh(): Promise<void> {
    this.scheduleRefresh.cancel();
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      try {
        do {
          this.again = false;
          await this.runOnce();
        } while (this.again);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Forget everything (folder closed or changed). */
  reset(): void {
    this.model = null;
    this.problem = null;
    this.mergeBases.clear();
    this.finish();
  }

  private async runOnce(): Promise<void> {
    const root = this.root;
    if (!root || !this.enabled) {
      this.model = null;
      this.problem = null;
      this.finish();
      return;
    }
    this.loading = true;
    this.emit();
    try {
      const status = await gitStatus(root);
      if (root !== this.root) return;
      let baseName = this.baseName;
      let baseRev = 'HEAD';
      let diffs: Awaited<ReturnType<typeof gitDiffNames>> | null = null;
      if (baseName !== 'HEAD') {
        try {
          baseRev = await gitMergeBase(root, 'HEAD', baseName);
          diffs = await gitDiffNames(root, baseRev);
        } catch (e) {
          this.ctx.ui.notify(`Cannot compare with ${baseName}: ${(e as Error).message}`, { kind: 'warn' });
          baseName = 'HEAD';
          baseRev = 'HEAD';
          this.ctx.workspace.state.set(BASE_KEY, null);
        }
      }
      if (root !== this.root) return;
      this.model = buildModel(this, status, baseName, baseRev, diffs);
      this.problem = null;
    } catch (e) {
      if (isIpcError(e, 'cancelled')) {
        // A newer status run replaced this one. Clear the spinner now; the newer run sends its own result.
        this.loading = false;
        this.emit();
        return;
      }
      if (root !== this.root) return;
      this.model = null;
      if (isIpcError(e, 'not_a_repo')) {
        this.problem = 'not_a_repo';
      } else if (isIpcError(e, 'git_missing')) {
        this.problem = 'git_missing';
        if (!this.warnedMissing) {
          this.warnedMissing = true;
          this.ctx.ui.notify('git was not found. Install git to see changes.', { kind: 'warn' });
        }
      } else {
        this.problem = e instanceof Error ? e.message : String(e);
      }
    } finally {
      this.loading = false;
    }
    this.finish();
  }

  private finish() {
    this.loading = false;
    this.onStatus?.(this.model);
    this.emit();
  }
}

export function statusOfEntry(e: StatusEntry): GitFileStatus {
  if (e.kind === 'unmerged') return 'conflict';
  if (e.kind === 'untracked') return 'untracked';
  if (e.index === 'R' || e.index === 'C' || e.worktree === 'R') return 'renamed';
  if (e.index === 'D' || e.worktree === 'D') return 'deleted';
  if (e.index === 'A') return 'added';
  return 'modified';
}

function statusOfLetter(letter: string): GitFileStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    case 'U':
      return 'conflict';
    case '?':
      return 'untracked';
    default:
      return 'modified';
  }
}

function buildModel(
  svc: GitService,
  s: Awaited<ReturnType<typeof gitStatus>>,
  baseName: string,
  baseRev: string,
  diffs: Awaited<ReturnType<typeof gitDiffNames>> | null,
): GitModel {
  const top = s.topLevel;
  const items: ChangeItem[] = [];
  const add = (group: Group, path: string, origPath: string | null, letter: string, status: GitFileStatus) =>
    items.push({ key: `${group}:${path}`, group, path, abs: svc.toAbs(path, top), origPath, letter, status });

  const conflicts: StatusEntry[] = [];
  const staged: StatusEntry[] = [];
  const changes: StatusEntry[] = [];
  const untracked: StatusEntry[] = [];
  for (const e of s.entries) {
    if (e.kind === 'unmerged') conflicts.push(e);
    else if (e.kind === 'untracked') untracked.push(e);
    else {
      if (e.staged) staged.push(e);
      if (e.unstaged) changes.push(e);
    }
  }
  for (const e of conflicts) add('conflicts', e.path, null, '!', 'conflict');
  if (diffs) {
    // Compare with a branch: one list with everything that differs from the merge base.
    const conflictPaths = new Set(conflicts.map((c) => c.path));
    for (const d of diffs) {
      if (conflictPaths.has(d.path)) continue;
      add('changes', d.path, d.origPath, d.status, statusOfLetter(d.status));
    }
  } else {
    for (const e of staged) add('staged', e.path, e.origPath, e.index, statusOfEntry({ ...e, worktree: '.' }));
    for (const e of changes) add('changes', e.path, null, e.worktree, statusOfEntry({ ...e, index: '.' }));
  }
  for (const e of untracked) add('untracked', e.path, null, 'U', 'untracked');
  const decorations: Record<string, GitFileStatus> = {};
  for (const e of s.entries) decorations[svc.toAbs(e.path, top)] = statusOfEntry(e);
  const count = new Set(items.map((i) => i.path)).size;
  return {
    topLevel: top,
    branch: s.branch,
    detached: s.detached,
    head: s.head,
    upstream: s.upstream,
    ahead: s.ahead,
    behind: s.behind,
    baseName,
    baseRev,
    items,
    count,
    decorations,
  };
}

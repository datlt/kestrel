// Pure logic of the branch switcher: quick pick items, the dirty editor
// decision and the check of a new branch name. No DOM, so it runs in tests.

import type { QuickPickItem } from '../../core/types';
import type { GitBranchList, GitLocalBranch, GitRemoteBranch } from '../../ipc/git';
import { relativeTime } from './format';

export type BranchPickKind = 'new' | 'newFrom' | 'fetch' | 'fetching' | 'detached' | 'local' | 'remote';

export interface BranchPickItem extends QuickPickItem {
  kind: BranchPickKind;
  /** Branch name for `local` and `remote` items (`origin/x` for remote ones). */
  name?: string;
  /** The item is the branch that is checked out now. */
  current?: boolean;
}

export interface BranchItemOptions {
  /** Seconds since the Unix epoch. Defaults to now. */
  now?: number;
  /** A fetch is running: the Fetch item shows a wait text. */
  fetching?: boolean;
  /** Icon factory for the check mark of the current branch. */
  checkIcon?: () => Element;
}

/** The short name of a remote branch: `origin/feature/x` gives `feature/x`. */
export function remoteShortName(remote: GitRemoteBranch): string {
  return remote.name.slice(remote.remote.length + 1);
}

/** Current branch first, then the newest commit first, then by name. */
export function sortLocal(list: GitLocalBranch[]): GitLocalBranch[] {
  return [...list].sort(
    (a, b) => Number(b.current) - Number(a.current) || b.time - a.time || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/**
 * Remote branches the user can still check out: the ones without a local
 * branch. A local branch hides a remote branch when it has the same name, or
 * when its upstream is that remote branch.
 */
export function visibleRemotes(list: GitBranchList): GitRemoteBranch[] {
  const localNames = new Set(list.local.map((b) => b.name));
  const upstreams = new Set(list.local.map((b) => b.upstream).filter((u): u is string => !!u));
  return [...list.remote]
    .filter((r) => !localNames.has(remoteShortName(r)) && !upstreams.has(r.name))
    .sort((a, b) => b.time - a.time || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `origin/main ↑1 ↓2`, or `origin/main (gone)`. Empty text when there is no upstream. */
export function upstreamText(b: GitLocalBranch): string {
  if (!b.upstream) return '';
  let text = b.upstream;
  if (b.gone) return `${text} (gone)`;
  if (b.ahead) text += ` ↑${b.ahead}`;
  if (b.behind) text += ` ↓${b.behind}`;
  return text;
}

function detail(subject: string, time: number, now: number): string {
  const when = time > 0 ? relativeTime(time, now) : '';
  return [subject, when].filter(Boolean).join(' · ');
}

/** Items of the "Switch Branch" quick pick, in display order. */
export function buildBranchItems(list: GitBranchList, opts: BranchItemOptions = {}): BranchPickItem[] {
  const now = opts.now ?? Date.now() / 1000;
  const items: BranchPickItem[] = [
    { id: 'new', kind: 'new', label: 'Create New Branch...', detail: 'Make a branch from the current commit and switch to it' },
    { id: 'newFrom', kind: 'newFrom', label: 'Create New Branch From...', detail: 'Pick where the new branch starts' },
    opts.fetching
      ? { id: 'fetching', kind: 'fetching', label: 'Fetching...', description: 'Please wait', detail: 'git fetch --prune --all' }
      : { id: 'fetch', kind: 'fetch', label: 'Fetch', detail: 'Update the remote branches (git fetch --prune --all)' },
  ];
  if (list.detached && list.head) {
    items.push({
      id: 'detached',
      kind: 'detached',
      label: `HEAD (detached at ${list.head})`,
      description: 'current',
      current: true,
      icon: opts.checkIcon,
    });
  }
  for (const b of sortLocal(list.local)) {
    items.push({
      id: `local:${b.name}`,
      kind: 'local',
      name: b.name,
      label: b.name,
      description: upstreamText(b) || undefined,
      detail: detail(b.subject, b.time, now),
      current: b.current,
      icon: b.current ? opts.checkIcon : undefined,
    });
  }
  for (const r of visibleRemotes(list)) {
    items.push({
      id: `remote:${r.name}`,
      kind: 'remote',
      name: r.name,
      label: r.name,
      description: 'remote',
      detail: detail(r.subject, r.time, now),
    });
  }
  return items;
}

/** Items to pick the start point of a new branch: local branches, then all remote branches. */
export function buildStartPointItems(list: GitBranchList, opts: BranchItemOptions = {}): BranchPickItem[] {
  const now = opts.now ?? Date.now() / 1000;
  const items: BranchPickItem[] = sortLocal(list.local).map((b) => ({
    id: b.name,
    kind: 'local' as const,
    name: b.name,
    label: b.name,
    description: b.current ? 'current' : undefined,
    detail: detail(b.subject, b.time, now),
    current: b.current,
    icon: b.current ? opts.checkIcon : undefined,
  }));
  const remotes = [...list.remote].sort((a, b) => b.time - a.time || (a.name < b.name ? -1 : 1));
  for (const r of remotes) {
    items.push({ id: r.name, kind: 'remote', name: r.name, label: r.name, description: 'remote', detail: detail(r.subject, r.time, now) });
  }
  return items;
}

/** True when accepting this item switches to a branch (and not to the same one). */
export function isSwitchTarget(item: BranchPickItem): boolean {
  return (item.kind === 'local' || item.kind === 'remote') && !item.current;
}

/** What to pass to `gitSwitch` for an accepted local or remote item. */
export function switchRequest(item: BranchPickItem): { branch: string; track?: string } | null {
  if (!isSwitchTarget(item) || !item.name) return null;
  if (item.kind === 'remote') {
    // `origin/feature/x` makes the local branch `feature/x` that tracks it.
    const slash = item.name.indexOf('/');
    return { branch: item.name.slice(slash + 1), track: item.name };
  }
  return { branch: item.name };
}

// --- Unsaved editors ---------------------------------------------------------

export interface DirtyEditor {
  path: string;
  isDirty(): boolean;
}

export interface DirtyDecision {
  /** Ask the user before the switch. */
  ask: boolean;
  /** File names (last path part) of the editors with unsaved changes. */
  names: string[];
  message: string;
}

export const DIRTY_BUTTONS = ['Save All and Switch', 'Switch Anyway', 'Cancel'] as const;

export function dirtyDecision(editors: DirtyEditor[]): DirtyDecision {
  const names = editors
    .filter((e) => e.isDirty())
    .map((e) => e.path.replace(/\\/g, '/').split('/').pop() || e.path);
  if (names.length === 0) return { ask: false, names, message: '' };
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? `, and ${names.length - 5} more` : '');
  const message =
    `${names.length === 1 ? '1 file has' : `${names.length} files have`} unsaved changes: ${shown}. ` +
    'Git may change files on disk. Files with unsaved changes keep your edits.';
  return { ask: true, names, message };
}

// --- New branch names --------------------------------------------------------

/**
 * Quick check of a new branch name while the user types. It follows the rules
 * of `git check-ref-format`. Rust checks again with git itself before the switch.
 * Returns an error text, or null when the name looks fine.
 */
export function validateBranchName(name: string, existing: Iterable<string> = []): string | null {
  if (!name.trim()) return 'Enter a branch name.';
  if (/\s/.test(name)) return 'A branch name cannot contain spaces.';
  if (name.startsWith('-')) return 'A branch name cannot start with "-".';
  if (name === '@' || name === 'HEAD') return `"${name}" is not allowed as a branch name.`;
  if (/[~^:?*[\\\u0000-\u001f\u007f]/.test(name)) return 'A branch name cannot contain these characters: ~ ^ : ? * [ \\';
  if (name.includes('..')) return 'A branch name cannot contain "..".';
  if (name.includes('@{')) return 'A branch name cannot contain "@{".';
  if (name.includes('//') || name.startsWith('/') || name.endsWith('/')) return 'Use single "/" between parts, and not at the start or end.';
  if (name.endsWith('.')) return 'A branch name cannot end with ".".';
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'A part of a branch name cannot start with ".".';
    if (part.endsWith('.lock')) return 'A part of a branch name cannot end with ".lock".';
  }
  for (const e of existing) if (e === name) return `A branch named "${name}" already exists.`;
  return null;
}

/** Message of git when it refuses a switch because of local changes: first lines only, for a dialog. */
export function shortGitMessage(message: string, maxLines = 12): string {
  const lines = message.trim().split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  return `${lines.slice(0, maxLines).join('\n')}\n...`;
}

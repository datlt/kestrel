// State of the GitHub feature for one workbench: the accounts of `gh` and the
// GitHub repository of the open folder.

import type { AppContext, Disposable } from '../../core/types';
import { ghRepoOf, ghStatus, type GhAccount, type GhRepoRef, type GhStatus } from '../../ipc/gh';
import { errorText, GhCalls } from './api';

/** What a pull request tab shows. It lives here so a rebuilt tab opens in the same place. */
export interface PrUiState {
  part: 'overview' | 'files';
  selected: string | null;
  filter: string;
  finishOpen: boolean;
  overviewScroll: number;
  fileScroll: number;
  diffScroll: number;
}

export class GithubService {
  readonly tabUi = new Map<string, PrUiState>();
  status: GhStatus | null = null;
  /** Text when `gh` could not be asked (for example it is not installed). */
  problem: string | null = null;
  loading = false;
  repo: GhRepoRef | null = null;
  readonly calls = new GhCalls();
  /** Set by the sidebar view. The `github.refresh` command calls it. */
  requestRefresh: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private statusRun = 0;

  constructor(private ctx: AppContext) {}

  onChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => void this.listeners.delete(fn) };
  }

  private emit() {
    for (const fn of [...this.listeners]) fn();
  }

  async loadStatus(): Promise<void> {
    const run = ++this.statusRun;
    this.loading = true;
    this.emit();
    try {
      const status = await ghStatus();
      if (run !== this.statusRun) return;
      this.status = status;
      this.problem = status.installed ? null : 'The GitHub CLI (gh) was not found. Install it from https://cli.github.com and restart Kestrel.';
    } catch (e) {
      if (run !== this.statusRun) return;
      this.status = null;
      this.problem = errorText(e);
    } finally {
      if (run === this.statusRun) this.loading = false;
      this.emit();
    }
  }

  async loadRepo(): Promise<void> {
    const root = this.ctx.workspace.root;
    let repo: GhRepoRef | null = null;
    if (root) {
      try {
        repo = await ghRepoOf(root);
      } catch {
        repo = null;
      }
    }
    // The folder can change while we wait.
    if (root !== this.ctx.workspace.root) return;
    this.repo = repo;
    this.emit();
  }

  accounts(): GhAccount[] {
    return this.status?.accounts ?? [];
  }

  /** Hosts where the active account has a working login. */
  workingHosts(): string[] {
    const hosts: string[] = [];
    for (const a of this.accounts()) if (a.active && a.state === 'success' && !hosts.includes(a.host)) hosts.push(a.host);
    return hosts;
  }

  /** The login that `gh` uses for a host (the active account). */
  loginOf(host: string): string {
    const list = this.accounts().filter((a) => a.host === host);
    return (list.find((a) => a.active) ?? list[0])?.login ?? '';
  }

  /** Host for `owner/repo#n` when the user does not type one. */
  defaultHost(): string {
    return this.repo?.host ?? this.workingHosts()[0] ?? this.accounts()[0]?.host ?? 'github.com';
  }

  /** True when the open folder is a clone of this repository. */
  isThisRepo(host: string, owner: string, repo: string): boolean {
    const r = this.repo;
    return !!r && r.host === host && r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === repo.toLowerCase();
  }

  dispose() {
    this.calls.close();
    this.listeners.clear();
  }
}

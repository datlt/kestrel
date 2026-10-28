// Branch switcher: the "Switch Branch..." quick pick and the switch flow.
// The pure parts (items, dirty check, name check) are in branch-model.ts.

import { Check, createElement } from 'lucide';
import type { AppContext, QuickPickHandle } from '../../core/types';
import { isIpcError } from '../../ipc/invoke';
import {
  gitBranchList,
  gitFetch,
  gitStashPop,
  gitStashPush,
  gitSwitch,
  gitValidateBranchName,
  type GitBranchList,
  type GitSwitchOptions,
} from '../../ipc/git';
import {
  buildBranchItems,
  buildStartPointItems,
  dirtyDecision,
  DIRTY_BUTTONS,
  shortGitMessage,
  switchRequest,
  validateBranchName,
  type BranchPickItem,
} from './branch-model';
import type { GitService } from './service';

const checkIcon = () => createElement(Check);

export class BranchSwitcher {
  private busy = false;
  private fetching = false;

  constructor(
    private ctx: AppContext,
    private svc: GitService,
  ) {}

  private errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  private async load(root: string): Promise<GitBranchList | null> {
    try {
      return await gitBranchList(root);
    } catch (e) {
      if (isIpcError(e, 'not_a_repo')) this.ctx.ui.notify('This folder is not a git repository.', { kind: 'warn' });
      else if (isIpcError(e, 'git_missing')) this.ctx.ui.notify('git was not found. Install git to switch branches.', { kind: 'warn' });
      else this.ctx.ui.notify(this.errorText(e), { kind: 'error' });
      return null;
    }
  }

  /** Command `git.switchBranch`. */
  async open(): Promise<void> {
    const root = this.ctx.workspace.root;
    if (!root || !this.svc.enabled) {
      this.ctx.ui.notify('Open a folder with a git repository first.', { kind: 'warn', timeoutMs: 2500 });
      return;
    }
    if (this.busy) return;
    const list = await this.load(root);
    if (list) this.show(root, list, '');
  }

  private show(root: string, list: GitBranchList, value: string): void {
    let handle: QuickPickHandle | null = null;
    let open = true;
    const opts = {
      placeholder: 'Switch to a branch, or create a new one',
      value,
      items: buildBranchItems(list, { fetching: this.fetching, checkIcon }),
      emptyText: 'No matching branch',
      onAccept: (item: BranchPickItem, query: string) => {
        open = false;
        this.accept(root, list, item, query);
      },
      onCancel: () => {
        open = false;
      },
    };
    handle = this.ctx.ui.quickPick<BranchPickItem>(opts);
    // A fetch started from an earlier picker may end while this one is open.
    // Returns false when this picker is closed.
    this.onFetchDone = async () => {
      if (!open) return false;
      const fresh = await this.load(root);
      if (!fresh || !open) return open;
      list = fresh;
      opts.items = buildBranchItems(fresh, { fetching: false, checkIcon });
      handle?.refresh();
      return true;
    };
  }

  private onFetchDone: (() => Promise<boolean>) | null = null;

  private accept(root: string, list: GitBranchList, item: BranchPickItem, query: string): void {
    switch (item.kind) {
      case 'new':
        void this.createBranch(root, list, null);
        return;
      case 'newFrom':
        void this.createFrom(root, list);
        return;
      case 'fetch':
        void this.fetch(root, list, query);
        return;
      case 'fetching':
        // The fetch runs. Show the picker again with the wait text.
        this.show(root, list, query);
        return;
      case 'detached':
        return;
      default: {
        const req = switchRequest(item);
        if (req) void this.switchTo(root, req.branch, req.track ? { track: req.track } : undefined);
      }
    }
  }

  private async fetch(root: string, list: GitBranchList, query: string): Promise<void> {
    this.fetching = true;
    this.show(root, list, query);
    try {
      await gitFetch(root);
    } catch (e) {
      this.fetching = false;
      if (!isIpcError(e, 'cancelled')) this.ctx.ui.notify(`Fetch failed: ${this.errorText(e)}`, { kind: 'error' });
      await this.onFetchDone?.();
      return;
    }
    this.fetching = false;
    const shown = (await this.onFetchDone?.()) ?? false;
    if (!shown) this.ctx.ui.notify('Fetch finished.', { timeoutMs: 2000 });
    this.svc.scheduleRefresh();
  }

  private async createBranch(root: string, list: GitBranchList, startPoint: string | null): Promise<void> {
    const existing = list.local.map((b) => b.name);
    const name = await this.ctx.ui.prompt({
      title: startPoint ? `New branch from ${startPoint}` : 'New branch name',
      placeholder: 'feature/my-change',
      validate: (v) => validateBranchName(v, existing),
    });
    if (name === null) return;
    const branch = name.trim();
    // Git checks the name once more, with its own rules.
    try {
      const check = await gitValidateBranchName(root, branch);
      if (!check.valid) {
        this.ctx.ui.notify(check.message ?? 'This is not a valid branch name.', { kind: 'error' });
        return;
      }
    } catch (e) {
      this.ctx.ui.notify(this.errorText(e), { kind: 'error' });
      return;
    }
    await this.switchTo(root, branch, { create: true, ...(startPoint ? { startPoint } : {}) }, `Created and switched to ${branch}`);
  }

  private createFrom(root: string, list: GitBranchList): Promise<void> {
    return new Promise((resolve) => {
      this.ctx.ui.quickPick<BranchPickItem>({
        placeholder: 'Start the new branch from...',
        items: buildStartPointItems(list, { checkIcon }),
        onAccept: (item) => {
          void this.createBranch(root, list, item.name ?? item.id).then(resolve);
        },
        onCancel: () => resolve(),
      });
    });
  }

  /** Asks about unsaved editors. Returns false when the user cancels or a save fails. */
  private async checkEditors(): Promise<boolean> {
    const decision = dirtyDecision(this.ctx.editors.all());
    if (!decision.ask) return true;
    const answer = await this.ctx.ui.confirm({
      title: 'Unsaved changes',
      message: decision.message,
      buttons: [...DIRTY_BUTTONS],
    });
    if (answer === 'Switch Anyway') return true;
    if (answer !== 'Save All and Switch') return false;
    await this.ctx.commands.execute('file.saveAll');
    if (dirtyDecision(this.ctx.editors.all()).ask) {
      this.ctx.ui.notify('Some files could not be saved. The branch was not changed.', { kind: 'warn' });
      return false;
    }
    return true;
  }

  /** The whole switch: editor check, git switch, stash offer, refresh, notification. */
  async switchTo(root: string, branch: string, options?: GitSwitchOptions, doneText?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!(await this.checkEditors())) return;
      let stashed = false;
      try {
        await gitSwitch(root, branch, options);
      } catch (e) {
        if (!isIpcError(e, 'conflict')) throw e;
        const answer = await this.ctx.ui.confirm({
          title: `Cannot switch to ${branch}`,
          message: `${shortGitMessage(e.message)}\n\nStash your changes, switch, and apply the stash later?`,
          buttons: ['Stash and Switch', 'Cancel'],
        });
        if (answer !== 'Stash and Switch') return;
        stashed = (await gitStashPush(root, `Kestrel: before switching to ${branch}`)).created;
        try {
          await gitSwitch(root, branch, options);
        } catch (e2) {
          // Put the changes back. The user keeps the work.
          if (stashed) await gitStashPop(root).catch(() => undefined);
          throw e2;
        }
      }
      await this.svc.refresh();
      this.ctx.ui.notify(doneText ?? `Switched to ${branch}`, {
        timeoutMs: stashed ? 15000 : 2500,
        actions: stashed ? [{ label: 'Apply Stash', run: () => void this.applyStash(root) }] : undefined,
      });
    } catch (e) {
      this.ctx.ui.notify(`Cannot switch to ${branch}: ${this.errorText(e)}`, { kind: 'error' });
      void this.svc.refresh();
    } finally {
      this.busy = false;
    }
  }

  private async applyStash(root: string): Promise<void> {
    try {
      await gitStashPop(root);
      this.ctx.ui.notify('Stash applied.', { timeoutMs: 2500 });
    } catch (e) {
      const text = this.errorText(e);
      this.ctx.ui.notify(isIpcError(e, 'conflict') ? `The stash did not apply cleanly. Git keeps it.\n${shortGitMessage(text)}` : text, {
        kind: 'error',
      });
    }
    await this.svc.refresh();
  }
}

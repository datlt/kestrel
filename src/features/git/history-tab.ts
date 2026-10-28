// Small entry for history tabs (kind `git-history`, id `history:<abs path>`).
// The heavy part (`history.ts`) loads with `import()` when the tab is created.

import type { AppContext, TabInput } from '../../core/types';
import { basename, dirname } from '../../core/util';
import type { GitService } from './service';

export const historyTabId = (path: string) => `history:${path}`;

/** What `HistoryContent` offers to the outside. */
export interface HistoryHandle {
  selectSha(sha: string): void;
}

export function historyTabInput(ctx: AppContext, svc: GitService, path: string): TabInput {
  return {
    id: historyTabId(path),
    kind: 'git-history',
    title: `${basename(path)} (history)`,
    description: dirname(ctx.workspace.relative(path)) || undefined,
    tooltip: `History of ${path}`,
    create: async (host) => {
      const { HistoryContent } = await import('./history');
      return new HistoryContent(ctx, svc, path, host);
    },
    serialize: () => ({ path }),
  };
}

export function restoreHistoryTab(ctx: AppContext, svc: GitService, data: unknown): TabInput | null {
  const d = data as { path?: unknown } | null;
  return d && typeof d.path === 'string' ? historyTabInput(ctx, svc, d.path) : null;
}

/** Opens the history of a file. With `sha`, that commit is selected. */
export function openHistory(ctx: AppContext, svc: GitService, path: string, sha?: string): void {
  if (sha) svc.historySelect.set(path, sha);
  const tab = ctx.tabs.open(historyTabInput(ctx, svc, path));
  // When the tab already exists, tell it which commit to show.
  if (sha && tab.content) (tab.content as unknown as HistoryHandle).selectSha?.(sha);
}

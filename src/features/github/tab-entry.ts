// Small entry for pull request tabs. It stays in the main bundle.
// The heavy part (`tab.ts`) loads with `import()` when the first tab is created.

import type { AppContext, TabInput } from '../../core/types';
import { parsePullRef, prShort, prTabId, type PullRef } from './parse';
import type { GithubService } from './service';

export function prTabInput(ctx: AppContext, svc: GithubService, ref: PullRef, title?: string): TabInput {
  return {
    id: prTabId(ref),
    kind: 'pr',
    title: title ?? prShort(ref),
    description: ref.host === 'github.com' ? undefined : ref.host,
    tooltip: `${prShort(ref)} on ${ref.host}`,
    create: async (host) => {
      const { PrTab } = await import('./tab');
      return new PrTab(ctx, svc, ref, host);
    },
    serialize: () => ({ host: ref.host, owner: ref.owner, repo: ref.repo, number: ref.number }),
  };
}

export function restorePrTab(ctx: AppContext, svc: GithubService, data: unknown): TabInput | null {
  const d = data as Partial<PullRef> | null;
  if (!d || typeof d.host !== 'string' || typeof d.owner !== 'string' || typeof d.repo !== 'string' || typeof d.number !== 'number') return null;
  const ref = parsePullRef(`${d.host}/${d.owner}/${d.repo}#${d.number}`, '');
  return ref ? prTabInput(ctx, svc, ref) : null;
}

export function openPullTab(ctx: AppContext, svc: GithubService, ref: PullRef, title?: string): void {
  ctx.tabs.open(prTabInput(ctx, svc, ref, title), { preview: false });
}

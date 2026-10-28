// GitHub pull requests (docs/DESIGN.md, section 12.4). Owner: github-ui agent.
//
// Sidebar view with the accounts of `gh` and the pull request lists, a tab for
// each pull request, and the commands. Heavy code (`view.ts`, `tab.ts`, the
// review diff) loads with `import()` the first time it is needed.

import { createElement, GitPullRequest } from 'lucide';
import type { AppContext } from '../../core/types';
import { lazyView } from '../lazy-view';
import { parsePullRef } from './parse';
import { GithubService } from './service';
import { openPullTab, restorePrTab } from './tab-entry';

interface PrTabLike {
  goFile?(dir: 1 | -1): void;
}

export function initGithub(ctx: AppContext): void {
  const svc = new GithubService(ctx);

  ctx.views.register({
    id: 'github',
    title: 'Pull Requests',
    icon: () => createElement(GitPullRequest),
    location: 'sidebar',
    order: 40,
    create: (host) => lazyView(host, async () => (await import('./view')).createGithubView(ctx, svc, host)),
  });

  ctx.tabs.registerKind('pr', (data) => restorePrTab(ctx, svc, data));

  ctx.bus.on('workspace:changed', () => void svc.loadRepo());
  ctx.bus.on('workbench:disposing', () => svc.dispose());

  const activePr = (): PrTabLike | null => {
    const tab = ctx.tabs.active();
    return tab && tab.input.kind === 'pr' ? ((tab.content as PrTabLike | null) ?? null) : null;
  };
  const category = 'GitHub';

  ctx.commands.registerMany([
    {
      id: 'github.showPullRequests',
      title: 'Show Pull Requests',
      category,
      run: () => ctx.views.show('github', { focus: true }),
    },
    {
      id: 'github.refresh',
      title: 'Refresh Pull Requests',
      category,
      run: () => {
        const wasVisible = ctx.views.isVisible('github');
        ctx.views.show('github');
        // A view that was hidden refreshes by itself when it shows.
        if (wasVisible) svc.requestRefresh?.();
      },
    },
    {
      id: 'github.openPullRequest',
      title: 'Open Pull Request...',
      category,
      run: async (arg?: unknown) => {
        if (!svc.status) await svc.loadStatus();
        if (!svc.repo) await svc.loadRepo();
        const host = svc.defaultHost();
        let text = typeof arg === 'string' ? arg : null;
        if (text === null) {
          text = await ctx.ui.prompt({
            title: 'Open Pull Request',
            placeholder: `https://${host}/owner/repo/pull/1  or  owner/repo#1`,
            validate: (v) => (parsePullRef(v, host) ? null : 'Enter a pull request address or owner/repo#number.'),
          });
        }
        const ref = text ? parsePullRef(text, host) : null;
        if (ref) openPullTab(ctx, svc, ref);
        else if (text) ctx.ui.notify('This is not a pull request address.', { kind: 'warn', timeoutMs: 4000 });
      },
    },
    {
      id: 'github.nextFile',
      title: 'Next File in Pull Request',
      category,
      when: () => activePr() !== null,
      run: () => activePr()?.goFile?.(1),
    },
    {
      id: 'github.previousFile',
      title: 'Previous File in Pull Request',
      category,
      when: () => activePr() !== null,
      run: () => activePr()?.goFile?.(-1),
    },
  ]);
}

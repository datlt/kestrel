// Git feature: sidebar view, diff tabs, editor gutter, status bar, decorations.
// Owner: git agent. Spec: docs/DESIGN.md section 7.5.

import { Compartment, type Extension } from '@codemirror/state';
import { createElement, GitBranch } from 'lucide';
import type { AppContext, FileEditor, QuickPickItem } from '../../core/types';
import { debounce } from '../../core/util';
import { gitBranches } from '../../ipc/git';
import { diffTabInput, restoreDiffTab } from './diff-tab';
import type { DiffContent } from './diff';
import { createGutter, jumpToChange } from './gutter';
import { openHistory, restoreHistoryTab } from './history-tab';
import { GitService, type GitModel } from './service';
import { lazyView } from '../lazy-view';

export function initGit(ctx: AppContext): void {
  ctx.settings.registerDefaults({ 'git.enabled': true, 'git.gutter': true });
  const svc = new GitService(ctx);
  const gutter = createGutter(ctx, svc);

  // --- Views, tabs, editor extension ---------------------------------------
  ctx.views.register({
    id: 'git',
    title: 'Source Control',
    icon: () => createElement(GitBranch),
    location: 'sidebar',
    order: 30,
    create: (host) => lazyView(host, async () => (await import('./view')).createGitView(ctx, svc, host)),
  });
  ctx.tabs.registerKind('diff', (data) => restoreDiffTab(ctx, svc, data));
  // Each file editor gets a compartment. `git.toggleBlame` fills or empties it.
  const blameState = new WeakMap<FileEditor, { comp: Compartment; on: boolean; ext?: Extension }>();
  ctx.editors.registerExtension((editor) => {
    const marks = gutter.provider(editor);
    if (editor.path.startsWith('untitled:')) return marks;
    const st = { comp: new Compartment(), on: false };
    blameState.set(editor, st);
    return [marks ?? [], st.comp.of([])];
  });
  ctx.tabs.registerKind('git-history', (data) => restoreHistoryTab(ctx, svc, data));

  // --- After each status: badge, status bar, decorations -------------------
  let lastKey = '';
  svc.onStatus = (m: GitModel | null) => {
    ctx.views.setBadge('git', m && m.count > 0 ? (m.count > 99 ? '99+' : String(m.count)) : null);
    if (m) {
      const where = m.branch ?? (m.head ? m.head.slice(0, 7) : 'no commits');
      let text = `${m.branch ? '' : 'HEAD '}${where}${m.count > 0 ? '*' : ''}`;
      if (m.ahead) text += ` ↑${m.ahead}`;
      if (m.behind) text += ` ↓${m.behind}`;
      ctx.status.set({
        id: 'git.branch',
        align: 'left',
        priority: 100,
        text,
        tooltip: m.upstream ? `${where} (upstream ${m.upstream}). ${m.count} change(s).` : `${where}. ${m.count} change(s).`,
        command: 'workbench.showGit',
      });
    } else {
      ctx.status.remove('git.branch');
    }
    const root = ctx.workspace.root;
    if (root) ctx.bus.emit('git:decorations', { root, files: m ? m.decorations : {} });

    // The gutter needs the top level path and, for new files, the untracked list.
    const key = m ? `${m.topLevel}|${m.head}` : '';
    gutter.hub.reloadAll(key !== lastKey);
    lastKey = key;
  };

  // --- Refresh triggers (all coalesced in the service) ---------------------
  const reloadBases = debounce(() => gutter.hub.reloadAll(true), 150);
  ctx.bus.on('workspace:changed', () => {
    svc.reset();
    void svc.refresh();
  });
  ctx.bus.on('file:saved', () => svc.scheduleRefresh());
  ctx.bus.on('fs:changed', (e) => {
    if (e.gitChanged || e.rescan) reloadBases();
    // Any change in the working tree can change the status.
    if (e.gitChanged || e.rescan || e.paths.length > 0) svc.scheduleRefresh();
  });
  // Only the visible workspace tab reacts to window focus (DESIGN 8.1).
  const onFocus = () => {
    if (ctx.window.isActive()) svc.scheduleRefresh();
  };
  window.addEventListener('focus', onFocus);
  ctx.bus.on('workbench:activated', () => {
    svc.scheduleRefresh();
    reloadBases();
  });
  ctx.bus.on('workbench:disposing', () => {
    window.removeEventListener('focus', onFocus);
    svc.scheduleRefresh.cancel();
  });
  ctx.bus.on('settings:changed', (e) => {
    if (e.settings['git.enabled'] !== e.previous['git.enabled']) void svc.refresh();
    if (e.settings['git.gutter'] !== e.previous['git.gutter']) gutter.hub.reloadAll(true);
  });
  if (ctx.workspace.root) void svc.refresh();

  // --- Commands ------------------------------------------------------------
  const activeDiff = () => {
    // `diff.ts` loads on demand, so we check the tab kind instead of using `instanceof`.
    const tab = ctx.tabs.active();
    return tab?.input.kind === 'diff' && tab.content ? (tab.content as DiffContent) : null;
  };
  const change = (dir: 1 | -1) => {
    const diff = activeDiff();
    if (diff) return diff.go(dir);
    const ed = ctx.editors.active();
    if (ed && !jumpToChange(ed, dir)) ctx.ui.notify('No changes in this file.', { timeoutMs: 2000 });
  };

  ctx.commands.registerMany([
    {
      id: 'git.refresh',
      title: 'Refresh',
      category: 'Git',
      run: () => svc.refresh(),
    },
    {
      id: 'git.openChanges',
      title: 'Open Changes',
      category: 'Git',
      keybinding: 'Mod-Alt-d',
      when: () => !!ctx.editors.active(),
      run: async () => {
        const ed = ctx.editors.active();
        if (!ed) return;
        const rel = svc.toRel(ed.path);
        if (!rel) {
          ctx.ui.notify('This file is not in the git repository.', { kind: 'warn' });
          return;
        }
        const item = svc.model?.items.find((i) => i.path === rel && i.group !== 'staged') ?? svc.model?.items.find((i) => i.path === rel);
        ctx.tabs.open(
          diffTabInput(ctx, svc, { base: svc.model?.baseName ?? 'HEAD', path: ed.path, origPath: item?.origPath ?? null }),
        );
      },
    },
    {
      id: 'git.compareWithBranch',
      title: 'Compare with Branch...',
      category: 'Git',
      run: async () => {
        const root = ctx.workspace.root;
        if (!root) return;
        let branches;
        try {
          branches = await gitBranches(root);
        } catch (e) {
          ctx.ui.notify((e as Error).message, { kind: 'error' });
          return;
        }
        const current = svc.baseName;
        const items: QuickPickItem[] = [
          {
            id: 'HEAD',
            label: 'Working tree vs HEAD',
            description: current === 'HEAD' ? 'current' : undefined,
            detail: 'Show uncommitted changes',
          },
          ...branches.map((b) => ({
            id: b.name,
            label: b.name,
            description: [b.current ? 'current branch' : b.remote ? 'remote' : '', current === b.name ? 'selected' : '']
              .filter(Boolean)
              .join(', '),
            detail: 'Compare with the merge base, like a pull request',
          })),
        ];
        ctx.ui.quickPick({
          placeholder: 'Compare the working tree with...',
          items,
          onAccept: (item) => {
            svc.setBase(item.id);
            ctx.views.show('git');
          },
        });
      },
    },
    {
      id: 'git.fileHistory',
      title: 'Show File History',
      category: 'Git',
      keybinding: 'Mod-Alt-h',
      // The optional argument is an absolute file path.
      run: (arg?: unknown) => {
        const path = typeof arg === 'string' ? arg : ctx.editors.active()?.path;
        if (!path || path.startsWith('untitled:')) {
          ctx.ui.notify('Open a file first.', { kind: 'warn', timeoutMs: 2000 });
          return;
        }
        if (!svc.toRel(path)) {
          ctx.ui.notify('This file is not in the git repository.', { kind: 'warn' });
          return;
        }
        openHistory(ctx, svc, path);
      },
    },
    {
      id: 'git.toggleBlame',
      title: 'Toggle Git Blame',
      category: 'Git',
      keybinding: 'Mod-Alt-b',
      when: () => !!ctx.editors.active(),
      run: async () => {
        const ed = ctx.editors.active();
        if (!ed) return;
        const st = blameState.get(ed);
        if (ed.meta.large || !st) {
          ctx.ui.notify(ed.meta.large ? 'Git blame is off for large files.' : 'Git blame is not available for this file.', {
            kind: 'warn',
            timeoutMs: 2500,
          });
          return;
        }
        if (!st.on && !svc.toRel(ed.path)) {
          ctx.ui.notify('This file is not in the git repository.', { kind: 'warn' });
          return;
        }
        st.on = !st.on;
        if (st.on) st.ext ??= (await import('./blame')).blameExtension(ctx, svc, ed);
        ed.view.dispatch({ effects: st.comp.reconfigure(st.on ? (st.ext ?? []) : []) });
      },
    },
    {
      id: 'git.nextChange',
      title: 'Go to Next Change',
      category: 'Git',
      keybinding: 'Alt-F5',
      when: () => !!activeDiff() || !!ctx.editors.active(),
      run: () => change(1),
    },
    {
      id: 'git.prevChange',
      title: 'Go to Previous Change',
      category: 'Git',
      keybinding: 'Shift-Alt-F5',
      when: () => !!activeDiff() || !!ctx.editors.active(),
      run: () => change(-1),
    },
  ]);
}

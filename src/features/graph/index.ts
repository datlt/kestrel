// Graph View of markdown files (docs/DESIGN.md, section 14.5).
//
// This file stays small: it registers the commands and the tab kind, and it
// keeps the Rust note index up to date. The view (`view.ts`, with the CSS, the
// simulation worker and d3) loads with `import()` the first time a graph tab
// is created.

import type { AppContext, TabInput } from '../../core/types';
import { debounce, dirname, isInside, joinPath, samePath } from '../../core/util';
import { fsStat } from '../../ipc/fs';
import { notesIndexDrop, notesIndexUpdate } from '../../ipc/notes';
import { FOLDERS_KEY, graphTitle, normalizeFolderState, normalizeOptions, normalizeScope, OPTIONS_KEY } from './model';
import type { GraphOptions, GraphScope, GraphTabState } from './types';
import type { GraphShared } from './view';

/** More changed files than this: let Rust read the whole folder again. */
const MAX_PATHS = 3000;
const FLUSH_MS = 400;

const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Paths inside `.git` change all the time and never hold notes. */
const inGitFolder = (p: string) => /[\\/]\.git([\\/]|$)/.test(p);

function readCamera(v: unknown): GraphTabState['camera'] {
  const c = v as { x?: unknown; y?: unknown; zoom?: unknown } | null;
  if (!c || typeof c.x !== 'number' || typeof c.y !== 'number' || typeof c.zoom !== 'number') return null;
  return Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.zoom) && c.zoom > 0 ? { x: c.x, y: c.y, zoom: c.zoom } : null;
}

export function initGraph(ctx: AppContext): void {
  let counter = 0;
  const shared: GraphShared = {
    saveOptions(o) {
      // The search text belongs to one graph. A new graph starts without it.
      ctx.workspace.globalState.set(OPTIONS_KEY, { ...o, query: '' });
    },
    saveFolders(f) {
      ctx.workspace.state.set(FOLDERS_KEY, f);
    },
    onIndexChanged: new Set(),
  };

  const loadOptions = (): GraphOptions => normalizeOptions(ctx.workspace.globalState.get(OPTIONS_KEY));

  function tabInput(n: number, state: GraphTabState): TabInput {
    const id = `graph:${n}`;
    return {
      id,
      kind: 'graph',
      title: graphTitle(state.scope, ctx.workspace.root),
      description: 'Graph',
      serialize: () => ({ n, scope: state.scope, options: state.options, folders: state.folders, camera: state.camera }),
      async create(host) {
        const { createGraphContent } = await import('./view');
        return createGraphContent(ctx, host, id, state, shared);
      },
    };
  }

  function openGraph(scope: GraphScope): void {
    const n = ++counter;
    const state: GraphTabState = {
      scope,
      options: loadOptions(),
      folders: normalizeFolderState(ctx.workspace.state.get(FOLDERS_KEY)),
      camera: null,
    };
    ctx.tabs.open(tabInput(n, state));
  }

  ctx.tabs.registerKind('graph', (data) => {
    const d = data as { n?: unknown; scope?: unknown; options?: unknown; folders?: unknown; camera?: unknown } | null;
    const scope = normalizeScope(d?.scope);
    if (!d || !scope || typeof d.n !== 'number') return null;
    counter = Math.max(counter, d.n);
    return tabInput(d.n, { scope, options: normalizeOptions(d.options), folders: normalizeFolderState(d.folders), camera: readCamera(d.camera) });
  });

  const hasRoot = () => !!ctx.workspace.root;

  ctx.commands.registerMany([
    {
      id: 'graph.show',
      title: 'Open Graph View',
      category: 'Graph',
      keybinding: 'Mod-Alt-g',
      when: hasRoot,
      run: () => openGraph({ kind: 'project' }),
    },
    {
      id: 'graph.showLocal',
      title: 'Open Local Graph',
      category: 'Graph',
      keybinding: 'Mod-Shift-Alt-g',
      when: hasRoot,
      run: (arg?: unknown) => {
        if (typeof arg === 'string' && arg) {
          openGraph({ kind: 'local', path: arg, follow: false });
          return;
        }
        // Without a file the graph follows the active editor.
        const active = ctx.editors.active()?.path;
        openGraph({ kind: 'local', path: active && isMarkdown(active) ? active : null, follow: true });
      },
    },
    {
      id: 'graph.showFolder',
      title: 'Show Graph for Folder',
      category: 'Graph',
      when: hasRoot,
      run: async (arg?: unknown) => {
        const root = ctx.workspace.root;
        let path = typeof arg === 'string' && arg ? arg : null;
        if (!path) {
          const active = ctx.editors.active();
          const start = active ? dirname(active.path) : (root ?? '');
          const answer = await ctx.ui.prompt({ title: 'Show Graph for Folder', value: start, placeholder: 'Path of a folder', validate: (v) => (v.trim() ? null : 'Enter a folder path.') });
          if (!answer) return;
          const typed = answer.trim();
          path = root && !/^([/\\]|[A-Za-z]:)/.test(typed) ? joinPath(root, typed) : typed;
        }
        try {
          const st = await fsStat(path);
          if (!st.exists) {
            ctx.ui.notify(`The folder does not exist: ${path}`, { kind: 'error' });
            return;
          }
          if (!st.isDir) path = dirname(path);
        } catch (e) {
          ctx.ui.notify(`Cannot read ${path}: ${errText(e)}`, { kind: 'error' });
          return;
        }
        openGraph(root && samePath(path, root) ? { kind: 'project' } : { kind: 'folder', path });
      },
    },
  ]);

  // --- Keep the note index up to date --------------------------------------------
  // Any file can change a link (a new image, a renamed note), so all paths go to Rust.

  const pending = new Set<string>();
  let rescan = false;
  const flush = debounce(() => {
    const root = ctx.workspace.root;
    if (!root) return;
    const paths = rescan ? [] : [...pending];
    const full = rescan;
    pending.clear();
    rescan = false;
    notesIndexUpdate(root, paths, full)
      .then(() => {
        for (const listener of [...shared.onIndexChanged]) listener();
      })
      .catch((e) => console.warn('note index: update failed', e));
  }, FLUSH_MS);

  const subs = [
    ctx.bus.on('fs:changed', (e) => {
      const root = ctx.workspace.root;
      if (!root || !samePath(e.root, root)) return;
      if (e.rescan) {
        rescan = true;
        pending.clear();
      } else if (!rescan) {
        for (const p of e.paths) if (isInside(p, root) && !inGitFolder(p)) pending.add(p);
        if (pending.size > MAX_PATHS) {
          rescan = true;
          pending.clear();
        }
      }
      if (rescan || pending.size) flush();
    }),
    ctx.bus.on('workspace:will-change', ({ from }) => {
      flush.cancel();
      pending.clear();
      rescan = false;
      if (from) notesIndexDrop(from).catch((e) => console.warn('note index: drop failed', e));
    }),
  ];
  ctx.bus.on('workbench:disposing', () => {
    flush.cancel();
    pending.clear();
    for (const s of subs) s.dispose();
  });
}

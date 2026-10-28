// Class diagram feature (docs/DESIGN.md, section 11.4).
//
// This file stays small: it registers the commands and the tab kind, and it
// keeps the Rust code index up to date. The view (`view.ts`, with the CSS) and
// dagre load with `import()` the first time a diagram tab is created.

import type { AppContext, TabInput } from '../../core/types';
import { debounce, dirname, extname, isInside, joinPath, samePath } from '../../core/util';
import type { DiagramScope } from '../../ipc/code';
import { codeIndexDrop, codeIndexUpdate } from '../../ipc/code';
import { fsStat } from '../../ipc/fs';
import { tabTitle } from './model';
import type { DiagramOptions } from './options';
import { normalizeOptions, normalizeScope, OPTIONS_KEY, scopeForSession } from './options';
import type { DiagramShared, DiagramTabState } from './view';

const SOURCE_EXTENSIONS = new Set(['.kt', '.kts', '.java', '.swift']);
const SOURCE_LANGUAGES = new Set(['kotlin', 'java', 'swift']);
/** More changed files than this: let Rust read the whole folder again. */
const MAX_PATHS = 3000;
const FLUSH_MS = 600;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function initDiagram(ctx: AppContext): void {
  let counter = 0;
  const shared: DiagramShared = {
    indexReady: false,
    saveOptions(o) {
      ctx.workspace.globalState.set(OPTIONS_KEY, o);
    },
    withEditorText(scope) {
      if (scope.kind !== 'cursor' && scope.kind !== 'file') return scope;
      const ed = ctx.editors.get(scope.path);
      const { text: _old, ...rest } = scope;
      return ed?.isDirty() ? ({ ...rest, text: ed.getText() } as DiagramScope) : (rest as DiagramScope);
    },
  };

  const loadOptions = (): DiagramOptions => normalizeOptions(ctx.workspace.globalState.get(OPTIONS_KEY));

  function tabInput(n: number, state: DiagramTabState): TabInput {
    const id = `diagram:${n}`;
    return {
      id,
      kind: 'diagram',
      title: state.title,
      description: 'Class Diagram',
      serialize: () => ({ n, scope: scopeForSession(state.scope), options: state.options, focus: state.focus, title: state.title }),
      async create(host) {
        const { createDiagramContent } = await import('./view');
        return createDiagramContent(ctx, host, id, state, shared);
      },
    };
  }

  function openDiagram(scope: DiagramScope): void {
    const n = ++counter;
    const state: DiagramTabState = { scope, options: loadOptions(), focus: null, title: tabTitle(scope as { kind: string; path?: string }, []) };
    ctx.tabs.open(tabInput(n, state));
  }

  ctx.tabs.registerKind('diagram', (data) => {
    const d = data as { n?: unknown; scope?: unknown; options?: unknown; focus?: unknown; title?: unknown } | null;
    const scope = normalizeScope(d?.scope);
    if (!d || !scope || typeof d.n !== 'number') return null;
    counter = Math.max(counter, d.n);
    const focus = Array.isArray(d.focus) && d.focus.every((f) => typeof f === 'string') ? (d.focus as string[]) : null;
    const state: DiagramTabState = {
      scope,
      options: normalizeOptions(d.options),
      focus,
      title: typeof d.title === 'string' && d.title ? d.title : tabTitle(scope as { kind: string; path?: string }, []),
    };
    return tabInput(d.n, state);
  });

  const isSourceEditor = () => {
    const ed = ctx.editors.active();
    return !!ed && SOURCE_LANGUAGES.has(ed.languageId);
  };

  function fileScope(path: string): DiagramScope {
    return shared.withEditorText({ kind: 'file', path });
  }

  ctx.commands.registerMany([
    {
      id: 'diagram.showForCursor',
      title: 'Show Class Diagram',
      category: 'Diagram',
      keybinding: 'Mod-Alt-u',
      when: isSourceEditor,
      run: () => {
        const ed = ctx.editors.active();
        if (!ed || !SOURCE_LANGUAGES.has(ed.languageId)) return;
        const doc = ed.view.state.doc;
        const head = ed.view.state.selection.main.head;
        const line = doc.lineAt(head);
        openDiagram(shared.withEditorText({ kind: 'cursor', path: ed.path, line: line.number, column: head - line.from + 1 }));
      },
    },
    {
      id: 'diagram.showForFile',
      title: 'Show Class Diagram for File',
      category: 'Diagram',
      run: (arg?: unknown) => {
        const path = typeof arg === 'string' && arg ? arg : ctx.editors.active()?.path;
        if (!path) {
          ctx.ui.notify('Open a Kotlin, Java or Swift file first.', { kind: 'info', timeoutMs: 3000 });
          return;
        }
        if (!SOURCE_EXTENSIONS.has(extname(path))) {
          ctx.ui.notify('A class diagram needs a Kotlin, Java or Swift file.', { kind: 'info', timeoutMs: 3000 });
          return;
        }
        openDiagram(fileScope(path));
      },
    },
    {
      id: 'diagram.showForFolder',
      title: 'Show Class Diagram for Folder',
      category: 'Diagram',
      run: async (arg?: unknown) => {
        const root = ctx.workspace.root;
        let path = typeof arg === 'string' && arg ? arg : null;
        if (!path) {
          const active = ctx.editors.active();
          const start = active ? dirname(active.path) : (root ?? '');
          const answer = await ctx.ui.prompt({ title: 'Show Class Diagram for Folder', value: start, placeholder: 'Path of a folder', validate: (v) => (v.trim() ? null : 'Enter a folder path.') });
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
        openDiagram({ kind: 'folder', path });
      },
    },
  ]);

  // --- Keep the code index up to date --------------------------------------------

  const pending = new Set<string>();
  let rescan = false;
  const flush = debounce(() => {
    const root = ctx.workspace.root;
    if (!root) return;
    const paths = rescan ? [] : [...pending];
    const full = rescan;
    pending.clear();
    rescan = false;
    codeIndexUpdate(root, paths, full).catch((e) => console.warn('code index: update failed', e));
  }, FLUSH_MS);

  const subs = [
    ctx.bus.on('fs:changed', (e) => {
      const root = ctx.workspace.root;
      if (!root || !samePath(e.root, root)) return;
      if (e.rescan) {
        rescan = true;
        pending.clear();
      } else if (!rescan) {
        for (const p of e.paths) {
          if (SOURCE_EXTENSIONS.has(extname(p)) && isInside(p, root)) pending.add(p);
        }
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
      shared.indexReady = false;
      if (from) codeIndexDrop(from).catch((e) => console.warn('code index: drop failed', e));
    }),
  ];
  ctx.bus.on('workbench:disposing', () => {
    flush.cancel();
    pending.clear();
    for (const s of subs) s.dispose();
  });
}

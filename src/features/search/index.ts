// Search feature: quick open (Mod-p) and find in files (the `search` view).
// Rust side: crates/kestrel-search and src-tauri/src/cmd/search.rs.

import { Search, createElement } from 'lucide';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import type { AppContext } from '../../core/types';
import { startIndexSync } from './index-sync';
import { createQuickOpen } from './quick-open';
import type { SearchView } from './view';
import { lazyView } from '../lazy-view';
import { isMac } from '../../core/util';
import type { FindWindowPayload } from './find-window';
import type { FindPopup } from './popup';


/** First line of the selection in the active editor, if there is one. */
function selectedText(ctx: AppContext): string | null {
  const view = ctx.editors.active()?.view;
  if (!view) return null;
  const sel = view.state.selection.main;
  if (sel.empty) return null;
  const text = view.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + 300));
  return text.split(/\r?\n/)[0] || null;
}

export function initSearch(ctx: AppContext): void {
  startIndexSync(ctx);
  const quickOpen = createQuickOpen(ctx);

  let view: SearchView | null = null;
  // Work for a view that does not exist yet (it is created at the first show).
  let pending: ((v: SearchView) => void) | null = null;
  let popup: FindPopup | null = null;
  let popupLoading: Promise<FindPopup> | null = null;

  /** The popup code loads at the first use. One popup per workbench. */
  async function getPopup(): Promise<FindPopup> {
    if (popup) return popup;
    popupLoading ??= import('./popup').then(({ FindPopup }) => {
      popup = new FindPopup(ctx);
      return popup;
    });
    return popupLoading;
  }

  async function openPopup(replace: boolean): Promise<void> {
    const text = selectedText(ctx);
    try {
      (await getPopup()).open({ replace, text });
    } catch (e) {
      ctx.ui.notify(`Cannot open Find in Files: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
    }
  }

  function withView(fn: (v: SearchView) => void): void {
    ctx.views.show('search', { focus: true });
    if (view) fn(view);
    else pending = fn;
  }

  ctx.bus.on('workspace:changed', () => popup?.workspaceChanged());
  ctx.bus.on('workbench:disposing', () => popup?.dispose());

  // On macOS the editor keymap uses Ctrl-f and friends to move the cursor.
  // This keymap runs first, so Ctrl-Shift-f and Ctrl-Shift-r reach our commands.
  if (isMac) {
    const keys = Prec.highest(
      keymap.of([
        { key: 'Ctrl-Shift-f', run: () => (void ctx.commands.execute('search.findInFiles'), true) },
        { key: 'Ctrl-Shift-r', run: () => (void ctx.commands.execute('search.replaceInFiles'), true) },
      ]),
    );
    ctx.editors.registerExtension(() => keys);
  }

  ctx.views.register({
    id: 'search',
    title: 'Search',
    icon: () => createElement(Search),
    location: 'sidebar',
    order: 20,
    // The view code loads with `import()` the first time the view is shown.
    create: (host) =>
      lazyView(host, async () => {
        const { SearchView } = await import('./view');
        const created = new SearchView(ctx, host);
        view = created;
        if (pending) {
          const fn = pending;
          pending = null;
          fn(created);
        }
        return created;
      }),
  });

  ctx.commands.registerMany([
    {
      id: 'search.quickOpen',
      title: 'Go to File…',
      category: 'Search',
      keybinding: 'Mod-p',
      run: () => quickOpen.open(),
    },
    {
      id: 'search.findInFiles',
      title: 'Find in Files',
      category: 'Search',
      keybinding: isMac ? ['Mod-Shift-f', 'Ctrl-Shift-f'] : 'Mod-Shift-f',
      run: () => openPopup(false),
    },
    {
      id: 'search.replaceInFiles',
      title: 'Replace in Files',
      category: 'Search',
      keybinding: isMac ? ['Mod-Shift-r', 'Ctrl-Shift-r'] : 'Mod-Shift-r',
      run: () => openPopup(true),
    },
    {
      // The sidebar Search view. With a payload (from the popup) it shows the popup results.
      id: 'search.showFindWindow',
      title: 'Show Find Window',
      category: 'Search',
      run: (payload?: FindWindowPayload) => {
        if (payload && typeof payload === 'object' && 'files' in payload) withView((v) => v.load(payload));
        else {
          const text = selectedText(ctx);
          withView((v) => v.activate(text));
        }
      },
    },
  ]);
}

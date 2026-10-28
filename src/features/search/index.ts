// Search feature: quick open (Mod-p) and find in files (the `search` view).
// Rust side: crates/kestrel-search and src-tauri/src/cmd/search.rs.

import { Search, createElement } from 'lucide';
import type { AppContext } from '../../core/types';
import { startIndexSync } from './index-sync';
import { createQuickOpen } from './quick-open';
import type { SearchView } from './view';
import { lazyView } from '../lazy-view';


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
  // Text for a view that does not exist yet (it is created at the first show).
  let pending: { text: string | null } | null = null;

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
          created.activate(pending.text);
          pending = null;
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
      run: () => {
        const text = selectedText(ctx);
        if (view) {
          ctx.views.show('search', { focus: true });
          view.activate(text);
        } else {
          pending = { text };
          ctx.views.show('search', { focus: true });
        }
      },
    },
  ]);
}

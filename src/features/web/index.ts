// Web tabs: web apps (mail, calendar, chat) as tabs inside the editor.
// Owner: web agent. Spec: docs/DESIGN.md section 10.3.
//
// A web tab shows a native web view that Rust creates over the tab content
// area (src-tauri/src/cmd/web.rs). The heavy part (`tab.ts`) loads with
// `import()` when the first web tab opens.

import { createElement, Globe } from 'lucide';
import type { AppContext, QuickPickItem } from '../../core/types';
import { lazyView } from '../lazy-view';
import { WebHub, type WebTabState } from './hub';
import { bookmarkTitle, hostOf, normalizeUrl } from './url';

/** Registers the Web view, the web tabs and the web commands. */
export function initWeb(ctx: AppContext): void {
  const hub = new WebHub(ctx);

  ctx.views.register({
    id: 'web',
    title: 'Web',
    icon: () => createElement(Globe),
    location: 'sidebar',
    order: 50,
    create: (host) => lazyView(host, async () => (await import('./view')).createWebView(ctx, hub, host)),
  });

  ctx.tabs.registerKind('web', (data) => {
    const d = data as Partial<WebTabState> | null;
    const url = d && typeof d.url === 'string' ? normalizeUrl(d.url) : null;
    if (!d || !url || typeof d.n !== 'number' || !Number.isFinite(d.n)) return null;
    hub.seen(d.n);
    return hub.tabInput({
      n: d.n,
      url,
      title: typeof d.title === 'string' ? d.title : undefined,
      origin: typeof d.origin === 'string' ? d.origin : undefined,
      zoom: typeof d.zoom === 'number' && d.zoom > 0 ? d.zoom : undefined,
    });
  });

  const inWebTab = () => hub.activeHandle() !== null || hub.activeUrl() !== null;
  const category = 'Web';

  ctx.commands.registerMany([
    {
      id: 'web.open',
      title: 'Open Web Page...',
      category,
      run: async () => {
        const text = await ctx.ui.prompt({
          title: 'Open Web Page',
          placeholder: 'https://example.com',
          validate: (v) => (normalizeUrl(v) ? null : 'Enter a web address, for example https://example.com'),
        });
        const url = text ? normalizeUrl(text) : null;
        if (url) hub.openUrl(url);
      },
    },
    {
      id: 'web.openBookmark',
      title: 'Open Web Bookmark...',
      category,
      run: (url?: unknown) => {
        // With an address as argument (from the sidebar), open it at once.
        if (typeof url === 'string' && url) {
          hub.openBookmark(url);
          return;
        }
        const items: (QuickPickItem & { url: string })[] = hub.bookmarks().map((u) => ({
          id: u,
          url: u,
          label: bookmarkTitle(u, hub.titles),
          description: hostOf(u),
          icon: () => createElement(Globe),
        }));
        ctx.ui.quickPick({
          placeholder: 'Open a bookmarked web page',
          items,
          emptyText: 'No bookmarks. Add pages in the setting web.bookmarks.',
          onAccept: (item) => hub.openBookmark(item.url),
        });
      },
    },
    {
      id: 'web.addBookmark',
      title: 'Add Current Web Page to Bookmarks',
      category,
      run: async () => {
        const url = hub.activeUrl();
        if (!url) {
          ctx.ui.notify('Open a web tab first.', { kind: 'info', timeoutMs: 3000 });
          return;
        }
        const added = await hub.addBookmark(url);
        ctx.ui.notify(added ? 'Added to bookmarks.' : 'This page is a bookmark already.', { kind: 'info', timeoutMs: 2500 });
      },
    },
    { id: 'web.reload', title: 'Reload Web Page', category, keybinding: 'Mod-Alt-r', when: inWebTab, run: () => hub.activeHandle()?.reload() },
    { id: 'web.back', title: 'Web Page Back', category, keybinding: 'Mod-[', when: inWebTab, run: () => hub.activeHandle()?.back() },
    { id: 'web.forward', title: 'Web Page Forward', category, keybinding: 'Mod-]', when: inWebTab, run: () => hub.activeHandle()?.forward() },
  ]);
}

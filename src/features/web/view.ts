// The Web sidebar view: bookmarks (from `web.bookmarks`) and the open web tabs.

import { createElement, Globe, X } from 'lucide';
import { h } from '../../core/dom';
import type { AppContext, Disposable, ViewInstance } from '../../core/types';
import { webSupported } from '../../ipc/web';
import type { WebHub } from './hub';
import { bookmarkTitle, hostOf } from './url';
import './web.css';

export function createWebView(ctx: AppContext, hub: WebHub, host: HTMLElement): ViewInstance {
  const root = h('div', { class: 'web-view' });
  host.append(root);
  const subs: Disposable[] = [];

  const run = (id: string, ...args: unknown[]) => {
    ctx.commands.execute(id, ...args).catch((err) => {
      console.error(`command ${id} failed`, err);
      ctx.ui.notify(`Command failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    });
  };

  function actionButton(text: string, id: string): HTMLButtonElement {
    const b = h('button', { class: 'shell-btn', type: 'button' }, text);
    b.addEventListener('click', () => run(id));
    return b;
  }

  function render() {
    const children: Node[] = [];
    if (!webSupported()) children.push(h('div', { class: 'web-view-note' }, 'Web tabs need the Kestrel app'));
    children.push(h('div', { class: 'web-view-actions' }, actionButton('Open URL...', 'web.open'), actionButton('Add current page', 'web.addBookmark')));

    const marks = hub.bookmarks();
    children.push(h('div', { class: 'web-section' }, 'Bookmarks'));
    if (!marks.length) children.push(h('div', { class: 'web-view-note' }, 'No bookmarks. Add pages in the setting web.bookmarks.'));
    for (const url of marks) {
      const row = h(
        'button',
        { class: 'web-row', type: 'button', title: url },
        createElement(Globe),
        h('span', { class: 'web-row-title' }, bookmarkTitle(url, hub.titles)),
        h('span', { class: 'web-row-desc' }, hostOf(url)),
      );
      row.addEventListener('click', () => run('web.openBookmark', url));
      row.addEventListener('contextmenu', (e) =>
        ctx.ui.contextMenu(e, [
          { label: 'Open', run: () => run('web.openBookmark', url) },
          { label: 'Open in New Tab', run: () => hub.openUrl(url) },
          { label: 'Remove Bookmark', separatorBefore: true, run: () => void hub.removeBookmark(url) },
        ]),
      );
      children.push(row);
    }

    const tabs = hub.webTabs();
    if (tabs.length) {
      children.push(h('div', { class: 'web-section' }, 'Open tabs'));
      const activeId = ctx.tabs.active()?.id;
      for (const t of tabs) {
        const close = h('button', { class: 'web-row-close', type: 'button', title: 'Close tab', 'aria-label': 'Close tab' }, createElement(X));
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          void ctx.tabs.close(t.id);
        });
        const row = h(
          'div',
          { class: 'web-row' + (t.id === activeId ? ' web-current' : ''), role: 'button', tabindex: '0', title: t.url },
          createElement(Globe),
          h('span', { class: 'web-row-title' }, t.title),
          h('span', { class: 'web-row-desc' }, t.url ? hostOf(t.url) : ''),
          close,
        );
        row.addEventListener('click', () => ctx.tabs.activate(t.id));
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            ctx.tabs.activate(t.id);
          }
        });
        children.push(row);
      }
    }
    root.replaceChildren(...children);
  }

  render();
  subs.push(hub.onChange(render), ctx.bus.on('tab:activated', render));

  return {
    onShow: render,
    dispose() {
      for (const s of subs) s.dispose();
      root.remove();
    },
  };
}

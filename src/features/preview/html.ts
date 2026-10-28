// HTML preview: shows the text of the editor in an iframe.
// Scripts off (default): `srcdoc` with `sandbox="allow-same-origin"`.
// Scripts on: Rust keeps the text, and the frame loads it from the URL of the
// file with `?kestrel-live=<id>` and `sandbox="allow-scripts"` (no
// `allow-same-origin`), so the page has its own empty origin and cannot reach
// the app. A `srcdoc` frame would get the CSP of the main window, which blocks
// inline scripts.

import { h } from '../../core/dom';
import type { AppContext, FileEditor, PreviewInstance } from '../../core/types';
import { dirname, escapeHtml } from '../../core/util';
import { previewDirUrl, previewDropLive, previewSetLive, previewUrl } from '../../ipc/preview';
import { nextZoom } from './frame';
import './preview.css';

/** Puts a `<base href>` at the start of the document head. Our base is the first one, so it wins. */
export function injectBase(html: string, base: string | null): string {
  if (!base) return html;
  const tag = `<base href="${escapeHtml(base)}">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + `<head>${tag}</head>` + html.slice(root.index + root[0].length);
  return tag + html;
}

export function createHtmlPreview(ctx: AppContext, host: HTMLElement, editor: FileEditor): PreviewInstance {
  const base = editor.path.startsWith('untitled:') ? null : previewDirUrl(dirname(editor.path));
  let scripts = ctx.settings.get('preview.htmlScripts');
  let text = '';
  let zoomLevel = 1;
  let scrollY = 0;
  let scrollX = 0;
  const liveId = Math.random().toString(36).slice(2);
  let liveVersion = 0;

  const iframe = h('iframe', { class: 'preview-frame is-html', title: 'HTML preview' });
  const scriptsBtn = h('button', { class: 'preview-btn', type: 'button', title: 'Run scripts in the page' }, 'Scripts');
  const note = h('span', { class: 'preview-note' });
  const reloadBtn = h('button', { class: 'preview-btn', type: 'button', title: 'Reload the page' }, 'Reload');
  const toolbar = h('div', { class: 'preview-toolbar' }, scriptsBtn, reloadBtn, h('span', { class: 'preview-spacer' }), note);
  host.append(h('div', { class: 'preview-root' }, toolbar, iframe));

  function saveScroll(): void {
    // Only readable without scripts (same origin).
    if (scripts) return;
    try {
      scrollY = iframe.contentWindow?.scrollY ?? 0;
      scrollX = iframe.contentWindow?.scrollX ?? 0;
    } catch {
      scrollY = scrollX = 0;
    }
  }

  function restoreScroll(): void {
    if (scripts) return;
    try {
      const doc = iframe.contentDocument;
      if (doc) (doc.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(zoomLevel);
      iframe.contentWindow?.scrollTo(scrollX, scrollY);
    } catch {
      // Cross-origin: nothing to restore.
    }
  }

  function load(): void {
    iframe.setAttribute('sandbox', scripts ? 'allow-scripts' : 'allow-same-origin');
    scriptsBtn.setAttribute('aria-pressed', String(scripts));
    note.textContent = scripts ? 'Scripts on' : 'Scripts off';
    if (scripts && base) {
      iframe.removeAttribute('srcdoc');
      const version = ++liveVersion;
      previewSetLive(liveId, text)
        .then(() => {
          if (version === liveVersion) iframe.src = `${previewUrl(editor.path)}?kestrel-live=${liveId}&v=${version}`;
        })
        .catch((e) => ctx.ui.notify(`HTML preview failed: ${e instanceof Error ? e.message : e}`, { kind: 'error' }));
      return;
    }
    iframe.removeAttribute('src');
    iframe.srcdoc = injectBase(text, base);
  }

  iframe.addEventListener('load', restoreScroll);
  scriptsBtn.addEventListener('click', () => {
    saveScroll();
    scripts = !scripts;
    scrollX = scrollY = 0;
    load();
  });
  reloadBtn.addEventListener('click', () => {
    saveScroll();
    load();
  });
  const sub = ctx.bus.on('settings:changed', ({ settings, previous }) => {
    if (settings['preview.htmlScripts'] === previous['preview.htmlScripts']) return;
    scripts = settings['preview.htmlScripts'];
    scrollX = scrollY = 0;
    load();
  });
  // The workspace tab closes. Free the text that Rust keeps for this page.
  const closing = ctx.bus.on('workbench:disposing', () => {
    liveVersion++;
    previewDropLive(liveId);
  });

  return {
    update(next) {
      if (next === text && (iframe.srcdoc || iframe.src)) return;
      saveScroll();
      text = next;
      load();
    },
    zoom(step) {
      zoomLevel = nextZoom(zoomLevel, step);
      restoreScroll();
    },
    dispose() {
      sub.dispose();
      closing.dispose();
      liveVersion++;
      previewDropLive(liveId);
      iframe.removeEventListener('load', restoreScroll);
      iframe.remove();
      toolbar.remove();
    },
  };
}

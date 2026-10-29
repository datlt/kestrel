// Markdown preview: an iframe that runs no scripts of the file. The frame is
// built once. Later updates replace the content of one element, so the scroll
// position stays. The frame has the same origin as the app (`allow-same-origin`),
// so this code reaches its document directly and adds the event listeners.
//
// WebKit (the Tauri web view on macOS) does not call event listeners in a frame
// whose sandbox has no `allow-scripts`, even listeners that this window added.
// Chrome does call them. So the frame loads with `allow-scripts`, and these
// rules keep the scripts of the file out:
// - The frame document has a CSP `script-src 'none'` (no <script>, no `onerror=`,
//   no `javascript:` links). The CSP of the app also applies to a srcdoc frame.
// - Right after the load, the sandbox goes back to `allow-same-origin` only. The
//   loaded document keeps its flags, but a page that the frame goes to later
//   (a link, a refresh) gets no scripts. Then `onLoad` loads our document again.
// - `<meta>` elements of the file are removed (a meta refresh would leave the page).

import { openUrl } from '@tauri-apps/plugin-opener';
import { h } from '../../core/dom';
import { DEFAULT_SETTINGS } from '../../core/settings';
import type { AppContext, FileEditor, PreviewInstance } from '../../core/types';
import { dirname, escapeHtml, extname, rafThrottle } from '../../core/util';
import { fsStat } from '../../ipc/fs';
import { mdRender, pathFromPreviewUrl, previewDirUrl } from '../../ipc/preview';
import { animate, forwardKeys, nextZoom, themeCss, wheelZoomStepper } from './frame';
import { PreviewFind } from './markdown-find';
import { findKeyAction } from './markdown-find-text';
import { MARKDOWN_CSS } from './markdown-css';
import { codeText, dragWidth, normalizeWidth, pageMaxWidth, PAGE_PADDING, widthLabel } from './markdown-layout';
import { NoteLinks } from './wikilinks';
import './preview.css';

const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,pre,li,blockquote,table,tr,hr,dl,details,div.markdown-alert'
  .split(',')
  .map((s) => `${s}[data-sourcepos]`)
  .join(',');
const HEADINGS = 'h1,h2,h3,h4,h5,h6';
const MAX_HIGHLIGHT_CHARS = 100_000;
const CACHE_LIMIT = 300;

/** Nothing of the file may run, embed a plugin or a frame, or send a form. */
const FRAME_CSP = "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'";
const SANDBOX_LOAD = 'allow-same-origin allow-scripts';
const SANDBOX_AFTER_LOAD = 'allow-same-origin';
/** More reloads than this in RELOAD_WINDOW_MS: the page keeps leaving, so stop loading it again. */
const MAX_RELOADS = 5;
const RELOAD_WINDOW_MS = 3000;
const RESIZE_TITLE = 'Drag to change the text width. Double-click: default width.';
const COPIED_MS = 1200;
// Small 16x16 line icons. They have no text, so copying page text stays clean.
const svg = (d: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
const ICON_COPY = svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>');
const ICON_CHECK = svg('<path d="M3 8.5l3.2 3.2L13 4.8"/>');
const ICON_WRAP = svg('<path d="M2 4h12M2 8h9a2.5 2.5 0 0 1 0 5H8"/><path d="M9.5 11.5L8 13l1.5 1.5"/>');

interface Block {
  el: HTMLElement;
  start: number;
  end: number;
}

// Highlighted code is kept between renders, so code blocks do not flash.
// Each workbench has its own cache (no module state shared between workbenches).
const highlightCaches = new WeakMap<AppContext, Map<string, string>>();

/** `load` numbers each load, so setting `srcdoc` always loads the frame again. */
function buildDoc(base: string | null, ctx: AppContext, load: number): string {
  const baseTag = base ? `<base href="${escapeHtml(base)}">` : '';
  return (
    `<!doctype html><html data-load="${load}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${baseTag}` +
    `<style id="kv">${themeCss()}</style><style>${MARKDOWN_CSS}</style>` +
    `<style id="hl">${ctx.editors.highlightCss()}</style></head>` +
    `<body><div id="page"><div class="md-resize md-resize-l" title="${RESIZE_TITLE}"></div>` +
    `<article id="md" class="markdown-body"></article>` +
    `<div class="md-resize md-resize-r" title="${RESIZE_TITLE}"></div></div></body></html>`
  );
}

export function createMarkdownPreview(ctx: AppContext, host: HTMLElement, editor: FileEditor): PreviewInstance {
  const isFile = !editor.path.startsWith('untitled:');
  const highlightCache = highlightCaches.get(ctx) ?? new Map<string, string>();
  highlightCaches.set(ctx, highlightCache);
  const iframe = h('iframe', { class: 'preview-frame', sandbox: SANDBOX_AFTER_LOAD, title: 'Markdown preview' });
  const root = h('div', { class: 'preview-root' }, iframe);
  host.append(root);
  const find = new PreviewFind(root, iframe);
  const base = isFile ? previewDirUrl(dirname(editor.path)) : null;
  // True from `loadFrame()` until its load event. Other loads are not ours.
  let loading = false;
  let loadCount = 0;
  let reloads: number[] = [];
  function loadFrame(): void {
    loading = true;
    iframe.setAttribute('sandbox', SANDBOX_LOAD);
    iframe.srcdoc = buildDoc(base, ctx, ++loadCount);
  }
  /** True when the frame shows our srcdoc document (a page of another origin throws on `location`). */
  function frameIsOurs(): boolean {
    try {
      return iframe.contentWindow?.location.href === 'about:srcdoc';
    } catch {
      return false;
    }
  }
  loadFrame();

  let disposed = false;
  const links = new NoteLinks(ctx, editor.path);
  let doc: Document | null = null;
  let article: HTMLElement | null = null;
  let lastHtml = '';
  let hasContent = false;
  let pendingText: string | null = null;
  let renderSeq = 0;
  let blocks: Block[] = [];
  let pendingLine: number | null = null;
  let savedScroll = 0;
  let zoomLevel = 1;
  let stopZoom: (() => void) | null = null;
  let page: HTMLElement | null = null;
  let resizing = false;

  try {
    const z = ctx.workspace.globalState.get<number>('preview.zoom');
    if (typeof z === 'number' && z >= 0.25 && z <= 5) zoomLevel = z;
  } catch {
    // The workspace service may not be ready. The default is fine.
  }

  // --- Scroll sync -------------------------------------------------------
  // Scroll events from our own scrolling (sync, anchors, zoom) must not go back
  // to the editor. Only scrolling that follows a user action (wheel, touch, key,
  // scrollbar drag) is sent.
  let lastIntent = 0;
  let pointerDown = false;
  let lastSentLine = -1;
  let lastUserScroll = 0;
  const intent = () => {
    lastIntent = performance.now();
  };
  const hasIntent = () => pointerDown || performance.now() - lastIntent < 400;

  function rebuildIndex(): void {
    blocks = [];
    if (!article) return;
    for (const el of article.querySelectorAll<HTMLElement>(BLOCKS)) {
      const m = /^(\d+):\d+-(\d+):\d+$/.exec(el.dataset.sourcepos ?? '');
      if (m) blocks.push({ el, start: +m[1], end: +m[2] });
    }
  }

  /** 1-based source line at the top of the preview. */
  function topLine(): number {
    if (!blocks.length) return 1;
    let lo = 0;
    let hi = blocks.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].el.getBoundingClientRect().top <= 1) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return 1;
    const b = blocks[found];
    const r = b.el.getBoundingClientRect();
    const frac = r.height > 0 ? Math.min(1, Math.max(0, -r.top / r.height)) : 0;
    return Math.max(1, Math.floor(b.start + frac * (b.end - b.start + 1)));
  }

  function scrollToLine(line: number): void {
    const win = iframe.contentWindow;
    if (!win || !blocks.length) return;
    let lo = 0;
    let hi = blocks.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].start <= line) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) {
      win.scrollTo(0, 0);
      return;
    }
    const b = blocks[found];
    const r = b.el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (line - b.start) / (b.end - b.start + 1)));
    win.scrollTo(0, win.scrollY + r.top + frac * r.height);
  }

  /**
   * Remembers the source line at the top of the preview. The returned function
   * scrolls back to that line after the layout changes (text width, code wrap).
   * At the very top of the page there is nothing to keep.
   */
  function keepPlace(): () => void {
    const win = iframe.contentWindow;
    if (!win || win.scrollY <= 0) return () => {};
    const line = topLine();
    return () => scrollToLine(line);
  }

  const sendScroll = rafThrottle(() => {
    if (resizing || !hasIntent()) return;
    const line = topLine();
    lastUserScroll = performance.now();
    if (line === lastSentLine) return;
    lastSentLine = line;
    editor.revealLine(line);
  });

  // --- Links -------------------------------------------------------------
  function scrollToAnchor(id: string): void {
    if (!doc) return;
    let name = id;
    try {
      name = decodeURIComponent(id);
    } catch {
      // Keep the raw text.
    }
    const el = doc.getElementById(name) ?? doc.getElementsByName(name)[0];
    if (!el) return;
    const target = el.closest(HEADINGS) ?? el;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function onClick(e: MouseEvent): void {
    const tool = (e.target as Element | null)?.closest?.<HTMLButtonElement>('button[data-md-action]');
    if (tool) {
      e.preventDefault();
      onTool(tool);
      return;
    }
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href == null) return;
    e.preventDefault();
    const background = e.metaKey || e.ctrlKey;
    if (a.dataset.wikilink) {
      void links.open(href, true, background).catch((err) => ctx.ui.notify(`Cannot open link: ${err}`, { kind: 'error' }));
    } else if (href.startsWith('#')) {
      scrollToAnchor(href.slice(1));
    } else if (/^(https?|mailto):/i.test(href)) {
      openUrl(href).catch((err) => ctx.ui.notify(`Cannot open link: ${err}`, { kind: 'error' }));
    } else {
      const path = pathFromPreviewUrl(a.href);
      if (!path) return;
      void openPathLink(path, href, background);
    }
  }

  // --- Code block tools --------------------------------------------------
  function onTool(btn: HTMLButtonElement): void {
    if (btn.dataset.mdAction === 'wrap') {
      ctx.settings
        .update({ 'preview.markdownCodeWrap': !ctx.settings.get('preview.markdownCodeWrap') })
        .catch((err) => ctx.ui.notify(`Cannot save the setting: ${err}`, { kind: 'error' }));
      return;
    }
    const pre = btn.closest('.md-code')?.querySelector('pre');
    if (!pre) return;
    const text = codeText((pre.querySelector('code') ?? pre).textContent ?? '');
    navigator.clipboard.writeText(text).then(
      () => {
        btn.innerHTML = ICON_CHECK;
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = ICON_COPY;
          btn.classList.remove('copied');
        }, COPIED_MS);
      },
      () => ctx.ui.notify('Cannot copy to the clipboard.', { kind: 'warn' }),
    );
  }

  function toolButton(d: Document, action: string, title: string, icon: string): HTMLButtonElement {
    const b = d.createElement('button');
    b.type = 'button';
    b.dataset.mdAction = action;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon;
    return b;
  }

  function updateWrapButton(btn: Element): void {
    const on = ctx.settings.get('preview.markdownCodeWrap');
    const title = on ? 'Do not wrap long lines' : 'Wrap long lines';
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('title', title);
    btn.setAttribute('aria-label', title);
  }

  /** Put each `pre` in a wrapper with the copy and wrap buttons. The `pre` itself stays as it is. */
  function addCodeTools(): void {
    if (!article || !doc) return;
    for (const pre of article.querySelectorAll('pre')) {
      const wrap = doc.createElement('div');
      wrap.className = 'md-code';
      const tools = doc.createElement('div');
      tools.className = 'md-code-tools';
      const wrapBtn = toolButton(doc, 'wrap', 'Wrap long lines', ICON_WRAP);
      updateWrapButton(wrapBtn);
      tools.append(wrapBtn, toolButton(doc, 'copy', 'Copy code', ICON_COPY));
      pre.replaceWith(wrap);
      wrap.append(pre, tools);
    }
  }

  // --- Width and wrap ----------------------------------------------------
  function applyWidth(width: number): void {
    if (page) page.style.maxWidth = pageMaxWidth(width);
  }

  function applyWrap(on: boolean): void {
    doc?.body.classList.toggle('code-wrap', on);
    for (const b of article?.querySelectorAll('button[data-md-action="wrap"]') ?? []) updateWrapButton(b);
  }

  function saveWidth(width: number): void {
    ctx.settings
      .update({ 'preview.markdownWidth': width })
      .catch((err) => ctx.ui.notify(`Cannot save the text width: ${err}`, { kind: 'error' }));
  }

  function startResize(e: PointerEvent, handle: HTMLElement): void {
    if (e.button !== 0 || !doc || !page || resizing) return;
    const d = doc;
    const el = page;
    e.preventDefault();
    // With the capture, moves outside the frame still arrive. Without it (it can
    // fail), the listeners on the document below still see moves inside the frame.
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // Keep going without the capture.
    }
    const side = handle.classList.contains('md-resize-l') ? 'l' : 'r';
    const startX = e.clientX;
    const startWidth = el.offsetWidth - PAGE_PADDING;
    const restore = keepPlace();
    let width = normalizeWidth(ctx.settings.get('preview.markdownWidth'));
    const label = d.createElement('div');
    label.className = 'md-width-label';
    resizing = true;
    d.documentElement.classList.add('md-resizing');
    d.body.append(label);
    const move = (ev: PointerEvent) => {
      width = dragWidth(startWidth, ev.clientX - startX, side, zoomLevel, d.body.clientWidth);
      el.style.maxWidth = pageMaxWidth(width);
      label.textContent = widthLabel(width);
      restore();
    };
    const end = (ev: PointerEvent) => {
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', end);
      d.removeEventListener('pointercancel', end);
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      d.documentElement.classList.remove('md-resizing');
      label.remove();
      resizing = false;
      // A click without movement keeps the width.
      if (ev.clientX !== startX) saveWidth(width);
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
    label.textContent = widthLabel(width);
  }

  function onResizeDown(e: PointerEvent): void {
    const handle = (e.target as Element | null)?.closest?.<HTMLElement>('.md-resize');
    if (handle) startResize(e, handle);
  }

  function onResizeDblClick(e: MouseEvent): void {
    if (!(e.target as Element | null)?.closest?.('.md-resize')) return;
    e.preventDefault();
    saveWidth(DEFAULT_SETTINGS['preview.markdownWidth']);
  }

  /** A relative link: the file when it exists, else the note index resolves it (`[x](Note)`, links by name). */
  async function openPathLink(path: string, href: string, background: boolean): Promise<void> {
    const st = await fsStat(path).catch(() => null);
    if (!st?.exists && (await links.open(href, false, background).catch(() => false))) return;
    const ext = extname(path);
    const markdown = ext === '.md' || ext === '.markdown' || ext === '.mdx';
    void ctx.editors.openFile(path, { mode: markdown ? 'preview' : undefined, activate: !background });
  }

  // --- Rendering ---------------------------------------------------------
  function highlightBlocks(seq: number): void {
    if (!article) return;
    const todo: { code: HTMLElement; lang: string; text: string; key: string }[] = [];
    for (const code of article.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
      const lang = /language-([^\s]+)/.exec(code.className)?.[1];
      const text = code.textContent ?? '';
      if (!lang || text.length > MAX_HIGHLIGHT_CHARS) continue;
      const key = `${lang}\0${text}`;
      const cached = highlightCache.get(key);
      if (cached !== undefined) code.innerHTML = cached;
      else todo.push({ code, lang, text, key });
    }
    if (!todo.length) return;
    void (async () => {
      for (const t of todo) {
        if (disposed || seq !== renderSeq) return;
        try {
          const html = await ctx.editors.highlightToHtml(t.text, t.lang);
          if (disposed || seq !== renderSeq || !t.code.isConnected) return;
          t.code.innerHTML = html;
          if (highlightCache.size >= CACHE_LIMIT) highlightCache.delete(highlightCache.keys().next().value!);
          highlightCache.set(t.key, html);
        } catch {
          // Unknown language: keep the plain text.
        }
      }
    })();
  }

  function apply(html: string): void {
    if (!article || !doc) return;
    const win = iframe.contentWindow!;
    const y = hasContent ? win.scrollY : savedScroll;
    // Parse in an inert template, so a meta refresh of the file never runs.
    const t = doc.createElement('template');
    t.innerHTML = html;
    for (const m of t.content.querySelectorAll('meta')) m.remove();
    article.replaceChildren(t.content);
    hasContent = true;
    addCodeTools();
    rebuildIndex();
    highlightBlocks(renderSeq);
    if (isFile) {
      const seq = renderSeq;
      void links.decorate(article, () => !disposed && seq === renderSeq);
    }
    if (pendingLine != null) {
      scrollToLine(pendingLine);
      pendingLine = null;
    } else {
      win.scrollTo(0, y);
    }
    find.refresh();
  }

  async function render(): Promise<void> {
    if (pendingText == null) return;
    const text = pendingText;
    const seq = ++renderSeq;
    try {
      const html = await mdRender(text);
      if (disposed || seq !== renderSeq) return;
      lastHtml = html;
      if (article) apply(html);
    } catch (e) {
      if (seq === renderSeq) ctx.ui.notify(`Markdown preview failed: ${(e as Error).message}`, { kind: 'error' });
    }
  }

  // --- Zoom --------------------------------------------------------------
  function setZoom(z: number): void {
    zoomLevel = z;
    if (doc) (doc.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(z);
  }

  function zoomTo(target: number): void {
    stopZoom?.();
    const win = iframe.contentWindow;
    if (!win || !doc) {
      setZoom(target);
      return;
    }
    // Keep the same relative position in the document while the size changes.
    const root = doc.documentElement;
    const ratio = win.scrollY / Math.max(1, root.scrollHeight);
    stopZoom = animate(zoomLevel, target, 140, (v) => {
      setZoom(v);
      win.scrollTo(0, ratio * root.scrollHeight);
    });
    try {
      ctx.workspace.globalState.set('preview.zoom', target);
    } catch {
      // Not saved. The zoom still works.
    }
  }

  // --- Find --------------------------------------------------------------
  function onFindKey(e: KeyboardEvent): void {
    if (!find.isOpen()) return;
    const action = findKeyAction(e, false);
    if (!action) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (action === 'close') find.close();
    else if (action === 'next') find.next();
    else find.previous();
  }

  // --- Frame setup (runs on every load of the srcdoc) ----------------------
  function onLoad(): void {
    if (disposed) return;
    // Not our load: the frame went to another page, or the browser loaded the
    // frame again after a move in the DOM (with scripts off). Load our document again.
    if (!loading || !frameIsOurs()) {
      const now = performance.now();
      reloads = reloads.filter((t) => now - t < RELOAD_WINDOW_MS);
      if (reloads.length >= MAX_RELOADS) return;
      reloads.push(now);
      doc = article = page = null;
      loadFrame();
      return;
    }
    loading = false;
    iframe.setAttribute('sandbox', SANDBOX_AFTER_LOAD);
    doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) return;
    article = doc.getElementById('md');
    page = doc.getElementById('page');
    doc.addEventListener('pointerdown', onResizeDown);
    doc.addEventListener('dblclick', onResizeDblClick);
    find.attach(doc);
    // Before `forwardKeys`: keys of the find bar must not go to the shell.
    doc.addEventListener('keydown', onFindKey);
    forwardKeys(doc);
    doc.addEventListener('click', onClick);
    doc.addEventListener('auxclick', (e) => e.preventDefault());
    doc.addEventListener('contextmenu', (e) => e.preventDefault());
    doc.addEventListener('wheel', (e) => {
      intent();
      if (e.ctrlKey || e.metaKey) stepper(e);
    }, { passive: false });
    doc.addEventListener('touchmove', intent, { passive: true });
    doc.addEventListener('keydown', intent);
    doc.addEventListener('pointerdown', () => {
      pointerDown = true;
      intent();
    });
    const up = () => {
      pointerDown = false;
      intent();
    };
    doc.addEventListener('pointerup', up);
    doc.addEventListener('pointercancel', up);
    win.addEventListener(
      'scroll',
      () => {
        savedScroll = win.scrollY;
        sendScroll();
      },
      { passive: true },
    );
    // Pinch on the trackpad (Safari).
    let base = 1;
    doc.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      base = zoomLevel;
    });
    doc.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      stopZoom?.();
      setZoom(Math.min(3, Math.max(0.5, base * (e as Event & { scale: number }).scale)));
    });
    setZoom(zoomLevel);
    applyWidth(normalizeWidth(ctx.settings.get('preview.markdownWidth')));
    applyWrap(ctx.settings.get('preview.markdownCodeWrap'));
    if (lastHtml) {
      hasContent = false;
      apply(lastHtml);
    }
  }
  const stepper = wheelZoomStepper((step) => zoomTo(nextZoom(zoomLevel, step)));
  iframe.addEventListener('load', onLoad);

  const sub = ctx.bus.on('theme:changed', () => {
    if (!doc) return;
    const kv = doc.getElementById('kv');
    const hl = doc.getElementById('hl');
    if (kv) kv.textContent = themeCss();
    if (hl) hl.textContent = ctx.editors.highlightCss();
  });

  const settingsSub = ctx.bus.on('settings:changed', ({ settings, previous }) => {
    // After a drag the page already has the new width, so only other previews and the Settings screen change it here.
    const widthChanged = pageMaxWidth(normalizeWidth(settings['preview.markdownWidth'])) !== page?.style.maxWidth;
    const wrapChanged = settings['preview.markdownCodeWrap'] !== previous['preview.markdownCodeWrap'];
    if (!doc || (!widthChanged && !wrapChanged)) return;
    const restore = keepPlace();
    if (widthChanged) applyWidth(normalizeWidth(settings['preview.markdownWidth']));
    if (wrapChanged) applyWrap(settings['preview.markdownCodeWrap']);
    restore();
  });

  return {
    update(text) {
      pendingText = text;
      void render();
    },
    revealLine(line) {
      // Ignore the echo of our own scrolling and do not fight the user.
      if (hasIntent() || performance.now() - lastUserScroll < 600) return;
      lastSentLine = line;
      if (!hasContent) pendingLine = line;
      else scrollToLine(line);
    },
    zoom(step) {
      zoomTo(nextZoom(zoomLevel, step));
    },
    find() {
      find.open();
    },
    dispose() {
      disposed = true;
      stopZoom?.();
      find.dispose();
      sub.dispose();
      settingsSub.dispose();
      links.dispose();
      iframe.removeEventListener('load', onLoad);
      iframe.remove();
    },
  };
}

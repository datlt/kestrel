// Markdown preview: an iframe without scripts. The frame is built once. Later
// updates replace the content of one element, so the scroll position stays.
// Because the frame is `sandbox="allow-same-origin"`, this code can reach its
// document directly. Scripts inside the frame cannot run.

import { openUrl } from '@tauri-apps/plugin-opener';
import { h } from '../../core/dom';
import type { AppContext, FileEditor, PreviewInstance } from '../../core/types';
import { dirname, escapeHtml, extname, rafThrottle } from '../../core/util';
import { mdRender, pathFromPreviewUrl, previewDirUrl } from '../../ipc/preview';
import { animate, forwardKeys, nextZoom, themeCss, wheelZoomStepper } from './frame';
import { MARKDOWN_CSS } from './markdown-css';
import './preview.css';

const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,pre,li,blockquote,table,tr,hr,dl,details,div.markdown-alert'
  .split(',')
  .map((s) => `${s}[data-sourcepos]`)
  .join(',');
const HEADINGS = 'h1,h2,h3,h4,h5,h6';
const MAX_HIGHLIGHT_CHARS = 100_000;
const CACHE_LIMIT = 300;

interface Block {
  el: HTMLElement;
  start: number;
  end: number;
}

// Highlighted code is kept between renders, so code blocks do not flash.
// Each workbench has its own cache (no module state shared between workbenches).
const highlightCaches = new WeakMap<AppContext, Map<string, string>>();

function buildDoc(base: string | null, ctx: AppContext): string {
  const baseTag = base ? `<base href="${escapeHtml(base)}">` : '';
  return (
    `<!doctype html><html><head><meta charset="utf-8">${baseTag}` +
    `<style id="kv">${themeCss()}</style><style>${MARKDOWN_CSS}</style>` +
    `<style id="hl">${ctx.editors.highlightCss()}</style></head>` +
    `<body><article id="md" class="markdown-body"></article></body></html>`
  );
}

export function createMarkdownPreview(ctx: AppContext, host: HTMLElement, editor: FileEditor): PreviewInstance {
  const isFile = !editor.path.startsWith('untitled:');
  const highlightCache = highlightCaches.get(ctx) ?? new Map<string, string>();
  highlightCaches.set(ctx, highlightCache);
  const iframe = h('iframe', { class: 'preview-frame', sandbox: 'allow-same-origin', title: 'Markdown preview' });
  host.append(h('div', { class: 'preview-root' }, iframe));
  iframe.srcdoc = buildDoc(isFile ? previewDirUrl(dirname(editor.path)) : null, ctx);

  let disposed = false;
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

  const sendScroll = rafThrottle(() => {
    if (!hasIntent()) return;
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
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href == null) return;
    e.preventDefault();
    if (href.startsWith('#')) {
      scrollToAnchor(href.slice(1));
    } else if (/^(https?|mailto):/i.test(href)) {
      openUrl(href).catch((err) => ctx.ui.notify(`Cannot open link: ${err}`, { kind: 'error' }));
    } else {
      const path = pathFromPreviewUrl(a.href);
      if (!path) return;
      const ext = extname(path);
      if (ext === '.md' || ext === '.markdown') void ctx.editors.openFile(path, { mode: 'preview' });
      else void ctx.editors.openFile(path);
    }
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
    article.innerHTML = html;
    hasContent = true;
    rebuildIndex();
    highlightBlocks(renderSeq);
    if (pendingLine != null) {
      scrollToLine(pendingLine);
      pendingLine = null;
    } else {
      win.scrollTo(0, y);
    }
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

  // --- Frame setup (runs on every load of the srcdoc) ----------------------
  function onLoad(): void {
    if (disposed) return;
    doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) return;
    article = doc.getElementById('md');
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
    dispose() {
      disposed = true;
      stopZoom?.();
      sub.dispose();
      iframe.removeEventListener('load', onLoad);
      iframe.remove();
    },
  };
}

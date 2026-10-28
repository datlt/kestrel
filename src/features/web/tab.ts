// The web tab content: a thin toolbar and an empty placeholder. Rust puts a
// native web view over the placeholder. The placeholder box tells Rust where.
//
// Order of work for the native view (all calls go through one queue, so Rust
// sees them in the same order as we decided them):
//   create (first time it may show) -> set bounds -> show / hide -> close.

import { ArrowLeft, ArrowRight, createElement, ExternalLink, RotateCw, Star, ZoomIn, ZoomOut } from 'lucide';
import { h } from '../../core/dom';
import type { AppContext, Disposable, TabContent } from '../../core/types';
import { rafThrottle } from '../../core/util';
import {
  onWebEvent,
  webBack,
  webClose,
  webForward,
  webHide,
  webNavigate,
  webOpen,
  webReload,
  webSetBounds,
  webShow,
  webSupported,
  webZoom,
  type WebEvent,
} from '../../ipc/web';
import { nextWebZoom, sameBounds, shouldShow, toLogicalBounds, type Bounds } from './bounds';
import type { WebHandle, WebHub, WebTabState } from './hub';
import { hostOf, normalizeUrl } from './url';
import './web.css';

const icon = (node: Parameters<typeof createElement>[0]) => createElement(node);

function button(label: string, node: Parameters<typeof createElement>[0], onclick: () => void): HTMLButtonElement {
  const b = h('button', { class: 'web-btn', type: 'button', title: label, 'aria-label': label }, icon(node));
  b.addEventListener('click', onclick);
  return b;
}

/** Shown in the browser dev bridge, where native web views do not exist. */
class UnsupportedContent implements TabContent {
  constructor(host: HTMLElement) {
    host.classList.add('web-tab');
    host.replaceChildren(h('div', { class: 'web-unsupported' }, 'Web tabs need the Kestrel app'));
  }
  focus() {}
  dispose() {}
}

export function createWebTab(ctx: AppContext, hub: WebHub, host: HTMLElement, tabId: string, state: WebTabState): TabContent {
  if (!webSupported()) return new UnsupportedContent(host);
  return new WebTabContent(ctx, hub, host, tabId, state);
}

class WebTabContent implements TabContent, WebHandle {
  private urlInput: HTMLInputElement;
  private zoomLabel: HTMLElement;
  private root: HTMLElement;
  private placeholder: HTMLElement;
  private status: HTMLElement;

  private url: string;
  private title: string;
  private zoomFactor: number;
  private readonly origin?: string;

  private label: string | null = null;
  private creating = false;
  private visible = false;
  private shown = false;
  private disposed = false;
  private lastBounds: Bounds | null = null;
  private queue: Promise<void> = Promise.resolve();
  private frame = 0;
  private cleanups: (() => void)[] = [];
  private offEvents: (() => void) | null = null;
  private subs: Disposable[] = [];
  private lastSavedUrl = '';

  constructor(
    private ctx: AppContext,
    private hub: WebHub,
    private host: HTMLElement,
    private tabId: string,
    state: WebTabState,
  ) {
    this.url = state.url;
    this.title = state.title ?? '';
    this.origin = state.origin;
    this.zoomFactor = state.zoom && state.zoom > 0 ? state.zoom : 1;
    this.lastSavedUrl = state.url;

    this.urlInput = h('input', {
      class: 'web-url',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Address',
    });
    this.urlInput.value = this.url;
    this.urlInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        this.go(this.urlInput.value);
      } else if (e.key === 'Escape') {
        this.urlInput.value = this.url;
        this.urlInput.blur();
      }
    });
    this.urlInput.addEventListener('focus', () => this.urlInput.select());

    this.zoomLabel = h('button', { class: 'web-zoom-label', type: 'button', title: 'Reset zoom' }, '');
    this.zoomLabel.addEventListener('click', () => this.setZoom(1));
    this.status = h('span', { class: 'web-status', 'aria-hidden': 'true' });

    const toolbar = h(
      'div',
      { class: 'web-toolbar' },
      button('Back', ArrowLeft, () => this.back()),
      button('Forward', ArrowRight, () => this.forward()),
      button('Reload', RotateCw, () => this.reload()),
      this.urlInput,
      this.status,
      button('Add to bookmarks', Star, () => void this.bookmark()),
      button('Zoom out', ZoomOut, () => this.setZoom(nextWebZoom(this.zoomFactor, -1))),
      this.zoomLabel,
      button('Zoom in', ZoomIn, () => this.setZoom(nextWebZoom(this.zoomFactor, 1))),
      button('Open in system browser', ExternalLink, () => void this.openExternal()),
    );
    this.placeholder = h('div', { class: 'web-placeholder' }, h('div', { class: 'web-placeholder-text' }, 'Loading page...'));
    this.root = h('div', { class: 'web-root', tabindex: '-1' }, toolbar, this.placeholder);
    host.classList.add('web-tab');
    host.replaceChildren(this.root);
    this.renderZoom();

    // Keep the native view on top of the placeholder.
    const request = rafThrottle(() => this.sync());
    this.request = request;
    const ro = new ResizeObserver(request);
    ro.observe(this.placeholder);
    ro.observe(host);
    window.addEventListener('resize', request);
    this.cleanups.push(() => {
      ro.disconnect();
      window.removeEventListener('resize', request);
    });
    this.subs.push(
      hub.onVisibility(() => this.sync()),
      hub.registerCloser(() => this.dispose()),
      ctx.bus.on('tabs:changed', request),
      ctx.bus.on('tab:activated', request),
      ctx.bus.on('settings:changed', (e) => {
        if (e.settings['ui.zoom'] !== e.previous['ui.zoom']) request();
      }),
    );
    hub.contents.set(tabId, this);
  }

  private request: () => void;

  // ---- TabContent ---------------------------------------------------------------------------

  focus(): void {
    this.root.focus({ preventScroll: true });
  }

  onShow(): void {
    this.shown = true;
    this.sync();
  }

  onHide(): void {
    this.shown = false;
    this.sync();
  }

  zoom(step: 1 | -1 | 0): boolean {
    this.setZoom(nextWebZoom(this.zoomFactor, step));
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    for (const c of this.cleanups) c();
    this.cleanups = [];
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.hub.contents.delete(this.tabId);
    this.offEvents?.();
    this.offEvents = null;
    this.visible = false;
    // The creation may still run. It checks `disposed` and closes the view itself.
    this.run(async () => {
      const label = this.label;
      this.label = null;
      if (!label) return;
      await webClose(label);
    });
  }

  // ---- WebHandle and state ----------------------------------------------------------------------

  snapshot(): WebTabState {
    const n = Number(this.tabId.slice('web:'.length));
    return { n, url: this.url, title: this.title || undefined, origin: this.origin, zoom: this.zoomFactor !== 1 ? this.zoomFactor : undefined };
  }

  currentUrl(): string {
    return this.url;
  }

  reload(): void {
    const label = this.label;
    if (label) this.run(() => webReload(label));
  }

  back(): void {
    const label = this.label;
    if (label) this.run(() => webBack(label));
  }

  forward(): void {
    const label = this.label;
    if (label) this.run(() => webForward(label));
  }

  // ---- Actions ----------------------------------------------------------------------------------

  private go(text: string) {
    const url = normalizeUrl(text);
    if (!url) {
      this.ctx.ui.notify('This is not a web address. Use a full address such as https://example.com.', { kind: 'warn', timeoutMs: 4000 });
      return;
    }
    this.setUrl(url);
    const label = this.label;
    // Before the view exists, the address is used when it opens.
    if (label) this.run(() => webNavigate(label, url));
    this.urlInput.blur();
  }

  private setZoom(factor: number) {
    this.zoomFactor = factor;
    this.renderZoom();
    const label = this.label;
    if (label) this.run(() => webZoom(label, factor));
    this.ctx.bus.emit('tabs:changed', {});
  }

  private renderZoom() {
    this.zoomLabel.textContent = `${Math.round(this.zoomFactor * 100)}%`;
  }

  private async bookmark() {
    const added = await this.hub.addBookmark(this.url).catch(() => false);
    this.ctx.ui.notify(added ? 'Added to bookmarks.' : 'This page is a bookmark already.', { kind: 'info', timeoutMs: 2500 });
  }

  private async openExternal() {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(this.url);
    } catch (err) {
      this.ctx.ui.notify(`Could not open the system browser: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    }
  }

  private setUrl(url: string) {
    this.url = url;
    const meta = this.hub.meta.get(this.tabId);
    if (meta) meta.url = url;
    if (document.activeElement !== this.urlInput) this.urlInput.value = url;
    this.urlInput.title = url;
  }

  // ---- Native view ------------------------------------------------------------------------------

  /** Runs native calls one after the other. A failed call is logged and does not stop the next ones. */
  private run(fn: () => Promise<unknown>) {
    this.queue = this.queue.then(fn).then(
      () => {},
      (err) => console.error('web view call failed', err),
    );
  }

  /** Decides what the native view must do now: create, move, show or hide. */
  private sync() {
    if (this.disposed) return;
    const bounds = toLogicalBounds(this.placeholder.getBoundingClientRect(), this.uiZoom());
    const want = !!bounds && shouldShow({ tabShown: this.shown, ...this.hub.state() });
    if (!this.label) {
      if (want && bounds && !this.creating) this.create(bounds);
      return;
    }
    const label = this.label;
    if (want && bounds) {
      if (!sameBounds(bounds, this.lastBounds)) {
        this.lastBounds = bounds;
        this.run(() => webSetBounds(label, bounds));
      }
      if (!this.visible) {
        this.visible = true;
        this.run(() => webShow(label));
      }
    } else if (this.visible) {
      this.visible = false;
      this.run(() => webHide(label));
    }
  }

  /** The window zoom (`ui.zoom`) is a web view zoom: one CSS pixel is `zoom` logical pixels. */
  private uiZoom(): number {
    const z = this.ctx.settings.get('ui.zoom');
    return typeof z === 'number' && z > 0 ? z : 1;
  }

  private create(bounds: Bounds) {
    this.creating = true;
    this.run(async () => {
      try {
        if (this.disposed) return;
        const label = await webOpen(this.url, bounds);
        if (this.disposed) {
          await webClose(label).catch(() => {});
          return;
        }
        this.label = label;
        this.lastBounds = bounds;
        this.visible = true;
        this.offEvents = onWebEvent(label, (e) => this.onEvent(e));
        if (this.zoomFactor !== 1) await webZoom(label, this.zoomFactor).catch(() => {});
        this.placeholder.classList.add('web-covered');
      } catch (err) {
        this.placeholder.replaceChildren(
          h('div', { class: 'web-placeholder-text web-error' }, `Could not open the page: ${err instanceof Error ? err.message : String(err)}`),
        );
        this.ctx.ui.notify(`Could not open the web page: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      } finally {
        this.creating = false;
        // The state may have changed while we waited (tab hidden, popup opened).
        if (!this.disposed) this.request();
      }
    });
  }

  // ---- Events from Rust -------------------------------------------------------------------------

  private onEvent(e: WebEvent) {
    if (this.disposed) return;
    switch (e.kind) {
      case 'url':
        this.setUrl(e.url);
        break;
      case 'title':
        this.title = e.title;
        this.ctx.tabs.setTitle(this.tabId, e.title, hostOf(this.url));
        this.hub.rememberTitle([this.origin, this.url], e.title);
        break;
      case 'loading':
        this.root.classList.toggle('web-loading', e.loading);
        this.status.classList.toggle('web-on', e.loading);
        this.setUrl(e.url);
        // The session saves the last address after a page loaded.
        if (!e.loading && this.lastSavedUrl !== e.url) {
          this.lastSavedUrl = e.url;
          this.ctx.bus.emit('tabs:changed', {});
        }
        break;
      case 'popup':
        this.hub.openUrl(e.url);
        break;
      case 'download':
        this.onDownload(e);
        break;
    }
  }

  private onDownload(e: Extract<WebEvent, { kind: 'download' }>) {
    if (e.state === 'started') {
      this.ctx.ui.notify(`Downloading ${e.name}...`, { kind: 'info', timeoutMs: 2500 });
    } else if (e.state === 'done') {
      const path = e.path;
      this.ctx.ui.notify(`Downloaded ${e.name} to your Downloads folder.`, {
        kind: 'info',
        timeoutMs: 8000,
        actions: path
          ? [
              {
                label: 'Show',
                run: () =>
                  void import('@tauri-apps/plugin-opener').then(({ revealItemInDir }) => revealItemInDir(path)).catch((err) => console.error('reveal failed', err)),
              },
            ]
          : undefined,
      });
    } else {
      this.ctx.ui.notify(`The download of ${e.name} failed.`, { kind: 'error' });
    }
  }
}

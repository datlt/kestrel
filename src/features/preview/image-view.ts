// A pan and zoom viewer for one image. Used by the image tab and the SVG preview.
// The image is placed with a CSS transform. Zoom moves smoothly toward a target
// and keeps the point under the cursor fixed.

import { h } from '../../core/dom';
import './preview.css';

interface View {
  s: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 40;

export interface ImageViewOptions {
  /** Fit mode may enlarge small images (good for SVG). Default false. */
  upscale?: boolean;
  /** Called after each (re)load with the natural size. */
  onLoad?(width: number, height: number): void;
  onError?(): void;
}

export class ImageView {
  readonly el: HTMLElement;
  private viewport: HTMLElement;
  private img: HTMLImageElement;
  private label: HTMLElement;
  private cur: View = { s: 1, x: 0, y: 0 };
  private target: View = { s: 1, x: 0, y: 0 };
  private mode: 'fit' | 'free' = 'fit';
  private frame = 0;
  private loaded = false;
  private ro: ResizeObserver;
  private drag: { id: number; x: number; y: number } | null = null;

  constructor(private opts: ImageViewOptions = {}) {
    this.img = h('img', { class: 'preview-image', draggable: 'false', alt: '' });
    this.viewport = h('div', { class: 'preview-image-viewport', tabindex: '0' }, this.img);
    this.label = h('span', { class: 'preview-image-zoom' }, '100%');
    const btn = (text: string, title: string, fn: () => void) =>
      h('button', { class: 'preview-btn', title, type: 'button', onclick: fn }, text);
    const bar = h(
      'div',
      { class: 'preview-image-bar' },
      btn('Fit', 'Fit to window', () => this.fit()),
      btn('100%', 'Actual size', () => this.actual()),
      btn('-', 'Zoom out', () => this.zoomBy(1 / 1.25)),
      btn('+', 'Zoom in', () => this.zoomBy(1.25)),
      this.label,
    );
    this.el = h('div', { class: 'preview-image-root' }, this.viewport, bar);

    this.img.addEventListener('load', () => this.onImageLoad());
    this.img.addEventListener('error', () => this.opts.onError?.());
    this.viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.viewport.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.viewport.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.viewport.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.viewport.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.viewport.addEventListener('lostpointercapture', (e) => this.onPointerUp(e));
    this.viewport.addEventListener('dblclick', () => (this.mode === 'fit' ? this.actual() : this.fit()));
    // Safari pinch on the trackpad.
    let gestureBase = 1;
    this.viewport.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      gestureBase = this.target.s;
    });
    this.viewport.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const ge = e as Event & { scale: number; clientX?: number; clientY?: number };
      const r = this.viewport.getBoundingClientRect();
      this.zoomAt(gestureBase * ge.scale, (ge.clientX ?? r.left + r.width / 2) - r.left, (ge.clientY ?? r.top + r.height / 2) - r.top);
    });
    this.ro = new ResizeObserver(() => {
      if (this.loaded && this.mode === 'fit') this.fit(false);
    });
    this.ro.observe(this.viewport);
  }

  /** Loads a new source. With `keepView` the zoom and position stay (for live SVG edits). */
  setSrc(url: string, keepView = false): void {
    this.keepOnLoad = keepView && this.loaded;
    this.img.src = url;
  }
  private keepOnLoad = false;

  get naturalSize(): { width: number; height: number } {
    return { width: this.img.naturalWidth, height: this.img.naturalHeight };
  }

  focus(): void {
    this.viewport.focus({ preventScroll: true });
  }

  /** Zoom step from the shell keys. 0 fits the image to the window. */
  zoom(step: 1 | -1 | 0): void {
    if (step === 0) this.fit();
    else this.zoomBy(step > 0 ? 1.25 : 1 / 1.25);
  }

  fit(animate = true): void {
    const { width: iw, height: ih } = this.naturalSize;
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    if (!iw || !ih || !vw || !vh) return;
    const pad = 16;
    let s = Math.min((vw - pad * 2) / iw, (vh - pad * 2) / ih);
    if (!this.opts.upscale) s = Math.min(s, 1);
    s = Math.max(MIN_SCALE, s);
    this.mode = 'fit';
    this.moveTo({ s, x: (vw - iw * s) / 2, y: (vh - ih * s) / 2 }, animate);
  }

  actual(): void {
    const { width: iw, height: ih } = this.naturalSize;
    if (!iw || !ih) return;
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    this.mode = 'free';
    this.zoomAt(1, vw / 2, vh / 2);
    // Small images stay centered.
    if (iw <= vw && ih <= vh) this.target = { s: 1, x: (vw - iw) / 2, y: (vh - ih) / 2 };
    this.start();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.ro.disconnect();
    this.img.removeAttribute('src');
    this.el.remove();
  }

  private onImageLoad(): void {
    const { width, height } = this.naturalSize;
    this.opts.onLoad?.(width, height);
    const first = !this.loaded;
    this.loaded = true;
    if (first || !this.keepOnLoad) this.fit(false);
    else this.apply();
  }

  private zoomBy(factor: number): void {
    this.mode = 'free';
    const r = this.viewport.getBoundingClientRect();
    this.zoomAt(this.target.s * factor, r.width / 2, r.height / 2);
  }

  /** Sets the target scale and keeps the point (px, py) of the viewport in place. */
  private zoomAt(scale: number, px: number, py: number): void {
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const t = this.target;
    const k = s / t.s;
    this.mode = 'free';
    this.target = { s, x: px - (px - t.x) * k, y: py - (py - t.y) * k };
    this.start();
  }

  private onWheel(e: WheelEvent): void {
    // Plain wheel and pinch (ctrl + wheel) both zoom. Shift or horizontal scroll pans.
    e.preventDefault();
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      this.pan(-e.deltaY - e.deltaX, 0);
      return;
    }
    const r = this.viewport.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : 1;
    const k = e.ctrlKey ? 0.01 : 0.0015;
    const factor = Math.exp(-e.deltaY * unit * k);
    this.zoomAt(this.target.s * factor, e.clientX - r.left, e.clientY - r.top);
  }

  private pan(dx: number, dy: number): void {
    this.mode = 'free';
    this.target = { ...this.target, x: this.target.x + dx, y: this.target.y + dy };
    this.cur = { ...this.target };
    this.apply();
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      this.viewport.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is gone already.
    }
    this.viewport.classList.add('is-dragging');
    this.viewport.focus({ preventScroll: true });
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag || this.drag.id !== e.pointerId) return;
    this.pan(e.clientX - this.drag.x, e.clientY - this.drag.y);
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drag || this.drag.id !== e.pointerId) return;
    this.drag = null;
    this.viewport.classList.remove('is-dragging');
  }

  private moveTo(v: View, animate: boolean): void {
    this.target = v;
    if (animate) this.start();
    else {
      this.cur = { ...v };
      this.apply();
    }
  }

  private start(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    this.frame = 0;
    const c = this.cur;
    const t = this.target;
    const f = 0.28;
    c.s += (t.s - c.s) * f;
    c.x += (t.x - c.x) * f;
    c.y += (t.y - c.y) * f;
    const done = Math.abs(t.s - c.s) < 0.0005 && Math.abs(t.x - c.x) < 0.2 && Math.abs(t.y - c.y) < 0.2;
    if (done) this.cur = { ...t };
    this.apply();
    if (!done) this.start();
  }

  private apply(): void {
    const { s, x, y } = this.cur;
    const { width, height } = this.naturalSize;
    this.img.style.width = `${width}px`;
    this.img.style.height = `${height}px`;
    this.img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    this.img.classList.toggle('is-pixelated', s >= 3);
    this.label.textContent = `${Math.round(s * 100)}%`;
  }
}

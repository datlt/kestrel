// Zoom: content zoom (editor font, previews) and window zoom (whole web view).

import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { AppContext } from '../core/types';
import { isMac } from '../core/util';

const UI_ZOOM_MIN = 0.5;
const UI_ZOOM_MAX = 3;
const UI_ZOOM_STEP = 0.1;
/** Wheel distance (pixels) for one zoom step. */
const WHEEL_PER_STEP = 50;

export function clampUiZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, value)) * 100) / 100;
}

export function nextUiZoom(current: number, step: 1 | -1 | 0): number {
  if (step === 0) return 1;
  return clampUiZoom(current + step * UI_ZOOM_STEP);
}

export function createZoom(ctx: AppContext) {
  let applied = 1;
  let idle: ReturnType<typeof setTimeout> | undefined;

  /** Active tab first (it may zoom a preview or an image), else the editor font. */
  function zoomContent(step: 1 | -1 | 0) {
    const content = ctx.tabs.active()?.content;
    if (content?.zoom?.(step)) return;
    ctx.editors.zoom(step);
  }

  function setWebviewZoom(z: number) {
    if (z === applied) return;
    applied = z;
    getCurrentWebview()
      .setZoom(z)
      .catch((err) => console.error('window zoom failed', err));
  }

  function applyUiZoom() {
    setWebviewZoom(clampUiZoom(ctx.settings.get('ui.zoom')));
  }

  function zoomUi(step: 1 | -1 | 0) {
    const next = nextUiZoom(ctx.settings.get('ui.zoom'), step);
    ctx.settings.update({ 'ui.zoom': next }).catch((err) => console.error('saving ui.zoom failed', err));
    setWebviewZoom(next);
  }

  const sub = ctx.bus.on('settings:changed', (e) => {
    if (e.settings['ui.zoom'] !== e.previous['ui.zoom']) applyUiZoom();
  });

  /** Ctrl+wheel and trackpad pinch over `area` zoom the content. */
  function attachGestures(area: HTMLElement) {
    let acc = 0;
    area.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || (isMac && e.metaKey))) return;
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        acc += e.deltaY * unit;
        while (Math.abs(acc) >= WHEEL_PER_STEP) {
          zoomContent(acc < 0 ? 1 : -1);
          acc -= Math.sign(acc) * WHEEL_PER_STEP;
        }
        clearTimeout(idle);
        idle = setTimeout(() => (acc = 0), 250);
      },
      { passive: false },
    );

    // Safari and WKWebView send gesture events for the pinch on a trackpad.
    let lastScale = 1;
    area.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      lastScale = 1;
    });
    area.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const scale = (e as unknown as { scale: number }).scale;
      const ratio = scale / lastScale;
      if (ratio > 1.1) {
        zoomContent(1);
        lastScale = scale;
      } else if (ratio < 0.9) {
        zoomContent(-1);
        lastScale = scale;
      }
    });
    area.addEventListener('gestureend', (e) => e.preventDefault());
  }

  function dispose() {
    clearTimeout(idle);
    sub.dispose();
  }

  return { zoomContent, zoomUi, applyUiZoom, attachGestures, dispose };
}

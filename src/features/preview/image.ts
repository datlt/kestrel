// Content of image tabs (tab kind `image`).

import { h } from '../../core/dom';
import type { AppContext, TabContent } from '../../core/types';
import { basename, samePath } from '../../core/util';
import { fsStat } from '../../ipc/fs';
import { previewAllowParent, previewUrl } from '../../ipc/preview';
import { ImageView } from './image-view';
import { setPreviewInfo } from './status';
import './preview.css';


export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Builds the content of an image tab. This file loads with `import()` (see `image-tab.ts`). */
export function createImageContent(ctx: AppContext, host: HTMLElement, tabId: string, path: string): TabContent {
  let info = '';
  let sizeText = '';
  let dims = '';
  let disposed = false;
  let active = ctx.tabs.active()?.id === tabId;

  const showError = () => {
    view.el.replaceWith(h('div', { class: 'preview-error' }, `Cannot show this image: ${basename(path)}`));
  };
  const view = new ImageView({
    onLoad(w, hh) {
      dims = `${w} × ${hh}`;
      updateInfo();
    },
    onError: showError,
  });
  host.append(view.el);

  function updateInfo(): void {
    info = [dims, sizeText].filter(Boolean).join(' · ');
    refreshStatus();
  }

  function refreshStatus(): void {
    if (disposed) return;
    setPreviewInfo(ctx, tabId, active && info ? info : null, path);
  }

  async function load(bust: boolean): Promise<void> {
    try {
      await previewAllowParent(path);
      const st = await fsStat(path);
      if (disposed) return;
      if (!st.exists) {
        showError();
        return;
      }
      sizeText = formatBytes(st.size);
      view.setSrc(previewUrl(path) + (bust ? `?t=${Date.now()}` : ''), true);
      updateInfo();
    } catch {
      if (!disposed) showError();
    }
  }
  void load(false);

  const subs = [
    ctx.bus.on('tab:activated', (e) => {
      active = e.tabId === tabId;
      refreshStatus();
    }),
    ctx.bus.on('fs:changed', (e) => {
      if (e.rescan || e.paths.some((p) => samePath(p, path))) void load(true);
    }),
  ];
  refreshStatus();

  return {
    focus: () => view.focus(),
    onShow() {
      active = true;
      refreshStatus();
    },
    onHide() {
      active = false;
      refreshStatus();
    },
    zoom(step) {
      view.zoom(step);
      return true;
    },
    dispose() {
      active = false;
      refreshStatus();
      disposed = true;
      for (const s of subs) s.dispose();
      view.dispose();
    },
  };
}

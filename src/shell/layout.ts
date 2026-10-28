// Layout: puts the parts side by side and handles the resize handles.

import { h } from '../core/dom';
import { rafThrottle } from '../core/util';
import { PANEL_DEFAULT, SIDEBAR_DEFAULT } from './layout-state';
import type { LayoutStore } from './layout-state';

const SIDEBAR_MIN = 150;
const PANEL_MIN = 80;

interface Parts {
  store: LayoutStore;
  activityBar: HTMLElement;
  sidebar: HTMLElement;
  panel: HTMLElement;
  tabBar: HTMLElement;
  content: HTMLElement;
  empty: HTMLElement;
  statusBar: HTMLElement;
  /** Overlay layer (quick pick, menus, dialogs, toasts). It is added to the root. */
  overlays: HTMLElement;
}

/** A thin drag handle. `onDrag` gets the pointer delta from the start; `onEnd` gets the final delta. */
function makeResizer(
  axis: 'x' | 'y',
  start: () => number,
  onDrag: (delta: number, startValue: number) => void,
  onEnd: (delta: number, startValue: number) => void,
  onReset: () => void,
): HTMLElement {
  const el = h('div', {
    class: `shell-resizer shell-resizer-${axis}`,
    role: 'separator',
    'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal',
  });
  let origin = 0;
  let startValue = 0;
  let delta = 0;
  // The pointer of the drag that runs now. Null when no drag runs.
  let activePointer: number | null = null;
  const move = rafThrottle((pos: number) => {
    // A frame can arrive after the drag ended. It must not undo the final size.
    if (activePointer === null) return;
    delta = pos - origin;
    onDrag(delta, startValue);
  });
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || activePointer !== null) return;
    e.preventDefault();
    origin = axis === 'x' ? e.clientX : e.clientY;
    startValue = start();
    delta = 0;
    activePointer = e.pointerId;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is gone already. The drag still ends on pointerup.
    }
    el.classList.add('shell-dragging');
    el.closest('.shell-root')?.classList.add(`shell-resizing-${axis}`);
  });
  el.addEventListener('pointermove', (e) => {
    if (activePointer !== e.pointerId) return;
    move(axis === 'x' ? e.clientX : e.clientY);
  });
  const finish = (e: PointerEvent) => {
    if (activePointer !== e.pointerId) return;
    activePointer = null;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    el.classList.remove('shell-dragging');
    el.closest('.shell-root')?.classList.remove(`shell-resizing-${axis}`);
    delta = (axis === 'x' ? e.clientX : e.clientY) - origin;
    onEnd(delta, startValue);
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  // The web view can take the capture away (for example when the window loses focus).
  el.addEventListener('lostpointercapture', finish);
  el.addEventListener('dblclick', onReset);
  return el;
}

export function createLayout(p: Parts) {
  const { store } = p;
  const content = p.content;

  const sidebarResizer = makeResizer(
    'x',
    () => p.sidebar.getBoundingClientRect().width,
    (d, v) => {
      p.sidebar.style.width = `${clampSidebar(v + d)}px`;
    },
    (d, v) => store.patch({ sidebarWidth: clampSidebar(v + d) }),
    () => store.patch({ sidebarWidth: SIDEBAR_DEFAULT }),
  );

  const panelResizer = makeResizer(
    'y',
    () => p.panel.getBoundingClientRect().height,
    (d, v) => {
      p.panel.style.height = `${clampPanel(v - d)}px`;
    },
    (d, v) => store.patch({ panelHeight: clampPanel(v - d) }),
    () => store.patch({ panelHeight: PANEL_DEFAULT }),
  );

  /** Size of the area this shell fills. Falls back to the window when the root is not laid out yet. */
  function hostSize(): { width: number; height: number } {
    const w = root.clientWidth;
    const hh = root.clientHeight;
    return { width: w || window.innerWidth, height: hh || window.innerHeight };
  }

  function clampSidebar(w: number): number {
    return Math.round(Math.max(SIDEBAR_MIN, Math.min(w, hostSize().width * 0.6)));
  }
  function clampPanel(v: number): number {
    return Math.round(Math.max(PANEL_MIN, Math.min(v, hostSize().height * 0.75)));
  }

  const editorArea = h('div', { class: 'shell-editor-area' }, p.tabBar, h('div', { class: 'shell-content' }, content, p.empty));
  const center = h('div', { class: 'shell-center' }, editorArea, panelResizer, p.panel);
  const main = h('div', { class: 'shell-main' }, p.activityBar, p.sidebar, sidebarResizer, center);
  const root = h('div', { class: 'shell-root' }, main, p.statusBar, p.overlays);

  function apply() {
    const s = store.state;
    p.sidebar.hidden = !s.sidebarVisible;
    sidebarResizer.hidden = !s.sidebarVisible;
    p.sidebar.style.width = `${clampSidebar(s.sidebarWidth)}px`;
    p.panel.hidden = !s.panelVisible;
    panelResizer.hidden = !s.panelVisible;
    p.panel.style.height = `${clampPanel(s.panelHeight)}px`;
  }
  store.onChange(apply);
  apply();

  return { root, editorArea };
}

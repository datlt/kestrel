// Toasts in the bottom right corner.

import { CircleAlert, Info, TriangleAlert, X } from 'lucide';
import { h } from '../core/dom';
import type { NotifyOptions } from '../core/types';
import { icon } from './icons';

const MAX_TOASTS = 5;

/** `layer` is the overlay layer inside the root element of this shell. */
export function createNotifier(layer: HTMLElement) {
  let host: HTMLElement | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function getHost(): HTMLElement {
    if (!host) {
      host = h('div', { class: 'shell-toasts', 'aria-live': 'polite' });
      layer.append(host);
    }
    return host;
  }

  function remove(toast: HTMLElement) {
    if (!toast.isConnected || toast.classList.contains('shell-toast-leaving')) return;
    toast.classList.add('shell-toast-leaving');
    const t = setTimeout(() => {
      timers.delete(t);
      toast.remove();
    }, 160);
    timers.add(t);
  }

  function notify(message: string, opts: NotifyOptions = {}): void {
    const kind = opts.kind ?? 'info';
    const timeout = opts.timeoutMs ?? (kind === 'error' ? 0 : 5000);
    const container = getHost();

    const glyph = kind === 'error' ? CircleAlert : kind === 'warn' ? TriangleAlert : Info;
    const closeBtn = h('button', { class: 'shell-toast-close', title: 'Close', 'aria-label': 'Close' }, icon(X));
    const body = h('div', { class: 'shell-toast-body' }, h('div', { class: 'shell-toast-message' }, message));
    const toast = h(
      'div',
      { class: `shell-toast shell-toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'shell-toast-icon' }, icon(glyph)),
      body,
      closeBtn,
    );

    if (opts.actions?.length) {
      const row = h('div', { class: 'shell-toast-actions' });
      for (const a of opts.actions) {
        row.append(
          h(
            'button',
            {
              class: 'shell-btn shell-btn-small',
              onclick: () => {
                remove(toast);
                a.run();
              },
            },
            a.label,
          ),
        );
      }
      body.append(row);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timeout > 0) {
        const t = setTimeout(() => {
          timers.delete(t);
          remove(toast);
        }, timeout);
        timer = t;
        timers.add(t);
      }
    };
    toast.addEventListener('pointerenter', () => {
      clearTimeout(timer);
      if (timer) timers.delete(timer);
    });
    toast.addEventListener('pointerleave', arm);
    closeBtn.addEventListener('click', () => remove(toast));
    arm();

    container.append(toast);
    const live = [...container.children].filter((c) => !c.classList.contains('shell-toast-leaving'));
    for (const old of live.slice(0, Math.max(0, live.length - MAX_TOASTS))) remove(old as HTMLElement);
  }

  /** Stops all timers. Called when the workbench is disposed. */
  function dispose() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  return { notify, dispose };
}

// A window inside a grid that shows one cell value: long text, JSON (with
// pretty print) or binary data in hex.

import { h } from '../../core/dom';
import { prettyJson } from './grid-data';

const MAX_SHOWN = 2_000_000;

export interface ViewerOptions {
  title: string;
  value: string | null;
  /** The column type says JSON. */
  json: boolean;
  copy(text: string): void;
}

/** Opens the viewer inside `host` (the host needs `position: relative`). Returns a function that closes it. */
export function openValueViewer(host: HTMLElement, opts: ViewerOptions): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const raw = opts.value ?? 'NULL';
  const pretty = opts.value === null ? null : prettyJson(raw);
  let usePretty = pretty !== null;
  const body = h('pre', { class: 'db-viewer-text', tabindex: '0' });
  const note = h('span', { class: 'db-viewer-note' });

  const shown = () => (usePretty && pretty !== null ? pretty : raw);
  const paint = () => {
    const text = shown();
    body.textContent = text.length > MAX_SHOWN ? text.slice(0, MAX_SHOWN) : text;
    note.textContent =
      `${text.length.toLocaleString('en-US')} characters` + (text.length > MAX_SHOWN ? ` (the first ${MAX_SHOWN.toLocaleString('en-US')} are shown)` : '');
    prettyBtn.setAttribute('aria-pressed', String(usePretty));
  };

  const close = () => {
    overlay.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
  const prettyBtn = h('button', {
    class: 'db-btn',
    type: 'button',
    title: 'Format the JSON text',
    onclick: () => {
      usePretty = !usePretty;
      paint();
    },
  }, 'Pretty JSON');
  prettyBtn.hidden = pretty === null;
  if (opts.json && pretty === null && opts.value !== null) note.title = 'The value is not valid JSON.';
  const copyBtn = h('button', { class: 'db-btn', type: 'button', onclick: () => opts.copy(shown()) }, 'Copy');
  const closeBtn = h('button', { class: 'db-btn', type: 'button', onclick: close }, 'Close');
  const dialog = h(
    'div',
    { class: 'db-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
    h('div', { class: 'db-viewer-head' }, h('span', { class: 'db-viewer-title' }, opts.title), note, h('span', { class: 'db-spacer' }), prettyBtn, copyBtn, closeBtn),
    body,
  );
  const overlay = h('div', { class: 'db-modal-backdrop' }, dialog);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  paint();
  host.append(overlay);
  body.focus();
  return close;
}

// A small password dialog. The shell prompt cannot hide the text, so this one
// has its own input of type password. It is placed inside the given element
// (a part of the workbench), so a hidden workbench never shows it.

import { h } from '../../core/dom';
import './db.css';

export interface PasswordOptions {
  title: string;
  detail?: string;
  /** Why the last try failed. */
  error?: string;
}

/** Resolves with the typed password (can be empty), or null when the user cancels. */
export function askPassword(host: HTMLElement, opts: PasswordOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const input = h('input', {
      class: 'db-input',
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Password',
    });
    const done = (value: string | null) => {
      overlay.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      resolve(value);
    };
    const ok = h('button', { class: 'db-btn db-btn-primary', type: 'button', onclick: () => done(input.value) }, 'Connect');
    const cancel = h('button', { class: 'db-btn', type: 'button', onclick: () => done(null) }, 'Cancel');
    const dialog = h(
      'div',
      { class: 'db-modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'db-modal-title' }, opts.title),
      opts.detail ? h('div', { class: 'db-modal-detail' }, opts.detail) : null,
      opts.error ? h('div', { class: 'db-modal-error' }, opts.error) : null,
      h('div', { class: 'db-modal-hint' }, 'The password is used for this session only. To keep it, save it in the connection form.'),
      input,
      h('div', { class: 'db-modal-buttons' }, cancel, ok),
    );
    const overlay = h('div', { class: 'db-modal-backdrop' }, dialog);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) done(null);
    });
    overlay.addEventListener('keydown', (e) => {
      // Keys belong to this dialog, so global shortcuts do not run behind it.
      e.stopPropagation();
      // The Enter that confirms IME text must not submit.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        done(input.value);
      } else if (e.key === 'Tab') {
        const items = [input, cancel, ok];
        const i = items.indexOf(document.activeElement as never);
        items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
        e.preventDefault();
      }
    });
    host.append(overlay);
    input.focus();
  });
}

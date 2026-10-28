// In-app modal dialogs: confirm and prompt. They never use window.confirm.

import { h } from '../core/dom';
import type { UiService } from '../core/types';

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, input')].filter((el) => !el.hasAttribute('disabled'));
}

/** Builds the overlay, traps Tab, and closes on Escape or backdrop click. */
function openModal<T>(
  layer: HTMLElement,
  build: (done: (value: T) => void) => { dialog: HTMLElement; focus: () => void },
  cancelValue: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    let finished = false;
    const done = (value: T) => {
      if (finished) return;
      finished = true;
      overlay.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(value);
    };
    const { dialog, focus } = build(done);
    const overlay = h('div', { class: 'shell-modal-backdrop' }, dialog);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) done(cancelValue);
    });
    overlay.addEventListener('keydown', (e) => {
      // A modal swallows all keys, so global shortcuts do not run behind it.
      e.stopPropagation();
      // Keys during IME composition belong to the IME. WKWebView sends the
      // Enter that confirms the text with keyCode 229 and isComposing false.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        done(cancelValue);
      } else if (e.key === 'Tab') {
        const items = focusable(dialog);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
        items[next].focus();
        e.preventDefault();
      }
    });
    layer.append(overlay);
    focus();
  });
}

/** `layer` is the overlay layer inside the root element of this shell. */
export function createDialogs(layer: HTMLElement): Pick<UiService, 'confirm' | 'prompt'> {
  return {
    confirm({ title, message, buttons }) {
      return openModal<string | null>(layer, (done) => {
        const btns = buttons.map((text, i) =>
          h('button', { class: 'shell-btn' + (i === 0 ? ' shell-btn-primary' : ''), onclick: () => done(text) }, text),
        );
        const dialog = h(
          'div',
          { class: 'shell-modal', role: 'alertdialog', 'aria-label': title },
          h('div', { class: 'shell-modal-title' }, title),
          message ? h('div', { class: 'shell-modal-message' }, message) : null,
          h('div', { class: 'shell-modal-buttons' }, ...btns),
        );
        // Arrow keys move between buttons.
        dialog.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          const i = btns.indexOf(document.activeElement as HTMLButtonElement);
          const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length;
          btns[next]?.focus();
          e.preventDefault();
        });
        return { dialog, focus: () => btns[0]?.focus() };
      }, null);
    },

    prompt({ title, value = '', placeholder, validate, selection }) {
      return openModal<string | null>(layer, (done) => {
        const input = h('input', {
          class: 'shell-input',
          type: 'text',
          spellcheck: 'false',
          autocomplete: 'off',
          placeholder: placeholder ?? '',
        });
        input.value = value;
        const error = h('div', { class: 'shell-modal-error' });
        const ok = h('button', { class: 'shell-btn shell-btn-primary' }, 'OK');
        const cancel = h('button', { class: 'shell-btn', onclick: () => done(null) }, 'Cancel');

        const check = (show = true): string | null => {
          const msg = validate ? validate(input.value) : null;
          error.textContent = show ? (msg ?? '') : '';
          error.hidden = !show || !msg;
          input.classList.toggle('shell-invalid', show && !!msg);
          ok.toggleAttribute('disabled', !!msg);
          return msg;
        };
        const submit = () => {
          if (!check()) done(input.value);
        };
        ok.addEventListener('click', submit);
        input.addEventListener('input', () => check());
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            submit();
          }
        });

        const dialog = h(
          'div',
          { class: 'shell-modal', role: 'dialog', 'aria-label': title },
          h('div', { class: 'shell-modal-title' }, title),
          input,
          error,
          h('div', { class: 'shell-modal-buttons' }, cancel, ok),
        );
        check(false);
        return {
          dialog,
          focus: () => {
            input.focus();
            const [a, b] = selection ?? [0, value.length];
            input.setSelectionRange(a, b);
          },
        };
      }, null);
    },
  };
}

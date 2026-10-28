// A comment box: a textarea that grows, buttons, a spinner and an error line.
// Used for new comments, replies and edits of drafts.

import { h } from '../../../core/dom';
import { canSubmit } from './drafts';

export interface ComposerButton {
  id: string;
  label: string;
  primary?: boolean;
}

export interface ComposerOptions {
  placeholder: string;
  initial?: string;
  /** The first button is used for Mod-Enter. A Cancel button is added at the end. */
  buttons: ComposerButton[];
  onSubmit(buttonId: string, body: string): Promise<void>;
  onCancel(): void;
  /** Called when the height of the box changes. */
  onResize(): void;
}

export class Composer {
  readonly dom: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private buttons: HTMLButtonElement[] = [];
  private cancelBtn: HTMLButtonElement;
  private spinner: HTMLElement;
  private errorEl: HTMLElement;
  private busy = false;

  constructor(private opts: ComposerOptions) {
    this.textarea = h('textarea', {
      class: 'review-diff-textarea',
      placeholder: opts.placeholder,
      rows: 3,
      spellcheck: 'false',
    });
    this.textarea.value = opts.initial ?? '';
    this.textarea.addEventListener('input', () => {
      this.grow();
      this.updateButtons();
    });
    this.textarea.addEventListener('keydown', (e) => this.onKey(e));

    this.spinner = h('span', { class: 'review-diff-spinner', hidden: true, 'aria-label': 'Working' });
    this.errorEl = h('div', { class: 'review-diff-error', role: 'alert', hidden: true });
    this.cancelBtn = h('button', { type: 'button', class: 'review-diff-btn', onclick: () => this.cancel() }, 'Cancel');
    const row = h('div', { class: 'review-diff-actions' }, this.spinner, h('span', { class: 'review-diff-spacer' }));
    for (const b of opts.buttons) {
      const el = h(
        'button',
        {
          type: 'button',
          class: b.primary ? 'review-diff-btn review-diff-btn-primary' : 'review-diff-btn',
          onclick: () => void this.submit(b.id),
        },
        b.label,
      );
      this.buttons.push(el);
      row.append(el);
    }
    row.append(this.cancelBtn);
    this.dom = h('div', { class: 'review-diff-composer' }, this.textarea, this.errorEl, row);
    this.updateButtons();
  }

  getText(): string {
    return this.textarea.value;
  }

  setText(text: string): void {
    this.textarea.value = text;
    this.grow();
    this.updateButtons();
  }

  isEmpty(): boolean {
    return this.textarea.value.trim() === '';
  }

  isBusy(): boolean {
    return this.busy;
  }

  focus(): void {
    this.textarea.focus({ preventScroll: true });
    const end = this.textarea.value.length;
    this.textarea.setSelectionRange(end, end);
    this.grow();
    this.dom.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Call after the box is in the page, so the height is known. */
  grow(): void {
    const t = this.textarea;
    t.style.height = 'auto';
    const next = Math.min(Math.max(t.scrollHeight, 60), 400);
    if (t.scrollHeight > 0) t.style.height = `${next}px`;
    this.opts.onResize();
  }

  setError(message: string | null): void {
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message ?? '';
    this.opts.onResize();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.textarea.disabled = busy;
    this.spinner.hidden = !busy;
    this.cancelBtn.disabled = busy;
    this.updateButtons();
  }

  private updateButtons(): void {
    const off = this.busy || !canSubmit(this.textarea.value);
    for (const b of this.buttons) b.disabled = off;
  }

  private cancel(): void {
    if (!this.busy) this.opts.onCancel();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const first = this.opts.buttons[0];
      if (first) void this.submit(first.id);
    } else if (e.key === 'Escape' && this.isEmpty()) {
      e.preventDefault();
      this.cancel();
    }
  }

  private async submit(id: string): Promise<void> {
    if (this.busy || !canSubmit(this.textarea.value)) return;
    this.setError(null);
    this.setBusy(true);
    try {
      await this.opts.onSubmit(id, this.textarea.value);
    } catch (e) {
      this.setError(e instanceof Error ? e.message : String(e));
    } finally {
      this.setBusy(false);
    }
  }
}

// The DOM of one review thread: comments, drafts, the reply box and Resolve.
// The element lives as long as the thread, so the text in a reply box stays when the
// editor moves or redraws the widget.

import { h } from '../../../core/dom';
import { Composer } from './composer';
import { canResolve, draftActions, resolvedSummary } from './drafts';
import { fullTime, relativeTime } from './time';
import type { ReviewComment, ReviewDiffOptions, ReviewThread } from './types';

export interface ThreadViewDeps {
  opts: ReviewDiffOptions;
  /** HTML cache by markdown text, shared by all threads. */
  htmlCache: Map<string, string>;
  /** The height or the open state changed. */
  onChange(): void;
  /** Text above the comments, for example "Old line 4". Empty for none. */
  locationLabel(thread: ReviewThread): string;
}

export class ThreadView {
  readonly dom: HTMLElement;
  private thread: ReviewThread;
  private expanded = false;
  private rendered = false;
  private disposed = false;
  private reply: Composer | null = null;
  private replyHost: HTMLElement;
  private edits = new Map<string, Composer>();
  private busyIds = new Set<string>();
  private errors = new Map<string, string>();
  private head: HTMLElement;
  private list: HTMLElement;
  private foot: HTMLElement;

  constructor(
    thread: ReviewThread,
    private deps: ThreadViewDeps,
  ) {
    this.thread = thread;
    this.head = h('div', { class: 'review-diff-thread-head' });
    this.list = h('div', { class: 'review-diff-comments' });
    this.replyHost = h('div', { class: 'review-diff-reply-host' });
    this.foot = h('div', { class: 'review-diff-thread-foot' });
    this.dom = h('div', { class: 'review-diff-thread', 'data-thread': thread.id }, this.head, this.list, this.replyHost, this.foot);
    this.render();
  }

  /** True when the comments are visible (not folded). Only open threads mark their lines. */
  isOpen(): boolean {
    return !this.thread.resolved || this.expanded;
  }

  update(thread: ReviewThread): void {
    const wasOpen = this.isOpen();
    this.thread = thread;
    // Drop edit boxes of comments that are gone or no longer drafts.
    for (const [id, c] of [...this.edits]) {
      const cm = thread.comments.find((x) => x.id === id);
      if (!cm || !draftActions(cm).edit) {
        this.edits.delete(id);
        c.dom.remove();
      }
    }
    if (!thread.resolved) this.expanded = false;
    this.render();
    if (wasOpen !== this.isOpen()) this.deps.onChange();
  }

  dispose(): void {
    this.disposed = true;
    this.dom.remove();
  }

  /** Called when the thread is shown. Renders the markdown of the comments. */
  ensureRendered(): void {
    if (this.rendered) return;
    this.rendered = true;
    this.render();
  }

  /** Draws again and keeps the focus of a text box that the user is typing in. */
  private render(): void {
    const active = document.activeElement;
    const keep = active instanceof HTMLTextAreaElement && this.dom.contains(active) ? active : null;
    this.draw();
    if (keep && keep.isConnected && document.activeElement !== keep) keep.focus({ preventScroll: true });
  }

  private draw(): void {
    const t = this.thread;
    this.dom.classList.toggle('review-diff-thread-resolved', t.resolved);
    this.dom.classList.toggle('review-diff-thread-outdated', t.outdated);
    this.head.replaceChildren();
    const folded = t.resolved && !this.expanded;
    if (t.resolved) {
      const bar = h(
        'button',
        { type: 'button', class: 'review-diff-fold', 'aria-expanded': String(!folded), onclick: () => this.toggle() },
        h('span', { class: 'review-diff-chevron' }, folded ? '▸' : '▾'),
        h('span', null, resolvedSummary(t)),
      );
      this.head.append(bar);
    }
    const label = this.deps.locationLabel(t);
    if (!folded && (label || t.outdated)) {
      this.head.append(
        h(
          'div',
          { class: 'review-diff-location' },
          label,
          t.outdated ? h('span', { class: 'review-diff-tag' }, 'Outdated') : null,
        ),
      );
    }
    this.list.hidden = folded;
    this.replyHost.hidden = folded;
    this.foot.hidden = folded;
    if (folded) {
      this.deps.onChange();
      return;
    }
    this.list.replaceChildren(...t.comments.map((c) => this.renderComment(c)));
    this.renderFoot();
    this.deps.onChange();
  }

  private toggle(): void {
    this.expanded = !this.expanded;
    this.render();
    this.deps.onChange();
  }

  private renderComment(c: ReviewComment): HTMLElement {
    const editing = this.edits.get(c.id);
    const actions = draftActions(c);
    const busy = this.busyIds.has(c.id);
    const meta = h(
      'div',
      { class: 'review-diff-comment-meta' },
      h('strong', { class: 'review-diff-author' }, c.author),
      c.createdAt ? h('span', { class: 'review-diff-time', title: fullTime(c.createdAt) }, relativeTime(c.createdAt)) : null,
      c.pending ? h('span', { class: 'review-diff-tag review-diff-tag-pending' }, 'Pending') : null,
      h('span', { class: 'review-diff-spacer' }),
      actions.edit && !editing
        ? h('button', { type: 'button', class: 'review-diff-link', disabled: busy, onclick: () => this.startEdit(c) }, 'Edit')
        : null,
      actions.delete && !editing
        ? h('button', { type: 'button', class: 'review-diff-link review-diff-link-danger', disabled: busy, onclick: () => void this.remove(c) }, 'Delete')
        : null,
      busy ? h('span', { class: 'review-diff-spinner' }) : null,
    );
    const err = this.errors.get(c.id);
    const body = h('div', { class: 'review-diff-md' });
    if (editing) body.hidden = true;
    else this.fillBody(body, c.body);
    return h(
      'div',
      { class: 'review-diff-comment', 'data-comment': c.id },
      meta,
      body,
      editing ? editing.dom : null,
      err ? h('div', { class: 'review-diff-error', role: 'alert' }, err) : null,
    );
  }

  /** Shows the plain text first. The HTML comes from `renderMarkdown` and nothing else. */
  private fillBody(el: HTMLElement, markdown: string): void {
    const cached = this.deps.htmlCache.get(markdown);
    if (cached !== undefined) {
      el.innerHTML = cached;
      return;
    }
    el.textContent = markdown;
    el.classList.add('review-diff-md-plain');
    if (!this.rendered) return;
    this.deps.opts
      .renderMarkdown(markdown)
      .then((html) => {
        this.deps.htmlCache.set(markdown, html);
        if (this.disposed || !el.isConnected) return;
        el.classList.remove('review-diff-md-plain');
        el.innerHTML = html;
        this.deps.onChange();
      })
      .catch(() => {
        // Keep the plain text.
      });
  }

  private startEdit(c: ReviewComment): void {
    const box = new Composer({
      placeholder: 'Edit comment',
      initial: c.body,
      buttons: [{ id: 'save', label: 'Save', primary: true }],
      onSubmit: async (_id, body) => {
        await this.deps.opts.onEditDraft(c.id, body);
        this.edits.delete(c.id);
        this.render();
      },
      onCancel: () => {
        this.edits.delete(c.id);
        this.render();
      },
      onResize: () => this.deps.onChange(),
    });
    this.edits.set(c.id, box);
    this.render();
    box.focus();
  }

  private async remove(c: ReviewComment): Promise<void> {
    this.busyIds.add(c.id);
    this.errors.delete(c.id);
    this.render();
    try {
      await this.deps.opts.onDeleteDraft(c.id);
    } catch (e) {
      this.errors.set(c.id, e instanceof Error ? e.message : String(e));
    } finally {
      this.busyIds.delete(c.id);
      if (!this.disposed) this.render();
    }
  }

  private renderFoot(): void {
    const { opts } = this.deps;
    const t = this.thread;
    this.foot.replaceChildren();
    this.replyHost.replaceChildren();
    if (opts.canComment) {
      if (this.reply) {
        this.replyHost.append(this.reply.dom);
      } else {
        this.foot.append(
          h('button', { type: 'button', class: 'review-diff-reply-open', onclick: () => this.openReply() }, 'Reply...'),
        );
      }
    }
    if (canResolve(t, !!opts.onResolve)) {
      this.foot.append(h('span', { class: 'review-diff-spacer' }), this.resolveButton());
    }
  }

  private resolveError: string | null = null;
  private resolving = false;

  private resolveButton(): HTMLElement {
    const t = this.thread;
    const btn = h(
      'button',
      { type: 'button', class: 'review-diff-btn', disabled: this.resolving, onclick: () => void this.resolve() },
      t.resolved ? 'Unresolve' : 'Resolve',
    );
    return h(
      'span',
      { class: 'review-diff-resolve' },
      this.resolving ? h('span', { class: 'review-diff-spinner' }) : null,
      this.resolveError ? h('span', { class: 'review-diff-error-inline', role: 'alert' }, this.resolveError) : null,
      btn,
    );
  }

  private async resolve(): Promise<void> {
    const { onResolve } = this.deps.opts;
    if (!onResolve || this.resolving) return;
    this.resolving = true;
    this.resolveError = null;
    this.render();
    try {
      await onResolve(this.thread.id, !this.thread.resolved);
    } catch (e) {
      this.resolveError = e instanceof Error ? e.message : String(e);
    } finally {
      this.resolving = false;
      if (!this.disposed) this.render();
    }
  }

  private openReply(): void {
    if (this.reply) return;
    const send = (mode: 'review' | 'now') => async (_id: string, body: string) => {
      await this.deps.opts.onReply(this.thread.id, body, mode);
      this.reply = null;
      this.render();
    };
    this.reply = new Composer({
      placeholder: 'Reply...',
      buttons: [
        { id: 'review', label: 'Add to Review', primary: true },
        { id: 'now', label: 'Comment Now' },
      ],
      onSubmit: (id, body) => send(id === 'now' ? 'now' : 'review')(id, body),
      onCancel: () => {
        this.reply = null;
        this.render();
      },
      onResize: () => this.deps.onChange(),
    });
    this.render();
    this.reply.focus();
  }
}

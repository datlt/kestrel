// The Code / Split / Preview switch of a file tab, the preview pane and the
// scroll sync. It only exists for files that have a matching PreviewProvider.

import type { Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { h } from '../core/dom';
import type { FileEditor, PreviewInstance, PreviewProvider, ViewMode } from '../core/types';
import { rafThrottle } from '../core/util';
import { pushDelay } from './large';

export interface PreviewOwner {
  /** The real editor. */
  readonly editor: FileEditor;
  /** Element of the tab: toolbar on top, then the body. */
  readonly root: HTMLElement;
  /** Holds the code pane, the splitter and the preview pane. */
  readonly body: HTMLElement;
  /** The code pane. */
  readonly codeEl: HTMLElement;
  /** Called after the mode changed. */
  modeChanged(mode: ViewMode): void;
  /** Share of the code pane in split mode (0..1). The value belongs to the workbench, not to this module. */
  splitRatio(): number;
  setSplitRatio(ratio: number): void;
}

const LABELS: [ViewMode, string, string][] = [
  ['code', 'Code', 'Show only the code'],
  ['split', 'Split', 'Show code and preview side by side'],
  ['preview', 'Preview', 'Show only the preview'],
];

export class PreviewHost {
  private provider: PreviewProvider | null = null;
  private instance: PreviewInstance | null = null;
  private mode: ViewMode = 'code';
  private toolbar: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private splitter: HTMLElement | null = null;
  private buttons = new Map<ViewMode, HTMLButtonElement>();
  /** The preview shows old text because it was hidden while the text changed. */
  private stale = false;
  /** Do not send editor scroll to the preview until this time (echo of a preview scroll). */
  private suppressUntil = 0;
  private disposed = false;

  /** The document that the preview got last. The same document is not sent twice. */
  private pushedDoc: Text | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pushLater = Object.assign(
    () => {
      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => this.pushText(), pushDelay(this.view.state.doc.length));
    },
    { cancel: () => clearTimeout(this.pushTimer) },
  );
  private readonly syncScroll = rafThrottle(() => this.sendScroll());
  private readonly onEditorScroll = () => this.syncScroll();

  constructor(
    private readonly owner: PreviewOwner,
    private readonly view: EditorView,
  ) {
    view.scrollDOM.addEventListener('scroll', this.onEditorScroll, { passive: true });
  }

  getMode(): ViewMode {
    return this.mode;
  }

  hasProvider(): boolean {
    return this.provider !== null;
  }

  /** Sets or removes the provider. `mode` is the mode to show first. */
  attach(provider: PreviewProvider | null, mode: ViewMode): void {
    if (this.disposed) return;
    if (provider !== this.provider) {
      this.destroyInstance();
      this.provider = provider;
    }
    if (!provider) {
      this.removeDom();
      this.setMode('code');
      return;
    }
    this.buildDom();
    this.setMode(mode);
  }

  setMode(mode: ViewMode): void {
    if (!this.provider) mode = 'code';
    this.mode = mode;
    this.owner.root.dataset.mode = mode;
    for (const [m, button] of this.buttons) button.setAttribute('aria-pressed', String(m === mode));
    if (mode !== 'code') {
      this.ensureInstance();
      if (this.stale) this.pushText();
    }
    this.view.requestMeasure();
    this.owner.modeChanged(mode);
  }

  /** The editor text changed. */
  docChanged(): void {
    if (this.instance) this.pushLater();
  }

  /** The preview calls `editor.revealLine`. Scroll the code without moving the cursor in split mode. */
  revealFromPreview(line: number, column?: number): void {
    this.suppressUntil = performance.now() + 200;
    if (this.mode === 'split') {
      const doc = this.view.state.doc;
      const pos = doc.line(Math.min(Math.max(1, Math.floor(line)), doc.lines)).from;
      this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
    } else {
      this.owner.editor.revealLine(line, column);
    }
  }

  /** Someone else moved the editor to a line (open at line). Move the preview too when the code is hidden. */
  revealInPreview(line: number): void {
    if (this.mode === 'preview') this.instance?.revealLine?.(line);
  }

  /** Zoom goes to the preview when it has focus or is the only pane. Returns true when handled. */
  zoom(step: 1 | -1 | 0): boolean {
    if (!this.instance?.zoom || this.mode === 'code') return false;
    const focused = !!this.previewEl && this.previewEl.contains(document.activeElement);
    if (!focused && this.mode !== 'preview') return false;
    this.instance.zoom(step);
    return true;
  }

  focusPreview(): void {
    this.previewEl?.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.pushLater.cancel();
    this.view.scrollDOM.removeEventListener('scroll', this.onEditorScroll);
    this.destroyInstance();
  }

  // --- Internals --------------------------------------------------------------------

  private pushText(): void {
    if (!this.instance) return;
    if (this.mode === 'code') {
      this.stale = true;
      return;
    }
    const doc = this.view.state.doc;
    if (doc !== this.pushedDoc) {
      this.pushedDoc = doc;
      this.instance.update(this.owner.editor.getText());
    }
    this.stale = false;
  }

  private sendScroll(): void {
    if (this.mode !== 'split' || !this.instance?.revealLine) return;
    if (performance.now() < this.suppressUntil) return;
    const { view } = this;
    const top = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top);
    const line = view.state.doc.lineAt(view.lineBlockAtHeight(top).from).number;
    this.instance.revealLine(line);
  }

  private ensureInstance(): void {
    if (this.instance || !this.provider || !this.previewEl) return;
    try {
      this.instance = this.provider.create(this.previewEl, this.previewEditor());
      this.pushedDoc = null;
      this.stale = true;
      this.pushText();
    } catch (e) {
      console.error('preview failed to start', e);
    }
  }

  /** The editor object for the preview: same as the real one, but `revealLine` is the scroll sync version. */
  private previewEditor(): FileEditor {
    const real = this.owner.editor;
    return {
      get path() {
        return real.path;
      },
      get tabId() {
        return real.tabId;
      },
      get languageId() {
        return real.languageId;
      },
      get meta() {
        return real.meta;
      },
      get isDraft() {
        return real.isDraft;
      },
      get view() {
        return real.view;
      },
      getText: () => real.getText(),
      isDirty: () => real.isDirty(),
      save: () => real.save(),
      reload: (opts) => real.reload(opts),
      revealLine: (line, column) => this.revealFromPreview(line, column),
      getMode: () => real.getMode(),
      setMode: (mode) => real.setMode(mode),
      onDidChange: (fn) => real.onDidChange(fn),
      focus: () => real.focus(),
    };
  }

  private destroyInstance(): void {
    this.pushLater.cancel();
    if (this.instance) {
      try {
        this.instance.dispose();
      } catch (e) {
        console.error('preview dispose failed', e);
      }
      this.instance = null;
    }
    this.previewEl?.replaceChildren();
  }

  private buildDom(): void {
    if (this.toolbar) return;
    const { root, body, codeEl } = this.owner;
    this.toolbar = h('div', { class: 'editor-toolbar' });
    for (const [mode, label, title] of LABELS) {
      const button = h('button', { class: 'editor-switch', type: 'button', title, onclick: () => this.owner.editor.setMode(mode) }, label);
      this.buttons.set(mode, button);
      this.toolbar.append(button);
    }
    root.insertBefore(this.toolbar, body);

    this.previewEl = h('div', { class: 'editor-preview', tabindex: '-1' });
    this.splitter = h('div', { class: 'editor-splitter', role: 'separator', 'aria-orientation': 'vertical' });
    this.splitter.addEventListener('pointerdown', (e) => this.startDrag(e));
    codeEl.after(this.splitter, this.previewEl);
    this.applyRatio();
  }

  private removeDom(): void {
    this.toolbar?.remove();
    this.previewEl?.remove();
    this.splitter?.remove();
    this.toolbar = this.previewEl = this.splitter = null;
    this.buttons.clear();
  }

  private applyRatio(): void {
    this.owner.root.style.setProperty('--editor-split', `${(this.owner.splitRatio() * 100).toFixed(2)}%`);
  }

  private startDrag(e: PointerEvent): void {
    const splitter = this.splitter;
    if (!splitter || e.button !== 0) return;
    e.preventDefault();
    try {
      splitter.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is gone already. The drag still ends on pointerup.
    }
    this.owner.root.classList.add('editor-dragging');
    let dragging = true;
    const rect = this.owner.body.getBoundingClientRect();
    const move = rafThrottle((ev: PointerEvent) => {
      if (!dragging) return;
      this.owner.setSplitRatio(Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width)));
    });
    const stop = () => {
      dragging = false;
      this.owner.root.classList.remove('editor-dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', stop);
      splitter.removeEventListener('pointercancel', stop);
      splitter.removeEventListener('lostpointercapture', stop);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', stop);
    splitter.addEventListener('pointercancel', stop);
    splitter.addEventListener('lostpointercapture', stop);
  }
}

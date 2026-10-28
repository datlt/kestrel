// Input methods (IME) in the terminal: Japanese (Kotoeri), Vietnamese (Telex) and others.
//
// An input method shows "marked text" while you type: `viêt` that turns into `việt`,
// or `にほん` that turns into `日本`. The browser reports it with composition events
// (`compositionstart`, `compositionupdate`, `compositionend`) on the hidden textarea
// of xterm. xterm has its own handling for this (CompositionHelper), but it guesses
// the final text from the textarea after a `setTimeout`, and it depends on the order
// of events, which differs between Chrome and WebKit (WKWebView on macOS). This file
// takes over the IME events on that textarea. xterm still draws the terminal and
// handles all other keys.
//
// What we do:
//  - We read the final text from `compositionend.data` and send it to the shell once.
//  - We show the marked text in our own view at the cursor, and keep the textarea
//    there too. The IME opens its candidate window next to the textarea.
//  - Key events that belong to the IME never reach xterm or the app shortcuts.
//
// The pure part (`ImeState`, `isImeKey`, `anchorBox`) has tests. `attachIme` is the
// DOM part.

import type { Terminal } from '@xterm/xterm';

/** The fields of a key event that we read. */
export interface ImeKeyLike {
  type?: string;
  key?: string;
  keyCode?: number;
  isComposing?: boolean;
  repeat?: boolean;
  timeStamp?: number;
}

/**
 * True when a key event belongs to the input method.
 *  - `isComposing`: Chrome marks every key event of a composition.
 *  - `keyCode` 229: both Chrome and WebKit use it for keys that the IME handles.
 *    WebKit (Safari, WKWebView) fires the `keydown` of the Enter that confirms a
 *    conversion AFTER `compositionend`, with `isComposing` false and `keyCode` 229.
 *    So `keyCode` is the only sign there.
 *  - `key` "Process": the name of such a key in some browsers.
 */
export function isImeKey(e: ImeKeyLike): boolean {
  return e.isComposing === true || e.keyCode === 229 || e.key === 'Process';
}

/**
 * Time after `compositionend` in which an Enter or Backspace `keydown` that is NOT
 * marked as IME key is still treated as the echo of the confirming key. The echo
 * comes from the same native key press, so it follows within a few milliseconds.
 * Event time stamps are the time the event was made, so a busy page does not
 * change this. A real second key press is always slower than 50 ms.
 */
export const ECHO_WINDOW_MS = 50;
/** An `insertText` event with the same text as a just ended composition is its duplicate. */
export const DUPLICATE_WINDOW_MS = 30;

/** State of the IME events of one terminal. No DOM, so tests can run it. */
export class ImeState {
  /** True between `compositionstart` and `compositionend`. */
  composing = false;
  /** The marked text now. */
  text = '';
  private endedAt = Number.NEGATIVE_INFINITY;
  private endedEmpty = false;
  private committed = '';
  private imeKeyDown = false;

  start(): void {
    this.composing = true;
    this.text = '';
  }

  update(data: string | null | undefined): void {
    this.text = data ?? '';
  }

  /**
   * Ends the composition and returns the text for the shell ('' when you cancelled).
   * `data` is `compositionend.data`. WebKit gives the final text there. When a
   * browser gives an empty string for a confirmed text, `inBox` is what the
   * textarea holds at the end, and we use it when it is the last marked text.
   */
  end(data: string | null | undefined, now: number, inBox = ''): string {
    const last = this.text;
    this.composing = false;
    this.text = '';
    let text = typeof data === 'string' ? data : '';
    if (text === '' && last !== '' && inBox !== '' && inBox.endsWith(last)) text = last;
    this.endedAt = now;
    this.endedEmpty = text === '';
    this.committed = text;
    return text;
  }

  /** Forgets a composition that cannot end any more (the textarea lost the focus). */
  cancel(): void {
    this.composing = false;
    this.text = '';
  }

  keyDown(e: ImeKeyLike): void {
    this.imeKeyDown = isImeKey(e);
  }

  keyUp(): void {
    this.imeKeyDown = false;
  }

  /**
   * True for a `keydown` or `keypress` that xterm and the app must not see
   * although it is not marked as IME key:
   *  - Enter right after `compositionend`: the key that confirmed the text.
   *    Without this, the shell would get `\r` and run the command.
   *  - Backspace right after a composition that ended empty: the key that
   *    deleted the last marked letter. It must not delete a letter of the shell.
   * Held keys (`repeat`) are real key presses.
   */
  blocksEcho(e: ImeKeyLike): boolean {
    if (this.composing || e.repeat) return false;
    const dt = (e.timeStamp ?? 0) - this.endedAt;
    if (dt < 0 || dt > ECHO_WINDOW_MS) return false;
    if (e.key === 'Enter') return true;
    return e.key === 'Backspace' && this.endedEmpty;
  }

  /**
   * Text of an `input` event that the IME inserted without a composition (for
   * example a full-width space or a punctuation mark right after a `keydown` with
   * `keyCode` 229). Returns null when xterm or the composition path handles it.
   */
  directText(e: { inputType?: string; data?: string | null; isComposing?: boolean; timeStamp?: number }): string | null {
    if (this.composing || e.isComposing) return null;
    if (e.inputType !== 'insertText' || !e.data || !this.imeKeyDown) return null;
    // Some engines send the confirmed text again as `insertText` after `compositionend`.
    const dt = (e.timeStamp ?? 0) - this.endedAt;
    if (this.committed !== '' && e.data === this.committed && dt >= 0 && dt <= DUPLICATE_WINDOW_MS) return null;
    return e.data;
  }
}

/** Position of the input view and the textarea, in CSS pixels inside the terminal. */
export interface AnchorBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The cell of the cursor. `screenWidth` and `screenHeight` are the size of the
 * `.xterm-screen` element, which holds exactly `cols` by `rows` cells. Returns
 * null when the terminal has no size yet (hidden) or the cursor is scrolled away.
 */
export function anchorBox(a: {
  cursorX: number;
  cursorY: number;
  cols: number;
  rows: number;
  screenWidth: number;
  screenHeight: number;
  cursorInView: boolean;
}): AnchorBox | null {
  if (!a.cursorInView || a.cols < 1 || a.rows < 1 || a.screenWidth < 1 || a.screenHeight < 1) return null;
  const cw = a.screenWidth / a.cols;
  const ch = a.screenHeight / a.rows;
  const x = Math.min(Math.max(a.cursorX, 0), a.cols - 1);
  return { left: x * cw, top: Math.max(a.cursorY, 0) * ch, width: cw, height: ch };
}

export interface ImeHandle {
  /** True while a composition runs. */
  readonly composing: boolean;
  /** Moves the textarea and the input view to the cursor. Call it after a resize or a font change. */
  sync(): void;
  dispose(): void;
}

/**
 * Takes over the IME events of `term`. `send` gets the text for the shell.
 * Returns null when xterm has no textarea (it is not open yet).
 */
export function attachIme(term: Terminal, send: (text: string) => void): ImeHandle | null {
  const ta = term.textarea;
  const host = ta?.parentElement;
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!ta || !host || !screen) return null;

  const state = new ImeState();
  const view = document.createElement('div');
  view.className = 'term-ime';
  host.appendChild(view);
  const ac = new AbortController();
  let frame = 0;
  let lastLayout = '';

  /**
   * Puts the textarea at the cursor. The IME opens its candidate window next to
   * the textarea, so this must be right also after a resize or a font zoom (xterm
   * moves the textarea only when the cursor moves). While you compose, the
   * textarea has the size of the marked text, like the view.
   */
  const sync = (): void => {
    const buf = term.buffer.active;
    const box = anchorBox({
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
      cols: term.cols,
      rows: term.rows,
      screenWidth: screen.offsetWidth,
      screenHeight: screen.offsetHeight,
      cursorInView: buf.viewportY === buf.baseY,
    });
    if (!box) return;
    const font = `${term.options.fontSize ?? 12}px ${term.options.fontFamily ?? 'monospace'}`;
    let width = box.width;
    if (state.composing) {
      view.style.left = `${box.left}px`;
      view.style.top = `${box.top}px`;
      view.style.height = `${box.height}px`;
      view.style.font = font;
      view.style.lineHeight = `${box.height}px`;
      width = Math.max(view.offsetWidth, 1);
    }
    const key = `${box.left}|${box.top}|${width}|${box.height}|${font}|${state.composing}`;
    if (key === lastLayout) return;
    lastLayout = key;
    ta.style.left = `${box.left}px`;
    ta.style.top = `${box.top}px`;
    ta.style.width = `${width}px`;
    ta.style.height = `${box.height}px`;
    ta.style.font = font;
    ta.style.lineHeight = `${box.height}px`;
    ta.style.zIndex = '-5';
  };
  const scheduleSync = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  };

  const showView = (text: string): void => {
    view.textContent = text;
    view.classList.add('is-active');
    sync();
  };
  const hideView = (): void => {
    view.classList.remove('is-active');
    view.textContent = '';
    lastLayout = '';
    sync();
  };

  const on = <E extends Event>(type: string, fn: (e: E) => void): void =>
    host.addEventListener(type, ((e: Event) => {
      if (e.target === ta) fn(e as E);
    }) as EventListener, { capture: true, signal: ac.signal });

  // Capture listeners on the parent run before xterm's listeners on the textarea.
  // `stopPropagation` there keeps the event away from xterm.

  on<KeyboardEvent>('keydown', (e) => {
    state.keyDown(e);
    if (isImeKey(e) || state.composing) {
      // The IME owns this key. Do not call preventDefault: it can cancel the IME.
      e.stopPropagation();
    } else if (state.blocksEcho(e)) {
      e.stopPropagation();
      e.preventDefault();
    }
  });
  on<KeyboardEvent>('keypress', (e) => {
    if (isImeKey(e) || state.composing || state.blocksEcho(e)) {
      e.stopPropagation();
      e.preventDefault();
    }
  });
  on<KeyboardEvent>('keyup', () => state.keyUp());

  on<CompositionEvent>('compositionstart', (e) => {
    e.stopPropagation();
    state.start();
    showView('');
  });
  on<CompositionEvent>('compositionupdate', (e) => {
    e.stopPropagation();
    state.update(e.data);
    showView(e.data ?? '');
  });
  on<CompositionEvent>('compositionend', (e) => {
    e.stopPropagation();
    const text = state.end(e.data, e.timeStamp, ta.value);
    hideView();
    if (text) send(text);
    // The textarea only exists for the IME. Empty it, so the next composition starts clean.
    setTimeout(() => {
      if (!state.composing) ta.value = '';
    }, 0);
  });

  on<InputEvent>('input', (e) => {
    // During a composition the text goes out at `compositionend`.
    if (state.composing || e.isComposing || /composition/i.test(e.inputType ?? '')) {
      e.stopPropagation();
      return;
    }
    const text = state.directText(e);
    if (text) {
      e.stopPropagation();
      send(text);
    }
  });

  // A composition that loses the focus ends in the browser. If that event never
  // comes, do not keep the view on the screen.
  on<FocusEvent>('blur', () => {
    setTimeout(() => {
      if (state.composing && document.activeElement !== ta) {
        state.cancel();
        hideView();
      }
    }, 50);
  });

  const subs = [term.onRender(scheduleSync), term.onCursorMove(scheduleSync), term.onResize(scheduleSync)];
  scheduleSync();

  return {
    get composing() {
      return state.composing;
    },
    sync: scheduleSync,
    dispose() {
      ac.abort();
      if (frame) cancelAnimationFrame(frame);
      subs.forEach((s) => s.dispose());
      view.remove();
    },
  };
}

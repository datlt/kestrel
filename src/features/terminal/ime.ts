// Input methods (IME) in the terminal: Japanese (Kotoeri), Vietnamese (Telex) and others.
//
// Two kinds of input methods exist, and a terminal must handle both:
//
//  1. Marked text. You type `nihon`, the browser shows `にほん` underlined, and the
//     events `compositionstart`, `compositionupdate`, `compositionend` follow. The
//     final text arrives at `compositionend`. (Japanese Kotoeri.)
//  2. In-place replacement. The input method changes letters that are already in
//     the text, with no marked text: typing `vieej` changes `e` to `ê` to `ệ`.
//     WebKit reports it as `input` events (`insertReplacementText`, sometimes
//     `insertText`) after a `keydown` with `keyCode` 229, and no composition events.
//     The press-and-hold accent popup (hold `e`, choose `é`) works the same way.
//     (Apple's Vietnamese input method, Simple Telex.)
//
// The shell is a stream: it cannot take letters back, except with Backspace. So we
// keep a MIRROR. The hidden textarea of xterm is the text the input method sees.
// `shadow` is the part of it that the shell already has. After every input event
// of an input method we compare `shadow` with the textarea, by code points. For
// each code point that disappeared at the end we send one Backspace (`\x7f`), then
// we send the new text. So `viê` -> `việ` sends one Backspace and `ệ`. It does not
// matter which event kind the input method used. `shadow` is then set to the new
// textarea value.
//
// Keys that xterm handles itself (letters of the plain keyboard, Backspace, Enter,
// arrows ...) change the shell, not the textarea, so we keep the textarea and
// `shadow` in step with them, and we clear both at Enter, arrows, a paste, a click
// and so on. A reset never sends anything.
//
// The pure part (`ImeState` and the helpers) has tests. `attachIme` is the DOM part.

import type { Terminal } from '@xterm/xterm';
import { escapeControl, inputLog } from './input-log';

/** The fields of a key event that we read. */
export interface ImeKeyLike {
  type?: string;
  key?: string;
  keyCode?: number;
  isComposing?: boolean;
  repeat?: boolean;
  timeStamp?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
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
/** When the textarea grows beyond this and the text ends with a space, we clear it. */
export const MAX_BOX_CHARS = 256;

// --- Text helpers (pure) ---------------------------------------------------------

/** Letters with marks in one form (`ệ` as one code point, not `e` and two marks). */
export function nfc(text: string): string {
  return text.normalize('NFC');
}

/** Splits text into code points. An emoji with two UTF-16 units is one item. */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

export function dropLastCodePoint(text: string): string {
  const cps = codePoints(text);
  cps.pop();
  return cps.join('');
}

export interface TextDiff {
  /** Code points at the end of the old text that are gone. */
  removed: number;
  /** Text to add after that. */
  inserted: string;
}

/**
 * What changed from `shadow` to `value`: the longest common start (by code points)
 * stays, the rest of `shadow` is removed and the rest of `value` is inserted. Both
 * texts are compared in NFC form, so `e` + combining marks and `ệ` are the same.
 */
export function codePointDiff(shadow: string, value: string): TextDiff {
  const a = codePoints(nfc(shadow));
  const b = codePoints(nfc(value));
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { removed: a.length - i, inserted: b.slice(i).join('') };
}

/** The bytes for the shell: one Backspace per removed code point, then the new text. */
export function diffToInput(shadow: string, value: string): string {
  const d = codePointDiff(shadow, value);
  return '\x7f'.repeat(d.removed) + d.inserted;
}

const NAVIGATION_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/**
 * Keys after which the textarea no longer matches the shell line: Enter, Tab,
 * Escape, arrows, Home/End, PageUp/PageDown, and any Ctrl, Meta or Alt combination.
 * We clear the textarea and `shadow` for them.
 */
export function isResetKey(e: ImeKeyLike): boolean {
  return !!(e.ctrlKey || e.metaKey || e.altKey) || NAVIGATION_KEYS.has(e.key ?? '');
}

/** True for a key that types one character on the plain keyboard. */
export function isPrintableKey(e: ImeKeyLike): boolean {
  return !!e.key && codePoints(e.key).length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !isImeKey(e);
}

/**
 * The textarea value after a plain printable key. xterm sends the key to the shell
 * and cancels the event, so the textarea may not have the character. We add it, so
 * a later in-place change (hold `e`, choose `é`) has the letter to replace. When the
 * textarea has it already, we keep it.
 */
export function valueAfterPrintable(before: string, after: string, key: string): string {
  return after === before ? before + key : after;
}

/** True when the box is too long and ends with a space: a good moment to clear it. */
export function boxIsTooLong(value: string): boolean {
  return value.length > MAX_BOX_CHARS && value.endsWith(' ');
}

const IGNORED_INPUT_TYPES = new Set(['insertFromPaste', 'insertFromDrop', 'insertFromYank', 'insertFromPasteAsQuotation']);

/** State of the IME events of one terminal. No DOM, so tests can run it. */
export class ImeState {
  /** True between `compositionstart` and `compositionend`. */
  composing = false;
  /** The marked text now. */
  text = '';
  /** The text of the textarea that the shell already has (NFC). */
  shadow = '';
  /** How many mirror updates ran. A caller uses it to see that nothing changed meanwhile. */
  mirrors = 0;
  private startShadow = '';
  private endedAt = Number.NEGATIVE_INFINITY;
  private endedEmpty = false;
  private imeKeyDown = false;

  start(): void {
    this.composing = true;
    this.text = '';
    this.startShadow = this.shadow;
  }

  update(data: string | null | undefined): void {
    this.text = data ?? '';
  }

  /**
   * Ends the composition and returns what to send to the shell ('' when you cancelled).
   * `data` is `compositionend.data`: WebKit gives the final text there. `value` is the
   * textarea now. Rules:
   *  - Normal case: send `data`. `shadow` becomes the textarea value.
   *  - A browser gives an empty `data` for a confirmed text: use the last marked text
   *    when the textarea ends with it and the textarea changed.
   *  - `data` does not explain the textarea (the input method changed text before
   *    the marked text): send the difference from the shadow at `compositionstart`.
   *    It needs `value` to contain `data`, so a textarea that is not updated yet
   *    cannot make us send Backspaces.
   */
  end(data: string | null | undefined, now: number, value = ''): string {
    const last = nfc(this.text);
    const v = nfc(value);
    const s0 = this.startShadow;
    this.composing = false;
    this.text = '';
    let d = nfc(typeof data === 'string' ? data : '');
    if (d === '' && last !== '' && v !== nfc(s0) && v.endsWith(last)) d = last;
    let send = d;
    if (d !== '' && v !== nfc(s0 + d) && v.includes(d)) send = diffToInput(s0, v);
    // Settled textarea: it is the shadow. A textarea that has not the text yet: the shadow is
    // what the shell has now.
    const expected = nfc(s0 + d);
    this.shadow = d !== '' && send === d && v !== expected ? expected : v;
    this.mirrors++;
    this.endedAt = now;
    this.endedEmpty = d === '';
    return send;
  }

  /** Forgets a composition that cannot end any more (the textarea lost the focus). */
  cancel(): void {
    this.composing = false;
    this.text = '';
  }

  /** Sets `shadow` to the textarea, without sending anything. */
  setShadow(value: string): void {
    this.shadow = nfc(value);
  }

  /** Clears the mirror (the textarea was emptied). Nothing is sent. */
  reset(): void {
    this.shadow = '';
    this.startShadow = '';
  }

  keyDown(e: ImeKeyLike): void {
    this.imeKeyDown = isImeKey(e);
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
   * True when an `input` event outside a composition must go through the mirror.
   * That is every input event after an IME key (`keyCode` 229, `isComposing`), and
   * every `insertReplacementText`, whatever came before. Paste and drop are left
   * to xterm. The kind of the event (`insertText`, `deleteContentBackward` ...) does
   * not matter: the mirror compares texts.
   */
  shouldMirror(e: { inputType?: string; isComposing?: boolean }): boolean {
    if (this.composing || e.isComposing) return false;
    const type = e.inputType ?? '';
    if (IGNORED_INPUT_TYPES.has(type) || /composition/i.test(type)) return false;
    return type === 'insertReplacementText' || this.imeKeyDown;
  }

  /** Compares the textarea with `shadow`, returns the bytes for the shell, and updates `shadow`. */
  mirror(value: string): string {
    const send = diffToInput(this.shadow, value);
    this.shadow = nfc(value);
    this.mirrors++;
    return send;
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

  const emit = (text: string): void => {
    if (!text) return;
    inputLog.add(performance.now(), `SENT to shell ${escapeControl(text)}`);
    send(text);
  };

  /** Empties the textarea and `shadow`. Sends nothing. Not during a composition. */
  const clearBox = (): void => {
    if (state.composing) return;
    ta.value = '';
    state.reset();
  };
  const clearBoxSoon = (): void => {
    setTimeout(clearBox, 0);
  };
  /** After the textarea passed 256 characters at a space, start again. */
  const trimBox = (): void => {
    if (boxIsTooLong(ta.value)) clearBox();
  };

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

  // --- Recorder (off by default, see input-log.ts) ---------------------------------
  // These listeners are added first, so they see every event before our handlers
  // stop it. Each line has the textarea value and selection when the event came, and
  // `=>` the value after the event was handled.
  const snapshot = (): string => `val=${escapeControl(ta.value)} sel=${ta.selectionStart}-${ta.selectionEnd}`;
  const record = (text: string): void => {
    if (!inputLog.active) return;
    const entry = inputLog.add(performance.now(), `${text} ${snapshot()}`);
    if (entry) setTimeout(() => (entry.after = `${snapshot()} shadow=${escapeControl(state.shadow)}`), 0);
  };
  for (const type of ['keydown', 'keyup', 'keypress']) {
    on<KeyboardEvent>(type, (e) =>
      record(`${type} key=${escapeControl(e.key)} code=${e.code} keyCode=${e.keyCode} isComposing=${e.isComposing} repeat=${e.repeat}`),
    );
  }
  for (const type of ['beforeinput', 'input']) {
    on<InputEvent>(type, (e) => record(`${type} inputType=${e.inputType} data=${escapeControl(e.data ?? '')} isComposing=${e.isComposing}`));
  }
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
    on<CompositionEvent>(type, (e) => record(`${type} data=${escapeControl(e.data ?? '')}`));
  }
  on<Event>('paste', () => record('paste'));
  on<Event>('blur', () => record('blur'));
  on<Event>('focus', () => record('focus'));

  // --- Keys ----------------------------------------------------------------------
  // Capture listeners on the parent run before xterm's listeners on the textarea.
  // `stopPropagation` there keeps the event away from xterm.

  on<KeyboardEvent>('keydown', (e) => {
    state.keyDown(e);
    if (isImeKey(e) || state.composing) {
      // The IME owns this key. Do not call preventDefault: it can cancel the IME.
      e.stopPropagation();
      return;
    }
    if (state.blocksEcho(e)) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    // xterm handles this key. Keep the textarea and the shadow like the shell line.
    if (isResetKey(e)) {
      clearBoxSoon();
    } else if (e.key === 'Backspace') {
      ta.value = dropLastCodePoint(ta.value);
      state.setShadow(dropLastCodePoint(state.shadow));
    } else if (isPrintableKey(e)) {
      const before = ta.value;
      const key = e.key;
      setTimeout(() => {
        if (state.composing) return;
        ta.value = valueAfterPrintable(before, ta.value, key);
        state.setShadow(ta.value);
        trimBox();
      }, 0);
    }
  });
  on<KeyboardEvent>('keypress', (e) => {
    if (isImeKey(e) || state.composing || state.blocksEcho(e)) {
      e.stopPropagation();
      e.preventDefault();
    }
  });

  // --- Marked text (composition) ---------------------------------------------------

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
    emit(text);
    // The textarea can still change after this event. When it has settled, and no
    // other input came meanwhile, it is the new shadow.
    const mirrors = state.mirrors;
    setTimeout(() => {
      if (!state.composing && state.mirrors === mirrors) {
        state.setShadow(ta.value);
        trimBox();
      }
    }, 0);
  });

  // --- Input events without marked text (in-place replacement) ---------------------

  on<InputEvent>('input', (e) => {
    // During a composition the text goes out at `compositionend`.
    if (state.composing || e.isComposing || /composition/i.test(e.inputType ?? '')) {
      e.stopPropagation();
      return;
    }
    if (state.shouldMirror(e)) {
      e.stopPropagation();
      emit(state.mirror(ta.value));
      trimBox();
      return;
    }
    // xterm handles this one (emoji picker, dictation ...). The textarea has the
    // text now and the shell gets it from xterm, so the shadow follows.
    if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop') {
      clearBoxSoon();
    } else {
      // Follow at once too: the next IME key can come before the timer below
      // runs, and with an old shadow it would send this text a second time.
      if (!state.composing) state.setShadow(ta.value);
      setTimeout(() => {
        if (!state.composing) state.setShadow(ta.value);
      }, 0);
    }
  });

  // A paste, a focus change and a click in the terminal end the mirror.
  on<Event>('paste', clearBoxSoon);
  on<Event>('focus', clearBoxSoon);
  on<FocusEvent>('blur', () => {
    clearBoxSoon();
    // A composition that loses the focus ends in the browser. If that event never
    // comes, do not keep the view on the screen.
    setTimeout(() => {
      if (state.composing && document.activeElement !== ta) {
        state.cancel();
        hideView();
      }
    }, 50);
  });
  term.element?.addEventListener('pointerdown', clearBoxSoon, { capture: true, signal: ac.signal });

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

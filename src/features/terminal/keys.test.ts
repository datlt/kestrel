import { describe, expect, it } from 'vitest';
import { clipboardAction, isClosingKey, routeKey, type KeyLike } from './keys';

function key(code: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { type: 'keydown', code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe('routeKey on macOS', () => {
  it('sends Ctrl keys to the shell program', () => {
    expect(routeKey(key('KeyC', { ctrlKey: true }), true)).toBe('term');
    expect(routeKey(key('KeyD', { ctrlKey: true }), true)).toBe('term');
    expect(routeKey(key('KeyW', { ctrlKey: true }), true)).toBe('term');
    expect(routeKey(key('KeyA', { ctrlKey: true }), true)).toBe('term');
  });

  it('sends plain and Alt keys to the shell program', () => {
    expect(routeKey(key('KeyA'), true)).toBe('term');
    expect(routeKey(key('ArrowLeft', { altKey: true }), true)).toBe('term');
    expect(routeKey(key('Tab'), true)).toBe('term');
  });

  it('gives Kestrel shortcuts to the app', () => {
    expect(routeKey(key('Backquote', { ctrlKey: true }), true)).toBe('app');
    expect(routeKey(key('Backquote', { ctrlKey: true, shiftKey: true }), true)).toBe('app');
    expect(routeKey(key('Backslash', { metaKey: true }), true)).toBe('app');
    expect(routeKey(key('Backslash', { metaKey: true, shiftKey: true }), true)).toBe('app');
    expect(routeKey(key('KeyW', { metaKey: true }), true)).toBe('app');
    expect(routeKey(key('KeyK', { metaKey: true }), true)).toBe('app');
    expect(routeKey(key('ArrowRight', { metaKey: true, altKey: true }), true)).toBe('app');
    expect(routeKey(key('ArrowLeft', { metaKey: true, altKey: true }), true)).toBe('app');
  });

  it('gives other Cmd shortcuts to the app', () => {
    expect(routeKey(key('KeyC', { metaKey: true }), true)).toBe('app');
    expect(routeKey(key('KeyV', { metaKey: true }), true)).toBe('app');
    expect(routeKey(key('KeyP', { metaKey: true }), true)).toBe('app');
    expect(routeKey(key('KeyB', { metaKey: true }), true)).toBe('app');
  });

  it('opens the terminal search with Cmd-f', () => {
    expect(routeKey(key('KeyF', { metaKey: true }), true)).toBe('search');
    expect(routeKey(key('KeyF', { ctrlKey: true }), true)).toBe('term');
  });
});

describe('routeKey on Windows and Linux', () => {
  it('keeps most Ctrl keys for the shell program', () => {
    expect(routeKey(key('KeyC', { ctrlKey: true }), false)).toBe('term');
    expect(routeKey(key('KeyP', { ctrlKey: true }), false)).toBe('term');
    expect(routeKey(key('KeyV', { ctrlKey: true, shiftKey: true }), false)).toBe('term');
  });

  it('uses Ctrl as Mod for the terminal shortcuts', () => {
    expect(routeKey(key('Backslash', { ctrlKey: true }), false)).toBe('app');
    expect(routeKey(key('KeyW', { ctrlKey: true }), false)).toBe('app');
    expect(routeKey(key('KeyF', { ctrlKey: true }), false)).toBe('search');
    expect(routeKey(key('ArrowRight', { ctrlKey: true, altKey: true }), false)).toBe('app');
  });

  it('does not touch Win key combinations', () => {
    expect(routeKey(key('KeyC', { metaKey: true }), false)).toBe('term');
  });
});

describe('routeKey for other events', () => {
  it('lets xterm see keyup and keypress', () => {
    expect(routeKey({ ...key('KeyW', { metaKey: true }), type: 'keyup' }, true)).toBe('term');
    expect(routeKey({ ...key('KeyW', { metaKey: true }), type: 'keypress' }, true)).toBe('term');
  });
});

describe('isClosingKey', () => {
  it('ignores a lone modifier', () => {
    expect(isClosingKey(key('ShiftLeft', { shiftKey: true }))).toBe(false);
    expect(isClosingKey(key('MetaLeft', { metaKey: true }))).toBe(false);
  });
  it('accepts normal keys on keydown only', () => {
    expect(isClosingKey(key('Enter'))).toBe(true);
    expect(isClosingKey({ ...key('Enter'), type: 'keyup' })).toBe(false);
  });
});

describe('clipboardAction', () => {
  it('uses Ctrl-Shift-c and Ctrl-Shift-v on Windows and Linux', () => {
    expect(clipboardAction(key('KeyC', { ctrlKey: true, shiftKey: true }), false)).toBe('copy');
    expect(clipboardAction(key('KeyV', { ctrlKey: true, shiftKey: true }), false)).toBe('paste');
    expect(clipboardAction(key('KeyC', { ctrlKey: true }), false)).toBeNull();
  });
  it('leaves macOS to the Edit menu', () => {
    expect(clipboardAction(key('KeyC', { metaKey: true }), true)).toBeNull();
  });
});

describe('keys of an input method (IME)', () => {
  const ime = (code: string, mods: Partial<KeyLike> = {}) => key(code, { keyCode: 229, ...mods });

  it('are never app shortcuts, also with the app modifiers', () => {
    // Cmd-w, Cmd-k, Cmd-\ , Ctrl-` and Cmd-f must not run while a composition is active.
    for (const code of ['KeyW', 'KeyK', 'Backslash', 'KeyF', 'KeyP']) {
      expect(routeKey(ime(code, { metaKey: true }), true)).toBe('term');
      expect(routeKey(key(code, { metaKey: true, isComposing: true }), true)).toBe('term');
    }
    expect(routeKey(ime('Backquote', { ctrlKey: true }), true)).toBe('term');
    expect(routeKey(ime('KeyW', { ctrlKey: true }), false)).toBe('term');
  });

  it('go to the input method when isComposing is true, whatever the key code is', () => {
    expect(routeKey(key('Enter', { isComposing: true, keyCode: 13 }), true)).toBe('term');
    expect(routeKey(key('Backspace', { isComposing: true, keyCode: 8 }), true)).toBe('term');
    expect(routeKey(key('Space', { isComposing: true, keyCode: 32 }), true)).toBe('term');
  });

  it('treats the key name "Process" as an IME key', () => {
    expect(routeKey(key('KeyA', { key: 'Process', metaKey: true }), true)).toBe('term');
  });

  it('does not close a pane whose shell ended', () => {
    expect(isClosingKey(ime('Enter'))).toBe(false);
    expect(isClosingKey(key('Enter', { isComposing: true }))).toBe(false);
    expect(isClosingKey(key('Enter', { keyCode: 13 }))).toBe(true);
  });

  it('are not copy or paste on Windows and Linux', () => {
    expect(clipboardAction(ime('KeyC', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(clipboardAction(key('KeyC', { ctrlKey: true, shiftKey: true }), false)).toBe('copy');
  });

  it('leave normal keys alone', () => {
    expect(routeKey(key('KeyW', { metaKey: true, keyCode: 87 }), true)).toBe('app');
    expect(routeKey(key('KeyA', { keyCode: 65 }), true)).toBe('term');
  });
});

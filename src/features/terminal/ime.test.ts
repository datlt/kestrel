import { describe, expect, it } from 'vitest';
import { ECHO_WINDOW_MS, ImeState, anchorBox, isImeKey } from './ime';

describe('isImeKey', () => {
  it('is true during a composition, for keyCode 229 and for the key "Process"', () => {
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    // WebKit: the Enter that confirms a conversion has isComposing false and keyCode 229.
    expect(isImeKey({ isComposing: false, keyCode: 229, key: 'Enter' })).toBe(true);
    expect(isImeKey({ key: 'Process' })).toBe(true);
  });

  it('is false for normal keys', () => {
    expect(isImeKey({ isComposing: false, keyCode: 13, key: 'Enter' })).toBe(false);
    expect(isImeKey({ keyCode: 65 })).toBe(false);
    expect(isImeKey({})).toBe(false);
  });
});

describe('ImeState: one text for the shell', () => {
  it('Vietnamese Telex: the marked text changes and the shell gets the last word once', () => {
    const s = new ImeState();
    s.start();
    // v i e e j t: the marked text is replaced at each update.
    for (const t of ['v', 'vi', 'vie', 'viê', 'viêj', 'việt']) s.update(t);
    expect(s.composing).toBe(true);
    expect(s.end('việt', 100)).toBe('việt');
    expect(s.composing).toBe(false);
    // The same state works for the next word.
    s.start();
    s.update('n');
    expect(s.end('nam', 500)).toBe('nam');
  });

  it('Japanese: the confirmed text is the kanji, not the kana', () => {
    const s = new ImeState();
    s.start();
    s.update('にほん');
    s.update('日本');
    expect(s.end('日本', 10)).toBe('日本');
  });

  it('cancelling a composition sends nothing', () => {
    const s = new ImeState();
    s.start();
    s.update('a');
    // The box has no marked text any more.
    expect(s.end('', 10, '')).toBe('');
    s.start();
    s.update('にほん');
    expect(s.end('', 20, '')).toBe('');
  });

  it('uses the textarea when a browser reports an empty `data` for a confirmed text', () => {
    const s = new ImeState();
    s.start();
    s.update('việt');
    expect(s.end('', 10, 'việt')).toBe('việt');
    s.start();
    s.update('việt');
    expect(s.end(undefined, 20, 'xx')).toBe('');
  });
});

describe('ImeState: the key that confirms a composition', () => {
  const enter = (timeStamp: number, extra = {}) => ({ key: 'Enter', keyCode: 13, timeStamp, ...extra });

  it('blocks the Enter that follows compositionend at once', () => {
    const s = new ImeState();
    s.start();
    s.update('日本');
    s.end('日本', 1000);
    expect(s.blocksEcho(enter(1002))).toBe(true);
    // The keypress of the same key.
    expect(s.blocksEcho(enter(1003, { type: 'keypress' }))).toBe(true);
  });

  it('lets a later Enter run the command', () => {
    const s = new ImeState();
    s.start();
    s.end('日本', 1000);
    expect(s.blocksEcho(enter(1000 + ECHO_WINDOW_MS + 1))).toBe(false);
    expect(s.blocksEcho(enter(1400))).toBe(false);
  });

  it('does not block a held Enter or other keys', () => {
    const s = new ImeState();
    s.start();
    s.end('日本', 1000);
    expect(s.blocksEcho(enter(1010, { repeat: true }))).toBe(false);
    expect(s.blocksEcho({ key: 'a', keyCode: 65, timeStamp: 1010 })).toBe(false);
    expect(s.blocksEcho({ key: 'Backspace', keyCode: 8, timeStamp: 1010 })).toBe(false);
  });

  it('blocks Backspace right after a composition that ended empty', () => {
    const s = new ImeState();
    s.start();
    s.update('a');
    s.end('', 1000);
    expect(s.blocksEcho({ key: 'Backspace', keyCode: 8, timeStamp: 1004 })).toBe(true);
    // A held Backspace goes on deleting the shell line.
    expect(s.blocksEcho({ key: 'Backspace', keyCode: 8, timeStamp: 1030, repeat: true })).toBe(false);
  });

  it('never blocks while a composition runs (the IME owns the key then)', () => {
    const s = new ImeState();
    s.start();
    expect(s.blocksEcho(enter(5))).toBe(false);
  });

  it('blocks nothing before the first composition', () => {
    expect(new ImeState().blocksEcho(enter(10))).toBe(false);
  });
});

describe('ImeState: text inserted without a composition', () => {
  it('returns the text after an IME key', () => {
    const s = new ImeState();
    s.keyDown({ keyCode: 229 });
    expect(s.directText({ inputType: 'insertText', data: '、', isComposing: false, timeStamp: 10 })).toBe('、');
  });

  it('leaves normal typing and emoji pickers to xterm', () => {
    const s = new ImeState();
    s.keyDown({ keyCode: 65 });
    expect(s.directText({ inputType: 'insertText', data: 'a', timeStamp: 10 })).toBeNull();
    s.keyDown({ keyCode: 229 });
    s.keyUp();
    expect(s.directText({ inputType: 'insertText', data: '😀', timeStamp: 10 })).toBeNull();
  });

  it('ignores composition input events and other input types', () => {
    const s = new ImeState();
    s.keyDown({ keyCode: 229 });
    expect(s.directText({ inputType: 'insertCompositionText', data: 'x', isComposing: true })).toBeNull();
    expect(s.directText({ inputType: 'insertFromComposition', data: 'x', isComposing: false })).toBeNull();
    expect(s.directText({ inputType: 'deleteContentBackward', data: null })).toBeNull();
    s.start();
    expect(s.directText({ inputType: 'insertText', data: 'x' })).toBeNull();
  });

  it('skips a duplicate of the text that compositionend just sent', () => {
    const s = new ImeState();
    s.keyDown({ keyCode: 229 });
    s.start();
    s.update('việt');
    s.end('việt', 100);
    expect(s.directText({ inputType: 'insertText', data: 'việt', timeStamp: 105 })).toBeNull();
    // A space after the word is new text.
    expect(s.directText({ inputType: 'insertText', data: ' ', timeStamp: 106 })).toBe(' ');
    // The same word typed much later is new text too.
    expect(s.directText({ inputType: 'insertText', data: 'việt', timeStamp: 900 })).toBe('việt');
  });
});

describe('anchorBox', () => {
  const base = { cursorX: 4, cursorY: 2, cols: 80, rows: 24, screenWidth: 640, screenHeight: 480, cursorInView: true };

  it('puts the box on the cursor cell', () => {
    expect(anchorBox(base)).toEqual({ left: 32, top: 40, width: 8, height: 20 });
  });

  it('follows a new cell size after a font zoom', () => {
    expect(anchorBox({ ...base, screenWidth: 960, screenHeight: 720 })).toEqual({ left: 48, top: 60, width: 12, height: 30 });
  });

  it('keeps the cursor in the last column', () => {
    expect(anchorBox({ ...base, cursorX: 80 })?.left).toBe(79 * 8);
  });

  it('returns null for a hidden terminal or a cursor that is scrolled away', () => {
    expect(anchorBox({ ...base, screenWidth: 0 })).toBeNull();
    expect(anchorBox({ ...base, cursorInView: false })).toBeNull();
    expect(anchorBox({ ...base, cols: 0 })).toBeNull();
  });
});

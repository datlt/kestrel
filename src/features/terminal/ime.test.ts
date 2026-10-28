import { describe, expect, it } from 'vitest';
import {
  ECHO_WINDOW_MS,
  ImeState,
  anchorBox,
  boxIsTooLong,
  codePointDiff,
  diffToInput,
  dropLastCodePoint,
  isImeKey,
  isPrintableKey,
  isResetKey,
  valueAfterPrintable,
} from './ime';
import { InputLog, MAX_LOG_EVENTS, escapeControl } from './input-log';

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

const DEL = '\x7f';

describe('codePointDiff and diffToInput', () => {
  it('viê -> việ: one Backspace and the new letter', () => {
    expect(diffToInput('viê', 'việ')).toBe(`${DEL}ệ`);
    expect(codePointDiff('viê', 'việ')).toEqual({ removed: 1, inserted: 'ệ' });
  });

  it('adds letters at the end', () => {
    expect(diffToInput('v', 'vi')).toBe('i');
    expect(diffToInput('', 'việt')).toBe('việt');
    expect(diffToInput('việt', 'việt')).toBe('');
  });

  it('deletes at the end', () => {
    expect(diffToInput('việt', 'việ')).toBe(DEL);
    expect(diffToInput('abc', '')).toBe(DEL.repeat(3));
  });

  it('a replacement in the middle removes everything after it and writes it again', () => {
    expect(diffToInput('abcd', 'aXcd')).toBe(`${DEL.repeat(3)}Xcd`);
  });

  it('NFC and NFD forms are the same text', () => {
    const nfd = 'vie\u0302\u0323t'; // e + circumflex + dot below
    expect(diffToInput('việt', nfd)).toBe('');
    // The shell gets NFC letters, also when the textarea has NFD.
    expect(diffToInput('vie', nfd)).toBe(`${DEL}ệt`);
    expect(diffToInput('vie\u0302', 'vie\u0302\u0323')).toBe(`${DEL}ệ`);
  });

  it('counts an emoji with two UTF-16 units as one code point', () => {
    expect(diffToInput('a😀', 'a')).toBe(DEL);
    expect(diffToInput('a😀', 'a😁')).toBe(`${DEL}😁`);
    expect(diffToInput('😀😀', '')).toBe(DEL.repeat(2));
  });

  it('dropLastCodePoint removes one code point', () => {
    expect(dropLastCodePoint('a😀')).toBe('a');
    expect(dropLastCodePoint('')).toBe('');
  });
});

/** Apple Simple Telex: replaces letters in place, no composition events. */
describe('mirror: Vietnamese in-place replacement', () => {
  const input = { inputType: 'insertReplacementText' };

  it('vieej step by step, as Apple sends it', () => {
    const s = new ImeState();
    const sent: string[] = [];
    for (const value of ['v', 'vi', 'vie', 'viê', 'việ', 'việt']) {
      s.keyDown({ keyCode: 229 });
      expect(s.shouldMirror({ inputType: value === 'viê' ? 'insertReplacementText' : 'insertText' })).toBe(true);
      sent.push(s.mirror(value));
    }
    expect(sent).toEqual(['v', 'i', 'e', `${DEL}ê`, `${DEL}ệ`, 't']);
    // The shell line, built from these bytes, is the word once.
    let line = '';
    for (const chunk of sent) for (const ch of chunk) line = ch === DEL ? dropLastCodePoint(line) : line + ch;
    expect(line).toBe('việt');
  });

  it('handles insertReplacementText also without an IME key before', () => {
    const s = new ImeState();
    s.setShadow('e');
    s.keyDown({ keyCode: 69, key: 'e' });
    expect(s.shouldMirror(input)).toBe(true);
  });

  it('handles a delete after an IME key and ignores it after a plain key', () => {
    const s = new ImeState();
    s.keyDown({ keyCode: 229 });
    expect(s.shouldMirror({ inputType: 'deleteContentBackward' })).toBe(true);
    s.keyDown({ keyCode: 8, key: 'Backspace' });
    expect(s.shouldMirror({ inputType: 'deleteContentBackward' })).toBe(false);
  });

  it('leaves paste, drop and composition events alone', () => {
    const s = new ImeState();
    s.keyDown({ keyCode: 229 });
    expect(s.shouldMirror({ inputType: 'insertFromPaste' })).toBe(false);
    expect(s.shouldMirror({ inputType: 'insertFromDrop' })).toBe(false);
    expect(s.shouldMirror({ inputType: 'insertCompositionText', isComposing: true })).toBe(false);
    expect(s.shouldMirror({ inputType: 'insertFromComposition' })).toBe(false);
    s.start();
    expect(s.shouldMirror({ inputType: 'insertText' })).toBe(false);
  });

  it('does not mirror a plain insert after a plain key (xterm handles it)', () => {
    const s = new ImeState();
    s.keyDown({ keyCode: 65, key: 'a' });
    expect(s.shouldMirror({ inputType: 'insertText' })).toBe(false);
  });
});

describe('mirror: press and hold', () => {
  it('hold e, choose é: one replacement of the last letter', () => {
    const s = new ImeState();
    // The plain key `e` went to the shell through xterm. The box follows (valueAfterPrintable).
    const box = valueAfterPrintable('', '', 'e');
    expect(box).toBe('e');
    s.setShadow(box);
    // The popup replaces the letter: `insertReplacementText`, with no IME key.
    expect(s.shouldMirror({ inputType: 'insertReplacementText' })).toBe(true);
    expect(s.mirror('é')).toBe(`${DEL}é`);
    expect(s.shadow).toBe('é');
  });

  it('keeps a letter that the textarea has already', () => {
    expect(valueAfterPrintable('ab', 'abe', 'e')).toBe('abe');
    expect(valueAfterPrintable('ab', 'ab', 'e')).toBe('abe');
  });
});

describe('mirror: composition (Japanese) with the shadow', () => {
  it('sends the kanji once and the shadow follows the textarea', () => {
    const s = new ImeState();
    s.start();
    s.update('にほん');
    s.update('日本');
    expect(s.end('日本', 10, '日本')).toBe('日本');
    expect(s.shadow).toBe('日本');
    // The next word is added to the same box.
    s.start();
    expect(s.end('語', 500, '日本語')).toBe('語');
    expect(s.shadow).toBe('日本語');
  });

  it('keeps the shadow right when the textarea is not updated at compositionend', () => {
    const s = new ImeState();
    s.setShadow('ab');
    s.start();
    expect(s.end('日本', 10, 'ab')).toBe('日本');
    expect(s.shadow).toBe('ab日本');
    // The value settles later: no second send from a late insert event of the same text.
    expect(s.mirror('ab日本')).toBe('');
  });

  it('a composition that changes text before it sends the difference', () => {
    const s = new ImeState();
    s.setShadow('abc');
    s.start();
    s.update('X');
    // The IME changed `c` to `C` and committed `X` after it.
    expect(s.end('X', 10, 'abCX')).toBe(`${DEL}CX`);
    expect(s.shadow).toBe('abCX');
  });

  it('does not send Backspaces when data is not in the textarea yet', () => {
    const s = new ImeState();
    s.setShadow('abc');
    s.start();
    expect(s.end('X', 10, '')).toBe('X');
    expect(s.shadow).toBe('abcX');
  });

  it('a cancelled composition sends nothing and leaves the shadow', () => {
    const s = new ImeState();
    s.setShadow('ab');
    s.start();
    s.update('にほん');
    expect(s.end('', 10, 'ab')).toBe('');
    expect(s.shadow).toBe('ab');
  });

  it('Vietnamese with marked text still sends the word once', () => {
    const s = new ImeState();
    s.start();
    s.update('việt');
    expect(s.end('việt', 10, 'việt')).toBe('việt');
    expect(s.mirror('việt')).toBe('');
  });
});

describe('reset rules', () => {
  it('Enter, Tab, Escape, arrows, Home/End, PageUp/PageDown reset', () => {
    for (const key of ['Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(isResetKey({ key }), key).toBe(true);
    }
  });

  it('Ctrl, Meta and Alt combinations reset', () => {
    expect(isResetKey({ key: 'c', ctrlKey: true })).toBe(true);
    expect(isResetKey({ key: 'v', metaKey: true })).toBe(true);
    expect(isResetKey({ key: 'f', altKey: true })).toBe(true);
  });

  it('letters and Backspace do not reset', () => {
    expect(isResetKey({ key: 'a' })).toBe(false);
    expect(isResetKey({ key: 'Backspace' })).toBe(false);
  });

  it('printable keys are single characters without modifiers or IME', () => {
    expect(isPrintableKey({ key: 'a', keyCode: 65 })).toBe(true);
    expect(isPrintableKey({ key: '😀' })).toBe(true);
    expect(isPrintableKey({ key: 'Enter' })).toBe(false);
    expect(isPrintableKey({ key: 'a', ctrlKey: true })).toBe(false);
    expect(isPrintableKey({ key: 'a', keyCode: 229 })).toBe(false);
  });

  it('reset clears the shadow without producing bytes', () => {
    const s = new ImeState();
    s.setShadow('việt');
    s.reset();
    expect(s.shadow).toBe('');
    // The next change is compared with an empty shadow.
    expect(s.mirror('x')).toBe('x');
  });

  it('a long box is cleared at a space', () => {
    expect(boxIsTooLong('a'.repeat(300) + ' ')).toBe(true);
    expect(boxIsTooLong('a'.repeat(300))).toBe(false);
    expect(boxIsTooLong('a ')).toBe(false);
  });
});

describe('InputLog', () => {
  it('records nothing until it starts', () => {
    const log = new InputLog();
    expect(log.add(10, 'keydown')).toBeNull();
    expect(log.toText()).toBe('');
  });

  it('keeps the last 400 events with times since the start', () => {
    const log = new InputLog();
    log.start(1000);
    for (let i = 0; i < MAX_LOG_EVENTS + 5; i++) log.add(1000 + i, `e${i}`);
    expect(log.size).toBe(MAX_LOG_EVENTS);
    const lines = log.toText().split('\n');
    expect(lines).toHaveLength(MAX_LOG_EVENTS);
    expect(lines[0]).toContain('e5');
    expect(lines[0]).toContain('5 ms');
  });

  it('stops, and a new start drops the old log', () => {
    const log = new InputLog();
    log.start(0);
    log.add(5, 'a');
    log.stop();
    expect(log.add(6, 'b')).toBeNull();
    expect(log.toText()).toContain('a');
    log.start(100);
    expect(log.size).toBe(0);
  });

  it('writes the value after the event', () => {
    const log = new InputLog();
    log.start(0);
    const e = log.add(1, 'input')!;
    e.after = 'val="x"';
    expect(log.toText()).toContain('=> val="x"');
  });

  it('escapes control characters', () => {
    expect(escapeControl('\x7fệ\r\n\t\x1b[A"\\')).toBe('"\\x7fệ\\r\\n\\t\\e[A\\"\\\\"');
  });
});

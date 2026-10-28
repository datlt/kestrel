import { describe, expect, it, vi } from 'vitest';
import { createCommandRegistry, eventKey, keyLabel, parseBinding } from './commands';

// Node runs as "linux", so Mod means Ctrl here. macOS cases are at the end.

type Fake = Partial<Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>>;
function ev(e: Fake): KeyboardEvent {
  return { key: '', code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...e } as KeyboardEvent;
}

describe('parseBinding', () => {
  it('turns Mod into Ctrl on linux', () => {
    expect(parseBinding('Mod-s')).toBe('ctrl+s');
  });
  it('orders modifiers the same way every time', () => {
    expect(parseBinding('Shift-Alt-f')).toBe('alt+shift+f');
    expect(parseBinding('Mod-Shift-Alt-p')).toBe('alt+ctrl+shift+p');
    expect(parseBinding('Alt-Shift-Ctrl-x')).toBe('alt+ctrl+shift+x');
  });
  it('is not case sensitive for names and keys', () => {
    expect(parseBinding('mod-SHIFT-P')).toBe('ctrl+shift+p');
  });
  it('reads a trailing dash as the minus key', () => {
    expect(parseBinding('Mod--')).toBe('ctrl+-');
    expect(parseBinding('Mod-Alt--')).toBe('alt+ctrl+-');
  });
  it('reads the plus and equal keys', () => {
    expect(parseBinding('Mod-=')).toBe('ctrl+=');
    expect(parseBinding('Mod-Shift-=')).toBe('ctrl+shift+=');
  });
  it('knows aliases', () => {
    expect(parseBinding('Esc')).toBe('escape');
    expect(parseBinding('Ctrl-Space')).toBe('ctrl+ ');
    expect(parseBinding('Alt-Up')).toBe('alt+arrowup');
    expect(parseBinding('Meta-Return')).toBe('meta+enter');
  });
  it('keeps function keys and Tab', () => {
    expect(parseBinding('F12')).toBe('f12');
    expect(parseBinding('Ctrl-Tab')).toBe('ctrl+tab');
    expect(parseBinding('Shift-Alt-F5')).toBe('alt+shift+f5');
  });
});

describe('eventKey', () => {
  it('matches a simple shortcut', () => {
    expect(eventKey(ev({ key: 's', code: 'KeyS', ctrlKey: true }))).toBe('ctrl+s');
  });
  it('uses the physical key when Alt changes the character', () => {
    expect(eventKey(ev({ key: 'π', code: 'KeyP', altKey: true }))).toBe('alt+p');
  });
  it('uses the physical key for digits', () => {
    expect(eventKey(ev({ key: ')', code: 'Digit0', ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+0');
    expect(eventKey(ev({ key: '0', code: 'Digit0', ctrlKey: true }))).toBe('ctrl+0');
  });
  it('turns Ctrl-Shift-+ on the Equal key into "="', () => {
    expect(eventKey(ev({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+=');
    expect(eventKey(ev({ key: '+', code: 'Equal', ctrlKey: true }))).toBe('ctrl+=');
  });
  it('turns the Minus key with Alt into "-"', () => {
    expect(eventKey(ev({ key: '–', code: 'Minus', ctrlKey: true, altKey: true }))).toBe('alt+ctrl+-');
  });
  it('lower-cases named keys', () => {
    expect(eventKey(ev({ key: 'F12', code: 'F12' }))).toBe('f12');
    expect(eventKey(ev({ key: 'ArrowUp', code: 'ArrowUp' }))).toBe('arrowup');
    expect(eventKey(ev({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+tab');
  });
  it('produces the same string as parseBinding', () => {
    const pairs: [string, Fake][] = [
      ['Mod-Shift-p', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }],
      ['Ctrl-Tab', { key: 'Tab', code: 'Tab', ctrlKey: true }],
      ['Mod-Alt-=', { key: '≠', code: 'Equal', ctrlKey: true, altKey: true }],
      ['Mod--', { key: '-', code: 'Minus', ctrlKey: true }],
      ['F1', { key: 'F1', code: 'F1' }],
    ];
    for (const [binding, fake] of pairs) expect(eventKey(ev(fake)), binding).toBe(parseBinding(binding));
  });
});

describe('keyLabel', () => {
  it('shows names on linux', () => {
    expect(keyLabel('Mod-s')).toBe('Ctrl+S');
    expect(keyLabel('Mod-Shift-p')).toBe('Ctrl+Shift+P');
    expect(keyLabel('Shift-Alt-f')).toBe('Shift+Alt+F');
    expect(keyLabel('F12')).toBe('F12');
    expect(keyLabel('Ctrl-Tab')).toBe('Ctrl+Tab');
    expect(keyLabel('Alt-Up')).toBe('Alt+↑');
    expect(keyLabel('Mod--')).toBe('Ctrl+-');
  });
});

describe('command registry', () => {
  const press = (key: string, extra: Fake = {}) => ev({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true, ...extra });

  it('finds a command by event and runs it', async () => {
    const reg = createCommandRegistry();
    const run = vi.fn(() => 42);
    reg.register({ id: 'a', title: 'A', keybinding: 'Mod-k', run });
    const cmd = reg.matchEvent(press('k'));
    expect(cmd?.id).toBe('a');
    expect(await reg.execute('a', 1)).toBe(42);
    expect(run).toHaveBeenCalledWith(1);
  });

  it('returns undefined when no key matches', () => {
    const reg = createCommandRegistry();
    reg.register({ id: 'a', title: 'A', keybinding: 'Mod-k', run: () => {} });
    expect(reg.matchEvent(press('j'))).toBeUndefined();
  });

  it('supports several bindings per command', () => {
    const reg = createCommandRegistry();
    reg.register({ id: 'p', title: 'P', keybinding: ['Mod-Shift-p', 'F1'], run: () => {} });
    expect(reg.matchEvent(press('p', { shiftKey: true }))?.id).toBe('p');
    expect(reg.matchEvent(ev({ key: 'F1', code: 'F1' }))?.id).toBe('p');
  });

  it('skips a command whose `when` is false and falls back to an older one', () => {
    const reg = createCommandRegistry();
    let on = false;
    reg.register({ id: 'old', title: 'Old', keybinding: 'Mod-k', run: () => {} });
    reg.register({ id: 'new', title: 'New', keybinding: 'Mod-k', when: () => on, run: () => {} });
    expect(reg.matchEvent(press('k'))?.id).toBe('old');
    on = true;
    expect(reg.matchEvent(press('k'))?.id).toBe('new');
  });

  it('returns undefined when every candidate fails `when`', () => {
    const reg = createCommandRegistry();
    reg.register({ id: 'a', title: 'A', keybinding: 'Mod-k', when: () => false, run: () => {} });
    expect(reg.matchEvent(press('k'))).toBeUndefined();
  });

  it('removes the command and its keys on dispose', () => {
    const reg = createCommandRegistry();
    const d = reg.register({ id: 'a', title: 'A', keybinding: 'Mod-k', run: () => {} });
    d.dispose();
    expect(reg.get('a')).toBeUndefined();
    expect(reg.matchEvent(press('k'))).toBeUndefined();
    expect(reg.list()).toHaveLength(0);
  });

  it('dispose of a replaced command does not remove the new one', () => {
    const reg = createCommandRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = reg.register({ id: 'a', title: 'First', keybinding: 'Mod-k', run: () => {} });
    reg.register({ id: 'a', title: 'Second', keybinding: 'Mod-k', run: () => {} });
    first.dispose();
    expect(reg.get('a')?.title).toBe('Second');
    expect(reg.matchEvent(press('k'))?.title).toBe('Second');
    warn.mockRestore();
  });

  it('registerMany disposes all commands together', () => {
    const reg = createCommandRegistry();
    const d = reg.registerMany([
      { id: 'a', title: 'A', keybinding: 'Mod-a', run: () => {} },
      { id: 'b', title: 'B', run: () => {} },
    ]);
    expect(reg.list()).toHaveLength(2);
    d.dispose();
    expect(reg.list()).toHaveLength(0);
  });

  it('rejects when the command is unknown', async () => {
    const reg = createCommandRegistry();
    await expect(reg.execute('nope')).rejects.toThrow('unknown command: nope');
  });
});

describe('macOS', () => {
  async function loadMac() {
    vi.resetModules();
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
    return import('./commands');
  }

  it('maps Mod to Meta and draws symbols', async () => {
    const mac = await loadMac();
    expect(mac.parseBinding('Mod-s')).toBe('meta+s');
    expect(mac.keyLabel('Mod-s')).toBe('⌘S');
    expect(mac.keyLabel('Mod-Shift-p')).toBe('⇧⌘P');
    expect(mac.keyLabel('Mod-Alt-Shift-p')).toBe('⌥⇧⌘P');
    expect(mac.keyLabel('Ctrl-Shift-g')).toBe('⌃⇧G');
    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

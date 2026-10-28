import type { Command, CommandRegistry, Disposable } from './types';
import { isMac } from './util';

// Key bindings use CodeMirror notation: modifiers joined with `-`, then the key.
// Modifiers: Mod (Cmd on macOS, Ctrl elsewhere), Ctrl, Alt, Shift, Meta (Cmd).
// We turn each binding and each KeyboardEvent into one canonical string:
// "alt+ctrl+meta+shift+<key>" (only the pressed modifiers), with `key` in lower case.

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  space: ' ',
  plus: '+',
  minus: '-',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  return: 'enter',
};

function canonical(mods: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }, key: string): string {
  let s = '';
  if (mods.alt) s += 'alt+';
  if (mods.ctrl) s += 'ctrl+';
  if (mods.meta) s += 'meta+';
  if (mods.shift) s += 'shift+';
  return s + key;
}

export function parseBinding(binding: string): string {
  // Split on `-`, but a trailing `-` is the minus key ("Mod--").
  const parts = binding.split(/-(?!$)/);
  const raw = parts.pop()!;
  const mods = { alt: false, ctrl: false, meta: false, shift: false };
  for (const p of parts) {
    switch (p.toLowerCase()) {
      case 'mod':
        if (isMac) mods.meta = true;
        else mods.ctrl = true;
        break;
      case 'ctrl':
      case 'control':
        mods.ctrl = true;
        break;
      case 'alt':
      case 'option':
        mods.alt = true;
        break;
      case 'shift':
        mods.shift = true;
        break;
      case 'meta':
      case 'cmd':
        mods.meta = true;
        break;
    }
  }
  const lower = raw.toLowerCase();
  return canonical(mods, KEY_ALIASES[lower] ?? lower);
}

export function eventKey(e: KeyboardEvent): string {
  let key = e.key.toLowerCase();
  // With Alt (and Shift on some layouts) `e.key` is a special character
  // (Alt-p gives "π" on macOS). Use the physical key for letters and digits.
  if (e.code.startsWith('Key')) key = e.code.slice(3).toLowerCase();
  else if (e.code.startsWith('Digit')) key = e.code.slice(5);
  else if (e.code === 'Equal' && (e.altKey || e.shiftKey)) key = '=';
  else if (e.code === 'Minus' && (e.altKey || e.shiftKey)) key = '-';
  else if (key === '+' && e.code === 'Equal') key = '=';
  return canonical({ alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey }, key);
}

const MAC_SYMBOLS: Record<string, string> = { alt: '⌥', ctrl: '⌃', meta: '⌘', shift: '⇧' };
const KEY_LABELS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  escape: 'Esc',
  enter: 'Enter',
  ' ': 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
};

export function keyLabel(binding: string): string {
  const parts = parseBinding(binding).split(/\+(?!$)/);
  const key = parts.pop()!;
  const keyText = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  if (isMac) {
    // macOS order: ⌃⌥⇧⌘
    const order = ['ctrl', 'alt', 'shift', 'meta'];
    return order.filter((m) => parts.includes(m)).map((m) => MAC_SYMBOLS[m]).join('') + keyText;
  }
  const names: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };
  const order = ['ctrl', 'shift', 'alt', 'meta'];
  return [...order.filter((m) => parts.includes(m)).map((m) => names[m]), keyText].join('+');
}

export function createCommandRegistry(): CommandRegistry {
  const commands = new Map<string, Command>();
  // canonical key -> command ids, last registered first
  const keys = new Map<string, string[]>();

  function bindingsOf(cmd: Command): string[] {
    if (!cmd.keybinding) return [];
    return Array.isArray(cmd.keybinding) ? cmd.keybinding : [cmd.keybinding];
  }

  const registry: CommandRegistry = {
    register(cmd) {
      if (commands.has(cmd.id)) console.warn(`command ${cmd.id} registered twice; the new one wins`);
      commands.set(cmd.id, cmd);
      const bound = bindingsOf(cmd).map(parseBinding);
      for (const k of bound) keys.set(k, [cmd.id, ...(keys.get(k) ?? []).filter((id) => id !== cmd.id)]);
      return {
        dispose() {
          if (commands.get(cmd.id) !== cmd) return;
          commands.delete(cmd.id);
          for (const k of bound) {
            const ids = (keys.get(k) ?? []).filter((id) => id !== cmd.id);
            if (ids.length) keys.set(k, ids);
            else keys.delete(k);
          }
        },
      };
    },
    registerMany(cmds) {
      const ds = cmds.map((c) => registry.register(c));
      return { dispose: () => ds.forEach((d) => d.dispose()) } satisfies Disposable;
    },
    async execute(id, ...args) {
      const cmd = commands.get(id);
      if (!cmd) throw new Error(`unknown command: ${id}`);
      return cmd.run(...args);
    },
    get: (id) => commands.get(id),
    list: () => [...commands.values()],
    matchEvent(e) {
      const ids = keys.get(eventKey(e));
      if (!ids) return undefined;
      for (const id of ids) {
        const cmd = commands.get(id);
        if (cmd && (!cmd.when || cmd.when())) return cmd;
      }
      return undefined;
    },
    keyLabel,
  };
  return registry;
}

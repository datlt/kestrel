// Decides who gets a key press inside a terminal. Pure logic, so tests can run it.
//
// `app`: Kestrel handles the key (xterm ignores it, the event goes on to the shell
//        of the app, which runs the command with that key binding).
// `search`: the terminal opens its own search bar.
// `term`: xterm sends the key to the shell program.
//
// A key that belongs to an input method (a composition, or `keyCode` 229) is always
// `term`: xterm and `ime.ts` handle it, and no app shortcut runs. While you compose
// Japanese or Vietnamese text, `Ctrl-\`` or Cmd-w must not close or toggle anything.

import { isImeKey } from './ime';

export interface KeyLike {
  type: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** True while an input method (IME) composes text. */
  isComposing?: boolean;
  /** 229 means the input method handles the key. */
  keyCode?: number;
  key?: string;
}

export type KeyRoute = 'app' | 'search' | 'term';

/**
 * Terminal shortcuts, as `code` values (the physical key). They match the
 * key bindings of the `terminal.*` commands in `index.ts`:
 *  - Ctrl-`, Ctrl-Shift-`    toggle and new terminal
 *  - Mod-\\, Mod-Shift-\\    split right and split down
 *  - Mod-w                   close the pane
 *  - Mod-Alt-Left / Right    focus the previous / next pane
 *  - Mod-k                   clear
 *  - Mod-f                   search in the terminal
 * On macOS every other Cmd key combination also goes to the app (copy, paste,
 * Cmd-p, Cmd-b ...). Ctrl keys always go to the shell program.
 */
export function routeKey(e: KeyLike, mac: boolean): KeyRoute {
  if (e.type !== 'keydown' || isImeKey(e)) return 'term';
  const mod = mac ? e.metaKey : e.ctrlKey;

  if (e.code === 'Backquote' && e.ctrlKey && !e.altKey && !e.metaKey) return 'app';
  if (mod && e.code === 'Backslash' && !e.altKey) return 'app';
  if (mod && !e.altKey && !e.shiftKey && (e.code === 'KeyW' || e.code === 'KeyK')) return 'app';
  if (mod && e.altKey && !e.shiftKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) return 'app';
  if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyF') return 'search';

  if (mac && e.metaKey) return 'app';
  return 'term';
}

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'NumLock',
  'ContextMenu',
]);

/** True for a key that closes a pane whose shell has ended (any key but a lone modifier). */
export function isClosingKey(e: KeyLike): boolean {
  // A key of the input method (keyCode 229) is not "any key": it must not close the pane.
  return e.type === 'keydown' && !isImeKey(e) && !MODIFIER_CODES.has(e.code);
}

/**
 * Copy and paste keys that the terminal handles itself. On macOS the app menu
 * (Edit) handles Cmd-c and Cmd-v, so this returns null there. On Windows and
 * Linux, Ctrl-c must reach the shell program, so copy and paste use Ctrl-Shift-c
 * and Ctrl-Shift-v.
 */
export function clipboardAction(e: KeyLike, mac: boolean): 'copy' | 'paste' | null {
  if (mac || e.type !== 'keydown' || isImeKey(e)) return null;
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  if (e.code === 'KeyC') return 'copy';
  if (e.code === 'KeyV') return 'paste';
  return null;
}

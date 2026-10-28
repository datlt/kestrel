// Key dispatch and web view defaults that do not fit an editor.

import type { AppContext } from '../core/types';
import { isMac } from '../core/util';

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/** Installs the key dispatcher and the web view defaults. Returns a function that removes them. */
export function installKeys(ctx: AppContext): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    // Every workbench listens on `window`. Only the visible one may act.
    if (!ctx.window.isActive()) return;
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    // On Windows, AltGr sends Ctrl+Alt. Layouts such as German or Vietnamese type
    // characters with it, so a shortcut like Ctrl-Alt-S must not take the key.
    if (e.getModifierState('AltGraph')) return;

    const cmd = ctx.commands.matchEvent(e);
    if (cmd) {
      e.preventDefault();
      ctx.commands.execute(cmd.id).catch((err) => {
        console.error(`command ${cmd.id} failed`, err);
        ctx.ui.notify(`Command failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      });
      return;
    }

    // No command took the key. Stop the web view from reloading or going back.
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === 'F5' || (mod && k === 'r') || (e.ctrlKey && k === 'r')) e.preventDefault();
    else if (e.key === 'Backspace' && !isEditable(e.target)) e.preventDefault();
    else if (isMac && e.metaKey && (e.key === '[' || e.key === ']')) e.preventDefault();
    else if (!isMac && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !isEditable(e.target)) e.preventDefault();
  };

  // No browser menu, except in text fields (copy and paste still work there).
  const onContextMenu = (e: MouseEvent) => {
    if (!isEditable(e.target)) e.preventDefault();
  };

  // A dropped file must not open in the web view. The files feature listens to
  // the Tauri drag-drop events instead.
  const stop = (e: Event) => e.preventDefault();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('dragover', stop);
  window.addEventListener('drop', stop);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('dragover', stop);
    window.removeEventListener('drop', stop);
  };
}

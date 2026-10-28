// The right-click menu of file editors.
//
// Two parts. `editorContextMenu` is a CodeMirror extension without any service.
// The engine adds it to every file editor (setup.ts). It stops the browser menu
// and sends a DOM event. `initEditorContextMenu(ctx)` listens for that event
// in one workbench, puts the cursor at the click, and shows the menu.

import { selectAll } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import type { AppContext, Disposable, MenuItem } from '../core/types';

export const EDITOR_MENU_EVENT = 'kestrel:editor-contextmenu';

export interface EditorMenuDetail {
  event: MouseEvent;
  view: EditorView;
}

/** Stops the browser menu and asks the workbench to show its own menu. */
export const editorContextMenu = EditorView.domEventHandlers({
  contextmenu(event, view) {
    event.preventDefault();
    view.dom.dispatchEvent(
      new CustomEvent<EditorMenuDetail>(EDITOR_MENU_EVENT, { bubbles: true, detail: { event, view } }),
    );
    return true;
  },
});

// --- Menu content (no DOM) ------------------------------------------------------

/** The commands of the first block, in order. */
export const COMMAND_ITEMS: readonly { id: string; label: string }[] = [
  { id: 'lsp.gotoDefinition', label: 'Go to Definition' },
  { id: 'usages.find', label: 'Find Usages' },
  { id: 'callHierarchy.show', label: 'Show Call Hierarchy' },
  { id: 'diagram.showForCursor', label: 'Show Class Diagram' },
  { id: 'lsp.rename', label: 'Rename Symbol' },
  { id: 'lsp.format', label: 'Format Document' },
];

export interface MenuDeps {
  commands: {
    get(id: string): { keybinding?: string | string[]; when?: () => boolean } | undefined;
    execute(id: string): Promise<unknown>;
  };
  hasSelection: boolean;
  readOnly: boolean;
  onError(message: string): void;
  clipboard: { cut(): void; copy(): void; paste(): void; selectAll(): void };
}

function firstBinding(binding: string | string[] | undefined): string | undefined {
  return Array.isArray(binding) ? binding[0] : binding;
}

/** A command appears only when it exists and its `when` passes. */
export function buildMenuItems(d: MenuDeps): MenuItem[] {
  const items: MenuItem[] = [];
  for (const { id, label } of COMMAND_ITEMS) {
    const cmd = d.commands.get(id);
    if (!cmd) continue;
    let applies = true;
    try {
      applies = !cmd.when || cmd.when();
    } catch {
      applies = false;
    }
    if (!applies) continue;
    items.push({
      label,
      keybinding: firstBinding(cmd.keybinding),
      run: () => {
        d.commands.execute(id).catch((e) => d.onError(`${label} failed: ${e instanceof Error ? e.message : String(e)}`));
      },
    });
  }
  items.push(
    { label: 'Cut', keybinding: 'Mod-x', run: d.clipboard.cut, disabled: !d.hasSelection || d.readOnly, separatorBefore: items.length > 0 },
    { label: 'Copy', keybinding: 'Mod-c', run: d.clipboard.copy, disabled: !d.hasSelection },
    { label: 'Paste', keybinding: 'Mod-v', run: d.clipboard.paste, disabled: d.readOnly },
    { label: 'Select All', keybinding: 'Mod-a', run: d.clipboard.selectAll },
  );
  return items;
}

// --- Wiring -----------------------------------------------------------------------

/** The cursor moves to the click, unless the click is inside the selection. */
function placeCursor(view: EditorView, event: MouseEvent): void {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  if (pos === null) return;
  const inside = view.state.selection.ranges.some((r) => !r.empty && pos >= r.from && pos <= r.to);
  if (!inside) view.dispatch({ selection: { anchor: pos } });
}

function clipboardActions(ctx: AppContext, view: EditorView): MenuDeps['clipboard'] {
  const notAllowed = (what: string) =>
    ctx.ui.notify(`The browser does not allow ${what} here. Use the keyboard shortcut instead.`, { kind: 'warn' });
  const selectedText = () =>
    view.state.selection.ranges
      .filter((r) => !r.empty)
      .map((r) => view.state.sliceDoc(r.from, r.to))
      .join(view.state.lineBreak);
  const copy = (then?: () => void) => {
    const text = selectedText();
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => {
        then?.();
        view.focus();
      },
      () => notAllowed('copying'),
    );
  };
  return {
    copy: () => copy(),
    cut: () =>
      copy(() => {
        if (!view.state.readOnly) view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete.cut', scrollIntoView: true });
      }),
    paste: () => {
      if (!navigator.clipboard?.readText) return notAllowed('pasting');
      navigator.clipboard.readText().then(
        (text) => {
          if (text) view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
          view.focus();
        },
        () => notAllowed('pasting'),
      );
    },
    selectAll: () => {
      selectAll(view);
      view.focus();
    },
  };
}

/** Shows the menu for the editors of this workbench. Call `dispose` when the workbench closes. */
export function initEditorContextMenu(ctx: AppContext): Disposable {
  const onMenu = (e: Event) => {
    const { event, view } = (e as CustomEvent<EditorMenuDetail>).detail;
    // Other workbenches have their own listener. Only the owner of the editor shows the menu.
    if (!ctx.editors.all().some((ed) => ed.view === view)) return;
    placeCursor(view, event);
    const items = buildMenuItems({
      commands: ctx.commands,
      hasSelection: view.state.selection.ranges.some((r) => !r.empty),
      readOnly: view.state.readOnly,
      onError: (m) => ctx.ui.notify(m, { kind: 'error' }),
      clipboard: clipboardActions(ctx, view),
    });
    ctx.ui.contextMenu(event, items);
  };
  document.addEventListener(EDITOR_MENU_EVENT, onMenu);
  return { dispose: () => document.removeEventListener(EDITOR_MENU_EVENT, onMenu) };
}

// Terminal feature (docs/DESIGN.md, section 10.4). A shell runs in a PTY in Rust.
// The bottom panel view `terminal` shows terminal tabs, and each tab can split
// into panes. xterm.js loads lazily, the first time a terminal opens.
import type { AppContext } from '../../core/types';
import './terminal.css';
import { createTerminalView, TerminalPanel, VIEW_ID } from './panel';

/** Registers the Terminal panel with tabs and split panes. */
export function initTerminal(ctx: AppContext): void {
  let panel: TerminalPanel | null = null;
  // True while a popup (command palette, menu) is open. Then the focus is in the popup,
  // but the commands of the focused terminal must still work from the palette.
  let overlayOpen = false;

  ctx.views.register(
    createTerminalView(ctx, (p) => {
      panel = p;
    }),
  );

  /** Shows the panel. The view is created on the first call. */
  function open(): TerminalPanel | null {
    ctx.views.show(VIEW_ID);
    return panel;
  }

  const focused = () => !!panel && (panel.hasFocus() || (overlayOpen && ctx.views.isVisible(VIEW_ID)));

  const category = 'Terminal';
  const subs = [
    ctx.bus.on('overlay:changed', (e) => {
      overlayOpen = e.open;
    }),
    ctx.commands.registerMany([
      {
        id: 'terminal.toggle',
        title: 'Toggle Terminal',
        category,
        keybinding: 'Ctrl-`',
        run: () => {
          const visible = ctx.views.isVisible(VIEW_ID);
          if (visible && panel?.hasFocus()) {
            ctx.views.togglePanel(false);
            ctx.editors.active()?.focus();
            return;
          }
          const p = open();
          if (p && p.tabCount() === 0) p.newTab();
          p?.focus();
        },
      },
      {
        id: 'terminal.new',
        title: 'New Terminal',
        category,
        // With Shift, many layouts report "~" instead of "`".
        keybinding: ['Ctrl-Shift-`', 'Ctrl-Shift-~'],
        run: () => {
          open()?.newTab();
        },
      },
      {
        id: 'terminal.splitRight',
        title: 'Split Terminal Right',
        category,
        keybinding: 'Mod-\\',
        when: focused,
        run: () => panel?.split('row'),
      },
      {
        id: 'terminal.splitDown',
        title: 'Split Terminal Down',
        category,
        // With Shift, many layouts report "|" instead of "\".
        keybinding: ['Mod-Shift-\\', 'Mod-Shift-|'],
        when: focused,
        run: () => panel?.split('column'),
      },
      {
        id: 'terminal.closePane',
        title: 'Close Terminal Pane',
        category,
        keybinding: 'Mod-w',
        when: focused,
        run: () => panel?.closePane(),
      },
      {
        id: 'terminal.focusNextPane',
        title: 'Focus Next Terminal Pane',
        category,
        keybinding: 'Mod-Alt-ArrowRight',
        when: focused,
        run: () => panel?.focusNeighbour(1),
      },
      {
        id: 'terminal.focusPrevPane',
        title: 'Focus Previous Terminal Pane',
        category,
        keybinding: 'Mod-Alt-ArrowLeft',
        when: focused,
        run: () => panel?.focusNeighbour(-1),
      },
      {
        id: 'terminal.clear',
        title: 'Clear Terminal',
        category,
        keybinding: 'Mod-k',
        when: focused,
        run: () => panel?.clear(),
      },
    ]),
  ];

  // Rule 5 of DESIGN 8.1: closing the workspace tab stops every shell of this workbench.
  // (Hidden workbenches keep their terminals running.)
  ctx.bus.on('workbench:disposing', () => {
    subs.forEach((s) => s.dispose());
    panel?.dispose();
    panel = null;
  });
}

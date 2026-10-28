// Command palette: all visible commands, recently used first.

import type { AppContext, Command, QuickPickHandle, QuickPickItem } from '../core/types';

const RECENT_KEY = 'shell.recentCommands';
const RECENT_MAX = 30;

function bindingOf(cmd: Command): string | undefined {
  return Array.isArray(cmd.keybinding) ? cmd.keybinding[0] : cmd.keybinding;
}

export function createPalette(ctx: AppContext, openPick: (opts: Parameters<AppContext['ui']['quickPick']>[0]) => QuickPickHandle) {
  let current: QuickPickHandle | null = null;

  function recent(): string[] {
    return ctx.workspace?.globalState.get<string[]>(RECENT_KEY) ?? [];
  }

  function remember(id: string) {
    const next = [id, ...recent().filter((x) => x !== id)].slice(0, RECENT_MAX);
    ctx.workspace?.globalState.set(RECENT_KEY, next);
  }

  function buildItems(): QuickPickItem[] {
    const recents = recent();
    const rank = new Map(recents.map((id, i) => [id, i]));
    const cmds = ctx.commands.list().filter((c) => {
      if (c.hidden) return false;
      try {
        return !c.when || c.when();
      } catch {
        return false;
      }
    });
    cmds.sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra !== undefined || rb !== undefined) return (ra ?? Infinity) - (rb ?? Infinity);
      return a.title.localeCompare(b.title);
    });
    return cmds.map((c) => {
      const binding = bindingOf(c);
      return {
        id: c.id,
        label: c.category ? `${c.category}: ${c.title}` : c.title,
        hint: binding ? ctx.commands.keyLabel(binding) : undefined,
      };
    });
  }

  return {
    toggle() {
      if (current) {
        current.close();
        current = null;
        return;
      }
      const handle = openPick({
        placeholder: 'Type a command',
        items: buildItems(),
        emptyText: 'No matching commands',
        onAccept: (item) => {
          current = null;
          remember(item.id);
          ctx.commands.execute(item.id).catch((err) => {
            console.error(`command ${item.id} failed`, err);
            ctx.ui.notify(`Command failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
          });
        },
        onCancel: () => {
          current = null;
        },
      });
      current = handle;
    },
  };
}

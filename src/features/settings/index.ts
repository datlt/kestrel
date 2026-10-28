import type { AppContext, TabInput } from '../../core/types';

const TAB_ID = 'settings:ui';

/** Registers the Settings screen (tab kind `settings`) and the `settings.open` command. */
export function initSettingsUi(ctx: AppContext): void {
  const input = (): TabInput => ({
    id: TAB_ID,
    kind: 'settings',
    title: 'Settings',
    tooltip: 'Settings',
    async create(host) {
      // Load the screen code only when the tab is shown for the first time.
      const { createSettingsScreen } = await import('./screen');
      return createSettingsScreen(ctx, host);
    },
    serialize: () => ({}),
  });

  ctx.tabs.registerKind('settings', () => input());
  ctx.commands.register({
    id: 'settings.open',
    title: 'Settings',
    category: 'Preferences',
    keybinding: 'Mod-,',
    run: () => {
      ctx.tabs.open(input());
    },
  });
}

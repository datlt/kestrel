// Theme: sets `data-theme` on <html> from the setting `theme`.

import type { AppContext } from '../core/types';

type Resolved = 'light' | 'dark';

export function createTheme(ctx: Pick<AppContext, 'bus' | 'settings'>) {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  let resolved: Resolved | null = null;

  function setting(): 'system' | 'light' | 'dark' {
    try {
      const t = ctx.settings.get('theme');
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch {
      return 'system';
    }
  }

  function resolve(): Resolved {
    const t = setting();
    if (t === 'system') return query.matches ? 'dark' : 'light';
    return t;
  }

  /** Applies the theme. Sends `theme:changed` when it changed (or when `force` is set). */
  function apply(force = false) {
    const next = resolve();
    document.documentElement.dataset.theme = next;
    if (next !== resolved || force) {
      resolved = next;
      ctx.bus.emit('theme:changed', { theme: next });
    }
  }

  const onSystemChange = () => {
    if (setting() === 'system') apply();
  };
  query.addEventListener('change', onSystemChange);
  const sub = ctx.bus.on('settings:changed', (e) => {
    if (e.settings.theme !== e.previous.theme) apply();
  });

  return {
    dispose() {
      query.removeEventListener('change', onSystemChange);
      sub.dispose();
    },
    apply,
    current: (): Resolved => resolved ?? resolve(),
    toggle() {
      const next: Resolved = (resolved ?? resolve()) === 'dark' ? 'light' : 'dark';
      return ctx.settings.update({ theme: next });
    },
  };
}

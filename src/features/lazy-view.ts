// Loads a sidebar or panel view with `import()` the first time it is shown.
// The shell calls `create` at once and expects a ViewInstance. This returns a
// small stand-in. It passes `onShow`, `onHide`, `focus` and `dispose` to the
// real view as soon as that view is loaded.

import type { ViewInstance } from '../core/types';

export function lazyView(host: HTMLElement, load: () => Promise<ViewInstance>): ViewInstance {
  let real: ViewInstance | null = null;
  let disposed = false;
  let shown = false;
  let wantFocus = false;

  load().then(
    (view) => {
      if (disposed) {
        view.dispose?.();
        return;
      }
      real = view;
      if (shown) view.onShow?.();
      if (wantFocus) view.focus?.();
    },
    (err) => {
      console.error('view failed to load', err);
      if (!disposed) host.textContent = `This view could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
    },
  );

  return {
    onShow() {
      shown = true;
      real?.onShow?.();
    },
    onHide() {
      shown = false;
      real?.onHide?.();
    },
    focus() {
      wantFocus = true;
      real?.focus?.();
    },
    dispose() {
      disposed = true;
      real?.dispose?.();
      real = null;
    },
  };
}

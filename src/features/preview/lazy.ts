// Preview renderers load with `import()` the first time a preview opens.
// `create` has to return a PreviewInstance at once. This returns a stand-in that
// remembers the latest text, scroll line and zoom steps. It hands them to the
// real preview when that preview is loaded.

import type { AppContext, FileEditor, PreviewInstance, PreviewProvider, ViewMode } from '../../core/types';

type Factory = (host: HTMLElement, editor: FileEditor) => PreviewInstance;

export function lazyPreview(ctx: AppContext, host: HTMLElement, editor: FileEditor, load: () => Promise<Factory>): PreviewInstance {
  let real: PreviewInstance | null = null;
  let disposed = false;
  let text: string | null = null;
  let line: number | null = null;
  const zoomSteps: (1 | -1 | 0)[] = [];

  load().then(
    (factory) => {
      if (disposed) return;
      try {
        real = factory(host, editor);
      } catch (e) {
        ctx.ui.notify(`Preview failed: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
        return;
      }
      if (text !== null) real.update(text);
      if (line !== null) real.revealLine?.(line);
      for (const step of zoomSteps) real.zoom?.(step);
      zoomSteps.length = 0;
    },
    (e) => {
      if (!disposed) ctx.ui.notify(`Preview failed to load: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
    },
  );

  return {
    update(next) {
      text = next;
      real?.update(next);
    },
    revealLine(next) {
      line = next;
      real?.revealLine?.(next);
    },
    zoom(step) {
      if (real) real.zoom?.(step);
      else zoomSteps.push(step);
    },
    dispose() {
      disposed = true;
      real?.dispose();
      real = null;
    },
  };
}

export function lazyProvider(
  ctx: AppContext,
  id: string,
  matches: PreviewProvider['matches'],
  defaultMode: (path: string) => ViewMode,
  load: () => Promise<Factory>,
): PreviewProvider {
  return { id, matches, defaultMode, create: (host, editor) => lazyPreview(ctx, host, editor, load) };
}

// Image tabs (tab kind `image`) and the file opener for raster images.
// This small file stays in the main bundle. The viewer itself (`image.ts` and
// `image-view.ts`) loads with `import()` when an image tab is created.

import type { AppContext, FileOpener, TabInput } from '../../core/types';
import { basename, extname } from '../../core/util';

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif'];

function imageTabInput(ctx: AppContext, path: string): TabInput {
  const id = `image:${path}`;
  return {
    id,
    kind: 'image',
    title: basename(path),
    tooltip: path,
    serialize: () => ({ path }),
    async create(host) {
      const { createImageContent } = await import('./image');
      return createImageContent(ctx, host, id, path);
    },
  };
}

export function registerImageViewer(ctx: AppContext): void {
  ctx.tabs.registerKind('image', (data) => {
    const path = (data as { path?: unknown } | null)?.path;
    return typeof path === 'string' && path ? imageTabInput(ctx, path) : null;
  });
  const opener: FileOpener = {
    id: 'preview.image',
    priority: 100,
    matches: (path) => IMAGE_EXTENSIONS.includes(extname(path)),
    async open(path, opts) {
      ctx.tabs.open(imageTabInput(ctx, path), { preview: opts.preview, activate: opts.activate });
      return true;
    },
  };
  ctx.editors.registerOpener(opener);
}

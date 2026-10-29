// Preview feature: markdown, HTML, SVG and CSV previews, and the image viewer.
// Rust side: crates/kestrel-markdown and src-tauri/src/cmd/preview.rs.
//
// The renderers load with `import()` when the first preview opens, so they are
// not part of the startup code. Only the file name rules stay here.

import type { AppContext } from '../../core/types';
import { registerImageViewer } from './image-tab';
import { lazyProvider } from './lazy';

const CSV_FILE = /\.(csv|tsv|tab|psv)$/i;

export function initPreview(ctx: AppContext): void {
  ctx.editors.registerPreview(
    lazyProvider(
      ctx,
      'preview.markdown',
      (path, languageId) => /\.(md|markdown)$/i.test(path) || languageId === 'markdown',
      () => ctx.settings.get('preview.markdownMode'),
      async () => {
        const { createMarkdownPreview } = await import('./markdown');
        return (host, editor) => createMarkdownPreview(ctx, host, editor);
      },
    ),
  );
  ctx.editors.registerPreview(
    lazyProvider(
      ctx,
      'preview.html',
      (path, languageId) => /\.(html?|xhtml)$/i.test(path) || (languageId === 'html' && !path.startsWith('untitled:')),
      () => ctx.settings.get('preview.htmlMode'),
      async () => {
        const { createHtmlPreview } = await import('./html');
        return (host, editor) => createHtmlPreview(ctx, host, editor);
      },
    ),
  );
  ctx.editors.registerPreview(
    lazyProvider(
      ctx,
      'preview.svg',
      (path) => /\.svg$/i.test(path),
      () => 'code',
      async () => {
        const { createSvgPreview } = await import('./svg');
        return (host) => createSvgPreview(host);
      },
    ),
  );
  // The CSV table and the column colors also work for large files (they only
  // draw what is on screen), so both say `largeFiles`.
  ctx.editors.registerPreview({
    ...lazyProvider(
      ctx,
      'preview.csv',
      (path) => CSV_FILE.test(path),
      () => ctx.settings.get('preview.csvMode'),
      async () => {
        const { createCsvPreview } = await import('./csv');
        return (host, editor) => createCsvPreview(ctx, host, editor);
      },
    ),
    largeFiles: true,
  });
  // Column colors in the code view. The module loads only for CSV files.
  ctx.editors.registerExtension(
    (editor) => {
      if (!CSV_FILE.test(editor.path)) return null;
      return import('./csv-colors').then((m) => m.csvColorExtension(editor));
    },
    { largeFiles: true },
  );
  registerImageViewer(ctx);
  ctx.commands.registerMany([
    {
      id: 'preview.find',
      title: 'Find in Preview',
      category: 'View',
      keybinding: 'Mod-f',
      run: () => void ctx.tabs.active()?.content?.find?.(),
    },
    {
      id: 'preview.toggleCodeWrap',
      title: 'Toggle Line Wrap in Markdown Code Blocks',
      category: 'View',
      run: () => ctx.settings.update({ 'preview.markdownCodeWrap': !ctx.settings.get('preview.markdownCodeWrap') }),
    },
  ]);
}

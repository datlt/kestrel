// Rules for large files (`FileMeta.large`). A large file opens in plain mode. A
// preview or an extension provider only runs there when it said `largeFiles`.
// Pure functions, so they are easy to test.

import type { EditorExtensionProvider, ExtensionOptions, PreviewProvider } from '../core/types';

/** The first preview that matches. Large files only use previews with `largeFiles`. */
export function pickPreview(previews: readonly PreviewProvider[], path: string, languageId: string, large: boolean): PreviewProvider | null {
  return previews.find((p) => (!large || p.largeFiles === true) && p.matches(path, languageId)) ?? null;
}

/** Extension providers that may run for a file. Large files only get the ones with `largeFiles`. */
export function pickProviders(
  providers: readonly EditorExtensionProvider[],
  options: ReadonlyMap<EditorExtensionProvider, ExtensionOptions>,
  large: boolean,
): EditorExtensionProvider[] {
  return large ? providers.filter((p) => options.get(p)?.largeFiles === true) : [...providers];
}

/** Text of the info message when a large file opens. */
export function largeFileNotice(name: string, preview: PreviewProvider | null): string {
  const base = `${name} is a large file. It opens in plain mode`;
  if (!preview) return `${base}: no syntax colors and no language features.`;
  if (preview.id === 'preview.csv') {
    return `${base}: no language features. The table preview and the column colors still work.`;
  }
  return `${base}: no syntax colors and no language features. The preview still works.`;
}

/**
 * Wait time (ms) after an edit before the editor sends the whole text to the
 * preview. Making the text is a copy of the whole document, and the preview then
 * parses it. A big text waits longer, so typing stays fast.
 */
export function pushDelay(docLength: number): number {
  const base = 150;
  if (docLength <= 1_000_000) return base;
  return base + Math.min(1200, Math.round(docLength / 40_000));
}

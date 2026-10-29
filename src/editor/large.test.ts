import { describe, expect, it } from 'vitest';
import type { EditorExtensionProvider, ExtensionOptions, PreviewProvider } from '../core/types';
import { largeFileNotice, pickPreview, pickProviders, pushDelay } from './large';

function preview(id: string, ext: string, largeFiles?: boolean): PreviewProvider {
  return {
    id,
    matches: (path) => path.endsWith(ext),
    defaultMode: () => 'preview',
    create: () => ({ update() {}, dispose() {} }),
    largeFiles,
  };
}

describe('pickPreview', () => {
  const md = preview('md', '.md');
  const csv = preview('csv', '.csv', true);
  const off = preview('off', '.txt', false);
  const all = [md, csv, off];

  it('uses every matching preview for normal files', () => {
    expect(pickPreview(all, 'a.md', 'markdown', false)).toBe(md);
    expect(pickPreview(all, 'a.csv', 'plaintext', false)).toBe(csv);
    expect(pickPreview(all, 'a.txt', 'plaintext', false)).toBe(off);
  });

  it('uses only previews with largeFiles for large files', () => {
    expect(pickPreview(all, 'a.csv', 'plaintext', true)).toBe(csv);
    expect(pickPreview(all, 'a.md', 'markdown', true)).toBeNull();
    expect(pickPreview(all, 'a.txt', 'plaintext', true)).toBeNull();
  });

  it('skips a preview that does not allow large files and takes a later one', () => {
    const first = preview('first', '.csv');
    expect(pickPreview([first, csv], 'a.csv', 'plaintext', true)).toBe(csv);
    expect(pickPreview([first, csv], 'a.csv', 'plaintext', false)).toBe(first);
  });
});

describe('pickProviders', () => {
  const a: EditorExtensionProvider = () => null;
  const b: EditorExtensionProvider = () => null;
  const c: EditorExtensionProvider = () => null;
  const options = new Map<EditorExtensionProvider, ExtensionOptions>([
    [b, { largeFiles: true }],
    [c, { largeFiles: false }],
  ]);

  it('returns all providers for normal files', () => {
    expect(pickProviders([a, b, c], options, false)).toEqual([a, b, c]);
  });

  it('returns only providers with largeFiles for large files', () => {
    expect(pickProviders([a, b, c], options, true)).toEqual([b]);
    expect(pickProviders([a, c], options, true)).toEqual([]);
  });
});

describe('largeFileNotice', () => {
  it('says plain mode for files without a preview', () => {
    expect(largeFileNotice('x.log', null)).toContain('no syntax colors and no language features');
  });
  it('says the table and the colors work for CSV', () => {
    const text = largeFileNotice('x.csv', preview('preview.csv', '.csv', true));
    expect(text).toContain('table preview and the column colors still work');
    expect(text).not.toContain('no syntax colors');
  });
});

describe('pushDelay', () => {
  it('keeps the normal wait for normal texts', () => {
    expect(pushDelay(0)).toBe(150);
    expect(pushDelay(1_000_000)).toBe(150);
  });
  it('waits longer for big texts, with a limit', () => {
    expect(pushDelay(32_000_000)).toBeGreaterThan(pushDelay(2_000_000));
    expect(pushDelay(500_000_000)).toBe(1350);
  });
});

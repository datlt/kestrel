import { describe, expect, it } from 'vitest';
import { pathFromPreviewUrl, previewDirUrl, previewUrl } from '../../ipc/preview';

describe('previewUrl', () => {
  it('builds macOS and Linux urls', () => {
    expect(previewUrl('/Users/me/My Docs/a.png', false)).toBe('preview://localhost/Users/me/My%20Docs/a.png');
  });

  it('encodes special characters in each segment', () => {
    expect(previewUrl('/a/b#c/d?e/日本.md', false)).toBe('preview://localhost/a/b%23c/d%3Fe/%E6%97%A5%E6%9C%AC.md');
    expect(previewUrl('/a/100%/x', false)).toBe('preview://localhost/a/100%25/x');
  });

  it('builds Windows urls and keeps the drive letter', () => {
    expect(previewUrl('C:\\work\\my docs\\a.png', true)).toBe('http://preview.localhost/C:/work/my%20docs/a.png');
    expect(previewUrl('C:/work/a.png', true)).toBe('http://preview.localhost/C:/work/a.png');
  });

  it('builds folder urls with one trailing slash', () => {
    expect(previewDirUrl('/a/b', false)).toBe('preview://localhost/a/b/');
    expect(previewDirUrl('/a/b/', false)).toBe('preview://localhost/a/b/');
    expect(previewDirUrl('C:\\', true)).toBe('http://preview.localhost/C:/');
    expect(previewDirUrl('/', false)).toBe('preview://localhost/');
  });

  it('turns a url back into a path', () => {
    expect(pathFromPreviewUrl('preview://localhost/Users/me/My%20Docs/a.md#top')).toBe('/Users/me/My Docs/a.md');
    expect(pathFromPreviewUrl('http://preview.localhost/C:/work/a%20b.md')).toBe('C:\\work\\a b.md');
    expect(pathFromPreviewUrl('https://example.com/a.md')).toBeNull();
  });
});

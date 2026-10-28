import { describe, expect, it } from 'vitest';
import { externalLink, isAllowedImage } from './rendered-rules';

describe('isAllowedImage', () => {
  it('allows https on the same host', () => {
    expect(isAllowedImage('https://github.example.test/a/b.png', 'github.example.test')).toBe(true);
    expect(isAllowedImage('https://GitHub.Example.test/a.png', 'github.example.test')).toBe(true);
  });
  it('removes everything else', () => {
    expect(isAllowedImage('http://github.example.test/a.png', 'github.example.test')).toBe(false);
    expect(isAllowedImage('https://evil.test/a.png', 'github.example.test')).toBe(false);
    expect(isAllowedImage('https://github.example.test.evil.test/a.png', 'github.example.test')).toBe(false);
    expect(isAllowedImage('data:image/png;base64,AAAA', 'github.example.test')).toBe(false);
    expect(isAllowedImage('/a.png', 'github.example.test')).toBe(false);
    expect(isAllowedImage('', 'github.example.test')).toBe(false);
    expect(isAllowedImage(null, 'github.example.test')).toBe(false);
  });
});

describe('externalLink', () => {
  const base = 'https://github.example.test/acme/shop/pull/1';
  it('opens http and https', () => {
    expect(externalLink('https://example.com/x', base)).toBe('https://example.com/x');
    expect(externalLink('http://example.com/', base)).toBe('http://example.com/');
  });
  it('places relative links under the pull request address', () => {
    expect(externalLink('/acme/shop/issues/3', base)).toBe('https://github.example.test/acme/shop/issues/3');
  });
  it('ignores the rest', () => {
    for (const h of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '#section', '', null, undefined, 'mailto:a@b.c']) {
      expect(externalLink(h as any, base)).toBeNull();
    }
  });
});

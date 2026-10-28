import { describe, expect, it } from 'vitest';
import { buildHighlightCss, highlightToHtmlString, TOKEN_CLASSES } from './highlight';
import { kotlinLanguage } from './kotlin';
import { loadLanguageById, preloadFenceLanguages } from './languages';

describe('highlightToHtmlString', () => {
  it('wraps Kotlin tokens in tok-* spans and escapes text', () => {
    const html = highlightToHtmlString('fun f(a: Int) = "x<y"', kotlinLanguage);
    expect(html).toContain('<span class="tok-keyword">fun</span>');
    expect(html).toContain('<span class="tok-function-def">f</span>');
    expect(html).toContain('<span class="tok-type">Int</span>');
    expect(html).toContain('&lt;');
    expect(html).not.toContain('x<y');
  });

  it('keeps line breaks', () => {
    expect(highlightToHtmlString('a\nb', kotlinLanguage).split('\n').length).toBe(2);
  });

  it('escapes text without a language', () => {
    expect(highlightToHtmlString('<b>', null)).toBe('&lt;b&gt;');
  });

  it('highlights Swift', async () => {
    const swift = await loadLanguageById('swift');
    const html = highlightToHtmlString('struct Point { let x: Int = 1 } // note', swift);
    expect(html).toContain('<span class="tok-keyword">struct</span>');
    expect(html).toContain('<span class="tok-comment">// note</span>');
  });

  it('highlights lezer languages and code blocks in markdown', async () => {
    const js = await loadLanguageById('js');
    expect(highlightToHtmlString('const a = 1;', js)).toContain('<span class="tok-keyword">const</span>');
    const md = await loadLanguageById('markdown');
    const code = '# Title\n\n```kotlin\nval x = 1\n```\n';
    await preloadFenceLanguages(code);
    const html = highlightToHtmlString(code, md);
    expect(html).toContain('tok-heading');
    expect(html).toContain('<span class="tok-keyword">val</span>');
  });
});

describe('buildHighlightCss', () => {
  it('resolves colors through the reader', () => {
    const css = buildHighlightCss((v) => (v === '--tok-keyword' ? ' #123456 ' : ''));
    expect(css).toContain('.tok-keyword{color:#123456}');
    expect(css).toContain('.tok-strong{font-weight:bold}');
    expect(css).not.toContain('.tok-string');
  });
});

// The project has no Node types, so the import is untyped.
// @ts-ignore
const { readFileSync } = (await import('node:fs')) as { readFileSync(url: URL, enc: string): string };

describe('tokens.css', () => {
  const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
  const dark = css.slice(css.indexOf(":root[data-theme='dark']"), css.indexOf(":root[data-theme='light']"));
  const light = css.slice(css.indexOf(":root[data-theme='light']"), css.indexOf('.tok-comment {'));

  for (const c of TOKEN_CLASSES) {
    it(`${c.cls} has a class rule and colors for both themes`, () => {
      expect(css).toContain(`.${c.cls} {`);
      if (c.color !== false) {
        expect(dark).toContain(`--${c.cls}:`);
        expect(light).toContain(`--${c.cls}:`);
      }
    });
  }
});

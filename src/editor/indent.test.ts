import { describe, expect, it } from 'vitest';
import { detectIndentation } from './indent';

describe('detectIndentation', () => {
  it('finds 4 spaces in Kotlin code', () => {
    const code = [
      'class A {',
      '    fun f() {',
      '        if (x) {',
      '            g()',
      '        }',
      '    }',
      '}',
    ].join('\n');
    expect(detectIndentation(code)).toEqual({ insertSpaces: true, size: 4 });
  });

  it('finds 2 spaces', () => {
    const code = 'function f() {\n  if (x) {\n    g();\n  }\n  return 1;\n}\n';
    expect(detectIndentation(code)).toEqual({ insertSpaces: true, size: 2 });
  });

  it('finds tabs', () => {
    const code = 'func f() {\n\tif x {\n\t\tg()\n\t}\n}\n';
    expect(detectIndentation(code)).toEqual({ insertSpaces: false, size: null });
  });

  it('returns null when nothing is indented', () => {
    expect(detectIndentation('a\nb\nc\n')).toBeNull();
    expect(detectIndentation('')).toBeNull();
  });

  it('ignores javadoc continuation lines and blank lines', () => {
    const code = '/**\n * Text.\n * More.\n */\nclass A {\n\n    int x;\n\n    int y;\n}\n';
    expect(detectIndentation(code)).toEqual({ insertSpaces: true, size: 4 });
  });

  it('takes the style that most lines use', () => {
    const code = ['a:', '  b: 1', '  c: 2', '\td', '  e: 3'].join('\n');
    expect(detectIndentation(code)?.insertSpaces).toBe(true);
  });

  it('works with CRLF line endings', () => {
    const code = 'a {\r\n    b;\r\n    c {\r\n        d;\r\n    }\r\n}\r\n';
    expect(detectIndentation(code)).toEqual({ insertSpaces: true, size: 4 });
  });

  it('does not count 4-space code as 8 when it dedents two levels', () => {
    const code = 'a {\n    b {\n        c {\n            d;\n        }\n    }\n}\ne {\n    f;\n}\n';
    expect(detectIndentation(code)?.size).toBe(4);
  });
});

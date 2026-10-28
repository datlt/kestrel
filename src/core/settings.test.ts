import { describe, expect, it, vi } from 'vitest';

// settings.ts imports the Tauri wrappers. Replace them so Node can load the file.
vi.mock('../ipc/app', () => ({ appSettingsRead: vi.fn(), appSettingsWrite: vi.fn() }));

const { parseJsonc, DEFAULT_SETTINGS } = await import('./settings');

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a": 1, "b": [true, null]}')).toEqual({ a: 1, b: [true, null] });
  });

  it('skips line comments', () => {
    expect(parseJsonc('{\n // a comment\n "a": 1 // after\n}')).toEqual({ a: 1 });
  });

  it('skips block comments, also over many lines', () => {
    expect(parseJsonc('{ /* one */ "a": /* two\n lines */ 1 }')).toEqual({ a: 1 });
  });

  it('allows trailing commas in objects and arrays', () => {
    expect(parseJsonc('{"a": [1, 2, ], "b": {"c": 1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  it('keeps // and /* inside strings', () => {
    const text = '{"url": "http://example.com/a", "glob": "**/*.ts", "c": "/* not a comment */"}';
    expect(parseJsonc(text)).toEqual({
      url: 'http://example.com/a',
      glob: '**/*.ts',
      c: '/* not a comment */',
    });
  });

  it('handles escaped quotes inside strings', () => {
    expect(parseJsonc('{"a": "say \\"//hi\\"", // real comment\n "b": 2}')).toEqual({ a: 'say "//hi"', b: 2 });
  });

  // Real bug in parseJsonc: the final regex `,(\s*[}\]])` also runs inside strings.
  // Fix: remove the trailing comma in the main loop, only outside strings. See the report.
  it('does not touch a comma followed by a bracket inside a string', () => {
    expect(parseJsonc('{"a": "x,}"}')).toEqual({ a: 'x,}' });
  });

  it('accepts an unterminated block comment at the end', () => {
    expect(parseJsonc('{"a": 1} /* open')).toEqual({ a: 1 });
  });

  it('throws on broken JSON', () => {
    expect(() => parseJsonc('{"a": }')).toThrow();
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('has a command and languages for each LSP server', () => {
    for (const [id, cfg] of Object.entries(DEFAULT_SETTINGS['lsp.servers'])) {
      expect(cfg.command.length, id).toBeGreaterThan(0);
      expect(cfg.languages.length, id).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../core/settings';
import type { Settings } from '../../core/types';
import { SECTIONS, SETTING_DEFS, checkNumber, defFor, filterSettings, sameValue } from './schema';

describe('schema', () => {
  it('has an entry for every default key, once', () => {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      expect(defFor(key), key).toBeDefined();
    }
    const keys = SETTING_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key in DEFAULT_SETTINGS, key).toBe(true);
  });

  it('uses known sections', () => {
    const ids = new Set(SECTIONS.map((s) => s.id));
    for (const d of SETTING_DEFS) expect(ids.has(d.section), d.key).toBe(true);
  });

  it('has valid enum defaults', () => {
    for (const d of SETTING_DEFS.filter((x) => x.type === 'enum')) {
      expect(d.options?.length, d.key).toBeGreaterThan(1);
      const values = d.options!.map((o) => o.value);
      expect(values, d.key).toContain(DEFAULT_SETTINGS[d.key]);
    }
  });

  it('has defaults inside number limits', () => {
    for (const d of SETTING_DEFS.filter((x) => x.type === 'number')) {
      const r = checkNumber(String(DEFAULT_SETTINGS[d.key]), d);
      expect(r.ok, d.key).toBe(true);
    }
  });

  it('matches the type of the default value', () => {
    for (const d of SETTING_DEFS) {
      const v = DEFAULT_SETTINGS[d.key];
      if (d.type === 'boolean') expect(typeof v).toBe('boolean');
      if (d.type === 'number') expect(typeof v).toBe('number');
      if (d.type === 'text') expect(typeof v).toBe('string');
      if (d.type === 'stringList') expect(Array.isArray(v)).toBe(true);
    }
  });

  it('shows the delay only for the "afterDelay" mode', () => {
    const d = defFor('files.autoSaveDelayMs')!;
    const s = (mode: Settings['files.autoSave']) => ({ ...DEFAULT_SETTINGS, 'files.autoSave': mode });
    expect(d.visibleWhen!(s('afterDelay'))).toBe(true);
    expect(d.visibleWhen!(s('onFocusChange'))).toBe(false);
    expect(d.visibleWhen!(s('off'))).toBe(false);
  });
});

describe('filterSettings', () => {
  const items = SETTING_DEFS;
  const keysOf = (q: string) => filterSettings(items, q).map((d) => d.key);

  it('keeps all items for an empty query', () => {
    expect(keysOf('')).toHaveLength(items.length);
    expect(keysOf('   ')).toHaveLength(items.length);
  });

  it('matches the title', () => {
    expect(keysOf('auto save')).toContain('files.autoSave');
  });

  it('matches the key', () => {
    expect(keysOf('editor.tabsize')).toEqual(['editor.tabSize']);
  });

  it('matches the description', () => {
    expect(keysOf('sandbox')).toContain('preview.htmlScripts');
  });

  it('needs every word to match, in any order', () => {
    expect(keysOf('delay save')).toContain('files.autoSaveDelayMs');
    expect(keysOf('zzzz save')).toEqual([]);
  });
});

describe('checkNumber', () => {
  const def = { min: 1, max: 10, integer: true };
  it('accepts a value in range', () => {
    expect(checkNumber(' 4 ', def)).toEqual({ ok: true, value: 4 });
  });
  it('rejects bad input', () => {
    expect(checkNumber('', def).ok).toBe(false);
    expect(checkNumber('abc', def).ok).toBe(false);
    expect(checkNumber('2.5', def).ok).toBe(false);
    expect(checkNumber('0', def).ok).toBe(false);
    expect(checkNumber('11', def).ok).toBe(false);
  });
  it('allows decimals when not integer', () => {
    expect(checkNumber('1.5', { min: 1, max: 3 })).toEqual({ ok: true, value: 1.5 });
  });
});

describe('sameValue', () => {
  it('compares arrays and objects by content', () => {
    expect(sameValue(['a'], ['a'])).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  });
});

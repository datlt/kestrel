// The filter of the Classes and Symbols tabs: kinds, languages, hide test code.
// An empty list means "all". The filter is kept in `globalState`.

export const FILTER_KEY = 'goto.filter';

/** Languages that the Rust code index reads. */
export const INDEX_LANGS = ['kotlin', 'java', 'swift'] as const;
export type IndexLang = (typeof INDEX_LANGS)[number];

export const CLASS_KINDS = [
  'class',
  'interface',
  'enum',
  'record',
  'annotation',
  'object',
  'struct',
  'protocol',
  'actor',
  'typeAlias',
] as const;

export const SYMBOL_KINDS = ['method', 'constructor', 'field', 'property', 'enumCase', 'function', 'variable'] as const;

/** Languages in the filter menu: the three of the index, then the ones that language servers handle. */
export const FILTER_LANGS: { id: string; label: string }[] = [
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'java', label: 'Java' },
  { id: 'swift', label: 'Swift' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'rust', label: 'Rust' },
  { id: 'go', label: 'Go' },
  { id: 'other', label: 'Other' },
];

export interface GotoFilter {
  classKinds: string[];
  symbolKinds: string[];
  langs: string[];
  hideTests: boolean;
}

export function defaultFilter(): GotoFilter {
  return { classKinds: [], symbolKinds: [], langs: [], hideTests: false };
}

function strings(v: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(v)) return [];
  return allowed.filter((a) => v.includes(a));
}

/** Reads a value from `globalState`. A broken value gives the default filter. */
export function readFilter(raw: unknown): GotoFilter {
  if (!raw || typeof raw !== 'object') return defaultFilter();
  const r = raw as Record<string, unknown>;
  return {
    classKinds: strings(r.classKinds, CLASS_KINDS),
    symbolKinds: strings(r.symbolKinds, SYMBOL_KINDS),
    langs: strings(
      r.langs,
      FILTER_LANGS.map((l) => l.id),
    ),
    hideTests: r.hideTests === true,
  };
}

/** Adds the value to the list, or removes it when it is there. Returns a new list. */
export function toggleIn(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function isFilterActive(f: GotoFilter, tab: 'classes' | 'symbols'): boolean {
  const kinds = tab === 'classes' ? f.classKinds : f.symbolKinds;
  return kinds.length > 0 || f.langs.length > 0 || f.hideTests;
}

const isIndexLang = (l: string): l is IndexLang => (INDEX_LANGS as readonly string[]).includes(l);

/** Does a language pass the language filter? `lang` is the language of the row. */
export function langPasses(f: GotoFilter, lang: string): boolean {
  if (f.langs.length === 0) return true;
  if (f.langs.includes(lang)) return true;
  // "Other" covers every language that has no entry of its own.
  const known = FILTER_LANGS.some((l) => l.id === lang);
  return !known && f.langs.includes('other');
}

/** Should the Rust index run for this filter? */
export function indexAllowed(f: GotoFilter): boolean {
  return f.langs.length === 0 || f.langs.some(isIndexLang);
}

/** Should language servers add results for this filter? */
export function lspAllowed(f: GotoFilter): boolean {
  return f.langs.length === 0 || f.langs.some((l) => !isIndexLang(l));
}

/** The parts of a `FindRequest` that come from the filter. */
export function indexRequestOptions(f: GotoFilter): { excludeTests?: boolean; langs?: IndexLang[] } {
  const out: { excludeTests?: boolean; langs?: IndexLang[] } = {};
  if (f.hideTests) out.excludeTests = true;
  const langs = f.langs.filter(isIndexLang);
  if (langs.length) out.langs = langs;
  return out;
}

export interface Filterable {
  kind: string;
  lang: string;
  test: boolean;
}

export function passesFilter(f: GotoFilter, tab: 'classes' | 'symbols', row: Filterable): boolean {
  const kinds = tab === 'classes' ? f.classKinds : f.symbolKinds;
  if (kinds.length && !kinds.includes(row.kind)) return false;
  if (f.hideTests && row.test) return false;
  return langPasses(f, row.lang);
}

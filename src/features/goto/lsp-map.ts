// Maps language server results to the rows of the Classes and Symbols tabs.
// No DOM here.

/** Files that the Rust code index reads. Language servers add results for all other files. */
export function isIndexedPath(path: string): boolean {
  return /\.(kt|kts|java|swift)$/i.test(path);
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
};

/** The language name of a file for the badge and the filter. Unknown extensions give the extension. */
export function langOfPath(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!ext) return 'other';
  return LANG_BY_EXT[ext] ?? ext;
}

const BADGES: Record<string, string> = {
  kotlin: 'Kotlin',
  java: 'Java',
  swift: 'Swift',
  typescript: 'TS',
  javascript: 'JS',
  python: 'Py',
  rust: 'Rust',
  go: 'Go',
};

export function langBadge(lang: string): string {
  return BADGES[lang] ?? lang.toUpperCase().slice(0, 4);
}

/** Does the path look like test code? Used for results of language servers, which have no flag. */
export function isTestPath(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  if (/(^|\/)(test|tests|__tests__|spec|specs|androidTest|testFixtures)\//.test(p)) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  return /(\.(test|spec)\.[a-z]+$)|(_test\.[a-z]+$)|(^test_.*\.py$)|(?:Test|Tests|Spec)\.[a-z]+$/.test(base);
}

/** LSP `SymbolKind` of a class-like symbol to our type kind. Other kinds give null. */
export function lspClassKind(kind: number): string | null {
  switch (kind) {
    case 5:
      return 'class';
    case 11:
      return 'interface';
    case 10:
      return 'enum';
    case 23:
      return 'struct';
    default:
      return null;
  }
}

/** LSP `SymbolKind` of a member or function to our symbol kind. Other kinds give null. */
export function lspSymbolKind(kind: number): string | null {
  switch (kind) {
    case 6:
      return 'method';
    case 9:
      return 'constructor';
    case 8:
      return 'field';
    case 7:
      return 'property';
    case 22:
      return 'enumCase';
    case 12:
      return 'function';
    case 13:
    case 14:
      return 'variable';
    default:
      return null;
  }
}

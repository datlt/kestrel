// Language ids, file name detection and lazy loading of CodeMirror languages.
// This file stays small: every language package loads with `import()` when
// the first file of that language opens.

import { LanguageDescription, LanguageSupport, StreamLanguage, type Language, type StreamParser } from '@codemirror/language';

export interface LanguageInfo {
  id: string;
  label: string;
  /** Extra names for code fences and `loadLanguage` (`kt`, `py`, ...). */
  aliases: string[];
  /** File extensions without the dot, lower case. */
  extensions: string[];
  /** Exact file names, lower case. */
  filenames: string[];
}

export const LANGUAGES: LanguageInfo[] = [
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt', 'kts'], extensions: ['kt', 'kts'], filenames: [] },
  { id: 'java', label: 'Java', aliases: [], extensions: ['java'], filenames: [] },
  { id: 'javascript', label: 'JavaScript', aliases: ['js', 'node'], extensions: ['js', 'mjs', 'cjs'], filenames: [] },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts'], extensions: ['ts', 'mts', 'cts'], filenames: [] },
  { id: 'jsx', label: 'JavaScript JSX', aliases: [], extensions: ['jsx'], filenames: [] },
  { id: 'tsx', label: 'TypeScript JSX', aliases: [], extensions: ['tsx'], filenames: [] },
  { id: 'python', label: 'Python', aliases: ['py', 'python3'], extensions: ['py', 'pyi', 'pyw', 'gyp'], filenames: [] },
  { id: 'html', label: 'HTML', aliases: ['htm', 'xhtml'], extensions: ['html', 'htm', 'xhtml', 'vue'], filenames: [] },
  { id: 'css', label: 'CSS', aliases: ['scss', 'less'], extensions: ['css', 'scss', 'less', 'pcss'], filenames: [] },
  {
    id: 'sql',
    label: 'SQL',
    aliases: ['mysql', 'pgsql', 'postgresql', 'sqlite'],
    extensions: ['sql', 'mysql', 'pgsql', 'ddl', 'dml'],
    filenames: [],
  },
  {
    id: 'json',
    label: 'JSON',
    aliases: ['jsonc', 'json5'],
    extensions: ['json', 'jsonc', 'json5', 'webmanifest', 'geojson', 'har', 'ipynb'],
    filenames: ['.babelrc', '.eslintrc', '.prettierrc', '.swcrc'],
  },
  { id: 'markdown', label: 'Markdown', aliases: ['md', 'mdx'], extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx'], filenames: [] },
  {
    id: 'xml',
    label: 'XML',
    aliases: ['svg', 'xsd', 'xsl', 'plist'],
    extensions: [
      'xml', 'svg', 'xsd', 'xsl', 'xslt', 'plist', 'fxml', 'wsdl', 'rss', 'atom', 'csproj', 'vbproj', 'props',
      'targets', 'resx', 'xaml', 'axml', 'storyboard', 'xib',
    ],
    filenames: [],
  },
  { id: 'yaml', label: 'YAML', aliases: ['yml'], extensions: ['yml', 'yaml'], filenames: [] },
  { id: 'rust', label: 'Rust', aliases: ['rs'], extensions: ['rs'], filenames: [] },
  { id: 'go', label: 'Go', aliases: ['golang'], extensions: ['go'], filenames: [] },
  { id: 'swift', label: 'Swift', aliases: [], extensions: ['swift'], filenames: [] },
  {
    id: 'cpp',
    label: 'C/C++',
    aliases: ['c', 'c++', 'cc', 'cxx', 'h', 'hpp'],
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ino', 'cu'],
    filenames: [],
  },
  {
    id: 'shell',
    label: 'Shell Script',
    aliases: ['sh', 'bash', 'zsh', 'console'],
    extensions: ['sh', 'bash', 'zsh', 'ksh', 'fish', 'command', 'bats', 'mk'],
    filenames: [
      'makefile', 'gnumakefile', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', 'gradlew',
      '.gitignore', '.dockerignore',
    ],
  },
  { id: 'groovy', label: 'Groovy', aliases: ['gradle'], extensions: ['groovy', 'gradle', 'gvy', 'gy'], filenames: ['jenkinsfile'] },
  {
    id: 'properties',
    label: 'Properties',
    aliases: ['ini'],
    extensions: ['properties', 'ini', 'cfg', 'conf', 'env', 'prefs', 'desktop', 'service'],
    filenames: ['.env', '.editorconfig', '.gitconfig'],
  },
  { id: 'toml', label: 'TOML', aliases: [], extensions: ['toml'], filenames: ['cargo.lock', 'pipfile', 'poetry.lock'] },
  { id: 'dockerfile', label: 'Dockerfile', aliases: ['docker'], extensions: ['dockerfile'], filenames: ['dockerfile', 'containerfile'] },
  { id: 'diff', label: 'Diff', aliases: ['patch'], extensions: ['diff', 'patch'], filenames: [] },
  { id: 'plaintext', label: 'Plain Text', aliases: ['text', 'txt'], extensions: ['txt', 'log'], filenames: [] },
];

const byId = new Map<string, LanguageInfo>();
const byAlias = new Map<string, string>();
const byExt = new Map<string, string>();
const byFilename = new Map<string, string>();
for (const l of LANGUAGES) {
  byId.set(l.id, l);
  byAlias.set(l.id, l.id);
  for (const a of l.aliases) byAlias.set(a, l.id);
  for (const e of l.extensions) byExt.set(e, l.id);
  for (const f of l.filenames) byFilename.set(f, l.id);
}

export function languageLabel(id: string): string {
  return byId.get(id)?.label ?? id;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Language id for a file path. Returns `plaintext` when nothing matches. */
export function languageIdFor(path: string): string {
  const name = fileName(path).toLowerCase();
  const byName = byFilename.get(name);
  if (byName) return byName;
  if (name.startsWith('dockerfile.') || name.startsWith('containerfile.')) return 'dockerfile';
  if (name.startsWith('.env.')) return 'properties';
  const dot = name.lastIndexOf('.');
  if (dot >= 0) {
    const byExtension = byExt.get(name.slice(dot + 1));
    if (byExtension) return byExtension;
  }
  return 'plaintext';
}

/** Language id from an id, an alias (`kt`) or an extension. Returns null when unknown. */
export function resolveLanguageId(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return byAlias.get(key) ?? byExt.get(key) ?? null;
}

/** Language name from a markdown code fence info string, like `kotlin title="x"` or `{.js}`. */
export function fenceLanguage(info: string): string | null {
  const first = info.trim().split(/\s+/)[0] ?? '';
  const cleaned = first.replace(/^[{.]+/, '').replace(/[}]+$/, '').replace(/^language-/, '');
  return resolveLanguageId(cleaned);
}

// --- Loading ---------------------------------------------------------------

function legacy(parser: StreamParser<unknown>): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}

type Loader = (variant: string) => Promise<LanguageSupport>;

const loaders: Record<string, Loader> = {
  kotlin: async () => (await import('./kotlin')).kotlin(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  tsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
  python: async () => (await import('@codemirror/lang-python')).python(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  sql: async (variant) => {
    const m = await import('@codemirror/lang-sql');
    return m.sql({ dialect: variant === 'mysql' ? m.MySQL : m.StandardSQL });
  },
  json: async () => (await import('@codemirror/lang-json')).json(),
  markdown: async () => {
    const m = await import('@codemirror/lang-markdown');
    return m.markdown({ base: m.markdownLanguage, codeLanguages: codeLanguageFor });
  },
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  swift: async () => legacy((await import('@codemirror/legacy-modes/mode/swift')).swift),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  shell: async () => legacy((await import('@codemirror/legacy-modes/mode/shell')).shell),
  groovy: async () => legacy((await import('@codemirror/legacy-modes/mode/groovy')).groovy),
  properties: async () => legacy((await import('@codemirror/legacy-modes/mode/properties')).properties),
  toml: async () => legacy((await import('@codemirror/legacy-modes/mode/toml')).toml),
  dockerfile: async () => legacy((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
  diff: async () => legacy((await import('@codemirror/legacy-modes/mode/diff')).diff),
};

const cache = new Map<string, Promise<LanguageSupport | null>>();

/**
 * Loads the language for an id or alias. `path` picks the SQL dialect
 * (`.mysql` uses MySQL). Returns null for plain text and unknown names.
 * The result is cached, so calling it again is cheap.
 */
export function loadLanguageSupport(idOrAlias: string, path?: string): Promise<LanguageSupport | null> {
  const id = resolveLanguageId(idOrAlias);
  const loader = id ? loaders[id] : undefined;
  if (!id || !loader) return Promise.resolve(null);
  const variant = id === 'sql' && path && /\.mysql$/i.test(path) ? 'mysql' : '';
  const key = variant ? `${id}:${variant}` : id;
  let p = cache.get(key);
  if (!p) {
    p = loader(variant).catch((e) => {
      console.error(`could not load language ${id}`, e);
      cache.delete(key);
      return null;
    });
    cache.set(key, p);
  }
  return p;
}

export async function loadLanguageById(idOrAlias: string): Promise<Language | null> {
  return (await loadLanguageSupport(idOrAlias))?.language ?? null;
}

// --- Code blocks in markdown -------------------------------------------------

const descriptions = new Map<string, LanguageDescription>();

function descriptionFor(id: string): LanguageDescription {
  let d = descriptions.get(id);
  if (!d) {
    d = LanguageDescription.of({
      name: id,
      load: async () => {
        const support = await loadLanguageSupport(id);
        if (!support) throw new Error(`no language ${id}`);
        return support;
      },
    });
    descriptions.set(id, d);
  }
  return d;
}

/** Used by the markdown language to find the language of a code fence. */
export function codeLanguageFor(info: string): LanguageDescription | null {
  const id = fenceLanguage(info);
  return id && loaders[id] ? descriptionFor(id) : null;
}

/** Loads all languages used by code fences in `text`, so a sync parse can highlight them. */
export async function preloadFenceLanguages(text: string): Promise<void> {
  const ids = new Set<string>();
  const re = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*([^\s`]*)/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const id = fenceLanguage(m[1]);
    if (id && loaders[id]) ids.add(id);
  }
  await Promise.all([...ids].map((id) => descriptionFor(id).load().catch(() => null)));
}

/** A file extension (without the dot) that maps back to this language, or null. Used to name drafts. */
export function extensionForLanguage(id: string): string | null {
  const ext = byId.get(id)?.extensions[0] ?? null;
  return ext && byExt.get(ext) === id ? ext : null;
}

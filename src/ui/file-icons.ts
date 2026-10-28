// File and folder icons with a color per file type. Owner: icons agent.
//
// Two parts:
//  1. fileIconId(): a pure function. It maps a name to an icon id. No DOM.
//  2. fileIcon(): builds the SVG for an id. Each SVG is parsed once and
//     then copied with cloneNode(true), so it is cheap in long lists.
//
// Colors live in file-icons.css (CSS variables for both themes).

import './file-icons.css';

export interface FileIconOptions {
  isDir?: boolean;
  /** Folder is expanded. */
  open?: boolean;
}

// ---------------------------------------------------------------------------
// Name to id mapping
// ---------------------------------------------------------------------------

/** Whole file names (lower case) to ids. */
const NAMES: Record<string, string> = {
  'dockerfile': 'docker',
  'containerfile': 'docker',
  'docker-compose.yml': 'compose',
  'docker-compose.yaml': 'compose',
  'compose.yml': 'compose',
  'compose.yaml': 'compose',
  'makefile': 'make',
  'gnumakefile': 'make',
  'pom.xml': 'maven',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'settings.gradle': 'gradle',
  'settings.gradle.kts': 'gradle',
  'gradlew': 'gradle',
  'gradlew.bat': 'gradle',
  'gradle.properties': 'gradle',
  'package.json': 'npm',
  'package-lock.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'cargo.lock': 'lock',
  'gemfile.lock': 'lock',
  'poetry.lock': 'lock',
  'composer.lock': 'lock',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitkeep': 'git',
  '.editorconfig': 'editorconfig',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
  'copying': 'license',
  'jsconfig.json': 'tsconfig',
};

/** Extensions (lower case, no first dot, may contain dots) to ids. */
const EXTS: Record<string, string> = {};
function ext(id: string, list: string): void {
  for (const e of list.split(' ')) EXTS[e] = id;
}
ext('kotlin', 'kt kts');
ext('java', 'java');
ext('gradle', 'gradle gradle.kts');
ext('groovy', 'groovy gvy');
ext('scala', 'scala sc sbt');
ext('js', 'js mjs cjs');
ext('ts', 'ts mts cts');
ext('dts', 'd.ts d.mts d.cts');
ext('jsx', 'jsx');
ext('tsx', 'tsx');
ext('json', 'json jsonc json5 webmanifest');
ext('python', 'py pyw pyi');
ext('html', 'html htm xhtml');
ext('css', 'css');
ext('scss', 'scss sass');
ext('less', 'less');
ext('sql', 'sql');
ext('markdown', 'md markdown mdx');
ext('yaml', 'yml yaml');
ext('xml', 'xml xsd xsl xslt plist fxml iml');
ext('toml', 'toml');
ext('properties', 'properties ini cfg conf');
ext('env', 'env');
ext('shell', 'sh bash zsh fish bat cmd ps1');
ext('docker', 'dockerfile');
ext('rust', 'rs');
ext('go', 'go');
ext('c', 'c');
ext('cpp', 'cpp cc cxx c++');
ext('header', 'h hh hpp hxx');
ext('csharp', 'cs');
ext('swift', 'swift');
ext('php', 'php');
ext('ruby', 'rb gemspec rake');
ext('dart', 'dart');
ext('vue', 'vue');
ext('svelte', 'svelte');
ext('csv', 'csv');
ext('tsv', 'tsv');
ext('log', 'log');
ext('text', 'txt text rtf');
ext('image', 'png jpg jpeg gif webp ico bmp avif tif tiff');
ext('svg', 'svg');
ext('font', 'ttf otf woff woff2 eot');
ext('pdf', 'pdf');
ext('archive', 'zip tar gz tgz bz2 xz 7z rar jar war ear');
ext('lock', 'lock');
ext('binary', 'exe dll so dylib bin class o a wasm dat');

/** Test file patterns that need the whole name. Case matters for "Test". */
const TEST_NAME = /(?:Tests?|Spec|IT)\.(?:kt|java|scala|groovy)$|^test_.+\.py$|_test\.(?:py|go|rs)$/;

/** Folder names (lower case) to the id of the closed folder. */
const FOLDERS: Record<string, string> = {
  'src': 'folder-src',
  'main': 'folder-main',
  'test': 'folder-test',
  'tests': 'folder-test',
  '__tests__': 'folder-test',
  'java': 'folder-java',
  'kotlin': 'folder-kotlin',
  'resources': 'folder-resources',
  'docs': 'folder-docs',
  'doc': 'folder-docs',
  'scripts': 'folder-scripts',
  'config': 'folder-config',
  'assets': 'folder-assets',
  'images': 'folder-assets',
  'lib': 'folder-lib',
  'public': 'folder-public',
  '.github': 'folder-github',
  '.git': 'folder-git',
  '.idea': 'folder-idea',
  '.vscode': 'folder-vscode',
  'node_modules': 'folder-node-modules',
  'build': 'folder-build',
  'dist': 'folder-build',
  'out': 'folder-build',
  'target': 'folder-build',
};

/** Maps a file or folder name (not a path) to an icon id. Pure, no DOM. */
export function fileIconId(name: string, isDir: boolean, open = false): string {
  const lower = name.toLowerCase();
  if (isDir) {
    const id = FOLDERS[lower] ?? 'folder';
    return open ? `${id}-open` : id;
  }
  const byName = NAMES[lower];
  if (byName) return byName;
  if (lower.startsWith('readme')) return 'readme';
  if (lower.startsWith('license') || lower.startsWith('licence')) return 'license';
  if (lower === '.env' || lower.startsWith('.env.')) return 'env';
  if (/^tsconfig(\..+)?\.json$/.test(lower)) return 'tsconfig';
  if (/^docker-compose\..+\.ya?ml$/.test(lower)) return 'compose';
  if (lower.startsWith('dockerfile.')) return 'docker';
  if (/\.(?:test|spec)\.[^.]+$/.test(lower) || TEST_NAME.test(name)) return 'test';
  // Try the longest extension first: "a.test.ts" tries "test.ts", then "ts".
  let dot = lower.indexOf('.');
  while (dot !== -1) {
    const id = EXTS[lower.slice(dot + 1)];
    if (id) return id;
    dot = lower.indexOf('.', dot + 1);
  }
  return 'file';
}

// ---------------------------------------------------------------------------
// SVG drawing
// ---------------------------------------------------------------------------

type Def = [color: string, shape: string];

// Shapes: a string is the label of a rounded badge. "!name" is a glyph
// drawn inside a badge. "#page" and "#text" are page outlines.
const BADGES: Record<string, Def> = {
  kotlin: ['purple', 'Kt'],
  java: ['orange', 'Jv'],
  gradle: ['teal', 'Gr'],
  groovy: ['cyan', 'Gy'],
  maven: ['red', 'Mv'],
  scala: ['red', 'Sc'],
  js: ['yellow', 'JS'],
  ts: ['blue', 'TS'],
  dts: ['indigo', 'dT'],
  jsx: ['cyan', 'Jx'],
  tsx: ['cyan', 'Tx'],
  test: ['green', '!check'],
  json: ['amber', '{}'],
  npm: ['red', 'Np'],
  tsconfig: ['blue', 'Tc'],
  python: ['blue', 'Py'],
  html: ['orange', '<>'],
  css: ['blue', '#'],
  scss: ['pink', 'Sa'],
  less: ['indigo', 'Le'],
  sql: ['amber', 'Sq'],
  markdown: ['slate', 'Md'],
  readme: ['cyan', 'Rd'],
  yaml: ['pink', 'Ym'],
  xml: ['orange', 'Xm'],
  toml: ['brown', 'To'],
  properties: ['gray', 'Pr'],
  env: ['lime', 'En'],
  shell: ['green', '>_'],
  docker: ['blue', 'Dk'],
  compose: ['cyan', 'Dc'],
  make: ['brown', 'Mk'],
  rust: ['brown', 'Rs'],
  go: ['cyan', 'Go'],
  c: ['indigo', 'C'],
  cpp: ['indigo', 'C+'],
  header: ['purple', 'H'],
  csharp: ['green', 'C#'],
  swift: ['orange', 'Sw'],
  php: ['indigo', 'Ph'],
  ruby: ['red', 'Rb'],
  dart: ['teal', 'Da'],
  vue: ['green', 'Vu'],
  svelte: ['orange', 'Sv'],
  csv: ['lime', 'Cv'],
  tsv: ['teal', 'Tv'],
  log: ['gray', 'Lg'],
  text: ['gray', '#text'],
  image: ['purple', '!image'],
  svg: ['amber', 'Sg'],
  font: ['pink', 'Aa'],
  pdf: ['red', 'Pd'],
  archive: ['brown', 'Zp'],
  lock: ['gray', '!lock'],
  git: ['orange', '!git'],
  editorconfig: ['gray', 'Ec'],
  license: ['amber', '©'],
  binary: ['slate', '01'],
  file: ['gray', '#page'],
};

// Folder colors. A name ending in "!" is drawn dimmed.
const FOLDER_COLORS: Record<string, string> = {
  'folder': 'folder',
  'folder-src': 'blue',
  'folder-main': 'indigo',
  'folder-test': 'green',
  'folder-java': 'orange',
  'folder-kotlin': 'purple',
  'folder-resources': 'amber',
  'folder-docs': 'cyan',
  'folder-scripts': 'teal',
  'folder-config': 'gray',
  'folder-assets': 'pink',
  'folder-lib': 'brown',
  'folder-public': 'lime',
  'folder-github': 'slate',
  'folder-git': 'red',
  'folder-idea': 'purple',
  'folder-vscode': 'blue',
  'folder-node-modules': 'green!',
  'folder-build': 'gray!',
};

const GLYPHS: Record<string, string> = {
  check: '<path class="g" d="M4.5 8.3l2.3 2.3 4.7-4.9"/>',
  image: '<circle class="k" cx="5.8" cy="5.8" r="1.2"/><path class="k" d="M3 12l3.2-3.4 2 2 2.2-3L13 12z"/>',
  lock: '<rect class="k" x="4.8" y="7.5" width="6.4" height="4.6" rx="1"/><path class="g" style="stroke-width:1.3" d="M6.2 7.5V6a1.8 1.8 0 0 1 3.6 0v1.5"/>',
  git: '<circle class="g" style="stroke-width:1.2" cx="5.5" cy="4.8" r="1.3"/><circle class="g" style="stroke-width:1.2" cx="5.5" cy="11.2" r="1.3"/><circle class="g" style="stroke-width:1.2" cx="10.5" cy="7" r="1.3"/><path class="g" style="stroke-width:1.2" d="M5.5 6.1v3.8M10.5 8.3c0 1.5-2.5 1.4-4.2 2.2"/>',
};

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function svgOf(id: string, inner: string, color: string): string {
  const dim = color.endsWith('!');
  const c = dim ? color.slice(0, -1) : color;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" class="file-icon file-icon-${id} fi-${c}${dim ? ' fi-dim' : ''}" aria-hidden="true" focusable="false">${inner}</svg>`;
}

function buildFile(id: string): string {
  const [color, shape] = BADGES[id] ?? BADGES.file;
  if (shape[0] === '#' && shape.length > 1) {
    const lines = shape === '#text' ? '<path class="s" d="M5.5 8h5M5.5 10.5h5"/>' : '';
    return svgOf(id, `<path class="s" d="M3.5 1.5h6l3 3v10h-9z"/><path class="s" d="M9.5 1.5v3h3"/>${lines}`, color);
  }
  const inner = shape[0] === '!'
    ? GLYPHS[shape.slice(1)]
    : `<text class="k" x="8" y="${(8 + (shape.length === 1 ? 10 : 8) * 0.36).toFixed(1)}" font-size="${shape.length === 1 ? 10 : 8}">${esc(shape)}</text>`;
  return svgOf(id, `<rect class="b" x="1" y="1" width="14" height="14" rx="3.2"/>${inner}`, color);
}

function buildFolder(id: string, open: boolean): string {
  const color = FOLDER_COLORS[id] ?? 'folder';
  const body = open
    ? '<path class="b" style="opacity:.55" d="M1.5 3.5a1 1 0 0 1 1-1h3.2l1.5 1.5h5.3a1 1 0 0 1 1 1V6h-12z"/><path class="b" d="M3 6.5h12.2a.6.6 0 0 1 .58.76l-1.4 5.6a1 1 0 0 1-.97.74H2.5a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1z"/>'
    : '<path class="b" style="opacity:.55" d="M1.5 3.5a1 1 0 0 1 1-1h3.2l1.5 1.5h6.3a1 1 0 0 1 1 1V6h-13z"/><path class="b" d="M1.5 5.5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>';
  return svgOf(open ? `${id}-open` : id, body, color);
}

/** Every icon id, in a stable order. Used by the preview page and tests. */
export function allIconIds(): string[] {
  const ids = Object.keys(BADGES);
  for (const f of Object.keys(FOLDER_COLORS)) ids.push(f, `${f}-open`);
  return ids;
}

const cache = new Map<string, Element>();

/** Returns a new 16px icon element for an icon id (see fileIconId). */
export function fileIconById(id: string): Element {
  let proto = cache.get(id);
  if (!proto) {
    let svg: string;
    if (id.startsWith('folder')) {
      const open = id.endsWith('-open');
      svg = buildFolder(open ? id.slice(0, -5) : id, open);
    } else {
      svg = buildFile(id);
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = svg;
    proto = tpl.content.firstElementChild as Element;
    cache.set(id, proto);
  }
  return proto.cloneNode(true) as Element;
}

/**
 * Returns a new 16px icon element for a file or folder name (not a path).
 * Safe to call for every visible row of a virtualized list.
 */
export function fileIcon(name: string, opts: FileIconOptions = {}): Element {
  return fileIconById(fileIconId(name, !!opts.isDir, !!opts.open));
}

// Description of every setting that the Settings screen shows.
// This file has no DOM code, so tests can import it.
import type { Settings } from '../../core/types';

export type SectionId =
  | 'appearance'
  | 'editor'
  | 'files'
  | 'explorer'
  | 'preview'
  | 'git'
  | 'lsp'
  | 'search'
  | 'database'
  | 'other';

export interface SectionDef {
  id: SectionId;
  title: string;
}

/** Sections in the order of the left list. "Other" is added by the screen when needed. */
export const SECTIONS: readonly SectionDef[] = [
  { id: 'appearance', title: 'Appearance' },
  { id: 'editor', title: 'Editor' },
  { id: 'files', title: 'Files' },
  { id: 'explorer', title: 'Explorer' },
  { id: 'preview', title: 'Preview' },
  { id: 'git', title: 'Git' },
  { id: 'lsp', title: 'Language Servers' },
  { id: 'search', title: 'Search' },
  { id: 'database', title: 'Database' },
];

export const OTHER_SECTION: SectionDef = { id: 'other', title: 'Other' };

export interface EnumOption {
  value: string;
  label: string;
}

export type SettingType = 'boolean' | 'enum' | 'number' | 'text' | 'stringList' | 'lspServers' | 'dbConnections';

export interface SettingDef {
  key: keyof Settings;
  title: string;
  description: string;
  section: SectionId;
  type: SettingType;
  /** For `enum`. The first option that equals the default is not marked; labels carry "(default)" when useful. */
  options?: EnumOption[];
  /** For `number`. */
  min?: number;
  max?: number;
  step?: number;
  /** For `number`: only whole numbers are valid. */
  integer?: boolean;
  /** Unit text after a number input, for example `MB`. */
  unit?: string;
  /** For `text` and `stringList`. */
  placeholder?: string;
  /** Short extra note under the description. */
  note?: string;
  /** When it returns false, the row is hidden. */
  visibleWhen?: (s: Readonly<Settings>) => boolean;
}

const viewModes: EnumOption[] = [
  { value: 'code', label: 'Code' },
  { value: 'split', label: 'Split' },
  { value: 'preview', label: 'Preview' },
];

export const SETTING_DEFS: readonly SettingDef[] = [
  // Appearance
  {
    key: 'theme',
    title: 'Theme',
    description: 'Color theme of the app. "System" follows the theme of your operating system.',
    section: 'appearance',
    type: 'enum',
    options: [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
  },
  {
    key: 'ui.zoom',
    title: 'Window Zoom',
    description: 'Zoom of the whole window. 1 means 100%.',
    section: 'appearance',
    type: 'number',
    min: 0.5,
    max: 3,
    step: 0.1,
  },

  // Editor
  {
    key: 'editor.fontFamily',
    title: 'Font Family',
    description: 'Font of the editor. Separate several fonts with commas, like in CSS.',
    section: 'editor',
    type: 'text',
    placeholder: 'Menlo, monospace',
  },
  {
    key: 'editor.fontSize',
    title: 'Font Size',
    description: 'Size of the editor text in pixels.',
    section: 'editor',
    type: 'number',
    min: 8,
    max: 40,
    step: 1,
    unit: 'px',
  },
  {
    key: 'editor.lineHeight',
    title: 'Line Height',
    description: 'Height of a line as a multiple of the font size.',
    section: 'editor',
    type: 'number',
    min: 1,
    max: 3,
    step: 0.1,
  },
  {
    key: 'editor.tabSize',
    title: 'Tab Size',
    description: 'Number of spaces that one tab or one indent step uses.',
    section: 'editor',
    type: 'number',
    min: 1,
    max: 16,
    step: 1,
    integer: true,
  },
  {
    key: 'editor.insertSpaces',
    title: 'Insert Spaces',
    description: 'Press Tab to insert spaces instead of a tab character.',
    section: 'editor',
    type: 'boolean',
  },
  {
    key: 'editor.detectIndentation',
    title: 'Detect Indentation',
    description: 'Read tabs or spaces and the indent size from the content of each file.',
    section: 'editor',
    type: 'boolean',
  },
  {
    key: 'editor.wordWrap',
    title: 'Word Wrap',
    description: 'Wrap long lines at the edge of the editor.',
    section: 'editor',
    type: 'boolean',
  },
  {
    key: 'editor.lineNumbers',
    title: 'Line Numbers',
    description: 'Show line numbers in the left margin.',
    section: 'editor',
    type: 'boolean',
  },
  {
    key: 'editor.highlightActiveLine',
    title: 'Highlight Active Line',
    description: 'Give the line with the cursor a light background.',
    section: 'editor',
    type: 'boolean',
  },
  {
    key: 'editor.largeFileMB',
    title: 'Large File Size',
    description:
      'Files bigger than this open in plain mode: no syntax tree, no language server, no git marks in the margin.',
    section: 'editor',
    type: 'number',
    min: 1,
    max: 4096,
    step: 1,
    integer: true,
    unit: 'MB',
  },
  {
    key: 'editor.maxFileMB',
    title: 'Maximum File Size',
    description: 'Files bigger than this do not open.',
    section: 'editor',
    type: 'number',
    min: 1,
    max: 8192,
    step: 1,
    integer: true,
    unit: 'MB',
  },

  // Files
  {
    key: 'files.exclude',
    title: 'Excluded Files',
    description: 'Glob patterns for files and folders that the explorer and search hide.',
    section: 'files',
    type: 'stringList',
    placeholder: '**/node_modules',
  },
  {
    key: 'files.autoSave',
    title: 'Auto Save',
    description: 'Choose when Kestrel saves changed files.',
    section: 'files',
    type: 'enum',
    options: [
      { value: 'afterDelay', label: 'After a delay (default)' },
      { value: 'onFocusChange', label: 'When focus changes' },
      { value: 'off', label: 'Off: save by hand (⌘S / Ctrl+S)' },
    ],
  },
  {
    key: 'files.autoSaveDelayMs',
    title: 'Auto Save Delay',
    description: 'Time to wait after the last change before the file is saved.',
    section: 'files',
    type: 'number',
    min: 100,
    max: 60000,
    step: 100,
    integer: true,
    unit: 'ms',
    visibleWhen: (s) => s['files.autoSave'] === 'afterDelay',
  },
  {
    key: 'files.trimTrailingWhitespace',
    title: 'Trim Trailing Whitespace',
    description: 'Remove spaces and tabs at the end of each line when a file is saved.',
    section: 'files',
    type: 'boolean',
  },
  {
    key: 'files.insertFinalNewline',
    title: 'Insert Final Newline',
    description: 'Add an empty line at the end of the file when it is saved.',
    section: 'files',
    type: 'boolean',
  },
  {
    key: 'files.encoding',
    title: 'Default Encoding',
    description: 'Encoding for new files, for example utf-8 or shift_jis. Existing files keep their own encoding.',
    section: 'files',
    type: 'text',
    placeholder: 'utf-8',
  },

  // Explorer
  {
    key: 'explorer.compactFolders',
    title: 'Compact Folders',
    description: 'Show a chain of folders that each hold only one folder as a single row.',
    section: 'explorer',
    type: 'boolean',
  },

  // Preview
  {
    key: 'preview.markdownMode',
    title: 'Markdown View',
    description: 'How Markdown files open: only code, code with a preview next to it, or only the preview.',
    section: 'preview',
    type: 'enum',
    options: viewModes,
  },
  {
    key: 'preview.htmlMode',
    title: 'HTML View',
    description: 'How HTML files open: only code, code with a preview next to it, or only the preview.',
    section: 'preview',
    type: 'enum',
    options: viewModes,
  },
  {
    key: 'preview.htmlScripts',
    title: 'Run scripts in HTML preview',
    description: 'Let JavaScript in an HTML file run inside the preview.',
    note: 'Scripts run in a sandbox. They cannot reach your files or the app.',
    section: 'preview',
    type: 'boolean',
  },
  {
    key: 'preview.csvMode',
    title: 'CSV / TSV View',
    description: 'How CSV and TSV files open. "Preview" shows a table. "Code" shows the raw text.',
    section: 'preview',
    type: 'enum',
    options: viewModes,
  },

  // Git
  {
    key: 'git.enabled',
    title: 'Enable Git',
    description: 'Show git status in the explorer and tabs, and turn on the git view.',
    section: 'git',
    type: 'boolean',
  },
  {
    key: 'git.gutter',
    title: 'Git Marks in Margin',
    description: 'Show added, changed and removed lines in the editor margin.',
    section: 'git',
    type: 'boolean',
  },

  // Language servers
  {
    key: 'lsp.enabled',
    title: 'Enable Language Servers',
    description: 'Use language servers for hover, completion, go to definition and problems.',
    section: 'lsp',
    type: 'boolean',
  },
  {
    key: 'lsp.servers',
    title: 'Servers',
    description: 'Language servers that Kestrel can start. Edit settings.json to add or change a server.',
    section: 'lsp',
    type: 'lspServers',
  },

  // Search
  {
    key: 'search.maxResults',
    title: 'Maximum Results',
    description: 'Search stops after this number of matches.',
    section: 'search',
    type: 'number',
    min: 100,
    max: 1000000,
    step: 100,
    integer: true,
  },

  // Database
  {
    key: 'db.connections',
    title: 'Connections',
    description: 'MySQL connections. Passwords are not stored here. Add and change connections in the Database view.',
    section: 'database',
    type: 'dbConnections',
  },
  {
    key: 'db.maxRows',
    title: 'Maximum Rows',
    description: 'A SQL console fetches at most this many rows for each result. A note shows when a result was cut.',
    section: 'database',
    type: 'number',
    min: 1,
    max: 200000,
    step: 100,
    integer: true,
  },
  {
    key: 'db.confirmWrites',
    title: 'Confirm Writes',
    description: 'Ask before a statement that changes data or the schema runs. UPDATE and DELETE without WHERE always ask.',
    section: 'database',
    type: 'enum',
    options: [
      { value: 'production', label: 'On production connections (default)' },
      { value: 'always', label: 'Always' },
      { value: 'never', label: 'Never' },
    ],
  },
  {
    key: 'db.showSystemSchemas',
    title: 'Show System Schemas',
    description: 'Show mysql, sys, information_schema and performance_schema in the Database view.',
    section: 'database',
    type: 'boolean',
  },
];

export function sectionTitle(id: SectionId): string {
  return [...SECTIONS, OTHER_SECTION].find((s) => s.id === id)?.title ?? id;
}

export function defFor(key: string): SettingDef | undefined {
  return SETTING_DEFS.find((d) => d.key === key);
}

/** Text parts that the search box looks at. */
export interface Searchable {
  key: string;
  title: string;
  description: string;
  note?: string;
}

/**
 * Keeps the items that match every word of `query`.
 * A word matches when it is part of the title, key, description or note (any case).
 * An empty query keeps everything.
 */
export function filterSettings<T extends Searchable>(items: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((it) => {
    const text = `${it.title}\n${it.key}\n${it.description}\n${it.note ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Result of checking a number input. */
export type NumberCheck = { ok: true; value: number } | { ok: false; error: string };

export function checkNumber(raw: string, def: Pick<SettingDef, 'min' | 'max' | 'integer'>): NumberCheck {
  const text = raw.trim();
  if (text === '') return { ok: false, error: 'Enter a number.' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: 'This is not a number.' };
  if (def.integer && !Number.isInteger(value)) return { ok: false, error: 'Use a whole number.' };
  if (def.min != null && value < def.min) return { ok: false, error: `The smallest value is ${def.min}.` };
  if (def.max != null && value > def.max) return { ok: false, error: `The biggest value is ${def.max}.` };
  return { ok: true, value };
}

/** Compares two JSON values (settings values are plain JSON). */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

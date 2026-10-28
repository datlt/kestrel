import { appSettingsRead, appSettingsWrite } from '../ipc/app';
import type { AppEvents, Settings, SettingsService } from './types';

export const DEFAULT_SETTINGS: Settings = {
  'theme': 'system',
  'ui.zoom': 1,
  'editor.fontFamily':
    '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Cascadia Code", "Noto Sans Mono", "Liberation Mono", monospace',
  'editor.fontSize': 13,
  'editor.lineHeight': 1.5,
  'editor.tabSize': 4,
  'editor.insertSpaces': true,
  'editor.detectIndentation': true,
  'editor.wordWrap': false,
  'editor.lineNumbers': true,
  'editor.highlightActiveLine': true,
  'editor.largeFileMB': 8,
  'editor.maxFileMB': 256,
  'files.exclude': ['**/.git', '**/.DS_Store', '**/Thumbs.db'],
  'files.autoSave': 'afterDelay',
  'files.autoSaveDelayMs': 1000,
  'files.trimTrailingWhitespace': false,
  'files.insertFinalNewline': false,
  'files.encoding': 'utf-8',
  'explorer.compactFolders': true,
  'preview.markdownMode': 'preview',
  'preview.htmlMode': 'preview',
  'preview.htmlScripts': true,
  'preview.csvMode': 'preview',
  'git.enabled': true,
  'git.gutter': true,
  'lsp.enabled': true,
  'lsp.servers': {
    kotlin: {
      command: ['kotlin-lsp', '--stdio'],
      languages: ['kotlin'],
      rootMarkers: ['settings.gradle.kts', 'settings.gradle', 'build.gradle.kts', 'build.gradle', 'pom.xml'],
    },
    java: {
      command: ['jdtls'],
      languages: ['java'],
      rootMarkers: ['settings.gradle.kts', 'settings.gradle', 'build.gradle.kts', 'build.gradle', 'pom.xml', '.project'],
    },
    typescript: {
      command: ['typescript-language-server', '--stdio'],
      languages: ['javascript', 'typescript', 'jsx', 'tsx'],
      rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    },
  },
  'search.maxResults': 20000,
  'db.connections': [],
  'db.maxRows': 1000,
  'db.confirmWrites': 'production',
  'db.showSystemSchemas': false,
};

/** JSON with // and /* comments and trailing commas (like VS Code settings). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '}' || c === ']') {
      // Drop a trailing comma before the closing bracket (outside strings only).
      out = out.replace(/,(\s*)$/, '$1') + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

/**
 * One settings service per window, shared by all workbenches. `emit` sends
 * `settings:changed` to the bus of every workbench.
 */
export async function createSettings(emit: (e: AppEvents['settings:changed']) => void): Promise<SettingsService> {
  let defaults: Settings = { ...DEFAULT_SETTINGS };
  let user: Record<string, unknown> = {};
  let current: Settings = { ...defaults };
  let filePath = '';

  function recompute() {
    const previous = current;
    current = { ...defaults, ...(user as Partial<Settings>) };
    return previous;
  }

  async function load() {
    const file = await appSettingsRead();
    filePath = file.path;
    if (!file.text) {
      user = {};
      return;
    }
    try {
      const parsed = parseJsonc(file.text);
      user = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch (e) {
      console.error('settings.json is not valid JSON; using defaults', e);
      user = {};
    }
  }

  try {
    await load();
  } catch (e) {
    console.error('could not read settings.json', e);
  }
  recompute();

  const service: SettingsService = {
    get: (key) => current[key],
    all: () => current,
    async update(patch) {
      Object.assign(user, patch);
      await appSettingsWrite(JSON.stringify(user, null, 2) + '\n');
      const previous = recompute();
      emit({ settings: current, previous });
    },
    registerDefaults(more) {
      defaults = { ...defaults, ...more };
      recompute();
    },
    path: () => filePath,
    async reload() {
      await load();
      const previous = recompute();
      emit({ settings: current, previous });
    },
  };
  return service;
}

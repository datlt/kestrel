// The form state of the Find in Files popup, and how it is saved.

import type { SearchContext } from '../../ipc/search';
import type { ScopeChoice, ScopeFiles } from './scope';

export type ScopeTab = 'project' | 'module' | 'directory' | 'scope';

export interface FindOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface FindForm {
  query: string;
  options: FindOptions;
  mask: string;
  maskOn: boolean;
  context: SearchContext;
  tab: ScopeTab;
  modulePath: string | null;
  moduleName: string | null;
  /** Folder of the Directory tab. Empty: the folder of the active file. */
  directory: string;
  recursive: boolean;
  scopeFiles: ScopeFiles;
  replace: string;
  preserveCase: boolean;
  /** Results grouped by file. */
  grouped: boolean;
  pinned: boolean;
}

export const CONTEXT_LABELS: Record<SearchContext, string> = {
  anywhere: 'Anywhere',
  inComments: 'In Comments',
  inStrings: 'In String Literals',
  exceptComments: 'Except Comments',
  exceptStrings: 'Except String Literals',
  exceptCommentsAndStrings: 'Except Comments and String Literals',
};

export const CONTEXTS = Object.keys(CONTEXT_LABELS) as SearchContext[];

export const SCOPE_FILE_LABELS: Record<ScopeFiles, string> = {
  openFiles: 'Open Files',
  changedFiles: 'Changed Files',
  currentFile: 'Current File',
  production: 'Production Files',
  tests: 'Test Files',
};

export const SCOPE_FILES = Object.keys(SCOPE_FILE_LABELS) as ScopeFiles[];

export function defaultForm(): FindForm {
  return {
    query: '',
    options: { matchCase: false, wholeWord: false, regex: false },
    mask: '',
    maskOn: false,
    context: 'anywhere',
    tab: 'project',
    modulePath: null,
    moduleName: null,
    directory: '',
    recursive: true,
    scopeFiles: 'openFiles',
    replace: '',
    preserveCase: false,
    grouped: false,
    pinned: false,
  };
}

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);

/** Reads a saved form. Wrong or missing fields get the default. */
export function loadForm(raw: unknown): FindForm {
  const d = defaultForm();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const o = (r.options && typeof r.options === 'object' ? r.options : {}) as Record<string, unknown>;
  return {
    query: str(r.query, d.query),
    options: {
      matchCase: bool(o.matchCase, false),
      wholeWord: bool(o.wholeWord, false),
      regex: bool(o.regex, false),
    },
    mask: str(r.mask, d.mask),
    maskOn: bool(r.maskOn, d.maskOn),
    context: oneOf(r.context, CONTEXTS, d.context),
    tab: oneOf(r.tab, ['project', 'module', 'directory', 'scope'] as const, d.tab),
    modulePath: typeof r.modulePath === 'string' ? r.modulePath : null,
    moduleName: typeof r.moduleName === 'string' ? r.moduleName : null,
    directory: str(r.directory, d.directory),
    recursive: bool(r.recursive, d.recursive),
    scopeFiles: oneOf(r.scopeFiles, SCOPE_FILES, d.scopeFiles),
    replace: str(r.replace, d.replace),
    preserveCase: bool(r.preserveCase, d.preserveCase),
    grouped: bool(r.grouped, d.grouped),
    pinned: bool(r.pinned, d.pinned),
  };
}

/**
 * The scope that the form selects. `activeDir` is the folder of the active
 * file. It is used when the Directory tab has no folder text.
 */
export function formToChoice(form: FindForm, activeDir: string | null): ScopeChoice {
  switch (form.tab) {
    case 'project':
      return { kind: 'project' };
    case 'module':
      return { kind: 'module', path: form.modulePath, name: form.moduleName ?? undefined };
    case 'directory':
      return { kind: 'directory', path: form.directory.trim() || activeDir || '', recursive: form.recursive };
    case 'scope':
      return { kind: 'files', which: form.scopeFiles };
  }
}

/** The mask text that takes part in the search. */
export function activeMask(form: FindForm): string {
  return form.maskOn ? form.mask : '';
}

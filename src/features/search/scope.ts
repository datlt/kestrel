// The scope of a search: which folder, which files, and the request fields
// (`root`, `include`, `exclude`, `paths`) that follow from it.
//
// Pure functions. The popup collects the facts (open files, changed files,
// the active file) and passes them in `ScopeEnv`.

import { TEST_GLOBS, matchesAnyGlob, type FileMask } from './globs';

export type ScopeFiles = 'openFiles' | 'changedFiles' | 'currentFile' | 'production' | 'tests';

export type ScopeChoice =
  | { kind: 'project' }
  /** `path` is the absolute folder of the module. null: no module chosen yet (searches the project). */
  | { kind: 'module'; path: string | null; name?: string }
  | { kind: 'directory'; path: string; recursive: boolean }
  | { kind: 'files'; which: ScopeFiles };

export interface ScopeEnv {
  /** Absolute path of the project folder. */
  root: string;
  /** Files that are open in an editor (absolute paths). */
  openFiles: string[];
  /** Files from the last `git:decorations` event, without deleted files. */
  changedFiles: string[];
  /** File of the active editor. */
  currentFile: string | null;
}

/** A test on the found files that Rust cannot do with globs. */
export interface PostFilter {
  /** Keep only test files (the `TEST_GLOBS`). */
  testsOnly?: boolean;
  /** Keep only files that are directly inside this folder (not recursive). */
  onlyInDir?: string;
}

export interface ScopeSpec {
  /** Short text for the UI, for example `Directory src/main`. */
  label: string;
  /** The folder that the search walks. */
  root: string;
  /** Include globs to use when the file mask has none. */
  include: string[];
  /** Exclude globs of the scope. The file mask adds more. */
  exclude: string[];
  /** Search only these files (absolute paths). */
  paths?: string[];
  postFilter: PostFilter | null;
  /** Set when the scope has nothing to search, for example no open files. */
  empty?: string;
}

function norm(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function sameFolder(a: string, b: string): boolean {
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

/** Path below `root` with `/` separators. A path outside `root` comes back without a leading slash. */
export function relPath(root: string, path: string): string {
  const r = norm(root);
  const p = norm(path);
  if (p.toLowerCase() === r.toLowerCase()) return '';
  if (p.toLowerCase().startsWith(r.toLowerCase() + '/')) return p.slice(r.length + 1);
  return p.replace(/^\/+/, '').replace(/^[A-Za-z]:\//, '');
}

function parentOf(path: string): string {
  const p = norm(path);
  const i = p.lastIndexOf('/');
  return i <= 0 ? p.slice(0, Math.max(i, 0)) || '/' : p.slice(0, i);
}

function listScope(label: string, root: string, paths: string[], empty: string): ScopeSpec {
  return { label, root, include: [], exclude: [], paths, postFilter: null, empty: paths.length ? undefined : empty };
}

export function scopeSpec(choice: ScopeChoice, env: ScopeEnv): ScopeSpec {
  const base = { root: env.root, include: [], exclude: [], postFilter: null };
  switch (choice.kind) {
    case 'project':
      return { label: 'In Project', ...base };
    case 'module': {
      if (!choice.path || sameFolder(choice.path, env.root)) return { label: 'In Project', ...base };
      return { label: `Module ${choice.name ?? relPath(env.root, choice.path)}`, ...base, root: choice.path };
    }
    case 'directory': {
      const dir = choice.path.trim() || env.root;
      return {
        label: `Directory ${relPath(env.root, dir) || dir}`,
        ...base,
        root: dir,
        // Folders right below the search root are skipped: only its own files stay.
        exclude: choice.recursive ? [] : ['/*/**'],
        postFilter: choice.recursive ? null : { onlyInDir: dir },
      };
    }
    case 'files':
      switch (choice.which) {
        case 'openFiles':
          return listScope('Open Files', env.root, env.openFiles, 'No files are open.');
        case 'changedFiles':
          return listScope('Changed Files', env.root, env.changedFiles, 'No changed files. Git reports no changes in this folder.');
        case 'currentFile':
          return listScope('Current File', env.root, env.currentFile ? [env.currentFile] : [], 'No file is open.');
        case 'production':
          return { label: 'Production Files', ...base, exclude: [...TEST_GLOBS] };
        case 'tests':
          return { label: 'Test Files', ...base, include: [...TEST_GLOBS], postFilter: { testsOnly: true } };
      }
  }
}

export interface SearchRequestParts {
  root: string;
  include: string[];
  exclude: string[];
  paths?: string[];
}

/**
 * Mixes the scope with the file mask. A mask with include globs replaces the
 * include globs of the scope (Rust adds include globs, it cannot AND them).
 * The `postFilter` of the scope then keeps the scope rule.
 */
export function buildSearchRequest(spec: ScopeSpec, mask: FileMask): SearchRequestParts {
  const out: SearchRequestParts = {
    root: spec.root,
    include: mask.include.length ? [...mask.include] : [...spec.include],
    exclude: [...spec.exclude, ...mask.exclude],
  };
  if (spec.paths) out.paths = [...spec.paths];
  return out;
}

/** True when a found file stays in the results. */
export function passesPostFilter(filter: PostFilter | null, absPath: string, projectRoot: string): boolean {
  if (!filter) return true;
  if (filter.onlyInDir && !sameFolder(parentOf(absPath), filter.onlyInDir)) return false;
  if (filter.testsOnly && !matchesAnyGlob(relPath(projectRoot, absPath), TEST_GLOBS)) return false;
  return true;
}

/** Changed files from the git decorations: everything except deleted files. */
export function changedFilesOf(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([, status]) => status !== 'deleted')
    .map(([path]) => path)
    .sort();
}

// Small entry for diff tabs. It stays in the main bundle.
// The heavy part (`diff.ts` and `@codemirror/merge`) loads with `import()` when
// a diff tab is created, so it is not part of the startup code.

import type { AppContext, TabInput } from '../../core/types';
import { basename, dirname } from '../../core/util';
import type { GitService } from './service';

export interface DiffParams {
  /** `HEAD` or a branch name (the merge base with HEAD is used). */
  base: string;
  /** Absolute path of the file in the working tree. */
  path: string;
  /** Old path (relative to the repo top level) when the file was renamed. */
  origPath?: string | null;
}

export const diffTabId = (p: DiffParams) => `diff:${p.base}:${p.path}`;

export function diffTabInput(ctx: AppContext, svc: GitService, p: DiffParams): TabInput {
  const name = basename(p.path);
  return {
    id: diffTabId(p),
    kind: 'diff',
    title: p.base === 'HEAD' ? `${name} (HEAD)` : `${name} (vs ${p.base})`,
    description: dirname(ctx.workspace.relative(p.path)) || undefined,
    tooltip: `${p.path}\nCompared with ${p.base === 'HEAD' ? 'HEAD' : `merge base with ${p.base}`}`,
    create: async (host) => {
      const { DiffContent } = await import('./diff');
      return new DiffContent(ctx, svc, p, host);
    },
    serialize: () => ({ base: p.base, path: p.path, origPath: p.origPath ?? null }),
  };
}

export function restoreDiffTab(ctx: AppContext, svc: GitService, data: unknown): TabInput | null {
  const d = data as Partial<DiffParams> | null;
  if (!d || typeof d.base !== 'string' || typeof d.path !== 'string') return null;
  return diffTabInput(ctx, svc, { base: d.base, path: d.path, origPath: d.origPath ?? null });
}

let mergeModule: Promise<typeof import('@codemirror/merge')> | null = null;
export const loadMerge = () => (mergeModule ??= import('@codemirror/merge'));

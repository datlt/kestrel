// Small pure helpers for IntelliJ data sources. No DOM and no IPC code, so
// tests can import this file.

import type { DbConnectionConfig } from '../../ipc/db';
import { copyName } from './form-model';

/** Ids of IntelliJ connections are `idea:<uuid>`. Saved connections never use this prefix. */
export const IDEA_PREFIX = 'idea:';

export const isIdeaId = (id: string | null | undefined): boolean => typeof id === 'string' && id.startsWith(IDEA_PREFIX);

/** How many IntelliJ sources connect at the same time. */
export const AUTO_CONNECT_LIMIT = 4;

/** Files in `.idea/` that change the list of data sources. */
const IDEA_FILES = new Set(['datasources.xml', 'datasources.local.xml', 'sshconfigs.xml']);

export function ideaGroupLabel(folderName: string | null): string {
  return `IntelliJ: ${folderName ?? 'project'}`;
}

/**
 * True when one of the changed paths is an IntelliJ file that matters, inside
 * `<root>/.idea/`. IntelliJ rewrites `workspace.xml` all the time. That file does not count.
 */
export function ideaFilesChanged(root: string, paths: readonly string[]): boolean {
  const base = root.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return paths.some((p) => {
    const norm = p.replace(/\\/g, '/').toLowerCase();
    if (!norm.startsWith(`${base}/.idea/`)) return false;
    const rest = norm.slice(base.length + '/.idea/'.length);
    return !rest.includes('/') && IDEA_FILES.has(rest);
  });
}

/**
 * The connection as a normal saved connection: a new id, no `source`, so it
 * does not read the IntelliJ files any more. The password is not part of it.
 */
export function copyForSaving(config: DbConnectionConfig, newId: string, taken: readonly string[]): DbConnectionConfig {
  const { source: _source, ...rest } = config;
  void _source;
  const name = taken.includes(config.name) ? copyName(config.name, taken) : config.name;
  return { ...rest, id: newId, name };
}

/** Runs `fn` for every item, with at most `limit` calls at the same time. Never rejects. */
export async function runLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch {
        // The caller shows the error of each item.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
}

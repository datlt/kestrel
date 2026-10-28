// Calls to GitHub through `src/ipc/gh.ts`. This class remembers the running
// calls, so a tab or a view can cancel all of them when it closes.

import {
  ghApi,
  ghCancel,
  ghFileText,
  ghGraphql,
  newGhRequestId,
  type GhApiRequest,
} from '../../ipc/gh';
import { IpcError } from '../../ipc/invoke';

export class GhCalls {
  private running = new Set<number>();
  private closed = false;

  private async run<T>(start: (id: number) => Promise<T>): Promise<T> {
    if (this.closed) throw new IpcError('cancelled', 'Closed.', 'gh');
    const id = newGhRequestId();
    this.running.add(id);
    try {
      return await start(id);
    } finally {
      this.running.delete(id);
    }
  }

  rest<T>(req: GhApiRequest): Promise<T> {
    return this.run((id) => ghApi<T>(id, req));
  }

  graphql<T>(host: string, query: string, variables: Record<string, unknown>): Promise<T> {
    return this.run((id) => ghGraphql<T>(id, host, query, variables));
  }

  fileText(host: string, owner: string, repo: string, path: string, ref: string): Promise<string> {
    return this.run((id) => ghFileText(id, host, owner, repo, path, ref));
  }

  /** Cancels every running call. New calls are refused after this. */
  close(): void {
    this.closed = true;
    for (const id of this.running) void ghCancel(id).catch(() => {});
    this.running.clear();
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof IpcError && e.code === 'cancelled';
}

/** The text to show for an error. GitHub's own message is kept. */
export function errorText(e: unknown): string {
  if (e instanceof IpcError) {
    if (e.code === 'gh_missing') return 'The GitHub CLI (gh) was not found. Install it from https://cli.github.com.';
    return e.message || e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

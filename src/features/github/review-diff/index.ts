// The review diff component (docs/DESIGN.md, section 12.4).
// This small file stays in the main bundle. The editor code (`component.ts` and
// `@codemirror/merge`) loads with `import()` when the first diff is made.

import type { CreateReviewDiff, DiffSide, ReviewDiffHandle, ReviewDiffOptions } from './types';

export const createReviewDiff: CreateReviewDiff = (host, options) => {
  // Options that the user can change before the code has loaded.
  const opts: ReviewDiffOptions = { ...options };
  let inner: ReviewDiffHandle | null = null;
  let disposed = false;
  const queue: Array<(h: ReviewDiffHandle) => void> = [];
  const run = (fn: (h: ReviewDiffHandle) => void) => {
    if (inner) fn(inner);
    else queue.push(fn);
  };

  const message = document.createElement('div');
  message.className = 'review-diff-message';
  message.textContent = 'Loading diff...';
  host.append(message);

  import('./component')
    .then(({ ReviewDiffComponent }) => {
      message.remove();
      if (disposed) return;
      inner = new ReviewDiffComponent(host, opts);
      for (const fn of queue.splice(0)) fn(inner);
    })
    .catch((e: unknown) => {
      message.textContent = e instanceof Error ? e.message : String(e);
    });

  return {
    setThreads(threads) {
      opts.threads = threads;
      inner?.setThreads(threads);
    },
    setLayout(layout) {
      opts.layout = layout;
      inner?.setLayout(layout);
    },
    reveal(side: DiffSide, line: number) {
      run((h) => h.reveal(side, line));
    },
    nextChange: (dir) => inner?.nextChange(dir) ?? false,
    zoom: (step) => inner?.zoom(step) ?? false,
    focus() {
      run((h) => h.focus());
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      message.remove();
      inner?.dispose();
      inner = null;
    },
  };
};

// Contract of the review diff: a diff of one file of a pull request, with the
// review comments inside the diff. Owner: integrator (contract). The
// review-diff agent writes the component (`index.ts` in this folder), the
// github-ui agent uses it. See docs/DESIGN.md, section 12.4.

import type { AppContext } from '../../../core/types';

/** `LEFT`: the old file (base). `RIGHT`: the new file (head). Same words as the GitHub API. */
export type DiffSide = 'LEFT' | 'RIGHT';

export interface ReviewComment {
  /** GitHub id. Draft comments (not sent yet) use an id that starts with `draft-`. */
  id: string;
  author: string;
  /** Markdown, as GitHub stores it. The component renders it with `renderMarkdown`. */
  body: string;
  /** ISO time. Empty for drafts. */
  createdAt: string;
  /** Part of the user's own review that is not submitted yet (a draft in Kestrel). */
  pending: boolean;
  /** The user can edit or delete it (own drafts). */
  mine: boolean;
}

export interface ReviewThread {
  /** GitHub thread id, or `draft-...` for a new thread that only has drafts. */
  id: string;
  side: DiffSide;
  /** 1-based line in the file of `side`. */
  line: number;
  /** First line of a comment on several lines. Not set for one line. */
  startLine?: number;
  /** The code changed after the comment. The component shows it with a note and without a line when `line` is 0. */
  outdated: boolean;
  resolved: boolean;
  /** Login of the person who resolved the thread (GraphQL `resolvedBy`). */
  resolvedBy?: string;
  comments: ReviewComment[];
}

export interface NewComment {
  side: DiffSide;
  line: number;
  startLine?: number;
  body: string;
  /**
   * `review`: add it to the user's pending review (sent later with Approve,
   * Comment or Request Changes). `now`: post it at once as a single comment.
   */
  mode: 'review' | 'now';
}

export interface ReviewDiffOptions {
  ctx: AppContext;
  /**
   * Path in the repository, for the syntax colors. The component draws no
   * header: the caller shows the file name and the Next File / Previous File
   * buttons. `nextChange` returns false at the last change, so the caller can
   * move to the next file.
   */
  path: string;
  /** null: the file is new (added). */
  oldText: string | null;
  /** null: the file was deleted. */
  newText: string | null;
  threads: ReviewThread[];
  /** `split`: old and new side by side. `unified`: one column. */
  layout: 'split' | 'unified';
  /** False when the user cannot comment (for example a closed pull request). */
  canComment: boolean;
  /** Renders markdown to safe HTML (`mdRenderSafe`). */
  renderMarkdown(markdown: string): Promise<string>;
  /** The component keeps the editor open with a spinner until the promise ends; on error it keeps the text. */
  onAddComment(comment: NewComment): Promise<void>;
  onReply(threadId: string, body: string, mode: 'review' | 'now'): Promise<void>;
  onEditDraft(commentId: string, body: string): Promise<void>;
  onDeleteDraft(commentId: string): Promise<void>;
  /** Not set: no Resolve button. */
  onResolve?(threadId: string, resolved: boolean): Promise<void>;
}

export interface ReviewDiffHandle {
  /** New threads (after a post or a reload). The scroll position stays. */
  setThreads(threads: ReviewThread[]): void;
  setLayout(layout: 'split' | 'unified'): void;
  /** Scrolls to a line and flashes it. */
  reveal(side: DiffSide, line: number): void;
  /** Next or previous change (hunk). Returns false at the end. */
  nextChange(dir: 1 | -1): boolean;
  /** Editor font zoom step, like `TabContent.zoom`. */
  zoom(step: 1 | -1 | 0): boolean;
  focus(): void;
  dispose(): void;
}

/** The component. `index.ts` in this folder exports `createReviewDiff` with this type. */
export type CreateReviewDiff = (host: HTMLElement, options: ReviewDiffOptions) => ReviewDiffHandle;

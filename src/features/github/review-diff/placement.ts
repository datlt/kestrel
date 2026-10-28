// Pure logic: where a thread or a comment box goes in the diff.
// Line numbers are 1-based. No DOM and no CodeMirror here, so vitest can test it.

import type { DiffSide, ReviewThread } from './types';

/** A changed chunk in lines. `from` is the first line, `to` is after the last line. Empty when from == to. */
export interface LineChunk {
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
}

export type Layout = 'split' | 'unified';
/** `both`: normal file. `added`: only the new side. `deleted`: only the old side. */
export type FileKind = 'both' | 'added' | 'deleted';

export interface PlaceInput {
  layout: Layout;
  kind: FileKind;
  chunks: readonly LineChunk[];
  /** Number of lines of the old text (CodeMirror `doc.lines`). */
  linesA: number;
  /** Number of lines of the new text. */
  linesB: number;
}

/**
 * `a` is the editor with the old text, `b` the editor with the new text.
 * `after`: the widget goes under this line of that editor.
 * `deleted` (unified layout only): the old line is in a deleted block. The widget goes
 * under that block, which is drawn before line `line` of editor `b`.
 */
export type Place =
  | { view: 'a' | 'b'; kind: 'after'; line: number }
  | { view: 'b'; kind: 'deleted'; line: number; oldLine: number };

/** Maps an old line to the new text. Gives the chunk when the line is deleted or changed. */
export function oldToNew(chunks: readonly LineChunk[], line: number): { chunk: LineChunk } | { line: number } {
  let shift = 0;
  for (const c of chunks) {
    if (line < c.aFrom) break;
    if (line < c.aTo) return { chunk: c };
    shift += c.bTo - c.bFrom - (c.aTo - c.aFrom);
  }
  return { line: line + shift };
}

/** True when the old line lies inside no chunk, so the new text has the same line. */
export function isUnchangedOld(chunks: readonly LineChunk[], line: number): boolean {
  return 'line' in oldToNew(chunks, line);
}

/** True when the new line lies inside no chunk. */
export function isUnchangedNew(chunks: readonly LineChunk[], line: number): boolean {
  return !chunks.some((c) => line >= c.bFrom && line < c.bTo);
}

/** The line of the other side for an unchanged line, or null. */
export function counterpartLine(chunks: readonly LineChunk[], side: DiffSide, line: number): number | null {
  if (side === 'LEFT') {
    const r = oldToNew(chunks, line);
    return 'line' in r ? r.line : null;
  }
  if (!isUnchangedNew(chunks, line)) return null;
  let shift = 0;
  for (const c of chunks) {
    if (line < c.bFrom) break;
    shift += c.bTo - c.bFrom - (c.aTo - c.aFrom);
  }
  return line - shift;
}

/** Finds the place of a line of `side`, or null when the line is not in the shown text. */
export function placeLine(input: PlaceInput, side: DiffSide, line: number): Place | null {
  if (!Number.isInteger(line) || line < 1) return null;
  const { layout, kind, chunks, linesA, linesB } = input;
  if (side === 'RIGHT') {
    if (kind === 'deleted' || line > linesB) return null;
    return { view: 'b', kind: 'after', line };
  }
  if (kind === 'added' || line > linesA) return null;
  if (kind === 'deleted' || layout === 'split') return { view: 'a', kind: 'after', line };
  const r = oldToNew(chunks, line);
  if ('chunk' in r) return { view: 'b', kind: 'deleted', line: r.chunk.bFrom, oldLine: line };
  if (r.line < 1 || r.line > linesB) return null;
  return { view: 'b', kind: 'after', line: r.line };
}

/** Lines that a multi-line thread marks, or null for a thread on one line. */
export function threadRange(t: { line: number; startLine?: number }): { from: number; to: number } | null {
  const s = t.startLine;
  if (!s || s < 1 || t.line < 1 || s >= t.line) return null;
  return { from: s, to: t.line };
}

export interface SplitResult {
  placed: Array<{ thread: ReviewThread; place: Place }>;
  /** Threads without a line (`line` 0, outdated) or on a line that is not in the shown text. */
  outdated: ReviewThread[];
}

/** Puts every thread either on a line or into the outdated list. */
export function splitThreads(threads: readonly ReviewThread[], place: (t: ReviewThread) => Place | null): SplitResult {
  const placed: SplitResult['placed'] = [];
  const outdated: ReviewThread[] = [];
  for (const thread of threads) {
    const p = thread.line > 0 ? place(thread) : null;
    if (p) placed.push({ thread, place: p });
    else outdated.push(thread);
  }
  return { placed, outdated };
}

/**
 * Index of the next (dir 1) or previous (dir -1) chunk start after `head`,
 * or -1 at the end. `starts` must be sorted.
 */
export function nextChunkIndex(starts: readonly number[], head: number, dir: 1 | -1): number {
  if (dir > 0) {
    for (let i = 0; i < starts.length; i++) if (starts[i] > head) return i;
    return -1;
  }
  for (let i = starts.length - 1; i >= 0; i--) if (starts[i] < head) return i;
  return -1;
}

/** Text for the line range of a comment: "Line 5", "Lines 5 to 8", "Old line 3". */
export function rangeLabel(side: DiffSide, line: number, startLine?: number): string {
  const many = !!startLine && startLine < line;
  const num = many ? `${startLine} to ${line}` : String(line);
  const noun = many ? 'lines' : 'line';
  return side === 'LEFT' ? `Old ${noun} ${num}` : `${many ? 'Lines' : 'Line'} ${num}`;
}

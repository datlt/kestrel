import { describe, expect, it } from 'vitest';
import {
  counterpartLine,
  nextChunkIndex,
  oldToNew,
  placeLine,
  rangeLabel,
  splitThreads,
  threadRange,
  type LineChunk,
  type PlaceInput,
} from './placement';
import type { ReviewThread } from './types';

// Old: 1..10. Lines 3-4 changed into 3-5 (one more line). Line 8 deleted. Line 11 (new) inserted after old 9.
const chunks: LineChunk[] = [
  { aFrom: 3, aTo: 5, bFrom: 3, bTo: 6 },
  { aFrom: 8, aTo: 9, bFrom: 9, bTo: 9 },
  { aFrom: 10, aTo: 10, bFrom: 10, bTo: 11 },
];
const input = (over: Partial<PlaceInput> = {}): PlaceInput => ({
  layout: 'split',
  kind: 'both',
  chunks,
  linesA: 10,
  linesB: 11,
  ...over,
});

describe('oldToNew', () => {
  it('shifts lines after a chunk', () => {
    expect(oldToNew(chunks, 1)).toEqual({ line: 1 });
    expect(oldToNew(chunks, 5)).toEqual({ line: 6 });
    expect(oldToNew(chunks, 7)).toEqual({ line: 8 });
    expect(oldToNew(chunks, 9)).toEqual({ line: 9 });
    expect(oldToNew(chunks, 10)).toEqual({ line: 11 });
  });
  it('returns the chunk for deleted or changed lines', () => {
    expect(oldToNew(chunks, 4)).toEqual({ chunk: chunks[0] });
    expect(oldToNew(chunks, 8)).toEqual({ chunk: chunks[1] });
  });
});

describe('counterpartLine', () => {
  it('maps unchanged lines both ways', () => {
    expect(counterpartLine(chunks, 'LEFT', 5)).toBe(6);
    expect(counterpartLine(chunks, 'RIGHT', 6)).toBe(5);
    expect(counterpartLine(chunks, 'RIGHT', 9)).toBe(9);
    expect(counterpartLine(chunks, 'RIGHT', 1)).toBe(1);
  });
  it('gives null for changed lines', () => {
    expect(counterpartLine(chunks, 'LEFT', 3)).toBeNull();
    expect(counterpartLine(chunks, 'RIGHT', 4)).toBeNull();
  });
});

describe('placeLine', () => {
  it('split: each side keeps its own line', () => {
    expect(placeLine(input(), 'LEFT', 4)).toEqual({ view: 'a', kind: 'after', line: 4 });
    expect(placeLine(input(), 'RIGHT', 4)).toEqual({ view: 'b', kind: 'after', line: 4 });
  });
  it('unified: RIGHT stays, LEFT under the deleted block', () => {
    const u = input({ layout: 'unified' });
    expect(placeLine(u, 'RIGHT', 4)).toEqual({ view: 'b', kind: 'after', line: 4 });
    expect(placeLine(u, 'LEFT', 4)).toEqual({ view: 'b', kind: 'deleted', line: 3, oldLine: 4 });
    expect(placeLine(u, 'LEFT', 8)).toEqual({ view: 'b', kind: 'deleted', line: 9, oldLine: 8 });
  });
  it('unified: LEFT on an unchanged line goes under the new line', () => {
    const u = input({ layout: 'unified' });
    expect(placeLine(u, 'LEFT', 7)).toEqual({ view: 'b', kind: 'after', line: 8 });
    expect(placeLine(u, 'LEFT', 1)).toEqual({ view: 'b', kind: 'after', line: 1 });
  });
  it('rejects lines out of range', () => {
    expect(placeLine(input(), 'RIGHT', 12)).toBeNull();
    expect(placeLine(input(), 'LEFT', 11)).toBeNull();
    expect(placeLine(input(), 'LEFT', 0)).toBeNull();
    expect(placeLine(input(), 'LEFT', 1.5)).toBeNull();
  });
  it('added file: only the new side', () => {
    const a = input({ kind: 'added', chunks: [], linesA: 0 });
    expect(placeLine(a, 'RIGHT', 2)).toEqual({ view: 'b', kind: 'after', line: 2 });
    expect(placeLine(a, 'LEFT', 1)).toBeNull();
  });
  it('deleted file: only the old side, in both layouts', () => {
    for (const layout of ['split', 'unified'] as const) {
      const d = input({ kind: 'deleted', layout, chunks: [], linesB: 0 });
      expect(placeLine(d, 'LEFT', 2)).toEqual({ view: 'a', kind: 'after', line: 2 });
      expect(placeLine(d, 'RIGHT', 1)).toBeNull();
    }
  });
});

describe('threadRange', () => {
  it('returns the range of a multi-line thread', () => {
    expect(threadRange({ line: 8, startLine: 5 })).toEqual({ from: 5, to: 8 });
  });
  it('returns null for one line or bad data', () => {
    expect(threadRange({ line: 8 })).toBeNull();
    expect(threadRange({ line: 8, startLine: 8 })).toBeNull();
    expect(threadRange({ line: 8, startLine: 9 })).toBeNull();
    expect(threadRange({ line: 0, startLine: 0 })).toBeNull();
  });
});

const thread = (id: string, line: number, over: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  side: 'RIGHT',
  line,
  outdated: false,
  resolved: false,
  comments: [],
  ...over,
});

describe('splitThreads', () => {
  it('moves line 0 and unplaceable threads to the outdated list', () => {
    const list = [thread('a', 3), thread('b', 0, { outdated: true }), thread('c', 99), thread('d', 5, { outdated: true })];
    const r = splitThreads(list, (t) => placeLine(input(), t.side, t.line));
    expect(r.placed.map((p) => p.thread.id)).toEqual(['a', 'd']);
    expect(r.outdated.map((t) => t.id)).toEqual(['b', 'c']);
  });
});

describe('nextChunkIndex', () => {
  const starts = [10, 20, 30];
  it('goes forward and back', () => {
    expect(nextChunkIndex(starts, 0, 1)).toBe(0);
    expect(nextChunkIndex(starts, 10, 1)).toBe(1);
    expect(nextChunkIndex(starts, 30, 1)).toBe(-1);
    expect(nextChunkIndex(starts, 30, -1)).toBe(1);
    expect(nextChunkIndex(starts, 10, -1)).toBe(-1);
    expect(nextChunkIndex(starts, 25, -1)).toBe(1);
  });
  it('handles no chunks', () => {
    expect(nextChunkIndex([], 0, 1)).toBe(-1);
  });
});

describe('rangeLabel', () => {
  it('names one line, many lines and old lines', () => {
    expect(rangeLabel('RIGHT', 5)).toBe('Line 5');
    expect(rangeLabel('RIGHT', 8, 5)).toBe('Lines 5 to 8');
    expect(rangeLabel('LEFT', 8, 5)).toBe('Old lines 5 to 8');
    expect(rangeLabel('LEFT', 3)).toBe('Old line 3');
  });
});

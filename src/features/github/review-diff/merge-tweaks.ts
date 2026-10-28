// Small changes to the look of `@codemirror/merge`. They follow the git feature
// (`src/features/git/diff.ts`), so both diffs look the same.

import { RangeSetBuilder, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Change } from '@codemirror/merge';

export type MergeModule = typeof import('@codemirror/merge');

/** True when the range starts at a line start and ends at a line end. */
function coversWholeLines(doc: Text, from: number, to: number): boolean {
  const starts = from === doc.lineAt(from).from || doc.sliceString(from, from + 1) === '\n';
  const ends = to >= doc.length || doc.sliceString(to, to + 1) === '\n' || doc.sliceString(to - 1, to) === '\n';
  return starts && ends;
}

/**
 * Removes the inline marks of lines that are fully added or fully deleted. Such a line
 * gets only the line background. Marks inside changed lines stay.
 */
function trimChunk(chunk: InstanceType<MergeModule['Chunk']>, a: Text, b: Text): void {
  const pure = chunk.fromA === chunk.toA || chunk.fromB === chunk.toB;
  const keep = pure
    ? []
    : chunk.changes.filter((ch: Change) => {
        if (ch.fromA === ch.toA) return !coversWholeLines(b, chunk.fromB + ch.fromB, chunk.fromB + ch.toB);
        if (ch.fromB === ch.toB) return !coversWholeLines(a, chunk.fromA + ch.fromA, chunk.fromA + ch.toA);
        return true;
      });
  if (keep.length !== chunk.changes.length) (chunk as unknown as { changes: readonly Change[] }).changes = keep;
}

/**
 * Runs `fn` (it creates a merge view or a unified state) while `Chunk.build` removes the
 * inline marks of whole added or deleted lines. The patch lasts only for the call.
 */
export function withTrimmedChunks<T>(m: MergeModule, fn: () => T): T {
  const original = m.Chunk.build;
  m.Chunk.build = (a, b, conf) => {
    const chunks = original.call(m.Chunk, a, b, conf);
    for (const c of chunks) trimChunk(c, a, b);
    return chunks;
  };
  try {
    return fn();
  } finally {
    m.Chunk.build = original;
  }
}

/** Gives every line of a changed chunk a line background of our own. */
export function chunkLineMarks(m: MergeModule): Extension {
  const build = (view: EditorView): DecorationSet => {
    const info = m.getChunks(view.state);
    const builder = new RangeSetBuilder<Decoration>();
    if (!info) return builder.finish();
    const isA = info.side === 'a';
    const deco = Decoration.line({ class: isA ? 'review-diff-line-del' : 'review-diff-line-add' });
    const doc = view.state.doc;
    const { from: vFrom, to: vTo } = view.viewport;
    let last = 0;
    for (const c of info.chunks) {
      const from = isA ? c.fromA : c.fromB;
      const end = Math.min(isA ? c.endA : c.endB, doc.length);
      if (from === (isA ? c.toA : c.toB) || from > doc.length) continue;
      if (from > vTo) break;
      if (end < vFrom) continue;
      for (let n = Math.max(doc.lineAt(from).number, last + 1); n <= doc.lineAt(end).number; n++) {
        const line = doc.line(n);
        if (line.to < vFrom || line.from > vTo) continue;
        builder.add(line.from, line.from, deco);
        last = n;
      }
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      deco: DecorationSet;
      constructor(view: EditorView) {
        this.deco = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || m.getChunks(u.startState)?.chunks !== m.getChunks(u.state)?.chunks)
          this.deco = build(u.view);
      }
    },
    { decorations: (v) => v.deco },
  );
}

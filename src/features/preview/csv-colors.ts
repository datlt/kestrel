// "Rainbow CSV": colors each column of a CSV or TSV file in the code view.
// It only decorates the lines that are on screen, and it skips very long lines.

import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { FileEditor } from '../../core/types';
import { delimiterForPath, detectDelimiter, type Delimiter } from './csv-parse';
import './csv.css';

const COLORS = 8;
/** Lines longer than this have no colors. */
export const MAX_COLORED_LINE = 3000;
/** The delimiter is detected from the start of the file. */
const DETECT_CHARS = 100_000;

const marks = Array.from({ length: COLORS }, (_, i) => Decoration.mark({ class: `csv-c${i}` }));
const sepMark = Decoration.mark({ class: 'csv-sep' });
const headerLine = Decoration.line({ class: 'csv-hdr-line' });

export interface ColorSpan {
  from: number;
  to: number;
  /** Column number for a field, -1 for a delimiter. */
  col: number;
}

/** Splits one line into fields and delimiters. Quotes keep a delimiter inside a field. */
export function colorSpans(line: string, delimiter: Delimiter): ColorSpan[] {
  const out: ColorSpan[] = [];
  let start = 0;
  let col = 0;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === delimiter && !inQuote) {
      if (i > start) out.push({ from: start, to: i, col });
      out.push({ from: i, to: i + 1, col: -1 });
      start = i + 1;
      col++;
    }
  }
  if (line.length > start) out.push({ from: start, to: line.length, col });
  return out;
}

export function csvColorExtension(editor: FileEditor): Extension {
  const hint = delimiterForPath(editor.path);
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      delimiter: Delimiter;
      constructor(view: EditorView) {
        this.delimiter = detectDelimiter(view.state.doc.sliceString(0, DETECT_CHARS), hint);
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) {
          let early = false;
          u.changes.iterChangedRanges((fromA) => {
            if (fromA < DETECT_CHARS) early = true;
          });
          if (early) this.delimiter = detectDelimiter(u.state.doc.sliceString(0, DETECT_CHARS), hint);
        }
        if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const doc = view.state.doc;
        let done = -1;
        for (const range of view.visibleRanges) {
          let pos = Math.max(range.from, done + 1);
          while (pos <= range.to) {
            const line = doc.lineAt(pos);
            pos = line.to + 1;
            done = line.to;
            if (line.length === 0 || line.length > MAX_COLORED_LINE) continue;
            if (line.number === 1) builder.add(line.from, line.from, headerLine);
            for (const span of colorSpans(line.text, this.delimiter)) {
              builder.add(line.from + span.from, line.from + span.to, span.col < 0 ? sepMark : marks[span.col % COLORS]);
            }
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
  return plugin;
}

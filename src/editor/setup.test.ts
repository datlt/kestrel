import { CompletionContext } from '@codemirror/autocomplete';
import { indentUnit } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { kotlin } from './kotlin';
import { baseExtensions, createCompartments, documentWords, tabKey } from './setup';

function makeState(doc: string, large = false, indent = { insertSpaces: true, size: 4 }) {
  return EditorState.create({
    doc,
    extensions: baseExtensions({
      compartments: createCompartments(),
      large,
      lineNumbers: true,
      activeLine: true,
      wordWrap: false,
      indent,
      language: kotlin(),
      onFocusLost: () => {},
    }),
  });
}

/** A tiny stand-in for EditorView: enough for commands that only use state and dispatch. */
function fakeView(state: EditorState): EditorView & { current: EditorState } {
  const view = {
    current: state,
    get state() {
      return view.current;
    },
    dispatch(...specs: any[]) {
      view.current = view.current.update(...specs).state;
    },
  };
  return view as unknown as EditorView & { current: EditorState };
}

describe('setup', () => {
  it('builds a state in normal and large mode', () => {
    const normal = makeState('val x = 1\n');
    const large = makeState('val x = 1\n', true);
    expect(normal.tabSize).toBe(4);
    expect(normal.facet(indentUnit)).toBe('    ');
    expect(large.tabSize).toBe(4);
  });

  it('uses a tab as indent unit', () => {
    const state = makeState('', false, { insertSpaces: false, size: 2 });
    expect(state.facet(indentUnit)).toBe('\t');
    expect(state.tabSize).toBe(2);
  });

  it('has the language in normal mode only', () => {
    expect(makeState('x').languageDataAt('commentTokens', 0).length).toBeGreaterThan(0);
    expect(makeState('x', true).languageDataAt('commentTokens', 0).length).toBe(0);
  });

  it('offers words of the document for completion', () => {
    const state = makeState('val someLongName = 1\nval other = som');
    const pos = state.doc.length;
    const result = documentWords(new CompletionContext(state, pos, false)) as any;
    expect(result.options.map((o: any) => o.label)).toContain('someLongName');
    expect(result.from).toBe(pos - 3);
    expect(result.options.map((o: any) => o.label)).not.toContain('som');
  });

  it('is registered as language data', () => {
    const state = makeState('x');
    expect(state.languageDataAt('autocomplete', 0)).toContain(documentWords);
  });
});

describe('tabKey', () => {
  it('inserts spaces up to the next tab stop', () => {
    const view = fakeView(makeState('ab').update({ selection: { anchor: 2 } }).state);
    tabKey(view);
    expect(view.current.doc.toString()).toBe('ab  ');
    expect(view.current.selection.main.head).toBe(4);
  });

  it('inserts a full unit at the start of a line', () => {
    const view = fakeView(makeState('x'));
    tabKey(view);
    expect(view.current.doc.toString()).toBe('    x');
  });

  it('indents selected lines', () => {
    const view = fakeView(makeState('a\nb').update({ selection: EditorSelection.range(0, 3) }).state);
    tabKey(view);
    expect(view.current.doc.toString()).toBe('    a\n    b');
  });

  it('inserts a tab character when the unit is a tab', () => {
    const state = makeState('a', false, { insertSpaces: false, size: 4 }).update({ selection: { anchor: 1 } }).state;
    const view = fakeView(state);
    tabKey(view);
    expect(view.current.doc.toString()).toBe('a\t');
  });
});

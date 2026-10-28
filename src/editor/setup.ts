// The CodeMirror extensions that every file editor uses.
// Settings that can change at run time live in a Compartment per editor.

import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  selectNextOccurrence,
  selectSelectionMatches,
} from '@codemirror/search';
import { Compartment, countColumn, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type Command,
  type KeyBinding,
} from '@codemirror/view';
import { editorContextMenu } from './context-menu';
import { kestrelHighlighter } from './highlight';
import { kestrelTheme } from './theme';

export interface Compartments {
  language: Compartment;
  providers: Compartment;
  wrap: Compartment;
  lineNumbers: Compartment;
  activeLine: Compartment;
  indent: Compartment;
  history: Compartment;
}

export function createCompartments(): Compartments {
  return {
    language: new Compartment(),
    providers: new Compartment(),
    wrap: new Compartment(),
    lineNumbers: new Compartment(),
    activeLine: new Compartment(),
    indent: new Compartment(),
    history: new Compartment(),
  };
}

export function indentExtension(info: { insertSpaces: boolean; size: number }): Extension {
  return [EditorState.tabSize.of(info.size), indentUnit.of(info.insertSpaces ? ' '.repeat(info.size) : '\t')];
}

export const lineNumbersExtension = (on: boolean): Extension => (on ? lineNumbers() : []);
export const activeLineExtension = (on: boolean): Extension => (on ? [highlightActiveLine(), highlightActiveLineGutter()] : []);
export const wrapExtension = (on: boolean): Extension => (on ? EditorView.lineWrapping : []);

// --- Keys ------------------------------------------------------------------------

/** Tab inserts spaces up to the next tab stop, or indents the selected lines. */
export const tabKey: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
  view.dispatch(
    state.changeByRange((range) => {
      const unit = state.facet(indentUnit);
      let insert = unit;
      if (unit[0] === ' ') {
        const line = state.doc.lineAt(range.head);
        const column = countColumn(line.text.slice(0, range.head - line.from), state.tabSize);
        insert = ' '.repeat(unit.length - (column % unit.length));
      }
      return { changes: { from: range.head, insert }, range: EditorSelection.cursor(range.head + insert.length) };
    }),
    { scrollIntoView: true, userEvent: 'input' },
  );
  return true;
};

const searchScope = 'editor search-panel';

/** Keys of the engine. `Mod-Alt-f` (macOS) and `Mod-h` (others) both open find and replace. */
const engineKeys: KeyBinding[] = [
  { key: 'Mod-f', run: openSearchPanel, scope: searchScope },
  { key: 'Mod-h', mac: 'Mod-Alt-f', run: openSearchPanel, scope: searchScope },
  { key: 'F3', run: findNext, shift: findPrevious, scope: searchScope, preventDefault: true },
  { mac: 'Mod-g', run: findNext, shift: findPrevious, scope: searchScope, preventDefault: true },
  { key: 'Escape', run: closeSearchPanel, scope: searchScope },
  { key: 'Mod-Shift-l', run: selectSelectionMatches },
  { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
  { key: 'Ctrl-g', run: gotoLine, preventDefault: true },
];

// --- Completion: words of the document -----------------------------------------------

const WORD = /[\p{L}\p{N}_$]{3,}/gu;

export function documentWords(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/[\p{L}\p{N}_$]+/u);
  if (!before || (before.from === before.to && !context.explicit)) return null;
  if (before.to - before.from < 2 && !context.explicit) return null;
  const { doc } = context.state;
  // Look at a window around the cursor so a huge file stays fast.
  const from = Math.max(0, before.from - 100_000);
  const to = Math.min(doc.length, before.to + 100_000);
  const text = doc.sliceString(from, to);
  const typed = before.text.toLowerCase();
  const seen = new Set<string>();
  const options: { label: string; type: string }[] = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0];
    const start = from + (m.index ?? 0);
    if (start === before.from) continue; // the word being typed
    if (word.length <= typed.length || !word.toLowerCase().startsWith(typed) || seen.has(word)) continue;
    seen.add(word);
    options.push({ label: word, type: 'text' });
    if (options.length >= 200) break;
  }
  return options.length ? { from: before.from, options, validFor: /^[\p{L}\p{N}_$]*$/u } : null;
}

// --- Assembly ------------------------------------------------------------------------

export interface SetupOptions {
  compartments: Compartments;
  /** Plain mode for big files: no language features, folding or completion. */
  large: boolean;
  lineNumbers: boolean;
  activeLine: boolean;
  wordWrap: boolean;
  indent: { insertSpaces: boolean; size: number };
  language: Extension;
  onFocusLost: () => void;
}

export function baseExtensions(o: SetupOptions): Extension[] {
  const c = o.compartments;
  const keys = keymap.of([
    ...engineKeys,
    ...closeBracketsKeymap,
    { key: 'Tab', run: tabKey, shift: indentLess },
    ...defaultKeymap,
    ...historyKeymap,
    ...foldKeymap,
  ]);

  const common: Extension[] = [
    kestrelTheme,
    EditorState.allowMultipleSelections.of(true),
    EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
    c.history.of(history()),
    c.lineNumbers.of(lineNumbersExtension(o.lineNumbers)),
    c.activeLine.of(activeLineExtension(o.activeLine)),
    c.indent.of(indentExtension(o.indent)),
    c.language.of(o.large ? [] : o.language),
    c.providers.of([]),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    // Alt-click adds a cursor, Alt-Shift-drag selects a column. Mod-click is free for "go to definition".
    EditorView.clickAddsSelectionRange.of((e) => e.altKey && !e.shiftKey),
    rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey && e.button === 0 }),
    search({ top: true }),
    keys,
    EditorView.domEventHandlers({ blur: () => o.onFocusLost() }),
    editorContextMenu,
  ];
  if (o.large) return common;

  return [
    ...common,
    c.wrap.of(wrapExtension(o.wordWrap)),
    syntaxHighlighting(kestrelHighlighter),
    foldGutter({ openText: '⌄', closedText: '›' }),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    EditorState.languageData.of(() => [{ autocomplete: documentWords }]),
    highlightSelectionMatches(),
  ];
}

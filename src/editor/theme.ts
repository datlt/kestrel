// The CodeMirror UI theme: gutters, cursor, selection, panels, tooltips,
// autocomplete and lint. It uses only the variables of src/styles/vars.css,
// so it follows the light and dark themes without a reload.

import { EditorView } from '@codemirror/view';

type Rules = Record<string, Record<string, string>>;

/**
 * CodeMirror has its own light and dark colors with selectors like
 * `.ͼ2 .cm-gutters`. We add `.cm-editor` to every selector of ours, so ours
 * are more specific and always win.
 */
function scoped(rules: Rules): Rules {
  const prefix = (selector: string) =>
    selector === '&' ? selector : selector.startsWith('&') ? selector.replace('&', '&.cm-editor') : `&.cm-editor ${selector}`;
  const out: Rules = {};
  for (const [selectors, style] of Object.entries(rules)) {
    out[selectors.split(',').map((s) => prefix(s.trim())).join(', ')] = style;
  }
  return out;
}

const mix = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

const monoFont = 'var(--editor-font-family, var(--font-mono))';

export const kestrelTheme = EditorView.theme(
  scoped({
    '&': {
      color: 'var(--fg)',
      backgroundColor: 'var(--bg)',
      height: '100%',
      fontSize: 'var(--editor-font-size)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: monoFont,
      lineHeight: 'var(--editor-line-height)',
    },
    '.cm-content': { caretColor: 'var(--fg)', padding: '4px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)', borderLeftWidth: '2px' },
    '.cm-selectionBackground': { backgroundColor: 'var(--selection)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
    '.cm-content ::selection': { backgroundColor: 'var(--selection)' },
    '.cm-activeLine': { backgroundColor: 'var(--hover)' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg)',
      color: 'var(--fg-faint)',
      border: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '34px' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--fg)' },
    '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', padding: '0 4px', color: 'var(--fg-faint)' },
    '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--fg)' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--hover)',
      border: 'none',
      color: 'var(--fg-muted)',
      padding: '0 6px',
      borderRadius: 'var(--radius)',
    },
    '.cm-matchingBracket': { backgroundColor: mix('var(--accent)', 28), outline: 'none' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: mix('var(--accent)', 28) },
    '.cm-nonmatchingBracket': { backgroundColor: mix('var(--danger)', 35) },
    '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: mix('var(--danger)', 35) },
    '.cm-selectionMatch': { backgroundColor: mix('var(--accent)', 24) },
    '.cm-searchMatch': {
      backgroundColor: mix('var(--warn)', 32),
      outline: `1px solid ${mix('var(--warn)', 60)}`,
    },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: mix('var(--warn)', 62) },
    '.cm-specialChar': { color: 'var(--warn)' },
    '.cm-placeholder': { color: 'var(--fg-faint)' },

    // Panels: search, go to line, lint list.
    '.cm-panels': {
      backgroundColor: 'var(--bg-alt)',
      color: 'var(--fg)',
      fontFamily: 'var(--font-ui)',
      fontSize: '12px',
    },
    '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
    '.cm-panel.cm-search': { padding: '6px 30px 6px 8px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 6px' },
    '.cm-search br': { display: 'none' },
    '.cm-search label': { color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '12px' },
    '.cm-textfield': {
      backgroundColor: 'var(--bg-input)',
      color: 'var(--fg)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '2px 6px',
      height: '24px',
      margin: '0',
      fontSize: '12px',
    },
    '.cm-textfield:focus': { outline: '1px solid var(--focus-ring)', outlineOffset: '-1px', borderColor: 'var(--focus-ring)' },
    '.cm-button': {
      backgroundColor: 'var(--bg-elevated)',
      backgroundImage: 'none',
      color: 'var(--fg)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '0 8px',
      height: '24px',
      margin: '0',
      fontSize: '12px',
      cursor: 'pointer',
    },
    '.cm-button:hover': { backgroundColor: 'var(--hover)' },
    '.cm-button:active': { backgroundColor: 'var(--active)', backgroundImage: 'none' },
    '.cm-panel.cm-search [name=close]': {
      color: 'var(--fg-muted)',
      cursor: 'pointer',
      fontSize: '16px',
      top: '4px',
      right: '8px',
    },
    '.cm-dialog': {
      backgroundColor: 'var(--bg-alt)',
      color: 'var(--fg)',
      borderBottom: '1px solid var(--border)',
      padding: '6px 8px',
      fontFamily: 'var(--font-ui)',
      fontSize: '12px',
    },

    // Tooltips and autocomplete.
    '.cm-tooltip': {
      backgroundColor: 'var(--bg-elevated)',
      color: 'var(--fg)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      boxShadow: 'var(--shadow)',
    },
    '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'var(--border)', borderBottomColor: 'var(--border)' },
    '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--bg-elevated)', borderBottomColor: 'var(--bg-elevated)' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: monoFont, fontSize: '0.92em', maxHeight: '260px' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px', lineHeight: '1.5' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--active)', color: 'var(--fg)' },
    '.cm-completionDetail': { color: 'var(--fg-muted)', fontStyle: 'normal', marginLeft: '8px' },
    '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600', color: 'var(--accent)' },
    '.cm-completionInfo': { backgroundColor: 'var(--bg-elevated)', color: 'var(--fg)', border: '1px solid var(--border)' },
    '.cm-tooltip-hover, .cm-lsp-documentation': { padding: '4px 8px', maxWidth: '640px' },

    // Lint (diagnostics from LSP).
    '.cm-diagnostic': { padding: '3px 8px', fontFamily: 'var(--font-ui)', fontSize: '12px' },
    '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
    '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warn)' },
    '.cm-diagnostic-info': { borderLeft: '3px solid var(--info)' },
    '.cm-diagnostic-hint': { borderLeft: '3px solid var(--fg-faint)' },
    '.cm-lintRange-error': {
      backgroundImage: 'none',
      textDecoration: 'underline wavy var(--danger)',
      textUnderlineOffset: '3px',
      paddingBottom: '0',
    },
    '.cm-lintRange-warning': {
      backgroundImage: 'none',
      textDecoration: 'underline wavy var(--warn)',
      textUnderlineOffset: '3px',
      paddingBottom: '0',
    },
    '.cm-lintRange-info, .cm-lintRange-hint': {
      backgroundImage: 'none',
      textDecoration: 'underline wavy var(--info)',
      textUnderlineOffset: '3px',
      paddingBottom: '0',
    },
    '.cm-panel.cm-panel-lint ul [aria-selected]': { backgroundColor: 'var(--active)', color: 'var(--fg)' },
  }),
);

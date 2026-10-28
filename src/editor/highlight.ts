// One tag highlighter for the editor and for HTML output (preview code blocks).
// It maps Lezer tags to `tok-*` classes. The colors come from the CSS
// variables `--tok-*` in tokens.css, so both themes use the same classes.

import type { Language } from '@codemirror/language';
import { highlightCode, tagHighlighter, tags, type Tag } from '@lezer/highlight';
import { escapeText } from './text';
import { docTagTag, interpolationTag } from './tags';

interface TokenClass {
  /** Class name. The color variable has the same name with `--` in front. */
  cls: string;
  tags: Tag[];
  /** Extra CSS, for example italic text. */
  style?: string;
  /** False for classes that only change the font style. */
  color?: boolean;
}

const t = tags;

export const TOKEN_CLASSES: TokenClass[] = [
  { cls: 'tok-comment', tags: [t.comment], style: 'font-style:italic' },
  { cls: 'tok-doc-comment', tags: [t.docComment], style: 'font-style:italic' },
  { cls: 'tok-doc-tag', tags: [docTagTag], style: 'font-style:italic' },
  { cls: 'tok-keyword', tags: [t.keyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword] },
  { cls: 'tok-control', tags: [t.controlKeyword] },
  { cls: 'tok-modifier', tags: [t.modifier] },
  { cls: 'tok-self', tags: [t.self, t.special(t.variableName)], style: 'font-style:italic' },
  { cls: 'tok-constant', tags: [t.atom, t.bool, t.null, t.constant(t.variableName), t.constant(t.name), t.constant(t.propertyName)] },
  { cls: 'tok-builtin', tags: [t.standard(t.variableName), t.standard(t.typeName), t.standard(t.propertyName), t.standard(t.className)] },
  { cls: 'tok-type', tags: [t.typeName, t.className] },
  { cls: 'tok-namespace', tags: [t.namespace] },
  { cls: 'tok-function-def', tags: [t.definition(t.function(t.variableName)), t.definition(t.function(t.propertyName))] },
  { cls: 'tok-function', tags: [t.function(t.variableName), t.function(t.propertyName), t.macroName] },
  { cls: 'tok-variable-def', tags: [t.definition(t.variableName)] },
  { cls: 'tok-property', tags: [t.propertyName] },
  { cls: 'tok-attribute', tags: [t.attributeName] },
  { cls: 'tok-tag', tags: [t.tagName] },
  { cls: 'tok-label', tags: [t.labelName] },
  { cls: 'tok-variable', tags: [t.variableName, t.name] },
  { cls: 'tok-string', tags: [t.string] },
  { cls: 'tok-escape', tags: [t.escape] },
  { cls: 'tok-regexp', tags: [t.regexp] },
  { cls: 'tok-interpolation', tags: [interpolationTag] },
  { cls: 'tok-number', tags: [t.number, t.color, t.unit] },
  { cls: 'tok-punctuation', tags: [t.punctuation, t.derefOperator] },
  { cls: 'tok-operator', tags: [t.operator] },
  { cls: 'tok-annotation', tags: [t.annotation] },
  { cls: 'tok-meta', tags: [t.meta] },
  { cls: 'tok-heading', tags: [t.heading], style: 'font-weight:bold' },
  { cls: 'tok-strong', tags: [t.strong], style: 'font-weight:bold', color: false },
  { cls: 'tok-emphasis', tags: [t.emphasis], style: 'font-style:italic', color: false },
  { cls: 'tok-strikethrough', tags: [t.strikethrough], style: 'text-decoration:line-through', color: false },
  { cls: 'tok-link', tags: [t.link], style: 'text-decoration:underline' },
  { cls: 'tok-url', tags: [t.url] },
  { cls: 'tok-quote', tags: [t.quote] },
  { cls: 'tok-list', tags: [t.list] },
  { cls: 'tok-monospace', tags: [t.monospace] },
  { cls: 'tok-inserted', tags: [t.inserted] },
  { cls: 'tok-deleted', tags: [t.deleted] },
  { cls: 'tok-changed', tags: [t.changed] },
  { cls: 'tok-invalid', tags: [t.invalid] },
];

export const kestrelHighlighter = tagHighlighter(TOKEN_CLASSES.flatMap((c) => c.tags.map((tag) => ({ tag, class: c.cls }))));

/** Highlights code with a parsed language. Returns HTML (text is escaped). */
export function highlightToHtmlString(code: string, language: Language | null): string {
  if (!language) return escapeText(code);
  const tree = language.parser.parse(code);
  let html = '';
  highlightCode(
    code,
    tree,
    kestrelHighlighter,
    (text, classes) => {
      const safe = escapeText(text);
      html += classes ? `<span class="${classes}">${safe}</span>` : safe;
    },
    () => {
      html += '\n';
    },
  );
  return html;
}

/**
 * CSS for all `tok-*` classes with resolved colors. `read` returns the value
 * of a CSS variable, for example `--tok-keyword`. An iframe cannot see the
 * variables of the app, so previews need the resolved values.
 */
export function buildHighlightCss(read: (variable: string) => string): string {
  const rules: string[] = [];
  for (const c of TOKEN_CLASSES) {
    const parts: string[] = [];
    if (c.color !== false) {
      const value = read(`--${c.cls}`).trim();
      if (value) parts.push(`color:${value}`);
    }
    if (c.style) parts.push(c.style);
    if (parts.length) rules.push(`.${c.cls}{${parts.join(';')}}`);
  }
  return rules.join('\n');
}

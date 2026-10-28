// Small text helpers without DOM. They are easy to test.

import type { Text } from '@codemirror/state';

export function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Ranges of trailing spaces and tabs at the end of lines. */
export function trailingWhitespaceChanges(doc: Text): TextChange[] {
  const changes: TextChange[] = [];
  const it = doc.iterLines();
  let pos = 0;
  for (let r = it.next(); !r.done; r = it.next()) {
    const line = r.value;
    const last = line.charCodeAt(line.length - 1);
    if (last === 32 || last === 9) {
      let start = line.length - 1;
      while (start > 0) {
        const c = line.charCodeAt(start - 1);
        if (c !== 32 && c !== 9) break;
        start--;
      }
      changes.push({ from: pos + start, to: pos + line.length, insert: '' });
    }
    pos += line.length + 1;
  }
  return changes;
}

/** The change that adds a final line break, or null when there is one (or the text is empty). */
export function finalNewlineChange(doc: Text): TextChange | null {
  if (doc.length === 0) return null;
  const last = doc.sliceString(doc.length - 1, doc.length);
  return last === '\n' ? null : { from: doc.length, to: doc.length, insert: '\n' };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The smallest single change that turns `oldText` into `newText`
 * (common start and common end are kept). Returns null when they are equal.
 */
export function minimalChange(oldText: string, newText: string): TextChange | null {
  if (oldText === newText) return null;
  const max = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  // Do not cut a surrogate pair in half.
  if (start > 0 && isHighSurrogate(oldText.charCodeAt(start - 1))) start--;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  if (endOld < oldText.length && isLowSurrogate(oldText.charCodeAt(endOld))) {
    endOld++;
    endNew++;
  }
  return { from: start, to: endOld, insert: newText.slice(start, endNew) };
}

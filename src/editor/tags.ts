// Extra highlight tags for the Kotlin tokenizer. They live in their own file so
// the highlighter (loaded at startup) does not pull in the tokenizer.

import { Tag, tags } from '@lezer/highlight';

/** `${` and `}` of a string template, and `$name`. */
export const interpolationTag = Tag.define('interpolation', tags.string);

/** `@param`, `@return` and other tags inside KDoc comments. */
export const docTagTag = Tag.define('docTag', tags.docComment);

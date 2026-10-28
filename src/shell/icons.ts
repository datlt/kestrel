import { createElement } from 'lucide';
import type { IconNode } from 'lucide';

/** Creates a lucide icon element. The size comes from CSS (`.shell-icon`). */
export function icon(node: IconNode, extraClass?: string): SVGElement {
  const el = createElement(node);
  el.removeAttribute('width');
  el.removeAttribute('height');
  el.classList.add('shell-icon');
  if (extraClass) el.classList.add(extraClass);
  return el;
}

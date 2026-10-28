// Tiny DOM helper. Text children are added as text nodes (safe for any data).

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener> & {
  class?: string;
  style?: string;
};

/**
 * h('div', { class: 'row', onclick: fn }, 'text', child)
 * Attributes that start with `on` become event listeners.
 * `true` sets an empty attribute, `false`/null/undefined skips it.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'object' ? c : String(c));
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

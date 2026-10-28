// DOM part of the rules for HTML from other people. The HTML comes from
// `mdRenderSafe` (Rust). This adds a second check before it enters the page.

import { mdRenderSafe } from '../../ipc/preview';
import { externalLink, FORBIDDEN_TAGS, isAllowedImage } from './rendered-rules';

/** Cleans HTML from `mdRenderSafe`: removes risky tags and attributes, keeps only images of the PR host. */
export function cleanHtml(html: string, prHost: string): string {
  const tpl = document.createElement('template');
  // The text comes from mdRenderSafe. Nothing else is ever put in here.
  tpl.innerHTML = html;
  const root = tpl.content;
  for (const el of Array.from(root.querySelectorAll(FORBIDDEN_TAGS.join(',')))) el.remove();
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (!isAllowedImage(img.getAttribute('src'), prHost)) {
      img.remove();
      continue;
    }
    img.removeAttribute('srcset');
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.setAttribute('loading', 'lazy');
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on') || attr.name === 'style' || attr.name === 'srcdoc') el.removeAttribute(attr.name);
    }
  }
  for (const a of Array.from(root.querySelectorAll('a'))) {
    a.removeAttribute('target');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  const holder = document.createElement('div');
  holder.append(root);
  return holder.innerHTML;
}

/** Markdown from another person to safe HTML. Shows the plain text when rendering fails. */
export async function renderSafe(markdown: string, prHost: string): Promise<string> {
  if (!markdown.trim()) return '';
  const html = await mdRenderSafe(markdown);
  return cleanHtml(html, prHost);
}

/**
 * Makes every link click inside `root` open in the system browser. The page of
 * Kestrel never navigates. Returns a function that removes the listener.
 */
export function routeLinks(root: HTMLElement, baseUrl: string): () => void {
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a || !root.contains(a)) return;
    e.preventDefault();
    e.stopPropagation();
    const url = externalLink(a.getAttribute('href'), baseUrl);
    if (url) openExternal(url);
  };
  root.addEventListener('click', onClick, true);
  root.addEventListener('auxclick', onClick, true);
  return () => {
    root.removeEventListener('click', onClick, true);
    root.removeEventListener('auxclick', onClick, true);
  };
}

export function openExternal(url: string): void {
  import('@tauri-apps/plugin-opener')
    .then((m) => m.openUrl(url))
    .catch((err) => console.error('could not open the browser', err));
}

/** Renders markdown from another person into `el`. Only cleaned `mdRenderSafe` HTML is put in. */
export async function renderInto(el: HTMLElement, markdown: string, prHost: string): Promise<void> {
  const html = await renderSafe(markdown, prHost);
  el.innerHTML = html;
}

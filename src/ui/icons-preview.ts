// Dev only. Shows every icon id in both themes. Not part of the app bundle.
import '../styles/vars.css';
import { allIconIds, fileIconById } from './file-icons';

const root = document.getElementById('app') as HTMLElement;

function pane(theme: 'dark' | 'light'): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pane';
  const title = document.createElement('h2');
  title.textContent = `${theme} theme`;
  el.append(title);
  const groups: [string, string[]][] = [
    ['Files', allIconIds().filter((i) => !i.startsWith('folder'))],
    ['Folders', allIconIds().filter((i) => i.startsWith('folder'))],
  ];
  for (const [label, ids] of groups) {
    const h = document.createElement('h3');
    h.textContent = `${label} (${ids.length})`;
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const id of ids) {
      const item = document.createElement('div');
      item.className = 'item';
      const code = document.createElement('code');
      code.textContent = id;
      item.append(fileIconById(id), code);
      grid.append(item);
    }
    el.append(h, grid);
  }
  return el;
}

// Both themes are shown at once. vars.css only reacts to the theme on the
// root element, so read the values for each theme and set them on each pane.
function themeVars(theme: 'dark' | 'light'): string {
  document.documentElement.dataset.theme = theme;
  const cs = getComputedStyle(document.documentElement);
  const names = ['--bg-alt', '--fg', '--fg-muted', '--font-ui', '--font-mono'];
  const colors = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown', 'gray', 'slate', 'folder'];
  for (const c of colors) names.push(`--fi-${c}`);
  names.push('--fi-ink');
  return names.map((n) => `${n}:${cs.getPropertyValue(n)}`).join(';');
}

for (const theme of ['dark', 'light'] as const) {
  const vars = themeVars(theme);
  const p = pane(theme);
  p.style.cssText = vars;
  root.append(p);
}
document.documentElement.dataset.theme = 'dark';

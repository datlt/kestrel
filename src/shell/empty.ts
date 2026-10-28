// The empty editor area: logo, "Open Folder", recent folders and key hints.

import { h } from '../core/dom';
import type { AppContext, Command } from '../core/types';

const HINTS: [string, string][] = [
  ['workbench.commandPalette', 'Command Palette'],
  ['search.quickOpen', 'Go to File'],
  ['workbench.showSearch', 'Find in Files'],
  ['workbench.toggleSidebar', 'Toggle Sidebar'],
  ['workspace.openFolder', 'Open Folder'],
  ['file.newDraft', 'New Draft'],
];

const RECENT_MAX = 6;

function logo(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'shell-empty-logo');
  svg.setAttribute('aria-hidden', 'true');
  const frame = document.createElementNS(ns, 'rect');
  frame.setAttribute('x', '4');
  frame.setAttribute('y', '4');
  frame.setAttribute('width', '56');
  frame.setAttribute('height', '56');
  frame.setAttribute('rx', '14');
  frame.setAttribute('fill', 'none');
  frame.setAttribute('stroke', 'currentColor');
  frame.setAttribute('stroke-width', '3');
  const k = document.createElementNS(ns, 'path');
  k.setAttribute('d', 'M22 16v32M44 16L26 33l18 15');
  k.setAttribute('fill', 'none');
  k.setAttribute('stroke', 'var(--accent)');
  k.setAttribute('stroke-width', '5');
  k.setAttribute('stroke-linecap', 'round');
  k.setAttribute('stroke-linejoin', 'round');
  svg.append(frame, k);
  return svg;
}

export function createEmptyState(ctx: AppContext) {
  const el = h('div', { class: 'shell-empty' });
  let token = 0;

  function firstBinding(cmd: Command | undefined): string | undefined {
    if (!cmd?.keybinding) return undefined;
    return Array.isArray(cmd.keybinding) ? cmd.keybinding[0] : cmd.keybinding;
  }

  function openFolder() {
    ctx.window.pickFolder().catch((err) => {
      ctx.ui.notify(`Could not open the folder: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    });
  }

  async function refresh() {
    const mine = ++token;
    const hints = h('div', { class: 'shell-empty-hints' });
    for (const [id, label] of HINTS) {
      const cmd = ctx.commands.get(id);
      const binding = firstBinding(cmd);
      if (!cmd || !binding) continue;
      hints.append(
        h('div', { class: 'shell-empty-hint' }, h('span', {}, label), h('kbd', { class: 'shell-kbd' }, ctx.commands.keyLabel(binding))),
      );
    }

    const root = ctx.workspace.root;
    const recentBox = h('div', { class: 'shell-empty-recent' });
    el.replaceChildren(
      logo(),
      h('div', { class: 'shell-empty-title' }, 'Kestrel'),
      root ? h('div', { class: 'shell-empty-sub' }, ctx.workspace.name ?? root) : h('div', { class: 'shell-empty-sub' }, 'A small, fast code editor'),
      h(
        'div',
        { class: 'shell-empty-actions' },
        h('button', { class: 'shell-btn shell-btn-primary', onclick: openFolder }, 'Open Folder'),
        // The "+" of the tab bar is hidden when no tab is open, so offer drafts here too.
        h('button', { class: 'shell-btn', onclick: () => void ctx.commands.execute('file.newDraft') }, 'New Draft'),
      ),
      recentBox,
      hints,
    );

    let recent: Awaited<ReturnType<AppContext['workspace']['recent']>> = [];
    try {
      recent = await ctx.workspace.recent();
    } catch {
      return;
    }
    if (mine !== token) return;
    const list = recent.filter((r) => r.path !== root).slice(0, RECENT_MAX);
    if (!list.length) return;
    recentBox.append(h('div', { class: 'shell-empty-heading' }, 'Recent'));
    for (const r of list) {
      recentBox.append(
        h(
          'button',
          {
            class: 'shell-empty-recent-item',
            title: r.path,
            onclick: () => {
              ctx.window.openFolder(r.path).catch((err) => {
                ctx.ui.notify(`Could not open ${r.path}: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
              });
            },
          },
          h('span', { class: 'shell-empty-recent-name' }, r.name),
          h('span', { class: 'shell-empty-recent-path' }, r.path),
        ),
      );
    }
  }

  return { el, refresh };
}

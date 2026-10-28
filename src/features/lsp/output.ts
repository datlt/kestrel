// Output panel (view id `lsp-output`): stderr and log lines of the language servers.
import { createElement, SquareTerminal } from 'lucide';
import type { ViewDescriptor, ViewInstance } from '../../core/types';
import { h } from '../../core/dom';
import { debounce } from '../../core/util';
import type { LspManager } from './manager';
import type { Session } from './session';

export function createOutputView(manager: LspManager): ViewDescriptor {
  return {
    id: 'lsp-output',
    title: 'Language servers',
    location: 'panel',
    order: 20,
    icon: () => createElement(SquareTerminal),
    create(host): ViewInstance {
      host.classList.add('lsp-output');
      const select = h('select', { class: 'lsp-output-select', title: 'Language server' });
      const restart = h('button', { class: 'lsp-output-button', onclick: () => current && void manager.restart(current) }, 'Restart');
      const clearBtn = h(
        'button',
        {
          class: 'lsp-output-button',
          onclick: () => {
            if (current) current.logs.length = 0;
            show();
          },
        },
        'Clear',
      );
      const bar = h('div', { class: 'lsp-output-bar' }, select, restart, clearBtn);
      const pre = h('pre', { class: 'lsp-output-text' });
      host.append(bar, pre);

      let current: Session | null = null;
      let visible = true;

      const fillSelect = () => {
        const sessions = manager.list();
        const wanted = current && sessions.includes(current) ? current : (sessions[0] ?? null);
        select.replaceChildren(
          ...sessions.map((s, i) => h('option', { value: String(i), selected: s === wanted }, `${s.serverId} (${s.root})`)),
        );
        current = wanted;
        restart.toggleAttribute('disabled', !current);
      };

      const show = () => {
        if (!visible) return;
        const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
        pre.textContent = current ? current.logs.join('\n') : 'No language server has started yet.';
        if (atEnd) pre.scrollTop = pre.scrollHeight;
      };
      const showSoon = debounce(show, 100);

      select.addEventListener('change', () => {
        current = manager.list()[Number(select.value)] ?? null;
        restart.toggleAttribute('disabled', !current);
        show();
        pre.scrollTop = pre.scrollHeight;
      });

      const subs = [
        manager.onLog((s) => {
          if (s === current) showSoon();
        }),
        manager.onChange(() => {
          fillSelect();
          showSoon();
        }),
      ];
      fillSelect();
      return {
        onShow() {
          visible = true;
          fillSelect();
          show();
          pre.scrollTop = pre.scrollHeight;
        },
        onHide() {
          visible = false;
        },
        dispose() {
          subs.forEach((s) => s.dispose());
        },
      };
    },
  };
}

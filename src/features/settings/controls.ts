// Input controls for the Settings screen. Each control has no shared state.
import type { DbConnectionConfig } from '../../ipc/db';
import { h } from '../../core/dom';
import type { LspServerConfig } from '../../core/types';
import { checkNumber, type SettingDef } from './schema';

export interface Control {
  el: HTMLElement;
  /** Shows a new value from settings. Does not call `commit`. */
  set(value: unknown): void;
}

/** Enter inside an IME composition only confirms the text. It must not save. */
function isEnter(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
}

export function switchControl(label: string, commit: (v: boolean) => void): Control {
  const btn = h('button', {
    class: 'settings-switch',
    type: 'button',
    role: 'switch',
    'aria-checked': 'false',
    'aria-label': label,
  });
  btn.append(h('span', { class: 'settings-switch-knob' }));
  btn.addEventListener('click', () => commit(btn.getAttribute('aria-checked') !== 'true'));
  return {
    el: btn,
    set: (v) => btn.setAttribute('aria-checked', v ? 'true' : 'false'),
  };
}

export function selectControl(def: SettingDef, commit: (v: string) => void): Control {
  const sel = h('select', { class: 'settings-select', 'aria-label': def.title });
  for (const o of def.options ?? []) sel.append(h('option', { value: o.value }, o.label));
  sel.addEventListener('change', () => commit(sel.value));
  return {
    el: sel,
    set: (v) => {
      sel.value = String(v);
    },
  };
}

export function numberControl(def: SettingDef, commit: (v: number) => void): Control {
  const input = h('input', {
    class: 'settings-input settings-input-number',
    type: 'number',
    'aria-label': def.title,
    min: def.min,
    max: def.max,
    step: def.step,
  });
  const error = h('div', { class: 'settings-error', role: 'alert', hidden: true });
  // The text of the last saved or shown value. It stops a double save (Enter, then blur).
  let settled = '';

  function validate(): boolean {
    const r = checkNumber(input.value, def);
    input.classList.toggle('settings-invalid', !r.ok);
    input.setAttribute('aria-invalid', r.ok ? 'false' : 'true');
    error.hidden = r.ok;
    if (!r.ok) error.textContent = r.error;
    return r.ok;
  }
  function save() {
    if (input.value === settled) return;
    const r = checkNumber(input.value, def);
    if (!validate() || !r.ok) return;
    settled = input.value;
    commit(r.value);
  }
  input.addEventListener('input', () => {
    // Show the error while typing, but save only on change or blur.
    if (input.value !== settled) validate();
  });
  input.addEventListener('change', save);
  input.addEventListener('keydown', (e) => {
    if (isEnter(e)) save();
    else if (e.key === 'Escape' && input.value !== settled) {
      input.value = settled;
      validate();
      e.stopPropagation();
    }
  });
  input.addEventListener('blur', () => {
    // A bad value is dropped when the user leaves the field.
    if (!validate()) {
      input.value = settled;
      validate();
    }
  });
  const wrap = h('div', { class: 'settings-number' }, h('div', { class: 'settings-number-line' }, input, def.unit ? h('span', { class: 'settings-unit' }, def.unit) : null), error);
  return {
    el: wrap,
    set: (v) => {
      settled = String(v);
      if (document.activeElement !== input || input.value === settled) input.value = settled;
      validate();
    },
  };
}

export function textControl(def: SettingDef, commit: (v: string) => void): Control {
  const input = h('input', {
    class: 'settings-input settings-input-text',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': def.title,
    placeholder: def.placeholder,
  });
  let settled = '';
  function save() {
    const v = input.value.trim();
    if (v === settled) return;
    settled = v;
    commit(v);
  }
  input.addEventListener('change', save);
  input.addEventListener('keydown', (e) => {
    if (isEnter(e)) save();
    else if (e.key === 'Escape' && input.value !== settled) {
      input.value = settled;
      e.stopPropagation();
    }
  });
  return {
    el: input,
    set: (v) => {
      settled = String(v);
      if (document.activeElement !== input) input.value = settled;
    },
  };
}

export function listControl(def: SettingDef, commit: (v: string[]) => void): Control {
  const list = h('div', { class: 'settings-list' });
  const items = h('div', { class: 'settings-list-items' });
  const addInput = h('input', {
    class: 'settings-input settings-input-text',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: def.placeholder ? `Add, for example ${def.placeholder}` : 'Add an entry',
    'aria-label': `Add to ${def.title}`,
  });
  const addBtn = h('button', { class: 'settings-btn', type: 'button' }, 'Add');
  let values: string[] = [];

  function render() {
    items.replaceChildren();
    values.forEach((val, i) => {
      const input = h('input', {
        class: 'settings-input settings-input-text',
        type: 'text',
        spellcheck: 'false',
        'aria-label': `${def.title} entry ${i + 1}`,
      });
      input.value = val;
      const save = () => {
        const next = input.value.trim();
        if (next === values[i]) return;
        const copy = values.slice();
        if (next) copy[i] = next;
        else copy.splice(i, 1);
        commit(copy);
      };
      input.addEventListener('change', save);
      input.addEventListener('keydown', (e) => {
        if (isEnter(e)) save();
        else if (e.key === 'Escape') {
          input.value = values[i] ?? '';
          e.stopPropagation();
        }
      });
      const remove = h(
        'button',
        {
          class: 'settings-icon-btn',
          type: 'button',
          title: 'Remove',
          'aria-label': `Remove ${val}`,
          onclick: () => commit(values.filter((_, j) => j !== i)),
        },
        '×',
      );
      items.append(h('div', { class: 'settings-list-item' }, input, remove));
    });
  }
  function add() {
    const v = addInput.value.trim();
    if (!v || values.includes(v)) {
      addInput.value = '';
      return;
    }
    addInput.value = '';
    commit([...values, v]);
  }
  addBtn.addEventListener('click', add);
  addInput.addEventListener('keydown', (e) => {
    if (isEnter(e)) {
      e.preventDefault();
      add();
    }
  });
  list.append(items, h('div', { class: 'settings-list-add' }, addInput, addBtn));
  return {
    el: list,
    set: (v) => {
      values = Array.isArray(v) ? v.map(String) : [];
      // Do not rebuild while the user edits one of the entries.
      if (!items.contains(document.activeElement)) render();
    },
  };
}

export function lspTableControl(openJson: () => void): Control {
  const wrap = h('div', { class: 'settings-lsp' });
  const body = h('div', { class: 'settings-table-wrap' });
  const btn = h('button', { class: 'settings-btn', type: 'button', onclick: openJson }, 'Edit in settings.json');
  wrap.append(body, h('div', { class: 'settings-lsp-actions' }, btn));
  return {
    el: wrap,
    set: (v) => {
      const servers = (v && typeof v === 'object' ? v : {}) as Record<string, LspServerConfig>;
      const ids = Object.keys(servers);
      body.replaceChildren();
      if (ids.length === 0) {
        body.append(h('div', { class: 'settings-empty-note' }, 'No language servers are set.'));
        return;
      }
      const table = h('table', { class: 'settings-table' });
      table.append(
        h('thead', null, h('tr', null, h('th', null, 'Server'), h('th', null, 'Command'), h('th', null, 'Languages'))),
      );
      const tb = h('tbody');
      for (const id of ids) {
        const s = servers[id];
        const off = s?.enabled === false;
        tb.append(
          h(
            'tr',
            { class: off ? 'settings-row-off' : '' },
            h('td', null, id, off ? h('span', { class: 'settings-tag' }, 'disabled') : null),
            h('td', { class: 'settings-mono' }, Array.isArray(s?.command) ? s.command.join(' ') : ''),
            h('td', null, Array.isArray(s?.languages) ? s.languages.join(', ') : ''),
          ),
        );
      }
      table.append(tb);
      body.append(table);
    },
  };
}

/** Read-only list of database connections, with a button that opens the Database view. */
export function dbConnectionsControl(openView: () => void): Control {
  const wrap = h('div', { class: 'settings-lsp' });
  const body = h('div', { class: 'settings-table-wrap' });
  const btn = h('button', { class: 'settings-btn', type: 'button', onclick: openView }, 'Edit in the Database view');
  wrap.append(body, h('div', { class: 'settings-lsp-actions' }, btn));
  return {
    el: wrap,
    set: (v) => {
      const list = (Array.isArray(v) ? v : []) as DbConnectionConfig[];
      body.replaceChildren();
      if (list.length === 0) {
        body.append(h('div', { class: 'settings-empty-note' }, 'No connections yet.'));
        return;
      }
      const table = h('table', { class: 'settings-table' });
      table.append(h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Server'), h('th', null, 'Options'))));
      const tb = h('tbody');
      for (const c of list) {
        const tags = [c.production ? 'production' : '', c.readOnly ? 'read-only' : '', c.ssh?.host ? `ssh ${c.ssh.host}` : '']
          .filter(Boolean)
          .map((t) => h('span', { class: 'settings-tag' }, t));
        tb.append(
          h(
            'tr',
            null,
            h('td', null, c.name || '(no name)'),
            h('td', { class: 'settings-mono' }, `${c.user}@${c.host}:${c.port}${c.database ? '/' + c.database : ''}`),
            h('td', null, ...tags),
          ),
        );
      }
      table.append(tb);
      body.append(table);
    },
  };
}

export function jsonControl(): Control {
  const pre = h('pre', { class: 'settings-json' });
  return {
    el: pre,
    set: (v) => {
      pre.textContent = JSON.stringify(v, null, 2) ?? String(v);
    },
  };
}

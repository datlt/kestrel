// DDL tab (kind `db-ddl`): the CREATE statement of a table, view, procedure,
// function or trigger, read-only, with SQL colors, and Copy and Refresh buttons.

import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { Copy, createElement, RefreshCw } from 'lucide';
import { h } from '../../core/dom';
import type { TabContent } from '../../core/types';
import { dbDdl } from '../../ipc/db';
import { describeError } from './errors';
import type { DbHub } from './hub';
import type { DdlSpec } from './tabs';
import './db.css';

export class DdlContent implements TabContent {
  private view: EditorView | null = null;
  private disposed = false;
  private token = 0;
  private text = '';
  private readonly body = h('div', { class: 'db-ddl-body' });
  private readonly note = h('span', { class: 'db-faint' });
  private readonly root = h('div', { class: 'db-ddl' });
  private language: Promise<import('@codemirror/language').Language | null>;

  constructor(
    private readonly hub: DbHub,
    private readonly spec: DdlSpec,
    host: HTMLElement,
  ) {
    const conn = hub.find(spec.connId);
    const copy = h('button', { class: 'db-btn db-tool', type: 'button', title: 'Copy the SQL text', onclick: () => void this.copy() }, createElement(Copy), h('span', null, 'Copy'));
    const refresh = h('button', { class: 'db-btn db-tool', type: 'button', title: 'Read the DDL from the server again', onclick: () => void this.load() }, createElement(RefreshCw), h('span', null, 'Refresh'));
    this.root.append(
      h(
        'div',
        { class: 'db-toolbar' },
        h('span', { class: 'db-ddl-title' }, `${spec.database}.${spec.name}`),
        h('span', { class: 'db-faint' }, `${spec.kind} on ${conn?.name ?? 'a deleted connection'}`),
        h('span', { class: 'db-spacer' }),
        this.note,
        copy,
        refresh,
      ),
      this.body,
    );
    host.append(this.root);
    this.language = hub.ctx.editors.loadLanguage('sql').catch(() => null);
    void this.load();
  }

  private async load(): Promise<void> {
    const token = ++this.token;
    const { connId, database, name, kind } = this.spec;
    this.note.textContent = 'Loading...';
    try {
      const sqlText = await this.hub.meta(connId, this.root).run((sid) => dbDdl(sid, database, name, kind));
      if (this.disposed || token !== this.token) return;
      this.text = sqlText;
      await this.show(sqlText);
      this.note.textContent = '';
    } catch (e) {
      if (this.disposed || token !== this.token) return;
      this.note.textContent = '';
      this.view?.destroy();
      this.view = null;
      this.body.replaceChildren(h('div', { class: 'db-ddl-error' }, describeError(e).text));
    }
  }

  private async show(text: string): Promise<void> {
    const lang = await this.language;
    if (this.disposed) return;
    this.view?.destroy();
    this.body.replaceChildren();
    this.view = new EditorView({
      parent: this.body,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          this.hub.ctx.editors.highlightExtension(),
          ...(lang ? [lang.extension] : []),
        ],
      }),
    });
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.text);
      this.hub.ctx.ui.notify('Copied the SQL text.', { timeoutMs: 1500 });
    } catch {
      this.hub.ctx.ui.notify('Cannot copy to the clipboard.', { kind: 'warn' });
    }
  }

  focus(): void {
    this.view?.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.view?.destroy();
    this.root.remove();
  }
}

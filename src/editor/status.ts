// Status bar items of the editor: cursor, indentation, encoding, line ending, language.

import type { AppContext, StatusItem } from '../core/types';
import { encodingLabel } from './encodings';
import type { FileEditorImpl } from './file-editor';

const IDS = ['editor.cursor', 'editor.indent', 'editor.encoding', 'editor.eol', 'editor.language'] as const;

export class EditorStatus {
  /** Last shown text per item id, so we only call the shell when something changed. */
  private shown = new Map<string, string>();

  constructor(private readonly ctx: AppContext) {}

  /** Shows the items for `ed`, or removes them when `ed` is null. */
  show(ed: FileEditorImpl | null): void {
    if (!ed) {
      for (const id of IDS) this.ctx.status.remove(id);
      this.shown.clear();
      return;
    }
    const c = ed.cursorInfo();
    let cursor = `Ln ${c.line}, Col ${c.column}`;
    if (c.ranges > 1) cursor += ` (${c.ranges} selections)`;
    else if (c.selected > 0) cursor += ` (${c.selected} selected)`;

    const indent = ed.indentInfo();
    const items: StatusItem[] = [
      { id: 'editor.cursor', align: 'right', priority: 100, text: cursor, tooltip: 'Go to Line', command: 'editor.gotoLine' },
      {
        id: 'editor.indent',
        align: 'right',
        priority: 90,
        text: indent.insertSpaces ? `Spaces: ${indent.size}` : `Tab Size: ${indent.size}`,
        tooltip: 'Select Indentation',
        command: 'editor.changeIndentation',
      },
      {
        id: 'editor.encoding',
        align: 'right',
        priority: 80,
        text: encodingLabel(ed.meta.encoding, ed.meta.bom),
        tooltip: 'Select Encoding',
        command: 'editor.changeEncoding',
      },
      {
        id: 'editor.eol',
        align: 'right',
        priority: 70,
        text: ed.meta.lineEnding.toUpperCase(),
        tooltip: 'Toggle End of Line Sequence (LF / CRLF)',
        command: 'editor.toggleLineEnding',
      },
      {
        id: 'editor.language',
        align: 'right',
        priority: 60,
        text: ed.languageLabel(),
        tooltip: ed.large ? 'Large file: syntax colors and language features are off' : 'Select Language Mode',
        command: ed.large ? undefined : 'editor.changeLanguage',
      },
    ];
    for (const item of items) {
      const key = `${item.text}\u0000${item.tooltip}`;
      if (this.shown.get(item.id) === key) continue;
      this.shown.set(item.id, key);
      this.ctx.status.set(item);
    }
  }
}

// The commands of the editor engine (DESIGN.md, section 6).

import { gotoLine } from '@codemirror/search';
import type { Command, Disposable, QuickPickItem } from '../core/types';
import { deleteDraftFile, listDrafts } from './draft-ops';
import { ENCODINGS, encodingLabel } from './encodings';
import type { FileEditorImpl } from './file-editor';
import { LANGUAGES } from './languages';
import type { EditorEngine } from './service';

const DELETE_ROW = '__delete';

export function registerEngineCommands(engine: EditorEngine): Disposable {
  const { ctx } = engine;
  const active = () => engine.active();
  const hasEditor = () => active() !== null;
  const hasPreview = () => active()?.hasPreview() === true;

  function pick<T extends QuickPickItem>(placeholder: string, items: T[], onAccept: (item: T) => void): void {
    ctx.ui.quickPick<T>({ placeholder, items, onAccept });
  }

  async function reopenWith(ed: FileEditorImpl, encoding: string): Promise<void> {
    if (ed.isDirty()) {
      const choice = await ctx.ui.confirm({
        title: 'Discard changes?',
        message: `${ed.title} has unsaved changes. Reopening with another encoding reads the file from disk again.`,
        buttons: ['Reopen', 'Cancel'],
      });
      if (choice !== 'Reopen') return;
    }
    await ed.reload({ encoding });
  }

  const when = (ms: number) => new Date(ms).toLocaleString();

  async function draftItems(): Promise<QuickPickItem[]> {
    const drafts = await listDrafts(engine);
    return drafts.map((d) => ({
      id: d.path,
      label: d.title,
      description: d.mtimeMs ? when(d.mtimeMs) : undefined,
      detail: d.preview || '(empty)',
    }));
  }

  /** Quick pick of all drafts, newest first. The last row deletes a draft. */
  async function openDraftPicker(): Promise<void> {
    const items = await draftItems();
    if (!items.length) {
      ctx.ui.notify('There are no drafts yet. Press the New Draft key to make one.', { kind: 'info' });
      return;
    }
    items.push({ id: DELETE_ROW, label: 'Delete a draft...', detail: 'Pick a draft to delete it' });
    ctx.ui.quickPick({
      placeholder: 'Open a draft',
      items,
      onAccept: (item) => {
        if (item.id === DELETE_ROW) void deleteDraftPicker();
        else void engine.openFile(item.id);
      },
    });
  }

  async function deleteDraftPicker(): Promise<void> {
    const items = await draftItems();
    if (!items.length) {
      ctx.ui.notify('There are no drafts to delete.', { kind: 'info' });
      return;
    }
    ctx.ui.quickPick({
      placeholder: 'Delete a draft',
      items,
      onAccept: (item) => void deleteDraft(item.id, item.label, item.detail === '(empty)'),
    });
  }

  async function deleteDraft(path: string, title: string, empty: boolean): Promise<void> {
    if (!empty) {
      const choice = await ctx.ui.confirm({
        title: `Delete ${title}?`,
        message: 'The text of this draft is deleted for good.',
        buttons: ['Delete', 'Cancel'],
      });
      if (choice !== 'Delete') return;
    }
    try {
      // Close the tab first, so auto save does not write the file again.
      await ctx.tabs.close(`file:${path}`, { force: true });
      await deleteDraftFile(path);
    } catch (e) {
      ctx.ui.notify(`Could not delete ${title}: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
    }
  }

  const commands: Command[] = [
    {
      id: 'file.newDraft',
      title: 'New Draft',
      category: 'File',
      keybinding: 'Mod-n',
      run: () => engine.newDraft(),
    },
    {
      id: 'file.openDraft',
      title: 'Open Draft...',
      category: 'File',
      run: () => openDraftPicker(),
    },
    {
      id: 'file.deleteDraft',
      title: 'Delete Draft...',
      category: 'File',
      run: () => deleteDraftPicker(),
    },
    {
      id: 'file.save',
      title: 'Save',
      category: 'File',
      keybinding: 'Mod-s',
      run: async () => {
        const content = ctx.tabs.active()?.content;
        return content?.save ? content.save() : false;
      },
    },
    {
      id: 'file.saveAs',
      title: 'Save As...',
      category: 'File',
      keybinding: 'Mod-Shift-s',
      when: hasEditor,
      run: () => active()?.saveAs(),
    },
    {
      id: 'file.saveAll',
      title: 'Save All',
      category: 'File',
      keybinding: 'Mod-Alt-s',
      run: async () => {
        for (const tab of ctx.tabs.list()) {
          if (tab.dirty && tab.content?.save) await tab.content.save();
        }
      },
    },
    {
      id: 'file.revert',
      title: 'Revert File',
      category: 'File',
      when: () => {
        return active() !== null;
      },
      run: async () => {
        const ed = active();
        if (!ed) return;
        if (ed.isDirty()) {
          const choice = await ctx.ui.confirm({
            title: 'Revert file?',
            message: `This drops all unsaved changes in ${ed.title} and reads the file from disk again.`,
            buttons: ['Revert', 'Cancel'],
          });
          if (choice !== 'Revert') return;
        }
        await ed.reload();
      },
    },
    {
      id: 'editor.gotoLine',
      title: 'Go to Line...',
      category: 'Editor',
      keybinding: 'Ctrl-g',
      when: hasEditor,
      run: () => {
        const ed = active();
        if (!ed) return;
        ed.view.focus();
        gotoLine(ed.view);
      },
    },
    {
      id: 'editor.toggleWordWrap',
      title: 'Toggle Word Wrap',
      category: 'Editor',
      keybinding: 'Alt-z',
      run: () => ctx.settings.update({ 'editor.wordWrap': !ctx.settings.get('editor.wordWrap') }),
    },
    {
      id: 'editor.changeLanguage',
      title: 'Change Language Mode',
      category: 'Editor',
      when: () => {
        const ed = active();
        return ed !== null && !ed.large;
      },
      run: () => {
        const ed = active();
        if (!ed) return;
        const items: QuickPickItem[] = [
          { id: '__auto', label: 'Auto Detect', description: 'From the file name' },
          ...LANGUAGES.map((l) => ({ id: l.id, label: l.label, description: l.id === ed.languageId ? 'current' : l.id })),
        ];
        pick('Select language mode', items, (item) => void (item.id === '__auto' ? ed.resetLanguage() : ed.setLanguage(item.id)));
      },
    },
    {
      id: 'editor.changeIndentation',
      title: 'Change Indentation',
      category: 'Editor',
      when: hasEditor,
      run: () => {
        const ed = active();
        if (!ed) return;
        const items: QuickPickItem[] = [
          { id: 'spaces:2', label: 'Indent Using Spaces: 2' },
          { id: 'spaces:4', label: 'Indent Using Spaces: 4' },
          { id: 'spaces:8', label: 'Indent Using Spaces: 8' },
          { id: 'tabs:2', label: 'Indent Using Tabs: tab size 2' },
          { id: 'tabs:4', label: 'Indent Using Tabs: tab size 4' },
          { id: 'tabs:8', label: 'Indent Using Tabs: tab size 8' },
          { id: 'detect', label: 'Detect Indentation from Content' },
        ];
        pick('Select indentation', items, (item) => {
          if (item.id === 'detect') return ed.setIndentation(null);
          const [kind, size] = item.id.split(':');
          ed.setIndentation({ insertSpaces: kind === 'spaces', size: Number(size) });
        });
      },
    },
    {
      id: 'editor.changeEncoding',
      title: 'Change File Encoding',
      category: 'Editor',
      when: hasEditor,
      run: () => {
        const items: QuickPickItem[] = [
          { id: 'reopen', label: 'Reopen with Encoding', description: 'Read the file again with another encoding' },
          { id: 'save', label: 'Save with Encoding', description: 'Write the file with another encoding' },
        ];
        pick('Select action', items, (item) => void ctx.commands.execute(item.id === 'reopen' ? 'editor.reopenWithEncoding' : 'editor.saveWithEncoding'));
      },
    },
    {
      id: 'editor.reopenWithEncoding',
      title: 'Reopen Editor with Encoding',
      category: 'Editor',
      when: hasEditor,
      run: () => {
        const ed = active();
        if (!ed) return;
        const items = ENCODINGS.filter((e) => !e.bom).map((e) => ({
          id: e.id,
          label: e.label,
          description: e.id === ed.meta.encoding ? 'current' : e.id,
        }));
        pick('Reopen with encoding', items, (item) => void reopenWith(ed, item.id));
      },
    },
    {
      id: 'editor.saveWithEncoding',
      title: 'Save with Encoding',
      category: 'Editor',
      when: hasEditor,
      run: () => {
        const ed = active();
        if (!ed) return;
        const choices = ENCODINGS.filter((e) => !e.readOnly);
        const items = choices.map((e, i) => ({
          id: String(i),
          label: e.label,
          description: encodingLabel(e.id, !!e.bom) === encodingLabel(ed.meta.encoding, ed.meta.bom) ? 'current' : e.id,
        }));
        pick('Save with encoding', items, (item) => {
          const choice = choices[Number(item.id)];
          ed.setEncoding(choice.id, !!choice.bom);
          void ed.save();
        });
      },
    },
    {
      id: 'editor.toggleLineEnding',
      title: 'Toggle End of Line Sequence (LF / CRLF)',
      category: 'Editor',
      when: hasEditor,
      run: () => {
        const ed = active();
        if (ed) ed.setLineEnding(ed.meta.lineEnding === 'lf' ? 'crlf' : 'lf');
      },
    },
    {
      id: 'editor.togglePreview',
      title: 'Toggle Preview',
      category: 'Editor',
      keybinding: 'Mod-Shift-v',
      when: hasPreview,
      run: () => {
        const ed = active();
        if (ed) ed.setMode(ed.getMode() === 'preview' ? 'code' : 'preview');
      },
    },
    {
      id: 'editor.toggleSplitPreview',
      title: 'Toggle Split Preview',
      category: 'Editor',
      keybinding: 'Mod-Alt-v',
      when: hasPreview,
      run: () => {
        const ed = active();
        if (ed) ed.setMode(ed.getMode() === 'split' ? 'code' : 'split');
      },
    },
  ];
  return ctx.commands.registerMany(commands);
}

// What a file editor needs from the engine. Keeps file-editor.ts and
// save.ts free of imports from service.ts.

import { Annotation } from '@codemirror/state';
import type { AppContext, EditorExtensionProvider, OpenFileOptions, PreviewProvider } from '../core/types';
import type { FileEditorImpl } from './file-editor';

/** Marks changes that do not come from the user (reload from disk, formatting on save). They do not pin the tab. */
export const programmatic = Annotation.define<boolean>();

export interface EngineHost {
  readonly ctx: AppContext;
  findPreview(path: string, languageId: string): PreviewProvider | null;
  extensionProviders(): EditorExtensionProvider[];
  zoom(step: 1 | -1 | 0): void;
  /** The editor was disposed. */
  forget(editor: FileEditorImpl): void;
  /** Cursor, meta or language changed: refresh the status bar if this is the active editor. */
  statusChanged(editor: FileEditorImpl): void;
  openFile(path: string, opts?: OpenFileOptions): Promise<unknown>;
  /** The drafts folder, or null when the app data folder is not known. The value is cached. */
  draftsDir(): Promise<string | null>;
  /** True when the path is inside the drafts folder (false until `draftsDir()` has resolved). */
  isDraft(path: string): boolean;
  openEditors(): FileEditorImpl[];
  /** Share of the code pane in split mode. It is the same for all tabs of this workbench. */
  splitRatio(): number;
  setSplitRatio(ratio: number): void;
}

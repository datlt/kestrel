// The CodeMirror extension for `.sql` files: Mod-Enter runs the statement at
// the cursor (or the selection), Mod-Shift-Enter runs the whole script. This
// file is small and loads at startup. The running code loads on first use.

import { Prec, type Extension } from '@codemirror/state';
import { keymap, ViewPlugin } from '@codemirror/view';
import type { FileEditor } from '../../core/types';
import type { DbHub } from './hub';

export function sqlFileExtension(hub: DbHub, editor: FileEditor): Extension {
  const withTarget = (fn: (t: import('./hub').RunTarget) => Promise<void>) => {
    void import('./sql-file').then((m) => fn(m.targetFor(hub, editor)));
    return true;
  };
  return [
    Prec.highest(
      keymap.of([
        { key: 'Mod-Enter', run: () => withTarget((t) => t.run()) },
        { key: 'Mod-Shift-Enter', run: () => withTarget((t) => t.runScript()) },
      ]),
    ),
    // The editor closes: close its session too. The server rolls back an open transaction.
    ViewPlugin.fromClass(
      class {
        destroy() {
          const t = hub.fileTargets.get(editor);
          if (t) {
            t.dispose?.();
            hub.fileTargets.delete(editor);
          }
          hub.refreshFileStatus();
        }
      },
    ),
  ];
}

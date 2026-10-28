// Find usages feature (docs/DESIGN.md, section 11.5). Owner: usages agent.
// The panel shows the usages of a name. They come from the language server or
// from the Kestrel code index (see controller.ts).
import type { AppContext } from '../../core/types';
import { initEditorContextMenu } from '../../editor/context-menu';
import { CallHierarchyController } from './call-controller';
import { createCallHierarchyView } from './call-view';
import { UsagesController, cursorRequest, type SearchRequest } from './controller';
import { createUsagesView } from './view';

function requestFromArgument(arg: unknown): SearchRequest | null {
  if (!arg || typeof arg !== 'object') return null;
  const a = arg as Partial<SearchRequest>;
  if (typeof a.path !== 'string' || !Number.isFinite(a.line)) return null;
  return { path: a.path, line: a.line as number, column: Number.isFinite(a.column) ? (a.column as number) : 1 };
}

export function initUsages(ctx: AppContext): void {
  const controller = new UsagesController(ctx);
  ctx.views.register(createUsagesView(ctx, controller));
  const calls = new CallHierarchyController(ctx);
  ctx.views.register(createCallHierarchyView(ctx, calls));

  const category = 'Go';
  ctx.commands.registerMany([
    {
      id: 'usages.find',
      title: 'Find Usages',
      category,
      keybinding: 'Alt-F7',
      // The argument `{ path, line, column }` comes from the class diagram. Without it the cursor is used.
      run: async (arg?: unknown) => {
        const req = requestFromArgument(arg) ?? cursorRequest(ctx);
        if (!req) {
          ctx.ui.notify('Open a file and put the cursor on a name first.');
          return null;
        }
        return controller.find(req);
      },
    },
    {
      id: 'usages.next',
      title: 'Next Usage',
      category,
      keybinding: 'F4',
      when: () => controller.hasResult(),
      run: () => controller.step(1),
    },
    {
      id: 'usages.prev',
      title: 'Previous Usage',
      category,
      keybinding: 'Shift-F4',
      when: () => controller.hasResult(),
      run: () => controller.step(-1),
    },
    {
      id: 'callHierarchy.show',
      title: 'Show Call Hierarchy',
      category,
      keybinding: 'Mod-Shift-h',
      // The argument `{ path, line, column }` is optional. Without it the cursor is used.
      run: async (arg?: unknown) => {
        const req = requestFromArgument(arg) ?? cursorRequest(ctx);
        if (!req) {
          ctx.ui.notify('Open a file and put the cursor on a method first.');
          return;
        }
        await calls.show(req);
      },
    },
  ]);

  // The right-click menu of file editors lives in src/editor/context-menu.ts.
  const menu = initEditorContextMenu(ctx);

  ctx.bus.on('workbench:disposing', () => {
    menu.dispose();
    controller.dispose();
    calls.dispose();
  });
}

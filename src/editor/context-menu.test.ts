import { describe, expect, it, vi } from 'vitest';
import { buildMenuItems, type MenuDeps } from './context-menu';

type Cmd = { keybinding?: string | string[]; when?: () => boolean };

function deps(commands: Record<string, Cmd>, over: Partial<MenuDeps> = {}) {
  const execute = vi.fn(async (_id: string) => undefined);
  const clipboard = { cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn() };
  const d: MenuDeps = {
    commands: { get: (id) => commands[id], execute },
    hasSelection: false,
    readOnly: false,
    onError: vi.fn(),
    clipboard,
    ...over,
  };
  return { d, execute, clipboard };
}

const ALL: Record<string, Cmd> = {
  'lsp.gotoDefinition': { keybinding: 'F12' },
  'usages.find': { keybinding: 'Alt-F7' },
  'diagram.showForCursor': { keybinding: ['Mod-Alt-u', 'Mod-u'] },
  'lsp.rename': { keybinding: 'F2' },
  'lsp.format': { keybinding: 'Shift-Alt-f' },
};

describe('buildMenuItems', () => {
  it('lists the commands, then the clipboard items after a separator', () => {
    const { d } = deps(ALL);
    const items = buildMenuItems(d);
    expect(items.map((i) => i.label)).toEqual([
      'Go to Definition', 'Find Usages', 'Show Class Diagram', 'Rename Symbol', 'Format Document',
      'Cut', 'Copy', 'Paste', 'Select All',
    ]);
    expect(items.map((i) => !!i.separatorBefore)).toEqual([false, false, false, false, false, true, false, false, false]);
    expect(items[0]!.keybinding).toBe('F12');
    expect(items[2]!.keybinding).toBe('Mod-Alt-u');
  });
  it('skips commands that do not exist or whose when fails', () => {
    const { d } = deps({ 'usages.find': { keybinding: 'Alt-F7' }, 'lsp.rename': { when: () => false }, 'lsp.format': { when: () => true } });
    expect(buildMenuItems(d).map((i) => i.label).slice(0, 2)).toEqual(['Find Usages', 'Format Document']);
    expect(buildMenuItems(d).map((i) => i.label)).not.toContain('Rename Symbol');
  });
  it('skips a command whose when throws', () => {
    const { d } = deps({ 'usages.find': { when: () => { throw new Error('x'); } } });
    expect(buildMenuItems(d).map((i) => i.label)).toEqual(['Cut', 'Copy', 'Paste', 'Select All']);
  });
  it('has no separator when there is no command item', () => {
    const { d } = deps({});
    expect(buildMenuItems(d)[0]!.separatorBefore).toBe(false);
  });
  it('disables Cut and Copy without a selection, Cut and Paste when read only', () => {
    const none = buildMenuItems(deps({}).d);
    expect(none.map((i) => !!i.disabled)).toEqual([true, true, false, false]);
    const sel = buildMenuItems(deps({}, { hasSelection: true }).d);
    expect(sel.map((i) => !!i.disabled)).toEqual([false, false, false, false]);
    const ro = buildMenuItems(deps({}, { hasSelection: true, readOnly: true }).d);
    expect(ro.map((i) => !!i.disabled)).toEqual([true, false, true, false]);
  });
  it('runs the command and the clipboard actions', async () => {
    const { d, execute, clipboard } = deps(ALL, { hasSelection: true });
    const items = buildMenuItems(d);
    items[1]!.run();
    expect(execute).toHaveBeenCalledWith('usages.find');
    items[5]!.run();
    items[8]!.run();
    expect(clipboard.cut).toHaveBeenCalled();
    expect(clipboard.selectAll).toHaveBeenCalled();
  });
  it('reports a failed command', async () => {
    const onError = vi.fn();
    const { d, execute } = deps(ALL, { onError });
    execute.mockRejectedValueOnce(new Error('boom'));
    buildMenuItems(d)[0]!.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('Go to Definition failed: boom');
  });
});

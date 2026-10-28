// Search Everywhere: go to class, file, symbol, action and text (docs/DESIGN.md, section 13.4).
// Owner: goto agent.
import type { AppContext } from '../../core/types';
import { DoubleShiftDetector } from './double-shift';
import './goto.css';
import { createPopup } from './popup';
import type { TabId } from './rows';

export function initGoto(ctx: AppContext): void {
  const popup = createPopup(ctx);
  const category = 'Search';

  const show = (tab: TabId) => () => popup.open(tab);
  ctx.commands.registerMany([
    {
      id: 'goto.everywhere',
      title: 'Search Everywhere',
      category,
      // The key is Shift pressed twice. The listener below runs this command.
      // While the popup is open, it stays open on its tab.
      run: () => (popup.isOpen() ? popup.open(popup.currentTab()) : popup.open('all')),
    },
    {
      id: 'goto.class',
      title: 'Go to Class',
      category,
      // Mod is Cmd on macOS. Macs also get the Ctrl form.
      keybinding: ['Mod-Shift-o', 'Ctrl-Shift-o'],
      run: show('classes'),
    },
    {
      id: 'goto.symbol',
      title: 'Go to Symbol',
      category,
      keybinding: ['Mod-Alt-o', 'Mod-t'],
      run: show('symbols'),
    },
    {
      id: 'goto.action',
      title: 'Go to Action',
      category,
      keybinding: 'Mod-Shift-a',
      run: show('actions'),
    },
  ]);

  // Shift pressed twice. This runs on `window`, so only the visible workbench may act.
  const detector = new DoubleShiftDetector();
  const feed = (type: 'keydown' | 'keyup', e: KeyboardEvent) => {
    if (!ctx.window.isActive()) {
      detector.reset();
      return;
    }
    const fired =
      type === 'keydown'
        ? detector.feed({ type, key: e.key, time: e.timeStamp, repeat: e.repeat, composing: e.isComposing || e.keyCode === 229 })
        : detector.feed({ type, key: e.key, time: e.timeStamp });
    if (fired) ctx.commands.execute('goto.everywhere').catch((err) => console.error('goto.everywhere failed', err));
  };
  const onKeyDown = (e: KeyboardEvent) => feed('keydown', e);
  const onKeyUp = (e: KeyboardEvent) => feed('keyup', e);
  const onMouse = (e: MouseEvent) => detector.feed({ type: 'mouse', time: e.timeStamp });
  const onBlur = () => detector.feed({ type: 'blur', time: 0 });
  // Capture phase: a field that stops the event must not hide it from us.
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mousedown', onMouse, true);
  window.addEventListener('blur', onBlur);

  ctx.bus.on('workbench:disposing', () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('mousedown', onMouse, true);
    window.removeEventListener('blur', onBlur);
    popup.dispose();
  });
}

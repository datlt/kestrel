// Helpers shared by the preview frames (markdown and html).

const VARS = [
  'bg', 'bg-alt', 'bg-elevated', 'fg', 'fg-muted', 'fg-faint', 'border', 'accent', 'accent-fg',
  'hover', 'selection', 'danger', 'warn', 'ok', 'info', 'scrollbar', 'font-ui', 'font-mono',
];

/** The theme variables of the app, as a `:root` rule for use inside an iframe. */
export function themeCss(): string {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const lines = VARS.map((v) => `--${v}:${cs.getPropertyValue('--' + v).trim()};`);
  return `:root{${lines.join('')}color-scheme:${currentScheme()};}`;
}

export function currentScheme(): 'light' | 'dark' {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * The frame has focus when the user clicks in it, so key presses do not reach
 * the shell. This sends key presses with Ctrl, Cmd or Alt (and function keys)
 * to the main window as a copy. If the shell handles the key, we stop the
 * original event. The Shift key goes too (down and up), for "Shift pressed
 * twice" (Search Everywhere).
 */
export function forwardKeys(doc: Document): void {
  const forward = (type: 'keydown' | 'keyup', e: KeyboardEvent) => {
    const copy = new KeyboardEvent(type, {
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      repeat: e.repeat,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(copy);
    if (copy.defaultPrevented) e.preventDefault();
  };
  doc.addEventListener('keydown', (e) => {
    const special = e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key) || e.key === 'Shift';
    if (special) forward('keydown', e);
  });
  doc.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') forward('keyup', e);
  });
}

export const ZOOM_LEVELS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** Next zoom level for a step. `step` 0 gives 1. */
export function nextZoom(current: number, step: 1 | -1 | 0): number {
  if (step === 0) return 1;
  if (step > 0) return ZOOM_LEVELS.find((z) => z > current + 1e-6) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  return [...ZOOM_LEVELS].reverse().find((z) => z < current - 1e-6) ?? ZOOM_LEVELS[0];
}

/** Animates a number from `from` to `to` in `ms`. Returns a function that stops it. */
export function animate(from: number, to: number, ms: number, step: (v: number) => void): () => void {
  const t0 = performance.now();
  let id = 0;
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    step(from + (to - from) * eased);
    if (p < 1) id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(id);
}

/** Collects Ctrl+wheel delta and gives one zoom step per about 50 px. */
export function wheelZoomStepper(onStep: (step: 1 | -1) => void): (e: WheelEvent) => void {
  let acc = 0;
  return (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    acc += e.deltaY;
    while (Math.abs(acc) >= 50) {
      onStep(acc < 0 ? 1 : -1);
      acc -= Math.sign(acc) * 50;
    }
  };
}

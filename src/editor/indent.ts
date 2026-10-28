// Detects tabs or spaces and the indent size from the start of a file.

export interface IndentInfo {
  insertSpaces: boolean;
  /** Spaces per level. `null` for tabs: the tab width is a setting. */
  size: number | null;
}

const CANDIDATES = [2, 4, 8, 3, 6, 5, 7];

/**
 * Looks at the first lines (at most `maxLines`) and returns the style that most
 * lines use. Returns null when no line is indented.
 */
export function detectIndentation(text: string, maxLines = 5000): IndentInfo | null {
  let tabLines = 0;
  let spaceLines = 0;
  let minSpaces = Infinity;
  // How often two lines differ by this many spaces (index = difference).
  const deltas = new Array<number>(9).fill(0);
  let prev = 0; // spaces of the previous code line, -1 after a tab line
  let pos = 0;
  const limit = Math.min(text.length, 1_000_000);

  for (let n = 0; n < maxLines && pos < limit; n++) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    let i = pos;
    let spaces = 0;
    let first = '';
    for (; i < end; i++) {
      const c = text[i];
      if (c === ' ') spaces++;
      else if (c === '\t') continue;
      else {
        first = c;
        break;
      }
    }
    const tabLed = text.charCodeAt(pos) === 9;
    pos = end + 1;
    // Skip empty lines, whitespace-only lines and comment continuation (` * text`).
    if (first === '' || first === '\r' || first === '*') continue;

    if (tabLed) {
      tabLines++;
      prev = -1;
      continue;
    }
    if (spaces >= 2) {
      spaceLines++;
      minSpaces = Math.min(minSpaces, spaces);
    }
    if (prev >= 0) {
      const d = Math.abs(spaces - prev);
      if (d >= 2 && d <= 8) deltas[d]++;
    }
    prev = spaces;
  }

  if (tabLines === 0 && spaceLines === 0) return null;
  if (tabLines > spaceLines) return { insertSpaces: false, size: null };

  let best = 0;
  let bestCount = 0;
  for (const d of CANDIDATES) {
    if (deltas[d] > bestCount) {
      best = d;
      bestCount = deltas[d];
    }
  }
  if (!best) best = Math.min(8, Math.max(2, minSpaces === Infinity ? 4 : minSpaces));
  return { insertSpaces: true, size: best };
}

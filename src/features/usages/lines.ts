// Text of source lines for results that come from a language server.
import type { AppContext } from '../../core/types';
import { lspReadLines } from '../../ipc/lsp';

/** Text of the wanted lines (0-based): from the open editor, else from disk. */
export async function readLineTexts(
  ctx: AppContext,
  wanted: { path: string; line: number }[],
): Promise<(path: string, line: number) => string> {
  const out = new Map<string, Map<number, string>>();
  const need = new Map<string, Set<number>>();
  for (const w of wanted) {
    const editor = ctx.editors.get(w.path);
    if (editor) {
      const doc = editor.view.state.doc;
      let m = out.get(w.path);
      if (!m) out.set(w.path, (m = new Map()));
      m.set(w.line, w.line + 1 <= doc.lines ? doc.line(w.line + 1).text : '');
    } else {
      let s = need.get(w.path);
      if (!s) need.set(w.path, (s = new Set()));
      s.add(w.line);
    }
  }
  if (need.size) {
    const requests = [...need.entries()].map(([path, lines]) => ({ path, lines: [...lines].sort((a, b) => a - b) }));
    try {
      const result = await lspReadLines(requests);
      requests.forEach((r, i) => out.set(r.path, new Map(r.lines.map((l, j) => [l, result[i]?.[j] ?? '']))));
    } catch {
      // The list still works without the line text.
    }
  }
  return (path, line) => out.get(path)?.get(line) ?? '';
}

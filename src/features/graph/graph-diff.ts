// Tells whether two answers of `notesGraph` hold the same notes and links, so a
// change of an unrelated file does not restart the layout.

import type { NoteGraph } from './types';

export function sameNoteGraph(a: NoteGraph, b: NoteGraph): boolean {
  if (a.root !== b.root || a.truncated !== b.truncated || a.nodes.length !== b.nodes.length || a.links.length !== b.links.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    const x = a.nodes[i];
    const y = b.nodes[i];
    if (x.rel !== y.rel || x.kind !== y.kind || x.title !== y.title || x.mtimeMs !== y.mtimeMs || x.size !== y.size) return false;
    if (x.tags.length !== y.tags.length || x.tags.some((t, k) => t !== y.tags[k])) return false;
    if (x.aliases.length !== y.aliases.length || x.aliases.some((t, k) => t !== y.aliases[k])) return false;
  }
  for (let i = 0; i < a.links.length; i++) {
    const x = a.links[i];
    const y = b.links[i];
    if (x.from !== y.from || x.to !== y.to || x.count !== y.count || x.embeds !== y.embeds) return false;
  }
  return true;
}

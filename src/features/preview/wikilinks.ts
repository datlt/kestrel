// Links between notes in the markdown preview (docs/DESIGN.md 14.3).
// `[[target|label]]` links (comrak marks them with `data-wikilink`) and
// markdown links that are not a file path resolve with the note index, like
// the Graph View. Embedded images (`![[logo.png]]`) show as images.

import type { AppContext } from '../../core/types';
import { basename, isInside } from '../../core/util';
import { fsCreateFile, fsWriteFile } from '../../ipc/fs';
import { notesResolve, type ResolvedLink } from '../../ipc/notes';
import { previewUrl } from '../../ipc/preview';

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The text of the link as the user wrote it (comrak percent-encodes the href). */
export function linkTarget(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** 1-based line of the heading `name` (or of the block `^name`) in `text`, or null. */
export function headingLine(text: string, name: string, block: boolean): number | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (block) {
      if (line.trimEnd().toLowerCase().endsWith(`^${want}`)) return i + 1;
      continue;
    }
    const m = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m && m[1].toLowerCase() === want) return i + 1;
  }
  return null;
}

/** Resolves links of one note. Answers are kept until a file in the folder changes. */
export class NoteLinks {
  private cache = new Map<string, Promise<ResolvedLink | null>>();
  private sub: { dispose(): void };

  constructor(
    private ctx: AppContext,
    private notePath: string,
  ) {
    this.sub = ctx.bus.on('fs:changed', () => this.cache.clear());
  }

  /** The open folder, when the note is inside it. Links of other notes cannot use the index. */
  root(): string | null {
    const root = this.ctx.workspace.root;
    return root && isInside(this.notePath, root) ? root : null;
  }

  resolve(target: string, wiki: boolean): Promise<ResolvedLink | null> {
    const root = this.root();
    if (!root) return Promise.resolve(null);
    const key = `${wiki ? 'w' : 'm'}\0${target}`;
    let p = this.cache.get(key);
    if (!p) {
      p = notesResolve(root, this.notePath, target, wiki).catch((e) => {
        console.warn('notes: resolve failed', e);
        return null;
      });
      this.cache.set(key, p);
    }
    return p;
  }

  /** Marks links to missing notes and turns embedded images into images. */
  async decorate(article: HTMLElement, isCurrent: () => boolean): Promise<void> {
    if (!this.root()) return;
    const links = [...article.querySelectorAll<HTMLAnchorElement>('a[data-wikilink]')];
    await Promise.all(
      links.map(async (a) => {
        const r = await this.resolve(linkTarget(a.getAttribute('href') ?? ''), true);
        if (!isCurrent() || !a.isConnected || !r) return;
        a.classList.toggle('wikilink-missing', !r.exists);
        a.title = r.exists ? (this.relative(r.path) ?? r.path) : `${basename(r.path)} does not exist yet. Click to create it.`;
        const embed = a.parentElement?.classList.contains('wikilink-embed');
        if (embed && r.exists && r.kind === 'attachment' && IMAGE.test(r.path)) {
          const img = a.ownerDocument.createElement('img');
          img.src = previewUrl(r.path);
          img.alt = a.textContent ?? '';
          img.dataset.path = r.path;
          a.replaceWith(img);
        }
      }),
    );
  }

  /** Opens the target of a clicked link. Returns false when the link is not for the note index. */
  async open(href: string, wiki: boolean, background: boolean): Promise<boolean> {
    if (!this.root()) {
      if (wiki) this.ctx.ui.notify('Links like [[note]] work for notes inside the open folder.', { kind: 'info', timeoutMs: 3000 });
      return wiki;
    }
    const r = await this.resolve(linkTarget(href), wiki);
    if (!r) return false;
    if (!r.exists) {
      if (r.kind === 'attachment' || (!MARKDOWN.test(r.path) && !wiki)) {
        this.ctx.ui.notify(`${basename(r.path)} does not exist.`, { kind: 'warn', timeoutMs: 3000 });
        return true;
      }
      const created = await createNote(this.ctx, r.path);
      if (!created) return true;
    }
    await openResolved(this.ctx, r, background);
    return true;
  }

  private relative(path: string): string | null {
    const root = this.root();
    return root && isInside(path, root) ? path.slice(root.length).replace(/^[/\\]/, '') : null;
  }

  dispose(): void {
    this.sub.dispose();
    this.cache.clear();
  }
}

/** Opens a note (markdown in preview mode) at its heading, or another file. */
export async function openResolved(ctx: AppContext, r: ResolvedLink, background = false): Promise<void> {
  const md = MARKDOWN.test(r.path);
  const opts = { mode: md ? ('preview' as const) : undefined, activate: !background };
  const ed = await ctx.editors.openFile(r.path, opts);
  if (!ed || !r.heading) return;
  const line = headingLine(ed.getText(), r.heading, r.block);
  if (line) await ctx.editors.openFile(r.path, { ...opts, line });
}

/**
 * Asks "Create note X.md?" and creates the file with a `# X` heading. Rust
 * creates missing folders. Returns true when the note exists afterwards.
 */
export async function createNote(ctx: AppContext, path: string): Promise<boolean> {
  const name = basename(path);
  const answer = await ctx.ui.confirm({ title: `Create note ${name}?`, message: path, buttons: ['Create', 'Cancel'] });
  if (answer !== 'Create') return false;
  try {
    await fsCreateFile(path);
    const title = name.replace(MARKDOWN, '');
    await fsWriteFile(path, `# ${title}\n`, { encoding: 'utf-8', bom: false, lineEnding: 'lf', expectedMtimeMs: null });
    return true;
  } catch (e) {
    ctx.ui.notify(`Cannot create ${name}: ${errText(e)}`, { kind: 'error' });
    return false;
  }
}

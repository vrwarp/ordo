/** The decks a run is given: files, or folders searched with their subfolders. */
import { existsSync } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** PresentationML files: decks, slide shows, templates, macro-enabled decks. */
export const DECK_RE = /\.(pptx|pptm|ppsx|ppsm|potx|potm)$/i;

export type DeckEntry = {
  file: string;
  /** Unique in the run: the path below the folder given, folders joined by `__`. */
  name: string;
  /** The folder (or file) the deck was found under, as given. */
  root: string;
  /**
   * False for a link whose target is gone (a dangling symlink): not a deck the converter failed on. The
   * harness leaves it out of the run and its means; the census lists it as unreadable.
   */
  exists: boolean;
};

/**
 * Every deck in `paths`: files as given, folders walked with their subfolders (links to folders are not
 * followed) in name order, dangling links included with `exists: false`. A path that is not there at all
 * throws.
 */
export async function listDecks(paths: readonly string[]): Promise<DeckEntry[]> {
  const out: DeckEntry[] = [];
  const walk = async (root: string, dir: string, prefix: string) => {
    for (const f of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (f.isDirectory()) await walk(root, join(dir, f.name), `${prefix}${f.name}__`);
      else if (DECK_RE.test(f.name)) {
        const file = join(dir, f.name);
        out.push({ file, name: prefix + f.name, root, exists: existsSync(file) });
      }
    }
  };
  for (const p of paths) {
    const st = await stat(p).catch(() => undefined);
    if (st?.isDirectory()) await walk(p, p, '');
    else if (st) out.push({ file: p, name: basename(p), root: p, exists: true });
    // A dangling link given by name is listed; a path that is not there at all is a mistake.
    else if (await lstat(p)) out.push({ file: p, name: basename(p), root: p, exists: false });
  }
  return out;
}

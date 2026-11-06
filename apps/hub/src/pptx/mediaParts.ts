/**
 * Media of an import, deduplicated (design/27 §1 `mediaParts.ts`, §4 "Pictures"; M3 item C): the
 * generalisation of `ImportService.mediaFor` (ProPresenter) for every importer. A file whose content is
 * already stored reuses that media item, found through the SHA-256 media hash index (a table, not a scan of
 * every media row); anything else is ingested (clips, never awaited) or added ready (prepared pictures).
 */
import type { PptxDeps } from './shared.ts';
import { notYet } from './shared.ts';

export type MediaPartOptions = {
  /** The media item's name (`baseName` applies). */
  name: string;
  /** e.g. ['pptx'] for a deck's pictures (MediaTab hides them unless asked, item G). */
  tags: string[];
  /** Mark the item as a background (an existing one is marked too). */
  background?: boolean;
};

/**
 * The media id for the file at `path` (a scratch file this call may move or delete): an existing item with
 * the same content, else a newly ingested one.
 */
export async function mediaForFile(deps: PptxDeps, path: string, opts: MediaPartOptions): Promise<string> {
  void deps;
  void path;
  void opts;
  throw notYet('C', 'mediaForFile');
}

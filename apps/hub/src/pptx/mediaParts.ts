/**
 * Media of an import, deduplicated (design/27 §1 `mediaParts.ts`, §4 "Pictures"; M3 item C): the
 * generalisation of `ImportService.mediaFor` (ProPresenter) for every importer. A file whose content is
 * already stored reuses that media item, found through the SHA-256 media hash index (a table, not a scan of
 * every media row); anything else is ingested (clips, never awaited) or added ready (prepared pictures,
 * `pictures.ts`).
 *
 * The index (`media_hashes`, db.ts migration 8) has two kinds of rows:
 * - `content`: each media item's original file hash (`Media.original.hash`; for a prepared picture, the
 *   prepared bytes). SQL triggers on `media` keep these exact whichever code path inserts, updates or deletes
 *   an item, and the migration backfilled them for libraries that existed before it.
 * - `source`: the hash of the deck part a prepared picture was made from (`addReadyPicture`), so a second
 *   import of the same picture finds it before preparing it again. The delete trigger drops these with the
 *   item.
 */
import { rm } from 'node:fs/promises';
import type { Media, MediaTrim } from '@ordo/domain';
import { type DB, nowIso } from '../db.ts';
import { normTrim, sameTrim } from '../media/service.ts';
import { hashFile } from '../store.ts';
import type { PptxDeps } from './shared.ts';

export type MediaPartOptions = {
  /** The media item's name (`baseName` applies). */
  name: string;
  /** e.g. ['pptx'] for a deck's pictures (MediaTab hides them unless asked, item G). */
  tags: string[];
  /** Mark the item as a background (an existing one is marked too). */
  background?: boolean;
  /**
   * Whether an existing item with the same content may stand for this file. Default: any item made from
   * the whole file (a trimmed clip of the same bytes, M5's `Media.trim`, is another item).
   */
  accept?: (m: Media) => boolean;
};

/** What a hash stands for in the index. */
export type HashRole = 'content' | 'source';

/** Candidates read per lookup: duplicates of one hash are rare, and a lookup must stay cheap. */
const MAX_CANDIDATES = 64;

/** The SHA-256 media hash index (db.ts migration 8, `media_hashes`). */
export class MediaHashes {
  constructor(private db: DB) {}

  /** Media ids recorded for `hash` as `role`, oldest first. */
  ids(hash: string, role: HashRole): string[] {
    const rows = this.db
      .prepare(
        `SELECT media_id FROM media_hashes WHERE hash = ? AND role = ? ORDER BY created_at, media_id LIMIT ?`,
      )
      .all(hash, role, MAX_CANDIDATES) as { media_id: string }[];
    return rows.map((r) => r.media_id);
  }

  /** Record that `mediaId` holds (`content`) or was made from (`source`) the bytes with this hash. */
  add(hash: string, role: HashRole, mediaId: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO media_hashes (hash, role, media_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(hash, role, mediaId, nowIso());
  }

  /** Drop every row of a media item (the delete trigger normally has). */
  forget(mediaId: string): void {
    this.db.prepare(`DELETE FROM media_hashes WHERE media_id = ?`).run(mediaId);
  }
}

/** Any item made from the whole file: M5's trimmed clips (`Media.trim`) are other items of the same bytes. */
export function wholeFile(m: Media): boolean {
  return (m as { trim?: unknown }).trim === undefined;
}

/**
 * The media items the index records for `hash` as `role` that `accept` takes, oldest first. Rows of items
 * that no longer exist are dropped on the way; a `content` row must still match the item's original.
 */
export function findMedia(
  deps: Pick<PptxDeps, 'lib'>,
  hash: string,
  role: HashRole,
  accept: (m: Media) => boolean = () => true,
): Media[] {
  const index = new MediaHashes(deps.lib.db);
  const out: Media[] = [];
  for (const id of index.ids(hash, role)) {
    const m = deps.lib.media.get(id);
    if (!m) {
      index.forget(id);
      continue;
    }
    if (role === 'content' && m.original.hash !== hash) continue;
    if (accept(m)) out.push(m);
  }
  return out;
}

/**
 * The media id for the file at `path` (a scratch file this call may move or delete): an existing item with
 * the same content, else a newly ingested one.
 */
export async function mediaForFile(deps: PptxDeps, path: string, opts: MediaPartOptions): Promise<string> {
  // Hashed as a stream: a service video can be larger than Node reads into one buffer.
  const { hash, bytes } = await hashFile(path);
  const existing = findMedia(deps, hash, 'content', opts.accept ?? wholeFile)[0];
  if (existing) {
    await rm(path, { force: true });
    if (opts.background && !existing.isBackground) {
      const updated = deps.lib.media.update(existing.id, { ...existing, isBackground: true });
      deps.lib.emit([{ kind: 'media', id: updated.id, rev: updated.rev, entity: updated }]);
    }
    return existing.id;
  }
  const m = await deps.media.ingest({ path, hash, bytes }, opts.name, {
    tags: opts.tags,
    isBackground: opts.background ?? false,
  });
  return m.id;
}

export type ClipOptions = {
  /** The media item's name (`baseName` applies). */
  name: string;
  tags: string[];
  /** The part of the clip kept, baked into its delivery (`IngestOpts.trim`). */
  trim?: MediaTrim;
  /** The file's hash and size when the caller has them (a part used with several trims is hashed once). */
  hashed?: { hash: string; bytes: number };
};

/**
 * The clip for the file at `path` (a scratch file this call moves or deletes): an existing video or audio
 * item with the same content and the same trim (design/27 §8 "Hub": deduplication keys on hash plus trim, so
 * one file used whole and trimmed gives two clips), else a new item stored without its processing job, which
 * the caller queues (`MediaService.queue`) once the import has queued its LibreOffice follow-up. A failed
 * item is not reused: the file is ingested again. Throws when the file is not a video or audio file.
 */
export async function clipForFile(
  deps: PptxDeps,
  path: string,
  opts: ClipOptions,
): Promise<{ media: Media; created: boolean }> {
  const { hash, bytes } = opts.hashed ?? (await hashFile(path));
  const trim = normTrim(opts.trim);
  const same = (m: Media) =>
    (m.kind === 'video' || m.kind === 'audio') && m.state !== 'failed' && sameTrim(normTrim(m.trim), trim);
  const existing = findMedia(deps, hash, 'content', same)[0];
  if (existing) {
    await rm(path, { force: true });
    return { media: existing, created: false };
  }
  const media = await deps.media.ingest({ path, hash, bytes }, opts.name, {
    checkExtension: false,
    tags: opts.tags,
    ...(trim ? { trim } : {}),
    queue: false,
  });
  return { media, created: true };
}

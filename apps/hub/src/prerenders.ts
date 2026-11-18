/**
 * Pre-rendered slides' keys and pictures on the hub (design/29 §1.3). `PrerenderIndex` is the DB-only side (a
 * property of `Library`): the upload check, the goLive key set and the stand-by lookup are index reads, never a
 * parse of a revision.
 */
import type { DB } from './db.ts';

export class PrerenderIndex {
  private db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  /** The keys of a presentation's current revision. */
  keySet(presentationId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT k.key FROM prerender_keys k JOIN presentations p ON p.id = k.presentation_id AND p.rev = k.rev WHERE k.presentation_id = ? ORDER BY k.key`,
        )
        .all(presentationId) as { key: string }[]
    ).map((r) => r.key);
  }
}

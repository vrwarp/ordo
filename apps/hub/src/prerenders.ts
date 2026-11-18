/**
 * Pre-rendered slides' keys and pictures on the hub (design/29 §1.3). `PrerenderIndex` is the DB-only side (a
 * property of `Library`): the upload check, the goLive key set and the stand-by lookup are index reads, never a
 * parse of a revision.
 */
import type { DB } from './db.ts';

/** One row of `prerender_keys`. */
export type KeyRow = { slideId: string; key: string; standbyId: string; sig: string };

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

  /** The newest revision of a presentation that has key rows. */
  latestKeyRev(presentationId: string): number | undefined {
    const r = this.db
      .prepare(`SELECT MAX(rev) AS rev FROM prerender_keys WHERE presentation_id = ?`)
      .get(presentationId) as { rev: number | null };
    return r.rev ?? undefined;
  }

  keysAt(presentationId: string, rev: number): KeyRow[] {
    return (
      this.db
        .prepare(
          `SELECT slide_id, key, standby_id, sig FROM prerender_keys WHERE presentation_id = ? AND rev = ? ORDER BY slide_id, key`,
        )
        .all(presentationId, rev) as { slide_id: string; key: string; standby_id: string; sig: string }[]
    ).map((r) => ({ slideId: r.slide_id, key: r.key, standbyId: r.standby_id, sig: r.sig }));
  }

  /** The slides of a revision that have a row. */
  slidesWithKeys(presentationId: string, rev: number): Set<string> {
    return new Set(
      (
        this.db
          .prepare(`SELECT DISTINCT slide_id FROM prerender_keys WHERE presentation_id = ? AND rev = ?`)
          .all(presentationId, rev) as { slide_id: string }[]
      ).map((r) => r.slide_id),
    );
  }

  /** Rows added beside the ones a revision has (a font or picture change): an existing key is left as it is. */
  addKeys(presentationId: string, rev: number, rows: readonly KeyRow[]): void {
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO prerender_keys (presentation_id, rev, slide_id, key, standby_id, sig, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const at = Date.now();
    this.db.transaction(() => {
      for (const r of rows) ins.run(presentationId, rev, r.slideId, r.key, r.standbyId, r.sig, at);
    })();
  }

  /** Presentations that have any key row: what a font or picture change may touch. */
  presentationsWithKeys(): string[] {
    return (
      this.db.prepare(`SELECT DISTINCT presentation_id FROM prerender_keys`).all() as {
        presentation_id: string;
      }[]
    ).map((r) => r.presentation_id);
  }

  /** Stored presentations whose JSON has a pre-render record: one text scan, for the start-up fill. */
  presentationsMentioningPrerender(): string[] {
    return (
      this.db.prepare(`SELECT id FROM presentations WHERE json LIKE '%"prerender":%'`).all() as {
        id: string;
      }[]
    ).map((r) => r.id);
  }
}

/**
 * Slide files on the hub (design/29 §1.3): the head and pages of a pre-rendered slide's full form, kept as
 * application/json files in the content store and checked in the CPU pool. `SlideFileIndex` is the DB-only side
 * (a property of `Library`: the save check, the goLive bundle and collection read it, never a file);
 * `SlideFiles` is the service (PUT a page, PUT a head, the writers inside the hub).
 *
 * The hub is the authority: a head's `uses` and bytes are its own record (`slide_heads`), written when the head
 * is checked; a presentation save rewrites the slide's `uses` and `file.bytes` from it (`Library.savePresentation`).
 */
import type { slideUses } from '@ordo/domain/prerender.ts';
import type { DB } from './db.ts';

/** The most refs or pages a refusal names. */
export const NAMED_MAX = 20;

/** What a slide file draws (`Slide.prerender.uses`): media ids, shape files, font families. */
export type SlideUses = ReturnType<typeof slideUses>;

export type HeadRow = { hash: string; bytes: number; objects: number; uses: SlideUses; pages: string[] };

/** The DB-only side: no pool, no store. */
export class SlideFileIndex {
  private db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  /** The head's record with its pages in order; undefined when the hub has no such head (a row AND its file). */
  head(hash: string): HeadRow | undefined {
    const r = this.db
      .prepare(
        `SELECT h.hash, h.bytes, h.objects, h.uses FROM slide_heads h JOIN files f ON f.hash = h.hash WHERE h.hash = ?`,
      )
      .get(hash) as { hash: string; bytes: number; objects: number; uses: string } | undefined;
    if (!r) return undefined;
    return {
      hash: r.hash,
      bytes: r.bytes,
      objects: r.objects,
      uses: JSON.parse(r.uses) as SlideUses,
      pages: this.pagesOf(hash),
    };
  }

  /** Of `refs`, those with a head row and a files row. */
  have(refs: readonly string[]): Set<string> {
    const out = new Set<string>();
    const unique = [...new Set(refs)];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const rows = this.db
        .prepare(
          `SELECT h.hash FROM slide_heads h JOIN files f ON f.hash = h.hash WHERE h.hash IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as { hash: string }[];
      for (const r of rows) out.add(r.hash);
    }
    return out;
  }

  pagesOf(head: string): string[] {
    return (
      this.db.prepare(`SELECT page FROM slide_head_pages WHERE head = ? ORDER BY pos`).all(head) as {
        page: string;
      }[]
    ).map((r) => r.page);
  }

  /** Record a checked head: its row and its pages, in one transaction. */
  record(row: HeadRow): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO slide_heads (hash, bytes, objects, uses, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(row.hash, row.bytes, row.objects, JSON.stringify(row.uses), new Date().toISOString());
      this.db.prepare(`DELETE FROM slide_head_pages WHERE head = ?`).run(row.hash);
      const ins = this.db.prepare(`INSERT INTO slide_head_pages (head, pos, page) VALUES (?, ?, ?)`);
      for (let i = 0; i < row.pages.length; i++) ins.run(row.hash, i, row.pages[i]);
    })();
  }

  /** Forget a head (collection removes it with its files row). */
  remove(hash: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM slide_head_pages WHERE head = ?`).run(hash);
      this.db.prepare(`DELETE FROM slide_heads WHERE hash = ?`).run(hash);
    })();
  }
}

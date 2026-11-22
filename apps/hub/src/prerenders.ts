/**
 * Pre-rendered slides' keys and pictures on the hub (design/29 §1.3). `PrerenderIndex` is the DB-only side (a
 * property of `Library`): the upload check, the goLive key set and the stand-by lookup are index reads, never a
 * parse of a revision.
 */
import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { FileRef, PrerenderRow } from '@ordo/domain';
import { PRERENDER_VERSION } from '@ordo/domain/prerender.ts';
import type { Logger } from 'pino';
import type { DB } from './db.ts';
import { badRequest, HttpError, notFound } from './errors.ts';
import type { Library } from './library.ts';
import { readPictureHeader } from './pptx/pictures.ts';
import type { LiveView } from './liveview.ts';
import type { Store } from './store.ts';

/** The sizes a picture is made at (design/29 §1.3): the two goLive lists and the 640 preview phones and grids use. */
export const PICTURE_SIZES: Readonly<Record<number, readonly [number, number]>> = {
  3840: [3840, 2160],
  1920: [1920, 1080],
  640: [640, 360],
};
/** The largest picture file (`PLATE_LIMITS.bytes` of add91d9). */
export const PICTURE_MAX_BYTES = 32 * 1024 * 1024;
/** What `Retry-After` says to a baker refused during a service (design/29: End service plus 2 minutes). */
export const PAUSED_RETRY_S = 120;
/** How long the budget numbers of hub health are reused. */
const HEALTH_BUDGET_MS = 5000;
/** The per-presentation file budget (design/29 A24, W29; the owner's 1 GiB of 2026-11-13). */
export const PRERENDER_BUDGET_BYTES = 1024 ** 3;

/** One row of `prerenders`. */
export type PictureRow = {
  presentationId: string;
  key: string;
  size: number;
  slideId: string;
  standbyId: string;
  version: number;
  kind: string;
  hash: string;
  mime: string;
  bytes: number;
  w: number;
  h: number;
  opaque: boolean;
  madeBy?: string;
  madeRole: 'operate' | 'edit';
  lastRev: number;
  createdAt: number;
};
type PictureDb = {
  presentation_id: string;
  key: string;
  size: number;
  slide_id: string;
  standby_id: string;
  version: number;
  kind: string;
  hash: string;
  mime: string;
  bytes: number;
  w: number;
  h: number;
  opaque: number;
  made_by: string | null;
  made_role: 'operate' | 'edit';
  last_rev: number;
  created_at: number;
};
const pictureOf = (r: PictureDb): PictureRow => ({
  presentationId: r.presentation_id,
  key: r.key,
  size: r.size,
  slideId: r.slide_id,
  standbyId: r.standby_id,
  version: r.version,
  kind: r.kind,
  hash: r.hash,
  mime: r.mime,
  bytes: r.bytes,
  w: r.w,
  h: r.h,
  opaque: r.opaque === 1,
  ...(r.made_by ? { madeBy: r.made_by } : {}),
  madeRole: r.made_role,
  lastRev: r.last_rev,
  createdAt: r.created_at,
});

const UNCLAIMED = `NOT EXISTS (SELECT 1 FROM prerender_keys k WHERE k.presentation_id = p.presentation_id AND k.key = p.key)
  AND NOT EXISTS (SELECT 1 FROM prerender_keys k JOIN presentations c ON c.id = k.presentation_id AND c.rev = k.rev
                  WHERE k.presentation_id = p.presentation_id AND k.standby_id = p.standby_id)`;
const UNCLAIMED_ROW = UNCLAIMED.replaceAll('p.', 'prerenders.');

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

  // ── pictures ──────────────────────────────────────────────────────────────────────────────────────────

  /** Whether any revision of the presentation (current or kept) has this key. */
  hasKey(presentationId: string, key: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM prerender_keys WHERE presentation_id = ? AND key = ? LIMIT 1`)
      .get(presentationId, key);
  }

  /** Whether the key is one of the presentation's current revision's. */
  isCurrentKey(presentationId: string, key: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM prerender_keys k JOIN presentations p ON p.id = k.presentation_id AND p.rev = k.rev WHERE k.presentation_id = ? AND k.key = ? LIMIT 1`,
      )
      .get(presentationId, key);
  }

  /** The slide and stand-by id of a key (the newest revision that has it). */
  keyInfo(
    presentationId: string,
    key: string,
  ): { slideId: string; standbyId: string; rev: number } | undefined {
    const r = this.db
      .prepare(
        `SELECT slide_id, standby_id, rev FROM prerender_keys WHERE presentation_id = ? AND key = ? ORDER BY rev DESC LIMIT 1`,
      )
      .get(presentationId, key) as { slide_id: string; standby_id: string; rev: number } | undefined;
    return r && { slideId: r.slide_id, standbyId: r.standby_id, rev: r.rev };
  }

  picture(presentationId: string, key: string, size: number): PictureRow | undefined {
    const r = this.db
      .prepare(`SELECT * FROM prerenders WHERE presentation_id = ? AND key = ? AND size = ?`)
      .get(presentationId, key, size) as PictureDb | undefined;
    return r && pictureOf(r);
  }

  /** Insert a picture; false when a row of that (key, size) exists (the first upload won). */
  insertPicture(p: PictureRow): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO prerenders (presentation_id, key, size, slide_id, standby_id, version, kind, hash, mime, bytes, w, h, opaque, made_by, made_role, last_rev, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(
          p.presentationId,
          p.key,
          p.size,
          p.slideId,
          p.standbyId,
          p.version,
          p.kind,
          p.hash,
          p.mime,
          p.bytes,
          p.w,
          p.h,
          p.opaque ? 1 : 0,
          p.madeBy ?? null,
          p.madeRole,
          p.lastRev,
          p.createdAt,
        ).changes > 0
    );
  }

  /**
   * Replace a key's picture with `p`. Returns the hash the row held just before, read in the same transaction as the
   * update (the caller releases that file: a replacement that raced another released the one the first had made, not
   * the one both had read before streaming); undefined when the row was gone.
   */
  replacePicture(p: PictureRow): string | undefined {
    return this.db.transaction(() => {
      const before = this.db
        .prepare(`SELECT hash FROM prerenders WHERE presentation_id = ? AND key = ? AND size = ?`)
        .get(p.presentationId, p.key, p.size) as { hash: string } | undefined;
      if (!before) return undefined;
      this.updatePicture(p);
      return before.hash;
    })();
  }

  private updatePicture(p: PictureRow): void {
    this.db
      .prepare(
        `UPDATE prerenders SET hash = ?, mime = ?, bytes = ?, w = ?, h = ?, opaque = ?, made_by = ?, made_role = ?, last_rev = ?, created_at = ?
         WHERE presentation_id = ? AND key = ? AND size = ?`,
      )
      .run(
        p.hash,
        p.mime,
        p.bytes,
        p.w,
        p.h,
        p.opaque ? 1 : 0,
        p.madeBy ?? null,
        p.madeRole,
        p.lastRev,
        p.createdAt,
        p.presentationId,
        p.key,
        p.size,
      );
  }

  /** Delete a key's pictures (one size, or all) and its failure; the hashes the deleted rows named. */
  deletePictures(presentationId: string, key: string, size?: number): string[] {
    return this.db.transaction(() => {
      const rows = (
        size === undefined
          ? this.db
              .prepare(`SELECT hash FROM prerenders WHERE presentation_id = ? AND key = ?`)
              .all(presentationId, key)
          : this.db
              .prepare(`SELECT hash FROM prerenders WHERE presentation_id = ? AND key = ? AND size = ?`)
              .all(presentationId, key, size)
      ) as { hash: string }[];
      if (size === undefined)
        this.db
          .prepare(`DELETE FROM prerenders WHERE presentation_id = ? AND key = ?`)
          .run(presentationId, key);
      else
        this.db
          .prepare(`DELETE FROM prerenders WHERE presentation_id = ? AND key = ? AND size = ?`)
          .run(presentationId, key, size);
      this.db.prepare(`DELETE FROM prerender_failures WHERE key = ?`).run(key);
      return rows.map((r) => r.hash);
    })();
  }

  /** Whether any picture row names this file. */
  hashNamed(hash: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM prerenders WHERE hash = ? LIMIT 1`).get(hash);
  }

  setFailure(key: string, reason: string, madeBy: string | undefined, at: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO prerender_failures (key, reason, made_by, at) VALUES (?, ?, ?, ?)`)
      .run(key, reason, madeBy ?? null, at);
  }

  /** The presentation's keys with their sizes, the failures of those keys and the picture bytes (at most 5,000 keys). */
  listing(presentationId: string): {
    keys: {
      slideId: string;
      key: string;
      standbyId: string;
      sizes: number[];
      madeBy?: string;
      at?: number;
    }[];
    failures: { key: string; reason: string; madeBy?: string; at: number }[];
    usedBytes: number;
  } {
    const rows = this.db
      .prepare(
        `SELECT k.slide_id, k.key, k.standby_id, p.size, p.made_by, p.created_at
         FROM prerender_keys k LEFT JOIN prerenders p ON p.presentation_id = k.presentation_id AND p.key = k.key
         WHERE k.presentation_id = ? ORDER BY k.rev DESC, k.slide_id, k.key LIMIT 40000`,
      )
      .all(presentationId) as {
      slide_id: string;
      key: string;
      standby_id: string;
      size: number | null;
      made_by: string | null;
      created_at: number | null;
    }[];
    const keys = new Map<
      string,
      { slideId: string; key: string; standbyId: string; sizes: number[]; madeBy?: string; at?: number }
    >();
    for (const r of rows) {
      let k = keys.get(r.key);
      if (!k) {
        if (keys.size >= LISTING_KEYS_MAX) continue;
        keys.set(r.key, (k = { slideId: r.slide_id, key: r.key, standbyId: r.standby_id, sizes: [] }));
      }
      if (r.size !== null && !k.sizes.includes(r.size)) {
        k.sizes.push(r.size);
        if (r.made_by && !k.madeBy) k.madeBy = r.made_by;
        if (r.created_at !== null && (k.at === undefined || r.created_at > k.at)) k.at = r.created_at;
      }
    }
    const failures = (
      this.db
        .prepare(
          `SELECT f.key, f.reason, f.made_by, f.at FROM prerender_failures f
           WHERE f.key IN (SELECT DISTINCT key FROM prerender_keys WHERE presentation_id = ?) ORDER BY f.at DESC LIMIT 5000`,
        )
        .all(presentationId) as { key: string; reason: string; made_by: string | null; at: number }[]
    ).map((f) => ({ key: f.key, reason: f.reason, ...(f.made_by ? { madeBy: f.made_by } : {}), at: f.at }));
    const used = this.db
      .prepare(`SELECT COALESCE(SUM(bytes), 0) AS n FROM prerenders WHERE presentation_id = ?`)
      .get(presentationId) as { n: number };
    return {
      keys: [...keys.values()].map((k) => ({ ...k, sizes: k.sizes.sort((a, b) => a - b) })),
      failures,
      usedBytes: used.n,
    };
  }

  /**
   * What a goLive lists of a presentation's pictures (design/29 §1.3, §1.7): the keys of its current revision and,
   * per slide and size (3840 and 1920: the 640 preview is no goLive file), the picture of the slide's own key
   * (the newest), else a stand-by (a picture of the same slide, live set, backdrops and media files made before a
   * font upload or by an older renderer, W39), marked `standby`. A picture whose file the library lacks is left out.
   */
  goLive(
    presentationId: string,
    file: (hash: string) => FileRef | undefined,
  ): { keys: string[]; rows: PrerenderRow[] } {
    const cur = this.db
      .prepare(
        `SELECT k.slide_id, k.key, k.standby_id FROM prerender_keys k JOIN presentations p ON p.id = k.presentation_id AND p.rev = k.rev WHERE k.presentation_id = ? ORDER BY k.slide_id, k.key`,
      )
      .all(presentationId) as { slide_id: string; key: string; standby_id: string }[];
    if (!cur.length) return { keys: [], rows: [] };
    const keys = [...new Set(cur.map((r) => r.key))];
    const pics = this.db
      .prepare(
        `SELECT key, size, standby_id, hash, created_at FROM prerenders WHERE presentation_id = ? AND size IN (3840, 1920) ORDER BY created_at DESC`,
      )
      .all(presentationId) as {
      key: string;
      size: number;
      standby_id: string;
      hash: string;
      created_at: number;
    }[];
    if (!pics.length) return { keys, rows: [] };
    const bySlide = new Map<string, { keys: Set<string>; standbys: Set<string> }>();
    for (const r of cur) {
      const s = bySlide.get(r.slide_id) ?? { keys: new Set<string>(), standbys: new Set<string>() };
      s.keys.add(r.key);
      s.standbys.add(r.standby_id);
      bySlide.set(r.slide_id, s);
    }
    const currentKeys = new Set(keys);
    const rows: PrerenderRow[] = [];
    for (const [slideId, s] of bySlide)
      for (const size of [3840, 1920] as const) {
        // `pics` is newest first
        const own = pics.find((p) => p.size === size && s.keys.has(p.key));
        const pick =
          own ?? pics.find((p) => p.size === size && !currentKeys.has(p.key) && s.standbys.has(p.standby_id));
        const f = pick && file(pick.hash);
        if (pick && f)
          rows.push({ slideId, key: pick.key, size, file: f, ...(own ? {} : { standby: true }) });
      }
    return { keys, rows };
  }

  /**
   * Pictures nothing claims (collection, a cache with no delay): the key is in no kept revision's key rows of the
   * presentation, and the slide's stand-by id is no current slide's. A deleted presentation claims none.
   */
  unclaimed(): { presentationId: string; key: string; size: number; hash: string; bytes: number }[] {
    return (
      this.db
        .prepare(
          `SELECT p.presentation_id, p.key, p.size, p.hash, p.bytes FROM prerenders p WHERE ${UNCLAIMED}`,
        )
        .all() as {
        presentation_id: string;
        key: string;
        size: number;
        hash: string;
        bytes: number;
      }[]
    ).map((r) => ({
      presentationId: r.presentation_id,
      key: r.key,
      size: r.size,
      hash: r.hash,
      bytes: r.bytes,
    }));
  }

  /** Delete one such row unless a save has claimed it since (the condition is the statement's own); true when it went. */
  dropUnclaimed(r: { presentationId: string; key: string; size: number }): boolean {
    return (
      this.db
        .prepare(
          `DELETE FROM prerenders WHERE presentation_id = ? AND key = ? AND size = ? AND ${UNCLAIMED_ROW}`,
        )
        .run(r.presentationId, r.key, r.size).changes > 0
    );
  }

  /**
   * The pictures of a presentation the budget may drop, oldest version first (design/29 A24): a key of no current
   * revision, and no current slide's stand-by. `freed` is what dropping the row gives back to the presentation's
   * unique bytes: its bytes when no other picture row and no content name the same file, else nothing.
   */
  droppable(presentationId: string): { key: string; size: number; hash: string; freed: number }[] {
    const current = `SELECT 1 FROM prerender_keys k JOIN presentations c ON c.id = k.presentation_id AND c.rev = k.rev
                     WHERE k.presentation_id = p.presentation_id`;
    return this.db
      .prepare(
        `SELECT p.key, p.size, p.hash,
           CASE WHEN NOT EXISTS (SELECT 1 FROM prerenders q WHERE q.hash = p.hash
                                  AND NOT (q.presentation_id = p.presentation_id AND q.key = p.key AND q.size = p.size))
                 AND NOT EXISTS (SELECT 1 FROM file_refs r WHERE r.hash = p.hash) THEN p.bytes ELSE 0 END AS freed
         FROM prerenders p
         WHERE p.presentation_id = ?
           AND NOT EXISTS (${current} AND k.key = p.key)
           AND NOT EXISTS (${current} AND k.standby_id = p.standby_id)
         ORDER BY (SELECT MAX(k.rev) FROM prerender_keys k WHERE k.presentation_id = p.presentation_id AND k.key = p.key),
                  p.created_at, p.key, p.size`,
      )
      .all(presentationId) as { key: string; size: number; hash: string; freed: number }[];
  }

  /** What replacing the picture of this key and size gives back (its bytes when it is the only name of its file). */
  freedByReplacing(presentationId: string, key: string, size: number): number {
    const r = this.db
      .prepare(
        `SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM prerenders q WHERE q.hash = p.hash
                                       AND NOT (q.presentation_id = p.presentation_id AND q.key = p.key AND q.size = p.size))
                      AND NOT EXISTS (SELECT 1 FROM file_refs r WHERE r.hash = p.hash) THEN p.bytes ELSE 0 END AS freed
         FROM prerenders p WHERE p.presentation_id = ? AND p.key = ? AND p.size = ?`,
      )
      .get(presentationId, key, size) as { freed: number } | undefined;
    return r?.freed ?? 0;
  }

  /** How many picture rows name this file. */
  rowsNaming(hash: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM prerenders WHERE hash = ?`).get(hash) as { n: number })
      .n;
  }

  /**
   * The failures of a presentation's keys. The key rows are the only link between a failure and its presentation,
   * so this runs before they go (the library's delete hook runs it before the references forget).
   */
  forgetFailures(presentationId: string): void {
    this.db
      .prepare(
        `DELETE FROM prerender_failures WHERE key IN (SELECT DISTINCT key FROM prerender_keys WHERE presentation_id = ?)`,
      )
      .run(presentationId);
  }

  /** A deleted presentation's pictures, failures and key rows; the hashes the pictures named. */
  forgetPresentation(presentationId: string): string[] {
    return this.db.transaction(() => {
      const hashes = (
        this.db.prepare(`SELECT hash FROM prerenders WHERE presentation_id = ?`).all(presentationId) as {
          hash: string;
        }[]
      ).map((r) => r.hash);
      this.forgetFailures(presentationId);
      this.db.prepare(`DELETE FROM prerenders WHERE presentation_id = ?`).run(presentationId);
      this.db.prepare(`DELETE FROM prerender_keys WHERE presentation_id = ?`).run(presentationId);
      return hashes;
    })();
  }
}

/** Keys a listing names at most (design/29: a baker reads it to skip what exists). */
export const LISTING_KEYS_MAX = 5000;

/** What an accepted picture of the running service tells the live loop (`prerender.add`, step 7). */
export type Accepted = {
  presentationId: string;
  slideId: string;
  key: string;
  size: 3840 | 1920;
  file: FileRef;
};

export type PutResult = { status: 200 | 201; body: Record<string, unknown> };

/** Throw the refusal for a picture past the presentation's budget (step 10 fills it in). */
export type BudgetCheck = { ok: true } | { ok: false; usedBytes: number; limitBytes: number };

/** The picture service: the rules of design/29 §1.3 over the index and the content store. */
export class PrerenderStore {
  private lib: Library;
  private store: Store;
  private live: LiveView;
  private log: Logger;
  private accepted: ((e: Accepted) => void)[] = [];
  private health?: { budgetLimitBytes: number; budgetUsedBytes: number };
  private healthAt = 0;
  /** The limit of unique bytes per presentation; a constructor argument, lowered by the tests. */
  budgetBytes: number;

  /**
   * `open`: false while the hub's switch is off (ORDO_PRERENDER=off, `HubConfig.prerender.store`): a picture is refused
   * 503 `prerender_off`. The listing, the delete and the failure route do not look at it (an operator reads and cleans
   * them), and nothing stored is touched. Absent: always open.
   */
  private open: () => boolean;

  constructor(
    lib: Library,
    store: Store,
    live: LiveView,
    opts: { log: Logger; budgetBytes?: number; open?: () => boolean },
  ) {
    this.lib = lib;
    this.store = store;
    this.live = live;
    this.log = opts.log;
    this.budgetBytes = opts.budgetBytes ?? PRERENDER_BUDGET_BYTES;
    this.open = opts.open ?? (() => true);
  }

  /** Called with every picture accepted for a key of the running service (wired to the live loop in step 7). */
  onAccepted(fn: (e: Accepted) => void): void {
    this.accepted.push(fn);
  }

  /**
   * The budget's check before a picture is stored (design/29 A24, W29): the unique bytes of the presentation (the
   * files only its saved versions name: slide pages and heads, shape files and pictures; a file two presentations
   * name counts for neither) plus the incoming picture must stay within the limit. Past it the pictures of the
   * oldest versions' keys go first (never a current version's key, never a current slide's stand-by); when that frees
   * too little nothing is dropped and the picture is refused, so the screens draw the slide. Slide pages, heads and
   * shape files are never refused for the budget (the only copy of a big slide, the rule "never drop an element"):
   * they count, and the picture routes feel it.
   */
  async checkBudget(
    presentationId: string,
    incoming: { hash: string; bytes: number },
    replacing?: { key: string; size: number },
  ): Promise<BudgetCheck> {
    const idx = this.lib.prerenderIndex;
    const used = this.lib.refs.uniqueBytes(presentationId);
    // the incoming file counts unless a name already holds it (then it is counted already, or shared)
    const adds = this.lib.refs.referenced(incoming.hash) ? 0 : incoming.bytes;
    const leaves = replacing ? idx.freedByReplacing(presentationId, replacing.key, replacing.size) : 0;
    const need = used + adds - leaves - this.budgetBytes;
    if (need <= 0) return { ok: true };
    const chosen: { key: string; size: number }[] = [];
    let freed = 0;
    for (const c of idx.droppable(presentationId)) {
      if (freed >= need) break;
      if (replacing && c.key === replacing.key && c.size === replacing.size) continue;
      chosen.push(c);
      freed += c.freed;
    }
    if (freed < need) {
      this.log.warn(
        { presentationId, usedBytes: used, limitBytes: this.budgetBytes },
        'a presentation is at its picture budget: the screens draw its newest slides',
      );
      return { ok: false, usedBytes: used, limitBytes: this.budgetBytes };
    }
    for (const c of chosen) {
      for (const h of new Set(idx.deletePictures(presentationId, c.key, c.size))) await this.release(h);
    }
    this.healthAt = 0;
    return { ok: true };
  }

  private drain(stream: Readable): void {
    stream.resume();
  }

  async put(
    presentationId: string,
    key: string,
    size: number,
    stream: Readable,
    ctx: { role: 'operate' | 'edit'; madeBy?: string; kind?: string },
  ): Promise<PutResult> {
    const dims = PICTURE_SIZES[size];
    const idx = this.lib.prerenderIndex;
    const refuse = (e: HttpError): never => {
      this.drain(stream);
      throw e;
    };
    // The refusals in their order (hook H4): the switch, the kind, then the presentation, the size and the key.
    if (!this.open())
      return refuse(
        new HttpError(503, 'prerender_off', 'Pictures of heavy slides are turned off on this hub.'),
      );
    if (ctx.kind !== undefined && ctx.kind !== 'slide')
      return refuse(badRequest('Only pictures of slides are made yet', 'bad_kind'));
    const pres = this.lib.presentations.get(presentationId);
    if (!pres) return refuse(notFound(`presentation ${presentationId} not found`));
    if (!dims) return refuse(badRequest('size is 3840, 1920 or 640', 'bad_size'));
    const info = idx.keyInfo(presentationId, key);
    if (!info)
      return refuse(
        new HttpError(409, 'unknown_key', 'The hub does not know this picture key for the presentation'),
      );
    const live = this.live.mode() === 'live';
    if (
      live &&
      !(this.live.locks().presentations.has(presentationId) && idx.isCurrentKey(presentationId, key))
    )
      return refuse(
        new HttpError(
          503,
          'paused_during_service',
          'Pictures are paused during the service. Try again after End service.',
          {
            retryAfterS: PAUSED_RETRY_S,
          },
        ),
      );
    const existing = idx.picture(presentationId, key, size);
    if (existing && (live || ctx.role !== 'operate')) {
      this.drain(stream);
      return { status: 200, body: { dropped: true, hash: existing.hash } };
    }
    const r = await this.store.receive(stream, PICTURE_MAX_BYTES);
    const discard = () => rm(r.path, { force: true });
    try {
      const h = await readPictureHeader(r.path).catch(() => undefined);
      if (!h || (h.format !== 'png' && h.format !== 'webp') || h.animated || h.partial)
        throw badRequest('Send a PNG or WebP picture that is not animated', 'bad_picture');
      if (h.width !== dims[0] || h.height !== dims[1])
        throw badRequest(`A picture of size ${size} is exactly ${dims[0]}x${dims[1]}`, 'bad_picture');
      if (existing && existing.hash === r.hash) {
        await discard();
        return { status: 200, body: { dropped: true, hash: existing.hash } };
      }
      const budget = await this.checkBudget(presentationId, { hash: r.hash, bytes: r.bytes }, existing);
      if (!budget.ok)
        throw new HttpError(
          507,
          'budget',
          'This presentation has more detailed slides than ordo keeps pictures for',
          {
            reason: 'budget',
            usedBytes: budget.usedBytes,
            limitBytes: budget.limitBytes,
          },
        );
      const mime = h.format === 'png' ? 'image/png' : 'image/webp';
      const ref = await this.store.put(r.path, { ext: h.format, mime, hash: r.hash, bytes: r.bytes });
      const row: PictureRow = {
        presentationId,
        key,
        size,
        slideId: info.slideId,
        standbyId: info.standbyId,
        version: PRERENDER_VERSION,
        kind: 'slide', // the one kind made yet (`ctx.kind` is 'slide' or absent)
        hash: r.hash,
        mime,
        bytes: r.bytes,
        w: h.width,
        h: h.height,
        opaque: h.alpha === false,
        madeBy: ctx.madeBy?.slice(0, 120) || undefined,
        madeRole: ctx.role,
        lastRev: pres.rev,
        createdAt: Date.now(),
      };
      const replaced = existing ? idx.replacePicture(row) : undefined;
      if (replaced) {
        await this.release(replaced);
      } else if (!idx.insertPicture(row)) {
        await this.release(r.hash);
        return { status: 200, body: { dropped: true } };
      }
      this.healthAt = 0;
      if (live && (size === 3840 || size === 1920))
        for (const fn of this.accepted) {
          try {
            fn({ presentationId, slideId: info.slideId, key, size, file: ref });
          } catch (e) {
            this.log.warn({ err: (e as Error).message }, 'announcing a picture to the live loop failed');
          }
        }
      return {
        status: existing ? 200 : 201,
        body: { hash: r.hash, key, size, bytes: r.bytes, ...(existing ? { replaced: true } : {}) },
      };
    } catch (e) {
      await discard();
      throw e;
    }
  }

  /** Delete a key's pictures and its failure ("Make picture again"); the files nothing names go too. */
  async remove(presentationId: string, key: string, size?: number): Promise<void> {
    for (const h of new Set(this.lib.prerenderIndex.deletePictures(presentationId, key, size)))
      await this.release(h);
    this.healthAt = 0;
  }

  fail(presentationId: string, key: string, reason: string, madeBy: string | undefined): void {
    if (!this.lib.presentations.get(presentationId))
      throw notFound(`presentation ${presentationId} not found`);
    if (!this.lib.prerenderIndex.hasKey(presentationId, key))
      throw new HttpError(409, 'unknown_key', 'The hub does not know this picture key for the presentation');
    this.lib.prerenderIndex.setFailure(key, reason, madeBy, Date.now());
  }

  list(presentationId: string) {
    if (!this.lib.presentations.get(presentationId))
      throw notFound(`presentation ${presentationId} not found`);
    const l = this.lib.prerenderIndex.listing(presentationId);
    return {
      keys: l.keys,
      failures: l.failures,
      budget: { usedBytes: this.lib.refs.uniqueBytes(presentationId), limitBytes: this.budgetBytes },
    };
  }

  /**
   * The limit and the largest presentation's unique bytes, for hub health: asked every few seconds, so measured at
   * most every HEALTH_BUDGET_MS and after pictures go.
   */
  healthFields(): { budgetLimitBytes: number; budgetUsedBytes: number } {
    const now = Date.now();
    if (
      !this.health ||
      now - this.healthAt > HEALTH_BUDGET_MS ||
      this.health.budgetLimitBytes !== this.budgetBytes
    ) {
      let max = 0;
      for (const id of this.lib.refs.budgeted()) max = Math.max(max, this.lib.refs.uniqueBytes(id));
      this.health = { budgetLimitBytes: this.budgetBytes, budgetUsedBytes: max };
      this.healthAt = now;
    }
    return this.health;
  }

  /** A deleted presentation's pictures, failures and key rows; its picture files go with no other row. */
  async forget(presentationId: string): Promise<void> {
    for (const h of new Set(this.lib.prerenderIndex.forgetPresentation(presentationId)))
      await this.release(h);
    this.healthAt = 0;
  }

  /** A picture file goes when no picture row names it (a cache: no thirty days). */
  private async release(hash: string): Promise<void> {
    if (!this.lib.prerenderIndex.hashNamed(hash)) await this.store.release(hash);
  }
}

/**
 * The files and fields a goLive bundle adds for pre-rendered slides (design/29 §1.7), from the DB-only indexes:
 * each slide's head, its pages and the shape files it uses (`files`), the head to its pages (`slideHeads`, read from
 * `slide_head_pages`, never from the file), and per presentation the keys of its current revision and its picture
 * rows. A field is present only when something is in it: a library with no pre-rendered slide sends the bundle it
 * always sent. The presentations are as stored (unvalidated), so every read is guarded.
 */
export function goLiveExtras(
  lib: Library,
  presentations: Record<string, unknown>,
): {
  files: Record<string, FileRef>;
  slideHeads?: Record<string, { pages: string[] }>;
  prerenders?: Record<string, PrerenderRow[]>;
  prerenderKeys?: Record<string, string[]>;
} {
  const files: Record<string, FileRef> = {};
  const slideHeads: Record<string, { pages: string[] }> = {};
  const prerenders: Record<string, PrerenderRow[]> = {};
  const prerenderKeys: Record<string, string[]> = {};
  const add = (hash: string) => {
    const f = lib.getFile(hash);
    if (f) files[hash] = f;
  };
  const sha = /^[0-9a-f]{64}$/;
  for (const [id, p] of Object.entries(presentations)) {
    const sections = (p as { sections?: unknown } | undefined)?.sections;
    for (const sec of Array.isArray(sections) ? sections : []) {
      const slides = (sec as { slides?: unknown } | undefined)?.slides;
      for (const s of Array.isArray(slides) ? slides : []) {
        const ref = (s as { prerender?: { file?: { ref?: unknown } } } | undefined)?.prerender?.file?.ref;
        if (typeof ref !== 'string' || !sha.test(ref) || slideHeads[ref]) continue;
        const head = lib.slideFiles.head(ref);
        if (!head) continue;
        slideHeads[ref] = { pages: head.pages };
        add(ref);
        for (const page of head.pages) add(page);
        for (const used of head.uses.files) add(used);
      }
    }
    const g = lib.prerenderIndex.goLive(id, (h) => lib.getFile(h));
    if (g.keys.length) prerenderKeys[id] = g.keys;
    if (g.rows.length) {
      prerenders[id] = g.rows;
      for (const r of g.rows) files[r.file.hash] = r.file;
    }
  }
  return {
    files,
    ...(Object.keys(slideHeads).length ? { slideHeads } : {}),
    ...(Object.keys(prerenders).length ? { prerenders } : {}),
    ...(Object.keys(prerenderKeys).length ? { prerenderKeys } : {}),
  };
}

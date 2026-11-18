/**
 * Pre-rendered slides' keys and pictures on the hub (design/29 §1.3). `PrerenderIndex` is the DB-only side (a
 * property of `Library`): the upload check, the goLive key set and the stand-by lookup are index reads, never a
 * parse of a revision.
 */
import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { FileRef } from '@ordo/domain';
import { PRERENDER_VERSION } from '@ordo/domain/prerender.ts';
import type { Logger } from 'pino';
import type { DB } from './db.ts';
import { badRequest, HttpError, notFound } from './errors.ts';
import type { Library } from './library.ts';
import { readPictureHeader } from './pptx/pictures.ts';
import type { LiveView } from './routes.ts';
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

  replacePicture(p: PictureRow): void {
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

  /** A deleted presentation's pictures, failures and key rows; the hashes the pictures named. */
  forgetPresentation(presentationId: string): string[] {
    return this.db.transaction(() => {
      const hashes = (
        this.db.prepare(`SELECT hash FROM prerenders WHERE presentation_id = ?`).all(presentationId) as {
          hash: string;
        }[]
      ).map((r) => r.hash);
      this.db
        .prepare(
          `DELETE FROM prerender_failures WHERE key IN (SELECT DISTINCT key FROM prerender_keys WHERE presentation_id = ?)`,
        )
        .run(presentationId);
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
  readonly budgetBytes: number;

  constructor(lib: Library, store: Store, live: LiveView, opts: { log: Logger; budgetBytes?: number }) {
    this.lib = lib;
    this.store = store;
    this.live = live;
    this.log = opts.log;
    this.budgetBytes = opts.budgetBytes ?? PRERENDER_BUDGET_BYTES;
  }

  /** Called with every picture accepted for a key of the running service (wired to the live loop in step 7). */
  onAccepted(fn: (e: Accepted) => void): void {
    this.accepted.push(fn);
  }

  /** The budget's check before a picture is stored (step 10 counts unique bytes and drops the oldest pictures). */
  checkBudget(_presentationId: string, _incomingBytes: number): BudgetCheck {
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
    ctx: { role: 'operate' | 'edit'; madeBy?: string },
  ): Promise<PutResult> {
    const dims = PICTURE_SIZES[size];
    const idx = this.lib.prerenderIndex;
    const refuse = (e: HttpError): never => {
      this.drain(stream);
      throw e;
    };
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
      const budget = this.checkBudget(presentationId, r.bytes);
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
        kind: 'slide',
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
      if (existing) {
        idx.replacePicture(row);
        await this.release(existing.hash);
      } else if (!idx.insertPicture(row)) {
        await this.release(r.hash);
        return { status: 200, body: { dropped: true } };
      }
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
      budget: { usedBytes: l.usedBytes, limitBytes: this.budgetBytes },
    };
  }

  /** A deleted presentation's pictures, failures and key rows; its picture files go with no other row. */
  async forget(presentationId: string): Promise<void> {
    for (const h of new Set(this.lib.prerenderIndex.forgetPresentation(presentationId)))
      await this.release(h);
  }

  /** A picture file goes when no picture row names it (a cache: no thirty days). */
  private async release(hash: string): Promise<void> {
    if (!this.lib.prerenderIndex.hashNamed(hash)) await this.store.release(hash);
  }
}

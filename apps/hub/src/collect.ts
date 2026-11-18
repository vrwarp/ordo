/**
 * What stored presentations and their saved versions name, and (steps 9-10) when the hub may let a file go (design/29
 * §1.3 "Collection with revisions", A37, M7).
 *
 * The references index: every save records, as an interval of revisions, each content file its JSON names (a `ref`
 * of a shape, a mask, a decoration or a pre-rendered slide's file, and the files of its `uses`), found by a text
 * scan of the string the save already built, never by a parse. An interval, not a row per revision: a 2,000-file deck
 * saved 50 times is 2,000 rows. A file is named while an interval of it reaches the oldest revision the hub still
 * keeps of that presentation (the current one always does). Pruning and deleting remove what they remove.
 */
import type { Logger } from 'pino';
import type { DB } from './db.ts';
import type { Library } from './library.ts';

const REF_RE = /"ref":"([0-9a-f]{64})"/g;
const FILES_RE = /"files":\[((?:"[0-9a-f]{64}",?)+)\]/g;

/**
 * The content files a stored JSON names: every `"ref":"<64 hex>"` and every 64-hex string of an array under a key
 * `files`, in the exact text `JSON.stringify` wrote. A quote inside a string is escaped, so neither pattern can
 * match user text (`"ref\":` never reads as a key). No parse.
 */
export function refsIn(json: string): Set<string> {
  const out = new Set<string>();
  if (json.includes('"ref":"')) for (const m of json.matchAll(REF_RE)) out.add(m[1]!);
  if (json.includes('"files":["'))
    for (const m of json.matchAll(FILES_RE)) for (const h of m[1]!.split(',')) out.add(h.slice(1, -1));
  return out;
}

/** The newest revision of a presentation a kept-revision interval must reach to name a file. */
const OLDEST_KEPT =
  'COALESCE((SELECT MIN(v.rev) FROM presentation_revisions v WHERE v.presentation_id = r.presentation_id), 9007199254740991)';

const chunks = <T>(xs: readonly T[], n = 500): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** DB-only: intervals of revisions that name a content file (`file_refs`), the backfill's markers, and what is named. */
export class RefIndex {
  private db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  /** A save: record the files its JSON names, mark the revision scanned and clear the marks of what it names. */
  recordSave(presentationId: string, rev: number, json: string): void {
    this.record(presentationId, rev, refsIn(json));
    this.markScanned(presentationId, rev);
  }

  /** `refs` are named by revision `rev`: extend the intervals open at `rev - 1`, open new ones, clear their marks. */
  record(presentationId: string, rev: number, refs: ReadonlySet<string>): void {
    if (!refs.size) return;
    const names = [...refs];
    this.db.transaction(() => {
      const open = new Set(
        (
          this.db
            .prepare(`SELECT hash FROM file_refs WHERE presentation_id = ? AND last_rev = ?`)
            .all(presentationId, rev - 1) as { hash: string }[]
        ).map((r) => r.hash),
      );
      const extend = names.filter((h) => open.has(h));
      for (const c of chunks(extend))
        this.db
          .prepare(
            `UPDATE file_refs SET last_rev = ? WHERE presentation_id = ? AND last_rev = ? AND hash IN (${c.map(() => '?').join(',')})`,
          )
          .run(rev, presentationId, rev - 1, ...c);
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO file_refs (presentation_id, hash, first_rev, last_rev) VALUES (?, ?, ?, ?)`,
      );
      for (const h of names) if (!open.has(h)) ins.run(presentationId, h, rev, rev);
      for (const c of chunks(names))
        this.db.prepare(`DELETE FROM collect_marks WHERE hash IN (${c.map(() => '?').join(',')})`).run(...c);
    })();
  }

  markScanned(presentationId: string, rev: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO refs_scanned (presentation_id, rev) VALUES (?, ?)`)
      .run(presentationId, rev);
  }

  /** After `pruneRevisions`: what only the pruned revisions held goes (intervals, key rows, markers). */
  prune(presentationId: string): void {
    const lo = (
      this.db
        .prepare(`SELECT MIN(rev) AS lo FROM presentation_revisions WHERE presentation_id = ?`)
        .get(presentationId) as {
        lo: number | null;
      }
    ).lo;
    if (lo === null) {
      this.forget(presentationId);
      return;
    }
    this.db
      .prepare(`DELETE FROM file_refs WHERE presentation_id = ? AND last_rev < ?`)
      .run(presentationId, lo);
    this.db
      .prepare(`DELETE FROM prerender_keys WHERE presentation_id = ? AND rev < ?`)
      .run(presentationId, lo);
    this.db.prepare(`DELETE FROM refs_scanned WHERE presentation_id = ? AND rev < ?`).run(presentationId, lo);
  }

  /** A deleted presentation: every interval and marker of it (its files wait out their days in the collector). */
  forget(presentationId: string): void {
    this.db.prepare(`DELETE FROM file_refs WHERE presentation_id = ?`).run(presentationId);
    this.db.prepare(`DELETE FROM refs_scanned WHERE presentation_id = ?`).run(presentationId);
    this.db.prepare(`DELETE FROM prerender_keys WHERE presentation_id = ?`).run(presentationId);
  }

  /**
   * Whether anything the hub keeps names this file (design/29 data model, "what is a name"): (a) an interval that
   * reaches a kept revision of some presentation, (b) a head named by (a) that has it as a page or in its uses, or
   * (c) a picture row. The current presentations' own JSON is asked by `Library.fileReferenced`.
   */
  referenced(hash: string): boolean {
    const alive = `${'r.last_rev'} >= ${OLDEST_KEPT}`;
    const direct = this.db
      .prepare(`SELECT 1 FROM file_refs r WHERE r.hash = ? AND ${alive} LIMIT 1`)
      .get(hash);
    if (direct) return true;
    const page = this.db
      .prepare(
        `SELECT 1 FROM slide_head_pages p WHERE p.page = ? AND EXISTS (SELECT 1 FROM file_refs r WHERE r.hash = p.head AND ${alive}) LIMIT 1`,
      )
      .get(hash);
    if (page) return true;
    const like = `%"${hash}"%`;
    const uses = this.db
      .prepare(
        `SELECT 1 FROM slide_heads h WHERE h.uses LIKE ? AND EXISTS (SELECT 1 FROM file_refs r WHERE r.hash = h.hash AND ${alive}) LIMIT 1`,
      )
      .get(like);
    if (uses) return true;
    return !!this.db.prepare(`SELECT 1 FROM prerenders WHERE hash = ? LIMIT 1`).get(hash);
  }

  /** The next revision after `after` (presentation, rev) that no save or scan has recorded, with its raw JSON. */
  nextUnscanned(after?: { id: string; rev: number }): { id: string; rev: number; json: string } | undefined {
    const id = after?.id ?? '';
    const rev = after?.rev ?? 0;
    return this.db
      .prepare(
        `SELECT v.presentation_id AS id, v.rev AS rev, v.json AS json FROM presentation_revisions v
         WHERE (v.presentation_id > ? OR (v.presentation_id = ? AND v.rev > ?))
           AND NOT EXISTS (SELECT 1 FROM refs_scanned s WHERE s.presentation_id = v.presentation_id AND s.rev = v.rev)
         ORDER BY v.presentation_id, v.rev LIMIT 1`,
      )
      .get(id, id, rev) as { id: string; rev: number; json: string } | undefined;
  }

  unscannedCount(): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM presentation_revisions v WHERE NOT EXISTS (SELECT 1 FROM refs_scanned s WHERE s.presentation_id = v.presentation_id AND s.rev = v.rev)`,
      )
      .get() as { n: number };
    return r.n;
  }

  setBackfillDone(done: boolean): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('refs_backfill_done', ?)`)
      .run(done ? '1' : '0');
  }
}

export type BackfillOptions = {
  live: () => 'idle' | 'live';
  log: Logger;
  now?: () => number;
  yield?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each revision read (tests count them and advance their clock). */
  onRead?: (presentationId: string, rev: number) => void;
  /** A slice of work is at most this long between yields (20 ms). */
  sliceMs?: number;
  startDelayMs?: number;
};

/** The start-up delay of the backfill (design/29: 2 minutes after the start). */
export const BACKFILL_START_DELAY_MS = 120_000;
const SLICE_MS = 20;
/** 100 ms of sleep per this many revisions. */
const PAUSE_EVERY = 10;
const PAUSE_MS = 100;

/**
 * The one-off scan of revisions a hub that did not record references saved (PR #29's, or an older build): raw text,
 * one revision at a time in slices of at most 20 ms, 100 ms of sleep per 10 revisions, resumable (every revision is
 * marked as it is scanned), never while a service is live. A revision saved meanwhile is recorded by its own save.
 */
export class RefBackfill {
  private lib: Library;
  private opts: BackfillOptions;
  private running = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;

  constructor(lib: Library, opts: BackfillOptions) {
    this.lib = lib;
    this.opts = opts;
  }

  start(): void {
    const t = setTimeout(() => void this.run(), this.opts.startDelayMs ?? BACKFILL_START_DELAY_MS);
    t.unref();
    this.timer = t;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** End service: a backfill that waited for it carries on. */
  onLiveMode(mode: 'idle' | 'live'): void {
    if (mode === 'idle' && !this.running && !this.stopped && this.timer) void this.run();
  }

  /** Scan what is unscanned, to the end, or until stopped or a service goes live. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const refs = this.lib.refs;
    const now = this.opts.now ?? Date.now;
    const yieldNow = this.opts.yield ?? (() => new Promise<void>((r) => setImmediate(r)));
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const sliceMs = this.opts.sliceMs ?? SLICE_MS;
    try {
      let cursor: { id: string; rev: number } | undefined;
      let started = false;
      let sinceSleep = 0;
      for (;;) {
        if (this.stopped) return;
        if (this.opts.live() === 'live') return;
        const t0 = now();
        let pause = false;
        while (now() - t0 < sliceMs && !pause) {
          const next = refs.nextUnscanned(cursor);
          if (!next) {
            refs.setBackfillDone(true);
            if (started) this.opts.log.info({ revisions: this.scanned }, 'references backfill finished');
            return;
          }
          if (!started) {
            started = true;
            refs.setBackfillDone(false);
            this.opts.log.info({ revisions: refs.unscannedCount() }, 'references backfill started');
          }
          refs.record(next.id, next.rev, refsIn(next.json));
          refs.markScanned(next.id, next.rev);
          cursor = { id: next.id, rev: next.rev };
          this.scanned++;
          this.opts.onRead?.(next.id, next.rev);
          if (this.stopped) return;
          if (++sinceSleep >= PAUSE_EVERY) {
            sinceSleep = 0;
            pause = true;
          }
        }
        await yieldNow();
        if (pause) await sleep(PAUSE_MS);
      }
    } finally {
      this.running = false;
    }
  }
  private scanned = 0;
}

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
import { rm } from 'node:fs/promises';
import { nextTimeOfDay } from '@ordo/domain';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { RETENTION_DAYS } from './backup.ts';
import type { CollectMode } from './config.ts';
import type { DB } from './db.ts';
import { errorMessage } from './errors.ts';
import type { Library } from './library.ts';
import type { Store } from './store.ts';

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

/**
 * The bytes of the files only one presentation's saved versions name (design/29 A24, W29), from the indexes alone:
 * the files its kept revisions name (`file_refs`), the pages of its heads and its picture rows, less any file a
 * second presentation names the same way. Each file once, whatever the number of revisions that name it.
 */
export const UNIQUE_BYTES_SQL = `
WITH mine(hash) AS (
  SELECT hash FROM file_refs WHERE presentation_id = :pid
  UNION SELECT p.page FROM slide_head_pages p JOIN file_refs r ON r.hash = p.head WHERE r.presentation_id = :pid
  UNION SELECT hash FROM prerenders WHERE presentation_id = :pid
)
SELECT COALESCE(SUM(f.bytes), 0) AS n FROM mine m JOIN files f ON f.hash = m.hash
WHERE NOT EXISTS (SELECT 1 FROM file_refs o WHERE o.hash = m.hash AND o.presentation_id <> :pid)
  AND NOT EXISTS (SELECT 1 FROM slide_head_pages q JOIN file_refs r2 ON r2.hash = q.head
                  WHERE q.page = m.hash AND r2.presentation_id <> :pid)
  AND NOT EXISTS (SELECT 1 FROM prerenders x WHERE x.hash = m.hash AND x.presentation_id <> :pid)`;

/**
 * The presentations with a picture or an interval that reaches a head. The heads come first (`CROSS JOIN` fixes the
 * order): left to itself the planner walks every interval (590,000 on a large library) and looks each up among no
 * heads at all, 45 ms of the library's loop every time the health numbers are asked.
 */
export const BUDGETED_SQL = `SELECT presentation_id AS id FROM prerenders
  UNION SELECT r.presentation_id FROM slide_heads h CROSS JOIN file_refs r ON r.hash = h.hash`;

/**
 * The backfill's next revision: the first one after the cursor that no save or scan has recorded. A plain index
 * range on the revisions' key, read in key order: no sort and no scan, so a library of 25,000 revisions costs 25,000
 * short reads, not 25,000 sorts of what is left (each of which would carry every remaining body).
 */
export const NEXT_UNSCANNED_SQL = `SELECT v.presentation_id AS id, v.rev AS rev, v.json AS json FROM presentation_revisions v
  WHERE (v.presentation_id > :id OR (v.presentation_id = :id AND v.rev > :rev))
    AND NOT EXISTS (SELECT 1 FROM refs_scanned s WHERE s.presentation_id = v.presentation_id AND s.rev = v.rev)
  ORDER BY v.presentation_id, v.rev LIMIT 1`;

/** The newest revision of a presentation a kept-revision interval must reach to name a file. */
const OLDEST_KEPT =
  'COALESCE((SELECT MIN(v.rev) FROM presentation_revisions v WHERE v.presentation_id = r.presentation_id), 9007199254740991)';

type Statement = Database.Statement<unknown[], unknown>;

/** DB-only: intervals of revisions that name a content file (`file_refs`), the backfill's markers, and what is named. */
export class RefIndex {
  private db: DB;
  /** Statements are parsed once: a backfill of 25,000 revisions asks the same few thousands of times. */
  private stmts = new Map<string, Statement>();
  private recordTx?: (presentationId: string, rev: number, names: string[]) => void;
  constructor(db: DB) {
    this.db = db;
  }

  private q(sql: string): Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** A save: record the files its JSON names, mark the revision scanned and clear the marks of what it names. */
  recordSave(presentationId: string, rev: number, json: string): void {
    this.record(presentationId, rev, refsIn(json));
    this.markScanned(presentationId, rev);
  }

  /**
   * `refs` are named by revision `rev`: extend the intervals open at `rev - 1`, open one for every name that has none
   * at `rev`, clear their marks. Two statements over the names as a JSON list, no read of the open intervals. One
   * transaction, unless the caller already holds one (`inBatch`, a slice of the backfill).
   */
  record(presentationId: string, rev: number, refs: ReadonlySet<string>, inBatch = false): void {
    if (!refs.size) return;
    const names = [...refs];
    if (inBatch) {
      this.recordBody(presentationId, rev, names);
      return;
    }
    this.recordTx ??= this.db.transaction((pid: string, r: number, n: string[]) =>
      this.recordBody(pid, r, n),
    );
    this.recordTx(presentationId, rev, names);
  }

  private recordBody(pid: string, r: number, names: string[]): void {
    const list = JSON.stringify(names);
    this.q(
      `UPDATE file_refs SET last_rev = :rev WHERE presentation_id = :pid AND last_rev = :prev
       AND hash IN (SELECT value FROM json_each(:list))`,
    ).run({ rev: r, pid, prev: r - 1, list });
    this.q(
      `INSERT OR IGNORE INTO file_refs (presentation_id, hash, first_rev, last_rev)
       SELECT :pid, value, :rev, :rev FROM json_each(:list)
       WHERE NOT EXISTS (SELECT 1 FROM file_refs o WHERE o.presentation_id = :pid AND o.hash = value AND o.last_rev = :rev)`,
    ).run({ pid, rev: r, list });
    this.unmark(names, list);
  }

  /** Run `fn` as one transaction: a slice of the backfill is one commit, not one per revision. */
  batch<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  markScanned(presentationId: string, rev: number): void {
    this.q(`INSERT OR IGNORE INTO refs_scanned (presentation_id, rev) VALUES (?, ?)`).run(
      presentationId,
      rev,
    );
  }

  /** After `pruneRevisions`: what only the pruned revisions held goes (intervals, key rows, markers). */
  prune(presentationId: string): void {
    const lo = (
      this.q(`SELECT MIN(rev) AS lo FROM presentation_revisions WHERE presentation_id = ?`).get(
        presentationId,
      ) as {
        lo: number | null;
      }
    ).lo;
    if (lo === null) {
      this.forget(presentationId);
      return;
    }
    this.q(`DELETE FROM file_refs WHERE presentation_id = ? AND last_rev < ?`).run(presentationId, lo);
    this.q(`DELETE FROM prerender_keys WHERE presentation_id = ? AND rev < ?`).run(presentationId, lo);
    this.q(`DELETE FROM refs_scanned WHERE presentation_id = ? AND rev < ?`).run(presentationId, lo);
  }

  /** A deleted presentation: every interval and marker of it (its files wait out their days in the collector). */
  forget(presentationId: string): void {
    this.q(`DELETE FROM file_refs WHERE presentation_id = ?`).run(presentationId);
    this.q(`DELETE FROM refs_scanned WHERE presentation_id = ?`).run(presentationId);
    this.q(`DELETE FROM prerender_keys WHERE presentation_id = ?`).run(presentationId);
  }

  /**
   * Whether anything the hub keeps names this file (design/29 data model, "what is a name"): (a) an interval that
   * reaches a kept revision of some presentation, (b) a head named by (a) that has it as a page or in its uses, or
   * (c) a picture row (unless `pictures` is false). The current presentations' own JSON is asked by
   * `Library.fileReferenced`.
   */
  referenced(hash: string, opts: { pictures?: boolean } = {}): boolean {
    const alive = `r.last_rev >= ${OLDEST_KEPT}`;
    const direct = this.q(`SELECT 1 FROM file_refs r WHERE r.hash = ? AND ${alive} LIMIT 1`).get(hash);
    if (direct) return true;
    const page = this.q(
      `SELECT 1 FROM slide_head_pages p WHERE p.page = ? AND EXISTS (SELECT 1 FROM file_refs r WHERE r.hash = p.head AND ${alive}) LIMIT 1`,
    ).get(hash);
    if (page) return true;
    const like = `%"${hash}"%`;
    const uses = this.q(
      `SELECT 1 FROM slide_heads h WHERE h.uses LIKE ? AND EXISTS (SELECT 1 FROM file_refs r WHERE r.hash = h.hash AND ${alive}) LIMIT 1`,
    ).get(like);
    if (uses) return true;
    if (opts.pictures === false) return false;
    return !!this.q(`SELECT 1 FROM prerenders WHERE hash = ? LIMIT 1`).get(hash);
  }

  /**
   * The bytes of the files only this presentation's saved versions name: a file two presentations name counts for
   * neither, a file several revisions name counts once (`UNIQUE_BYTES_SQL`).
   */
  uniqueBytes(presentationId: string): number {
    return (this.q(UNIQUE_BYTES_SQL).get({ pid: presentationId }) as { n: number }).n;
  }

  /** The presentations that have a pre-rendered slide's file or a picture: the ones the budget can concern. */
  budgeted(): string[] {
    return (this.q(BUDGETED_SQL).all() as { id: string }[]).map((r) => r.id);
  }

  /**
   * A file is named (again): its collection clock stops, and starts from nothing the next time it is unnamed. Nothing
   * to do (and nothing asked of the names) while no file has a mark, which is every save before the first collection.
   */
  unmark(hashes: readonly string[], list?: string): void {
    if (!hashes.length || !this.q(`SELECT 1 FROM collect_marks LIMIT 1`).get()) return;
    this.q(`DELETE FROM collect_marks WHERE hash IN (SELECT value FROM json_each(?))`).run(
      list ?? JSON.stringify(hashes),
    );
  }

  /** Whether the backfill has scanned every revision (collection waits for it: until then the index is partial). */
  backfillDone(): boolean {
    const r = this.q(`SELECT value FROM meta WHERE key = 'refs_backfill_done'`).get() as
      | { value: string }
      | undefined;
    return r?.value === '1';
  }

  meta(key: string): string | undefined {
    return (this.q(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.q(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value);
  }

  /** The next `limit` content files (`application/json`) after `after`, by hash: the candidates of collection. */
  jsonFiles(after: string, limit: number): { hash: string; bytes: number }[] {
    return this.q(
      `SELECT hash, bytes FROM files WHERE mime = 'application/json' AND hash > ? ORDER BY hash LIMIT ?`,
    ).all(after, limit) as { hash: string; bytes: number }[];
  }

  /** Start a file's clock at `at` unless it already runs; true when this call started it. */
  markUnnamed(hash: string, at: number): boolean {
    return (
      this.q(`INSERT OR IGNORE INTO collect_marks (hash, since) VALUES (?, ?)`).run(hash, at).changes > 0
    );
  }

  /** Marks of files that are not content files any more (their row went another way): one probe a mark, no list. */
  dropOrphanMarks(): void {
    this.q(
      `DELETE FROM collect_marks WHERE NOT EXISTS
         (SELECT 1 FROM files f WHERE f.hash = collect_marks.hash AND f.mime = 'application/json')`,
    ).run();
  }

  /** Every file's clock starts again at `at` (the hub's clock jumped); the number of marks moved. */
  rebaseMarks(at: number): number {
    return this.q(`UPDATE collect_marks SET since = ?`).run(at).changes;
  }

  /** The files whose mark is `before` or older: heads first, so their pages are named by nothing when they come. */
  dueFiles(before: number): { hash: string; bytes: number }[] {
    return this.q(
      `SELECT m.hash AS hash, f.bytes AS bytes FROM collect_marks m JOIN files f ON f.hash = m.hash
         WHERE f.mime = 'application/json' AND m.since <= ?
         ORDER BY EXISTS (SELECT 1 FROM slide_heads h WHERE h.hash = m.hash) DESC, m.hash`,
    ).all(before) as { hash: string; bytes: number }[];
  }

  /** The next revision after `after` (presentation, rev) that no save or scan has recorded, with its raw JSON. */
  nextUnscanned(after?: { id: string; rev: number }): { id: string; rev: number; json: string } | undefined {
    return this.q(NEXT_UNSCANNED_SQL).get({ id: after?.id ?? '', rev: after?.rev ?? 0 }) as
      | { id: string; rev: number; json: string }
      | undefined;
  }

  unscannedCount(): number {
    const r = this.q(
      `SELECT COUNT(*) AS n FROM presentation_revisions v WHERE NOT EXISTS (SELECT 1 FROM refs_scanned s WHERE s.presentation_id = v.presentation_id AND s.rev = v.rev)`,
    ).get() as { n: number };
    return r.n;
  }

  setBackfillDone(done: boolean): void {
    this.q(`INSERT OR REPLACE INTO meta (key, value) VALUES ('refs_backfill_done', ?)`).run(done ? '1' : '0');
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
  /** A run ended because a service went live: it resumes when the service ends (not before its own start delay). */
  private waiting = false;
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
    if (mode === 'idle' && this.waiting && !this.running && !this.stopped) void this.run();
  }

  /** Scan what is unscanned, to the end, or until stopped or a service goes live. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.waiting = false;
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
        if (this.opts.live() === 'live') {
          this.waiting = true;
          return;
        }
        const t0 = now();
        // set inside the batch below: a union the compiler does not narrow to its first value
        let outcome = 'time' as 'time' | 'pause' | 'done' | 'stopped';
        // a slice is one transaction: the commits of 10 revisions are 10 times the cost of one
        refs.batch(() => {
          while (now() - t0 < sliceMs) {
            const next = refs.nextUnscanned(cursor);
            if (!next) {
              outcome = 'done';
              return;
            }
            if (!started) {
              started = true;
              refs.setBackfillDone(false);
              this.opts.log.info({ revisions: refs.unscannedCount() }, 'references backfill started');
            }
            refs.record(next.id, next.rev, refsIn(next.json), true);
            refs.markScanned(next.id, next.rev);
            cursor = { id: next.id, rev: next.rev };
            this.scanned++;
            this.opts.onRead?.(next.id, next.rev);
            if (this.stopped) {
              outcome = 'stopped';
              return;
            }
            if (++sinceSleep >= PAUSE_EVERY) {
              sinceSleep = 0;
              outcome = 'pause';
              return;
            }
          }
        });
        if (outcome === 'stopped') return;
        if (outcome === 'done') {
          refs.setBackfillDone(true);
          if (started) this.opts.log.info({ revisions: this.scanned }, 'references backfill finished');
          return;
        }
        await yieldNow();
        if (outcome === 'pause') await sleep(PAUSE_MS);
      }
    } finally {
      this.running = false;
    }
  }
  private scanned = 0;
}

// ── collection ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How long a content file nothing names is kept before it may go: the nightly backups' retention and one night more,
 * so the manifest of any backup that can still be restored finds the file, the backup made the night the file was
 * first seen unnamed included (it is pruned at the 03:00 backup of the 31st day, the sweep is the 04:00 run after it;
 * with exactly the retention the two fell on the same night). CO3, CO6: a test fails if this is lowered.
 */
export const COLLECT_DELAY_DAYS = RETENTION_DAYS + 1;
const DELAY_MS = COLLECT_DELAY_DAYS * 86_400_000;
/** The first run is this long after the start; the others are at 04:00 venue time, an hour after the 03:00 backup. */
export const COLLECT_START_DELAY_MS = 10 * 60_000;
const COLLECT_AT = '04:00';
/** A run that was held back for the backfill looks again this often. */
const BACKFILL_RETRY_MS = 10 * 60_000;
/** The scheduler never arms a timer shorter than this. */
const MIN_ARM_MS = 1000;
const PAGE = 200;
/** A slice of a pass: at most this long between yields (the loop's delay is this plus a step; 20 ms is the rule). */
const COLLECT_SLICE_MS = 5;
/**
 * The wall clock against the monotonic one between two runs of a process, and against the last run's own time across
 * a restart: more apart than this and the clock has jumped (a hub without a clock battery set by the network, a
 * suspended machine), so every mark starts again. A jump shorter than this is inside the night the delay adds.
 */
const CLOCK_JUMP_MS = 6 * 3_600_000;

export type CollectResult =
  | { ran: false; reason: 'off' | 'live' | 'unknown' | 'backfill' | 'busy' }
  | {
      ran: true;
      mode: 'report' | 'on';
      /** Files newly marked unnamed by this run (their 30 days start). */
      marked: number;
      /** Files deleted (report: that `on` would delete). */
      files: number;
      bytes: number;
      /** Picture rows deleted (report: that `on` would delete) and the bytes of the files that went with them. */
      pictures: number;
      pictureBytes: number;
    };

export type CollectorOptions = {
  mode: CollectMode;
  live: () => 'idle' | 'live';
  /** Whether the service's state has been told (the library process waits for the supervisor's first word). */
  known: () => boolean;
  timeZone: () => string;
  log: Logger;
  now?: () => number;
  /** A clock that only runs forward, in milliseconds (default `performance.now()`; with `now` injected it follows `now`). */
  mono?: () => number;
  yield?: () => Promise<void>;
  sliceMs?: number;
  /** Called after each file or picture the run looks at (tests count steps and advance their clock). */
  onStep?: (what: 'mark' | 'sweep' | 'picture') => void;
  /** Called between the scan that finds what is due and the deletes (tests save something in between). */
  afterScan?: () => void | Promise<void>;
  /** Arm the timers on `start()` (the hub tests do not). */
  schedule?: boolean;
  startDelayMs?: number;
  /** After every run that ran (the library process pushes fresh health). */
  onRun?: (r: CollectResult) => void;
};

type LastRun = {
  at: number;
  mode: 'report' | 'on';
  marked: number;
  files: number;
  bytes: number;
  pictures: number;
  pictureBytes: number;
};

const HEX64 = /"([0-9a-f]{64})"/g;

/**
 * The collection of content files nothing names (design/29 §1.3, A37, M7): a nightly mark and sweep over the
 * `application/json` files (shape, mask and decoration files, slide pages and heads, client scenes), never a media
 * original, delivery, poster, font, deck or pdf. A file nothing names is marked (the 30-day clock, `collect_marks`);
 * a file that is named again loses its mark; a file marked for 30 days is deleted, after a last check inside the same
 * synchronous transaction as its row's delete (a save cannot slip in between). Pictures of keys no kept revision has
 * are a cache and go at the run. Mode `report` (the default) does all of it but the deleting and says what `on` would
 * delete. Nothing runs while a service is live, before the references backfill is done, or before the library
 * process has been told the service's state; every step of a run is a slice of at most 20 ms.
 */
export class Collector {
  readonly mode: CollectMode;
  private lib: Library;
  private store: Store;
  private opts: CollectorOptions;
  private timer?: NodeJS.Timeout;
  private running?: Promise<CollectResult>;
  /** A scheduled run was held back for the service or for the first word on it: it runs when the service ends. */
  private pending = false;
  private stopped = false;
  private last?: LastRun;
  private sliceStart = 0;
  /** The wall and monotonic clocks at the start of this process's last run: a jump shows as the two moving apart. */
  private clock?: { wall: number; mono: number };

  constructor(lib: Library, store: Store, opts: CollectorOptions) {
    this.lib = lib;
    this.store = store;
    this.opts = opts;
    this.mode = opts.mode;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private mono(): number {
    return this.opts.mono?.() ?? (this.opts.now ? this.opts.now() : performance.now());
  }

  /**
   * Whether the wall clock has jumped since the last run: against this process's last run (the wall clock moved by
   * something other than the monotonic one did), and against the last run of any process (the clock is before it).
   */
  private clockJumped(at: number, mono: number): boolean {
    if (this.clock && Math.abs(at - this.clock.wall - (mono - this.clock.mono)) > CLOCK_JUMP_MS) return true;
    const last = this.readLast();
    return !!last && at < last.at - CLOCK_JUMP_MS;
  }

  /** The next 04:00 in the venue time zone, strictly after `now` (a run that just fired arms tomorrow's). */
  nextRunAt(now = Date.now()): number {
    return nextTimeOfDay(COLLECT_AT, this.opts.timeZone(), now, { strictlyAfter: true, minLeadMs: 5000 });
  }

  /** Arm the first run, 10 minutes after the start; each run arms the next 04:00. */
  start(): void {
    if (!this.opts.schedule || this.mode === 'off') return;
    this.stopped = false;
    this.arm(this.opts.startDelayMs ?? COLLECT_START_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fire(), Math.max(MIN_ARM_MS, ms));
    this.timer.unref();
  }

  private async fire(): Promise<void> {
    let again: number | undefined;
    try {
      const r = await this.run();
      if (!r.ran && (r.reason === 'live' || r.reason === 'unknown')) this.pending = true;
      else if (!r.ran && r.reason === 'backfill') again = BACKFILL_RETRY_MS;
    } catch (e) {
      this.opts.log.error({ err: errorMessage(e) }, 'collection failed');
    }
    if (this.stopped) return;
    this.arm(again ?? this.nextRunAt(Date.now()) - Date.now());
  }

  /** The service's mode changed (or its first state arrived): a run that waited for it goes now. */
  onLiveMode(mode: 'idle' | 'live'): void {
    if (mode !== 'idle' || !this.pending || this.stopped) return;
    this.pending = false;
    void this.run().then(
      (r) => {
        if (!r.ran && (r.reason === 'live' || r.reason === 'unknown')) this.pending = true;
      },
      (e) => this.opts.log.error({ err: errorMessage(e) }, 'collection failed'),
    );
  }

  /** Optional health fields of the last run (`LibraryStats`); empty until a run has run. */
  healthFields(): { collectedFiles?: number; collectedBytes?: number; lastCollectAt?: number } {
    const l = this.last ?? this.readLast();
    if (!l) return {};
    return {
      collectedFiles: l.mode === 'on' ? l.files + l.pictures : 0,
      collectedBytes: l.mode === 'on' ? l.bytes + l.pictureBytes : 0,
      lastCollectAt: l.at,
    };
  }

  private readLast(): LastRun | undefined {
    try {
      const raw = this.lib.refs.meta('collect_last_run');
      if (!raw) return undefined;
      this.last = JSON.parse(raw) as LastRun;
      return this.last;
    } catch {
      return undefined;
    }
  }

  private gate(): 'live' | 'unknown' | 'backfill' | undefined {
    if (!this.opts.known()) return 'unknown';
    if (this.opts.live() === 'live') return 'live';
    if (!this.lib.refs.backfillDone()) return 'backfill';
    return undefined;
  }

  async run(): Promise<CollectResult> {
    if (this.mode === 'off') return { ran: false, reason: 'off' };
    if (this.running) return { ran: false, reason: 'busy' };
    const gate = this.gate();
    if (gate) return { ran: false, reason: gate };
    this.running = this.doRun().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** One step of a run: counted, and a slice of at most `sliceMs` ends with a yield. False when a service went live. */
  private async step(what: 'mark' | 'sweep' | 'picture'): Promise<boolean> {
    this.opts.onStep?.(what);
    if (this.now() - this.sliceStart < (this.opts.sliceMs ?? COLLECT_SLICE_MS)) return true;
    await (this.opts.yield ?? (() => new Promise<void>((r) => setImmediate(r))))();
    this.sliceStart = this.now();
    return this.opts.live() !== 'live' && !this.stopped;
  }

  /**
   * Every content name in what the current rows hold as text, read once and in slices (a page of rows a step):
   * media, fonts and unfinished jobs, and for a sweep the presentations too. The references index answers for the
   * saved revisions, this is the net under it for what the index is not made from.
   */
  private async gather(withPresentations: boolean): Promise<Set<string> | undefined> {
    const names = new Set<string>();
    const sources: ('media' | 'fonts' | 'jobs' | 'presentations')[] = ['media', 'fonts', 'jobs'];
    if (withPresentations) sources.push('presentations');
    for (const source of sources) {
      let after = 0;
      for (;;) {
        const page = this.lib.sourcePage(source, after, 20);
        if (!page.length) break;
        if (!(await this.step('mark'))) return undefined;
        for (const r of page) {
          for (const m of r.text.matchAll(HEX64)) names.add(m[1]!);
          after = r.rowid;
        }
      }
    }
    return names;
  }

  private async doRun(): Promise<CollectResult> {
    const at = this.now();
    const mono = this.mono();
    const report = this.mode === 'report';
    this.sliceStart = at;
    const aborted: CollectResult = { ran: false, reason: 'live' };

    // A wall clock that jumped makes every file look unnamed for as long as the jump: deleting for good on that would
    // be deleting on a wrong date, so the marks start again from now (the delay is then counted in days that passed).
    if (this.clockJumped(at, mono)) {
      const n = this.lib.refs.rebaseMarks(at);
      this.opts.log.warn({ marks: n }, 'the clock jumped since the last collection run; the 30-day clocks start again');
    }
    this.clock = { wall: at, mono };

    // What media, fonts and unfinished jobs name, read once; the index answers for everything else.
    const outside = await this.gather(false);
    if (!outside) return aborted;

    // 1. mark and clear: every candidate is named or it is marked
    let marked = 0;
    let after = '';
    for (;;) {
      const page = this.lib.refs.jsonFiles(after, PAGE);
      if (!page.length) break;
      for (const f of page) {
        if (!(await this.step('mark'))) return aborted;
        if (outside.has(f.hash) || this.lib.refs.referenced(f.hash)) this.lib.refs.unmark([f.hash]);
        else if (this.lib.refs.markUnnamed(f.hash, at)) marked++;
      }
      after = page[page.length - 1]!.hash;
    }
    this.lib.refs.dropOrphanMarks();

    // 2. what is due: marked for the whole delay, heads first (their pages are then named by nothing)
    const due = this.lib.refs.dueFiles(at - DELAY_MS);
    await this.opts.afterScan?.();
    let files = 0;
    let bytes = 0;
    // The last check of a sweep is the index (a save names a file in its own transaction) and one read of the rows
    // that hold names as text, never every presentation's JSON for every file.
    let guard: Set<string> | undefined;
    if (!report) {
      guard = await this.gather(true);
      if (!guard) return aborted;
    }
    const named = (hash: string): boolean => this.lib.refs.referenced(hash) || !!guard?.has(hash);
    if (report) {
      files = due.length;
      bytes = due.reduce((n, f) => n + f.bytes, 0);
    } else {
      for (const f of due) {
        if (!(await this.step('sweep'))) return aborted;
        const row = this.lib.sweepFile(f.hash, named, 'application/json', at - DELAY_MS);
        if (!row) continue;
        files++;
        bytes += row.bytes;
        try {
          await rm(this.store.abs(row.path), { force: true });
        } catch (e) {
          this.opts.log.warn({ hash: row.hash, err: errorMessage(e) }, 'collection could not remove a file');
        }
      }
    }

    // 3. pictures of keys no kept revision has: a cache, no delay
    let pictures = 0;
    let pictureBytes = 0;
    const unclaimed = this.lib.prerenderIndex.unclaimed();
    const perHash = new Map<string, number>();
    for (const r of unclaimed) perHash.set(r.hash, (perHash.get(r.hash) ?? 0) + 1);
    const counted = new Set<string>();
    for (const r of unclaimed) {
      if (!(await this.step('picture'))) return aborted;
      if (report) {
        pictures++;
        if (
          !counted.has(r.hash) &&
          this.lib.prerenderIndex.rowsNaming(r.hash) === perHash.get(r.hash) &&
          !this.lib.namedBesidePictures(r.hash)
        ) {
          counted.add(r.hash);
          pictureBytes += r.bytes;
        }
        continue;
      }
      if (!this.lib.prerenderIndex.dropUnclaimed(r)) continue;
      pictures++;
      // its file goes with it when no other row names it: the same check, in the one transaction that deletes the row
      const file = this.lib.sweepFile(r.hash, named, '*');
      if (file) {
        pictureBytes += file.bytes;
        try {
          await rm(this.store.abs(file.path), { force: true });
        } catch (e) {
          this.opts.log.warn(
            { hash: file.hash, err: errorMessage(e) },
            'collection could not remove a picture',
          );
        }
      }
    }

    const last: LastRun = {
      at,
      mode: report ? 'report' : 'on',
      marked,
      files,
      bytes,
      pictures,
      pictureBytes,
    };
    this.last = last;
    this.lib.refs.setMeta('collect_last_run', JSON.stringify(last));
    this.opts.log.info({ mode: last.mode, marked, files, bytes, pictures, pictureBytes }, 'collection run');
    const result: CollectResult = {
      ran: true,
      mode: last.mode,
      marked,
      files,
      bytes,
      pictures,
      pictureBytes,
    };
    this.opts.onRun?.(result);
    return result;
  }
}

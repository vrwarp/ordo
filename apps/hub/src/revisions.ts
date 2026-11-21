import type { RevisionInfo } from '@ordo/protocol';
import type { Logger } from 'pino';
import type { DB } from './db.ts';

/**
 * Revision summaries (design/28 P2, pulled forward for the title only). A presentation's revision is a full copy of it (up to
 * the 8 MiB budget), and the History list used to read and parse every kept revision to show its title: 57 revisions of 8 MiB
 * took 5.4 s and 2.2 GiB of the library process. The list now reads one small row per revision, `revision_summaries` (migration
 * 15), written in the save that writes the revision.
 *
 *  - The title is kept as its JSON string literal (`title_json`), so what the list answers is `JSON.parse` of that literal: the
 *    exact string the old reading gave, a lone surrogate or a NUL included, with no encoding to get wrong.
 *  - Three triggers on `presentation_revisions` (migration 15) delete the summary of a row that is replaced, edited or deleted,
 *    whoever does it: an older hub that opens the folder writes revisions without knowing the table, and a summary is never
 *    wrong or left behind. A revision with no summary is read once, one row at a time, and its summary is made.
 *  - The backfill makes the summaries of the revisions that have none (a hub that kept none saved them), a slice of a few
 *    milliseconds at a time, never while a service is live. It runs in the library process.
 */

/** The first characters of a revision's JSON in which the title is looked for (a stored presentation has it third). */
export const TITLE_PREFIX_CHARS = 16 * 1024;
/** The larger look, for a body that stores its title later (an older shape of the document). */
export const TITLE_WIDE_PREFIX_CHARS = 1024 * 1024;

const QUOTE = 34;
const BACKSLASH = 92;
const COMMA = 44;
const COLON = 58;
const OPEN_OBJECT = 123;
const CLOSE_OBJECT = 125;
const OPEN_ARRAY = 91;
const CLOSE_ARRAY = 93;
const KEY_TITLE = '"title"';

const isSpace = (c: number): boolean => c === 32 || c === 10 || c === 13 || c === 9;

function skipSpace(s: string, from: number): number {
  let i = from;
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  return i;
}

/** The index after the string literal that starts at `s[from]` (a quote), or -1 when the text ends inside it. */
function stringEnd(s: string, from: number): number {
  for (let i = from + 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === QUOTE) return i + 1;
    if (c === BACKSLASH) i++;
  }
  return -1;
}

/** The index after the value that starts at `s[from]`, or -1 when the text ends inside it. Iterative: nesting costs no stack. */
function valueEnd(s: string, from: number): number {
  const c = s.charCodeAt(from);
  if (c === QUOTE) return stringEnd(s, from);
  if (c === OPEN_OBJECT || c === OPEN_ARRAY) {
    let depth = 0;
    for (let i = from; i < s.length; i++) {
      const d = s.charCodeAt(i);
      if (d === QUOTE) {
        const e = stringEnd(s, i);
        if (e < 0) return -1;
        i = e - 1;
      } else if (d === OPEN_OBJECT || d === OPEN_ARRAY) depth++;
      else if (d === CLOSE_OBJECT || d === CLOSE_ARRAY) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }
  // a number or a literal: up to the next delimiter, which must be in the text or the value may go on
  for (let i = from; i < s.length; i++) {
    const d = s.charCodeAt(i);
    if (d === COMMA || d === CLOSE_OBJECT || d === CLOSE_ARRAY || isSpace(d)) return i;
  }
  return -1;
}

/**
 * The raw JSON string literal of the top-level `title` member of an object's JSON text (quotes and escapes as written, so
 * `JSON.parse` of it is the title), looked for in `prefix`, the first characters of a body. It walks the top-level members in
 * order and skips each other member's value with a bracket and string count, so a `"title"` inside a string or a nested object
 * is never taken. Undefined when it cannot be told from this much text: the title comes later, is not a string, is not there,
 * or the text is not an object. Never a wrong string: the answer is the exact literal or nothing.
 *
 * Exact for what `JSON.stringify` writes (a key once, spelled plainly). A body that spells a key with escapes or repeats it is not
 * taken here; the caller reads it by the other ways, which are exact for those too.
 */
export function titleTokenIn(prefix: string): string | undefined {
  let i = skipSpace(prefix, 0);
  if (prefix.charCodeAt(i) !== OPEN_OBJECT) return undefined;
  i++;
  for (;;) {
    i = skipSpace(prefix, i);
    if (prefix.charCodeAt(i) !== QUOTE) return undefined; // the end of the object (no title), the end of the text, or not JSON
    const keyEnd = stringEnd(prefix, i);
    if (keyEnd < 0) return undefined;
    const isTitle = prefix.startsWith(KEY_TITLE, i); // the literal ends at its own closing quote: no other key begins this way
    i = skipSpace(prefix, keyEnd);
    if (prefix.charCodeAt(i) !== COLON) return undefined;
    i = skipSpace(prefix, i + 1);
    if (isTitle) {
      if (prefix.charCodeAt(i) !== QUOTE) return undefined;
      const end = stringEnd(prefix, i);
      return end < 0 ? undefined : prefix.slice(i, end);
    }
    const end = valueEnd(prefix, i);
    if (end < 0) return undefined;
    i = skipSpace(prefix, end);
    if (prefix.charCodeAt(i) !== COMMA) return undefined;
    i++;
  }
}

type SummaryRow = {
  rev: number;
  title_json: string | null;
  saved_by: string | null;
  saved_at: string | null;
};

/** What reading one revision gave: its list entry, and whether a summary of it was made. */
export type SummarizeResult = { info: RevisionInfo; recorded: boolean; readable: boolean };

/** The summary table and the reading of a revision that has none. One per Library. */
export class RevisionSummaries {
  private db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  /** Remember the summary of a revision just written, in the save that wrote it (the title as its JSON string literal). */
  record(id: string, rev: number, title: string, savedBy: string | null, savedAt: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO revision_summaries (presentation_id, rev, title_json, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, rev, JSON.stringify(title), savedBy, savedAt);
  }

  /**
   * The revisions of a presentation, newest first (`GET /presentations/:id/revisions`). The revision keys come from the index of
   * `presentation_revisions` and the rest from the summaries: no revision's JSON is read. A revision with no summary is read on its
   * own (`summarize`), one at a time, and its summary is made.
   */
  list(id: string): RevisionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT r.rev AS rev, s.title_json AS title_json, s.saved_by AS saved_by, s.saved_at AS saved_at
         FROM presentation_revisions r
         LEFT JOIN revision_summaries s ON s.presentation_id = r.presentation_id AND s.rev = r.rev
         WHERE r.presentation_id = ? ORDER BY r.rev DESC`,
      )
      .all(id) as SummaryRow[];
    const out: RevisionInfo[] = [];
    for (const r of rows) {
      if (r.title_json !== null && r.saved_at !== null) {
        try {
          out.push({
            rev: r.rev,
            savedAt: r.saved_at,
            savedBy: r.saved_by ?? undefined,
            title: JSON.parse(r.title_json) as string,
          });
          continue;
        } catch {
          /* a summary that does not parse is read again from its revision */
        }
      }
      const read = this.summarize(id, r.rev);
      if (read) out.push(read.info);
    }
    return out;
  }

  /**
   * Read one revision for its title and record the summary (best effort: a list is never refused because a summary could not
   * be written). The body is read inside SQLite, a prefix of it, never into a JavaScript string of its size; the first of these
   * that finds the title answers:
   *   1. the first TITLE_PREFIX_CHARS, scanned by `titleTokenIn` (where a stored presentation keeps its title, third);
   *   2. the first TITLE_WIDE_PREFIX_CHARS, for a body whose title comes later;
   *   3. SQLite's own parse of the body (`json -> '$.title'`), one body at a time, for a title past that;
   *   4. the old reading: the whole body parsed here, for what the three cannot answer (a title that is not a string, no title, a
   *      body SQLite refuses). A body that cannot be parsed gives an empty title and no summary.
   * Undefined when the revision is not there.
   */
  summarize(id: string, rev: number): SummarizeResult | undefined {
    const stage = (chars: number) =>
      this.db
        .prepare(
          `SELECT saved_by, saved_at, substr(json, 1, ?) AS head FROM presentation_revisions WHERE presentation_id = ? AND rev = ?`,
        )
        .get(chars, id, rev) as { saved_by: string | null; saved_at: string; head: unknown } | undefined;
    const first = stage(TITLE_PREFIX_CHARS);
    if (!first) return undefined;
    const base = { rev, savedAt: first.saved_at, savedBy: first.saved_by ?? undefined };
    let token: string | undefined;
    let whole = false;
    if (typeof first.head === 'string') {
      token = titleTokenIn(first.head);
      whole = first.head.length < TITLE_PREFIX_CHARS;
      if (token === undefined && !whole) {
        const wide = stage(TITLE_WIDE_PREFIX_CHARS);
        if (wide && typeof wide.head === 'string') {
          token = titleTokenIn(wide.head);
          whole = wide.head.length < TITLE_WIDE_PREFIX_CHARS;
        }
      }
    }
    if (token === undefined && !whole) {
      try {
        const t = (
          this.db
            .prepare(
              `SELECT json -> '$.title' AS t FROM presentation_revisions WHERE presentation_id = ? AND rev = ?`,
            )
            .get(id, rev) as { t: unknown } | undefined
        )?.t;
        if (typeof t === 'string' && t.startsWith('"')) token = t;
      } catch {
        /* SQLite refuses the body (malformed, or nested past its limit): the old reading below decides */
      }
    }
    if (token !== undefined) {
      try {
        const title = JSON.parse(token) as string;
        return {
          info: { ...base, title },
          recorded: this.keep(id, rev, token, first.saved_by, first.saved_at),
          readable: true,
        };
      } catch {
        /* a literal that is not JSON: the old reading below */
      }
    }
    // The old reading, for this one revision.
    const row = this.db
      .prepare(`SELECT json FROM presentation_revisions WHERE presentation_id = ? AND rev = ?`)
      .get(id, rev) as { json: string } | undefined;
    if (!row) return undefined;
    let title: unknown;
    try {
      title = (JSON.parse(row.json) as { title?: unknown }).title;
    } catch {
      return { info: { ...base, title: '' }, recorded: false, readable: false };
    }
    const recorded =
      typeof title === 'string' && this.keep(id, rev, JSON.stringify(title), first.saved_by, first.saved_at);
    return { info: { ...base, title: title as string }, recorded, readable: true };
  }

  private keep(id: string, rev: number, titleJson: string, savedBy: string | null, savedAt: string): boolean {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO revision_summaries (presentation_id, rev, title_json, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, rev, titleJson, savedBy, savedAt);
      return true;
    } catch {
      return false;
    }
  }

  /** The first revision after `after` (presentation id, then rev) that has no summary, from the two indexes alone. */
  next(after?: { id: string; rev: number }): { id: string; rev: number } | undefined {
    return this.db
      .prepare(
        `SELECT r.presentation_id AS id, r.rev AS rev FROM presentation_revisions r
         WHERE (r.presentation_id > @id OR (r.presentation_id = @id AND r.rev > @rev))
           AND NOT EXISTS (SELECT 1 FROM revision_summaries s WHERE s.presentation_id = r.presentation_id AND s.rev = r.rev)
         ORDER BY r.presentation_id, r.rev LIMIT 1`,
      )
      .get({ id: after?.id ?? '', rev: after?.rev ?? 0 }) as { id: string; rev: number } | undefined;
  }

  /** How many revisions have no summary. */
  count(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM presentation_revisions r
           WHERE NOT EXISTS (SELECT 1 FROM revision_summaries s WHERE s.presentation_id = r.presentation_id AND s.rev = r.rev)`,
        )
        .get() as { n: number }
    ).n;
  }

  /** Run `fn` in one transaction (a slice of the backfill: the commits of ten revisions are ten times the cost of one). */
  batch(fn: () => void): void {
    this.db.transaction(fn)();
  }
}

export type RevisionBackfillOptions = {
  live: () => 'idle' | 'live';
  log: Logger;
  now?: () => number;
  yield?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each revision read (tests count them and advance their clock). */
  onRead?: (presentationId: string, rev: number) => void;
  /** A slice of work is at most this long between yields (5 ms). */
  sliceMs?: number;
  startDelayMs?: number;
};

/** The start-up delay of the backfill (as the references backfill's: 2 minutes after the start). */
export const REVISION_BACKFILL_START_DELAY_MS = 120_000;
const SLICE_MS = 5;
/** After a slice the loop rests this many times the slice's own length (a fifth of the time at most), and at least MIN_REST_MS. */
const REST_FACTOR = 4;
const MIN_REST_MS = 10;

/**
 * The one-off summary of the revisions that have none (a hub that kept no summaries saved them): one revision at a time, a slice
 * of at most 5 ms between yields and a rest of four times the slice, resumable (a revision with a summary is not read again, so a
 * restart carries on where it stopped), never while a service is live. A revision saved meanwhile carries its own summary.
 * Runs in the library process; the live process never reads a revision.
 */
export class RevisionTitleBackfill {
  private summaries: RevisionSummaries;
  private opts: RevisionBackfillOptions;
  private running = false;
  private stopped = false;
  /** A run ended because a service went live: it carries on when the service ends. */
  private waiting = false;
  private timer?: NodeJS.Timeout;

  constructor(summaries: RevisionSummaries, opts: RevisionBackfillOptions) {
    this.summaries = summaries;
    this.opts = opts;
  }

  start(): void {
    const t = setTimeout(() => void this.run(), this.opts.startDelayMs ?? REVISION_BACKFILL_START_DELAY_MS);
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

  /** Summarise what has no summary, to the end, or until stopped or a service goes live. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.waiting = false;
    const now = this.opts.now ?? (() => performance.now());
    const yieldNow = this.opts.yield ?? (() => new Promise<void>((r) => setImmediate(r)));
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const sliceMs = this.opts.sliceMs ?? SLICE_MS;
    const log = this.opts.log;
    const started = now();
    let cursor: { id: string; rev: number } | undefined;
    let begun = false;
    let done = 0;
    let unreadable = 0;
    try {
      for (;;) {
        if (this.stopped) return;
        if (this.opts.live() === 'live') {
          this.waiting = true;
          return;
        }
        const t0 = now();
        let outcome = 'time' as 'time' | 'done' | 'stopped';
        this.summaries.batch(() => {
          while (now() - t0 < sliceMs) {
            const next = this.summaries.next(cursor);
            if (!next) {
              outcome = 'done';
              return;
            }
            if (!begun) {
              begun = true;
              log.info({ revisions: this.summaries.count() }, 'revision summaries backfill started');
            }
            cursor = next;
            try {
              const read = this.summaries.summarize(next.id, next.rev);
              if (read && !read.readable && unreadable++ === 0)
                log.warn(
                  { presentationId: next.id, rev: next.rev },
                  'a stored revision could not be read for its title: it is listed without one',
                );
            } catch (e) {
              if (unreadable++ === 0)
                log.warn(
                  { presentationId: next.id, rev: next.rev, err: e instanceof Error ? e.message : String(e) },
                  'a stored revision could not be read for its title: it is listed without one',
                );
            }
            done++;
            this.opts.onRead?.(next.id, next.rev);
            if (this.stopped) {
              outcome = 'stopped';
              return;
            }
          }
        });
        if (outcome === 'stopped') return;
        if (outcome === 'done') {
          if (begun)
            log.info(
              { revisions: done, unreadable, ms: Math.round(now() - started) },
              'revision summaries backfill finished',
            );
          return;
        }
        const worked = now() - t0;
        await yieldNow();
        await sleep(Math.max(MIN_REST_MS, REST_FACTOR * worked));
      }
    } finally {
      this.running = false;
    }
  }
}

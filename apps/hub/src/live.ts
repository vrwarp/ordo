import { createHash } from 'node:crypto';
import {
  DEGRADED_MAX,
  type Degraded as DomainDegraded,
  expandCues,
  GOLIVE_ENDED_REASON,
  type GoLiveInputs as DomainGoLiveInputs,
  GoLiveRejection,
  type LiveCommand,
  type LiveEvent,
  type LiveState,
  type Output,
  quarantinePresentation,
  type ResolvedPlaylist,
  resolvePlaylist,
  type Cue,
  type SurfaceSettings,
  validatePlaylist,
} from '@ordo/domain';
import {
  autoAdvance,
  checkInvariants,
  initialState,
  isLiveEventShape,
  isLiveStateShape,
  reduce,
} from '@ordo/live-state';
import type { Logger } from 'pino';
import { type DB, LIVE_CUES_SQL, LIVE_RESOLVED_SQL } from './db.ts';
import { GoLiveWorker, type PrepareOutput } from './golive-worker.ts';
import type { Library } from './library.ts';

export class LiveRejection extends Error {}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

export type Origin =
  | { role: 'operate'; id?: string }
  | { role: 'output' | 'stage'; outputId: string; id?: string }
  | { role: 'system'; id?: string };

/**
 * A goLive's delta also names its copy: the bytes of `event.resolved` as the live service holds them (UTF-8
 * JSON) and their SHA-256, so a listener that sends the delta never serialises the copy (design/29 §2.3 M2).
 */
export type DeltaListener = (d: {
  seq: number;
  fromSeq: number;
  event: LiveEvent;
  id?: string;
  copy?: { id: string; json: Uint8Array };
}) => void;
export type StateListener = (state: LiveState) => void;

/** What the live service needs from the library for one goLive (see @ordo/domain goLive.ts). */
export type GoLiveInputs = DomainGoLiveInputs;

/** Settings the live service reads outside goLive (audio master, message presets). */
export type LiveSettings = { outputs: Output[]; surfaces: Pick<SurfaceSettings, 'messagePresets'> };

/**
 * Where the live service reads library data. In one process it is the Library itself; in the live process
 * it is a cached copy fetched from the library process (librarylink.ts), so a library outage blocks
 * nothing that was fetched before it.
 */
export interface LiveSource {
  /**
   * A remote source (the live process): the playlist's goLive bundle as the JSON bytes the library sent,
   * fetched beside the running service (design/29 §2.3 M8), or a cached copy with the reason the goLive
   * carries. Undefined: the playlist does not exist. Throws LiveRejection when there is nothing to go live
   * from. With it, a goLive is checked in golive-worker.ts and enters the queue only once prepared.
   */
  bundle?(playlistId: string, opts: BundleOptions): Promise<RawBundle | undefined>;
  /** A goLive of this playlist was applied: the source may persist its copy now. */
  applied?(playlistId: string): void;
  /** When the source's saved copy of a playlist was taken (W41's "Go live from the copy saved ..."). */
  savedAt?(playlistId: string): number | undefined;
  /** The in-process source: the inputs, resolved on the loop (`resolve`). */
  goLiveInputs(playlistId: string): GoLiveInputs | undefined;
  settings(): LiveSettings;
}

/** A goLive bundle's JSON bytes (without `takenAt`), when the copy was taken, and why it is a cached copy. */
export type RawBundle = { bytes: Uint8Array; takenAt: number; cachedCopy?: string };
export type BundleOptions = {
  /** Bytes received so far, and the announced total. */
  onProgress?: (received: number, total: number | undefined) => void;
  /** Go live from the saved copy without asking the library (the operator chose it, W41). */
  saved?: boolean;
  /** Abandons the fetch (the operator chose the saved copy meanwhile). */
  signal?: AbortSignal;
};

/** How a prepare stands (POST /live/prepare, design/29 M8; LivePrepareRes in @ordo/protocol). */
export type PrepareState = {
  playlistId: string;
  state: 'preparing' | 'ready' | 'failed';
  /** 0-90 while the bundle arrives (by its announced length), 90 while it is checked, 100 when done. */
  pct: number;
  /** Why it failed: the goLive's refusal. */
  reason?: string;
  /** When the hub's saved copy of the playlist was taken, if it has one. */
  savedAt?: number;
  /** The prepared copy's size (UTF-8 JSON bytes). */
  bytes?: number;
};

type Prepared = { ok: true; buffer: Uint8Array; resolvedId: string } | { ok: false; reason: string };
type Prep = {
  playlistId: string;
  saved: boolean;
  /** Refused before it fetched anything: PREPARES_IN_FLIGHT_MAX others were in flight. */
  busy: boolean;
  ctrl: AbortController;
  state: PrepareState;
  promise: Promise<Prepared>;
  result?: Prepared;
  doneAt?: number;
  emittedAt: number;
  waiters: Set<() => void>;
  expiry?: NodeJS.Timeout;
};

/** After an auto-advance whose write failed, the same advance is tried again after this (see `advanceDue`). */
export const ADVANCE_RETRY_MS = 2000;

/** A prepared goLive not applied within this is dropped; a goLive after it prepares again (design/29 M8). */
export const PREPARED_TTL_MS = 10_000;
/**
 * Prepares in flight at once: each holds its copy (up to BUNDLE_MAX_BYTES) while it arrives and its checked
 * form after, in the process that runs the service. One more is refused with PREPARE_BUSY_REASON.
 */
export const PREPARES_IN_FLIGHT_MAX = 2;
/** W67 (design/29 §3, blocking): the operator's "Could not go live" dialog shows it. */
export const PREPARE_BUSY_REASON =
  'Another service is still getting ready to go live. Try Go live again in a moment.';
/** Progress is reported at most this often. */
const PROGRESS_EVERY_MS = 100;
const CANCELLED = 'cancelled';

/** The in-process source: reads straight from the Library. */
export function librarySource(lib: Library): LiveSource {
  return {
    goLiveInputs(playlistId) {
      const playlist = lib.playlists.get(playlistId);
      if (!playlist) return undefined;
      const s = lib.getSettings();
      return {
        playlist,
        presentation: (id) => lib.presentations.get(id),
        media: (id) => lib.media.get(id),
        file: (hash) => lib.getFile(hash),
        // Pre-rendered slides, from the library's DB-only indexes, as the bundle route sends them to the live process.
        slideHead: (ref) => {
          const h = lib.slideFiles.head(ref);
          return h ? { pages: h.pages } : undefined;
        },
        prerenders: (id) => lib.prerenderIndex.goLive(id, (h) => lib.getFile(h)).rows,
        prerenderKeys: (id) => lib.prerenderIndex.keySet(id),
        fonts: () => lib.listFonts(),
        looks: s.looks,
        general: s.general,
        midiPresets: s.surfaces.midiPresets,
      };
    },
    settings: () => ({ outputs: lib.getSetting('outputs'), surfaces: lib.getSetting('surfaces') }),
  };
}

const JOURNAL_KEEP = 5000;
/**
 * Run `fn` after the loop has polled for I/O once more (two `setImmediate` hops): a callback of the check phase runs
 * before the next poll, so bytes that reached a socket while the caller held the loop (a GO pressed during a take-over's
 * apply) would be read only after `fn`; with the second hop they are read first, and applied, before it runs.
 */
const afterPoll = (fn: () => void): void => {
  setImmediate(() => setImmediate(fn));
};
/** A copy's id: the SHA-256 of its bytes, hex. */
const RESOLVED_ID = /^[0-9a-f]{64}$/;
/**
 * What the by-name forms look like (see `snapshotText` and `apply`): the ids are at fixed places, never parsed for.
 * A snapshot ends `...,"cuesId":"<64 hex>","resolvedId":"<64 hex>"}`: the cue list and the copy it names.
 */
const SNAPSHOT_TAIL = ',"resolvedId":"';
const CUES_KEY = ',"cuesId":"';
const JOURNAL_GOLIVE_HEAD = '{"k":"goLive","resolvedId":"';
/** From the end of a by-name snapshot: the copy's id is the 66 characters before the end less its closing `"}`. */
const RID_FROM_END = 64 + 2;
/** The cue list's id: before the closing quote, SNAPSHOT_TAIL and the copy's id (`"` + tail + id + `"}`). */
const CID_FROM_END = 1 + SNAPSHOT_TAIL.length + RID_FROM_END + 64;
/** Snapshots kept besides the current one; restore falls back through them (design/25). */
export const SNAPSHOTS_PREV_KEEP = 2;
/** Operator `at` values outside [now - AT_PAST_MS, now + AT_FUTURE_MS] are replaced by now + AT_REPLACE_MS. */
export const AT_PAST_MS = 500;
export const AT_FUTURE_MS = 2000;
export const AT_REPLACE_MS = 33;
export { DEGRADED_MAX, quarantinePresentation, validatePlaylist };
export type Degraded = DomainDegraded;

/** Hub-authoritative live state: resolve, reduce, journal, snapshot, broadcast. */
export class LiveService {
  state: LiveState = initialState();
  private deltaListeners: DeltaListener[] = [];
  private stateListeners: StateListener[] = [];
  private dirty = false;
  private snapshotTimer?: NodeJS.Timeout;
  private advanceTimer?: NodeJS.Timeout;
  private advanceKey = '';
  /** Auto-advances in a row whose write failed (reset by one that was written). */
  private advanceFailures = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** goLives in arrival order among themselves, each entering `queue` once prepared (design/29 M8). */
  private goLiveChain: Promise<unknown> = Promise.resolve();
  /** Bumped by End service: a goLive sent before it and still being prepared is not applied after it. */
  private goLiveGen = 0;
  /** Playlists of goLives sent and not yet applied or refused, by count. */
  private pendingGoLives = new Map<string, number>();
  private preps = new Map<string, Prep>();
  private worker?: GoLiveWorker;
  /** Warnings from the last restore (tests and diagnostics). */
  restoreWarnings: string[] = [];
  /**
   * The SHA-256 of the copy the last prepared goLive applied (design/29 M2: live-by-ref names the running
   * service by it). Undefined after a goLive resolved on the loop (the in-process source).
   */
  resolvedId?: string;
  /**
   * The bytes of `state.resolved` and their SHA-256 (live-by-ref): the prepared bytes of the goLive that applied
   * it, or one serialisation of a copy that came without bytes (`resolvedCopy`). `object` is the copy they
   * were made from: they are used only while `state.resolved` is that object.
   */
  private copy?: { id: string; json: Uint8Array; object: ResolvedPlaylist };
  /**
   * The cue list's JSON and its row, kept while `state.cues` is the same array (the reducer builds it once, at the
   * goLive): the text and the bytes are each made when first asked for (a restore that read the row has the bytes and
   * no text, a socket's state wants the text, the snapshot wants the bytes and their SHA-256).
   */
  private cueCache?: { cues: Cue[]; json?: string; row?: { id: string; json: Buffer } };
  /** Cue rows a restore found torn or missing: the next snapshot of that cue list writes the row again. */
  private badCueIds = new Set<string>();

  private db: DB;
  private source: LiveSource;
  private log: Logger;
  private opts: {
    snapshotIntervalMs: number;
    now?: () => number;
    byRef?: boolean;
    prerender?: { on: boolean; store: boolean };
  };
  /** ORDO_LIVE_BYREF: the snapshot and the journal name the copy instead of holding it (default on). */
  readonly byRef: boolean;
  constructor(
    db: DB,
    source: LiveSource,
    log: Logger,
    opts: {
      snapshotIntervalMs: number;
      now?: () => number;
      byRef?: boolean;
      /**
       * The hub's switch for pictures (store-2, `HubConfig.prerender`): `on` is what the Go-live picture line (W33)
       * follows, `store` false lists no picture rows and no key set. Absent: as before the switch existed.
       */
      prerender?: { on: boolean; store: boolean };
    },
  ) {
    this.db = db;
    this.source = source;
    this.log = log;
    this.opts = opts;
    this.byRef = opts.byRef ?? true;
    // The table of the copies is the live service's own (see LIVE_RESOLVED_SQL): there on any database it runs on.
    db.exec(LIVE_RESOLVED_SQL);
    db.exec(LIVE_CUES_SQL);
  }

  now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  onDelta(fn: DeltaListener): void {
    this.deltaListeners.push(fn);
  }
  onState(fn: StateListener): void {
    this.stateListeners.push(fn);
  }

  start(): void {
    this.restore();
    // Copies nothing names any more (an older run's, a torn write's) go once at start.
    if (this.byRef) this.collect();
    this.snapshotTimer = setInterval(() => this.snapshot(), this.opts.snapshotIntervalMs);
    this.snapshotTimer.unref();
    this.scheduleAdvance();
  }

  stop(): void {
    clearInterval(this.snapshotTimer);
    clearTimeout(this.advanceTimer);
    for (const p of this.preps.values()) {
      clearTimeout(p.expiry);
      p.ctrl.abort();
    }
    void this.worker?.close();
    this.snapshot(true);
  }

  /** Why a stored state cannot be trusted, or undefined when it can. */
  private static unsound(x: unknown): string | undefined {
    if (!isLiveStateShape(x)) return 'malformed state';
    const v = checkInvariants(x);
    return v.length ? v.slice(0, 3).join('; ') : undefined;
  }

  /**
   * Load the newest valid snapshot and replay the journal after it (design/25). A snapshot that does not
   * parse, has the wrong shape or breaks an invariant is skipped for the next older one (the current plus
   * SNAPSHOTS_PREV_KEEP are kept); a journal row that does not parse or does not apply ends the replay with a
   * warning. Never throws: with nothing usable the service starts idle.
   */
  restore(): void {
    const warnings: string[] = [];
    const candidates: { seq: number; json: string; where: string }[] = [];
    try {
      const cur = this.db.prepare(`SELECT seq, json FROM live_snapshot WHERE id = 1`).get() as
        | { seq: number; json: string }
        | undefined;
      if (cur) candidates.push({ ...cur, where: 'current snapshot' });
      const prev = this.db
        .prepare(`SELECT seq, json FROM live_snapshot_prev ORDER BY rowid DESC LIMIT ?`)
        .all(SNAPSHOTS_PREV_KEEP) as { seq: number; json: string }[];
      for (const [i, p] of prev.entries()) candidates.push({ ...p, where: `previous snapshot ${i + 1}` });
    } catch (e) {
      warnings.push(`snapshot tables unreadable: ${(e as Error).message}`);
    }
    let s: LiveState | undefined;
    let from = 'empty';
    let restoredCopy: { id: string; json: Uint8Array; object: ResolvedPlaylist } | undefined;
    let restoredCues: { id: string; json: Buffer; object: Cue[] } | undefined;
    for (const c of candidates) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(c.json);
      } catch {
        warnings.push(`${c.where} (seq ${c.seq}) is not valid JSON`);
        continue;
      }
      // A snapshot written by name holds the copy's id, not the copy: join it from the rows (both forms are read).
      let named: { id: string; json: Uint8Array; object: ResolvedPlaylist } | undefined;
      let cuesRow: { id: string; json: Buffer; object: Cue[] } | undefined;
      if (isRecord(parsed) && typeof parsed.resolvedId === 'string' && !('resolved' in parsed)) {
        const id = parsed.resolvedId;
        delete parsed.resolvedId;
        named = this.readCopy(id, warnings);
        if (!named) {
          warnings.push(`${c.where} (seq ${c.seq}) names a copy that cannot be read`);
          continue;
        }
        parsed.resolved = named.object;
        // The cue list is in the snapshot (the first by-name form) or named by it (its own row, verified like the copy).
        // A row that cannot be read does not lose the service: the cue list is what the goLive's reducer built from
        // the copy, so it is built from the copy again (a warning; the next snapshot writes the row).
        if (typeof parsed.cuesId === 'string' && !('cues' in parsed)) {
          const cid = parsed.cuesId;
          delete parsed.cuesId;
          cuesRow = this.readCues(cid, warnings);
          if (cuesRow) parsed.cues = cuesRow.object;
          else {
            warnings.push(
              `${c.where} (seq ${c.seq}): the cue list ${String(cid).slice(0, 12)} cannot be read; built from the copy`,
            );
            this.badCueIds.add(cid);
            try {
              parsed.cues = expandCues(named.object);
            } catch (e) {
              warnings.push(
                `${c.where} (seq ${c.seq}): the cue list cannot be built (${(e as Error).message})`,
              );
              continue;
            }
          }
        }
      }
      const why = LiveService.unsound(parsed);
      if (why) {
        warnings.push(`${c.where} (seq ${c.seq}) failed validation: ${why}`);
        continue;
      }
      s = parsed as LiveState;
      restoredCopy = named;
      restoredCues = cuesRow;
      from = c.where;
      break;
    }
    if (!s) s = initialState();
    let replayed = 0;
    try {
      const rows = this.db
        .prepare(`SELECT seq, kind, event_json FROM live_journal WHERE seq > ? ORDER BY seq`)
        .all(s.seq) as { seq: number; kind: string; event_json: string }[];
      for (const r of rows) {
        if (r.kind !== 'event' || r.seq !== s.seq + 1) break;
        let ev: unknown;
        try {
          ev = JSON.parse(r.event_json);
        } catch {
          warnings.push(`journal row ${r.seq} is not valid JSON; replay stopped`);
          break;
        }
        let rowCopy: { id: string; json: Uint8Array; object: ResolvedPlaylist } | undefined;
        if (isRecord(ev) && ev.k === 'goLive' && typeof ev.resolvedId === 'string' && !('resolved' in ev)) {
          rowCopy = this.readCopy(ev.resolvedId, warnings);
          if (!rowCopy) {
            warnings.push(`journal row ${r.seq} names a copy that cannot be read; replay stopped`);
            break;
          }
          ev = { k: 'goLive', resolved: rowCopy.object };
        }
        if (!isLiveEventShape(ev)) {
          warnings.push(`journal row ${r.seq} is not a live event; replay stopped`);
          break;
        }
        let next: LiveState;
        try {
          next = reduce(s, ev);
        } catch (e) {
          warnings.push(`journal row ${r.seq} does not apply (${(e as Error).message}); replay stopped`);
          break;
        }
        const why = LiveService.unsound(next);
        if (why) {
          warnings.push(`journal row ${r.seq} leads to an unsound state (${why}); replay stopped`);
          break;
        }
        s = next;
        if (ev.k === 'goLive') restoredCopy = rowCopy;
        else if (ev.k === 'endService') restoredCopy = undefined;
        if (ev.k === 'goLive' || ev.k === 'endService') restoredCues = undefined;
        replayed++;
      }
    } catch (e) {
      warnings.push(`journal unreadable: ${(e as Error).message}`);
    }
    this.state = s;
    // The verified bytes of the joined copy are kept: the first state sent after a restart serialises nothing.
    this.copy = restoredCopy && restoredCopy.object === s.resolved ? restoredCopy : undefined;
    // ... and so are the cue list's: the first snapshot after a restart encodes and hashes nothing.
    this.cueCache =
      restoredCues && restoredCues.object === s.cues
        ? { cues: s.cues, row: { id: restoredCues.id, json: restoredCues.json } }
        : undefined;
    this.restoreWarnings = warnings;
    for (const w of warnings) this.log.warn({ warning: w }, 'live restore');
    if (candidates.length || replayed)
      this.log.info({ seq: s.seq, mode: s.mode, replayed, from }, 'live state restored');
    // A restore that skipped a bad snapshot writes a good one now, so the next restart starts from it.
    if (warnings.length) this.dirty = true;
  }

  /**
   * Write the current state as the snapshot; the one it replaces moves to live_snapshot_prev (the newest
   * SNAPSHOTS_PREV_KEEP are kept). Only a state that passes its own validation is written.
   */
  snapshot(force = false): void {
    if (!this.dirty && !force) return;
    const why = LiveService.unsound(this.state);
    if (why) {
      this.log.error({ why, seq: this.state.seq }, 'live state failed validation; snapshot skipped');
      return;
    }
    try {
      this.db.transaction(() => {
        const text = this.snapshotText();
        const cur = this.db.prepare(`SELECT seq FROM live_snapshot WHERE id = 1`).get() as
          | { seq: number }
          | undefined;
        const rotated = !!cur && cur.seq !== this.state.seq;
        if (cur && cur.seq !== this.state.seq) {
          this.db
            .prepare(
              `INSERT INTO live_snapshot_prev (seq, json, saved_at) SELECT seq, json, saved_at FROM live_snapshot WHERE id = 1`,
            )
            .run();
          this.db
            .prepare(
              `DELETE FROM live_snapshot_prev WHERE rowid NOT IN (SELECT rowid FROM live_snapshot_prev ORDER BY rowid DESC LIMIT ?)`,
            )
            .run(SNAPSHOTS_PREV_KEEP);
        }
        this.db
          .prepare(`INSERT OR REPLACE INTO live_snapshot (id, seq, json, saved_at) VALUES (1, ?, ?, ?)`)
          .run(this.state.seq, text, Date.now());
        if (rotated || this.byRef) this.collect();
      })();
      this.dirty = false;
    } catch (e) {
      this.log.error({ err: (e as Error).message }, 'live snapshot failed');
    }
  }

  /**
   * The snapshot's text. A live state with a copy is written by name when ORDO_LIVE_BYREF is on: the state without
   * its copy and its cue list (small: it does not grow with the service), then the cue list's id and the copy's id
   * LAST, at fixed places, so `resolvedIdsInUse` reads them from the row without parsing it. The copy's two rows
   * and the cue list's row are written first if they are not there (a state restored whole is named here, once; a
   * periodic snapshot finds all of them and writes none). An idle state, or any state with the switch off, is
   * written whole as before this existed.
   */
  private snapshotText(): string {
    const s = this.state;
    if (!this.byRef || s.mode !== 'live' || !s.resolved) return JSON.stringify(s);
    const c = this.resolvedCopy()!;
    this.writeRows(c, true);
    const cuesId = this.writeCues(s.cues);
    const { resolved: _r, cues: _c, ...rest } = s;
    const head = JSON.stringify(rest);
    return `${head.slice(0, -1)}${CUES_KEY}${cuesId}"${SNAPSHOT_TAIL}${c.id}"}`;
  }

  /**
   * The cue list's row: written once per cue list (the SHA-256 of its bytes names it), never again while it is
   * there; a row a restore found torn is written over. Returns the id the snapshot names.
   */
  private writeCues(cues: Cue[]): string {
    const row = this.cuesRow(cues);
    const have = this.db.prepare(`SELECT 1 AS x FROM live_cues WHERE cues_id = ?`).get(row.id);
    if (!have || this.badCueIds.has(row.id)) {
      this.db
        .prepare(`INSERT OR REPLACE INTO live_cues (cues_id, bytes, json, saved_at) VALUES (?, ?, ?, ?)`)
        .run(row.id, row.json.length, row.json, Date.now());
      this.badCueIds.delete(row.id);
    }
    return row.id;
  }

  /**
   * The cue list named `id`, from its row when the SHA-256 of the row's bytes is the id and its length is `bytes`
   * and it parses as a list. Undefined (with a warning): no row, a torn row, or not a list.
   */
  private readCues(id: string, warnings: string[]): { id: string; json: Buffer; object: Cue[] } | undefined {
    if (!RESOLVED_ID.test(id)) {
      warnings.push(`a cue list is named by something that is not an id`);
      return undefined;
    }
    let row: { bytes: number; json: Buffer } | undefined;
    try {
      row = this.db.prepare(`SELECT bytes, json FROM live_cues WHERE cues_id = ?`).get(id) as
        | { bytes: number; json: Buffer }
        | undefined;
    } catch (e) {
      warnings.push(`cue list ${id.slice(0, 12)} is unreadable: ${(e as Error).message}`);
      return undefined;
    }
    if (!row) {
      warnings.push(`cue list ${id.slice(0, 12)} is missing`);
      return undefined;
    }
    if (row.json.length !== row.bytes || createHash('sha256').update(row.json).digest('hex') !== id) {
      warnings.push(`cue list ${id.slice(0, 12)} failed its hash`);
      return undefined;
    }
    try {
      const object = JSON.parse(row.json.toString('utf8')) as unknown;
      if (!Array.isArray(object)) {
        warnings.push(`cue list ${id.slice(0, 12)} is not a list`);
        return undefined;
      }
      return { id, json: row.json, object: object as Cue[] };
    } catch {
      warnings.push(`cue list ${id.slice(0, 12)} is not valid JSON`);
      return undefined;
    }
  }

  /** Ids whose second row is wanted in a transaction of its own right after the one that wrote the first. */
  private secondRowDue = new Set<string>();

  /**
   * The copy's two rows (copy 0 and 1, the same bytes): written if either is missing; never rewritten. With
   * `deferSecond` the second goes in a transaction of its own after the loop has polled once more (`afterPoll`): a goLive's
   * apply holds the live loop for one 20 MiB write instead of two (design/29 M2: 213 ms against 385 ms for the whole
   * apply at 20 MiB, measured; the keys already queued are applied in the microtask that follows the apply, those that
   * reached a socket during it are read by the poll that comes before the second write: `afterPoll`). The snapshot that
   * names the id is written once copy 0 is there; a crash between the two writes leaves one verified copy, and the next
   * snapshot writes the other.
   */
  private writeRows(c: { id: string; json: Uint8Array }, deferSecond = false): void {
    const have = this.db.prepare(`SELECT copy FROM live_resolved WHERE resolved_id = ?`).all(c.id) as {
      copy: number;
    }[];
    const missing = [0, 1].filter((copy) => !have.some((h) => h.copy === copy));
    if (!missing.length) return;
    const bytes = Buffer.from(c.json.buffer, c.json.byteOffset, c.json.byteLength);
    const put = this.db.prepare(
      `INSERT OR IGNORE INTO live_resolved (resolved_id, copy, bytes, json, saved_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const copy of missing) {
      if (copy === 1 && deferSecond && missing.includes(0)) continue;
      if (copy === 1 && deferSecond) {
        // copy 0 is there: the second follows in a turn of its own (once per id)
        if (!this.secondRowDue.has(c.id)) {
          this.secondRowDue.add(c.id);
          afterPoll(() => {
            this.secondRowDue.delete(c.id);
            // only for the service still running (an ended one's rows are the collection's)
            if (this.copy?.id !== c.id) return;
            try {
              this.db.transaction(() => this.writeRows(c))();
            } catch (e) {
              this.log.warn({ err: (e as Error).message }, 'could not write the second copy of the service');
            }
          });
        }
        continue;
      }
      put.run(c.id, copy, bytes.length, bytes, Date.now());
    }
    // both missing and deferring: copy 0 is written now, copy 1 is scheduled by the call below
    if (deferSecond && missing.includes(0) && missing.includes(1)) this.writeRows(c, true);
  }

  /**
   * The copy named `id`, from the first of its two rows whose SHA-256 is the id and whose length is its `bytes`
   * (a torn or flipped row is a warning, the other is tried). Undefined: neither can be read.
   */
  private readCopy(
    id: string,
    warnings: string[],
  ): { id: string; json: Uint8Array; object: ResolvedPlaylist } | undefined {
    if (!RESOLVED_ID.test(id)) {
      warnings.push(`a copy is named by something that is not an id`);
      return undefined;
    }
    for (const copy of [0, 1]) {
      let row: { bytes: number; json: Buffer } | undefined;
      try {
        row = this.db
          .prepare(`SELECT bytes, json FROM live_resolved WHERE resolved_id = ? AND copy = ?`)
          .get(id, copy) as { bytes: number; json: Buffer } | undefined;
      } catch (e) {
        warnings.push(`copy ${copy} of ${id.slice(0, 12)} is unreadable: ${(e as Error).message}`);
        continue;
      }
      if (!row) {
        warnings.push(`copy ${copy} of ${id.slice(0, 12)} is missing`);
        continue;
      }
      if (row.json.length !== row.bytes || createHash('sha256').update(row.json).digest('hex') !== id) {
        warnings.push(`copy ${copy} of ${id.slice(0, 12)} failed its hash`);
        continue;
      }
      try {
        return { id, json: row.json, object: JSON.parse(row.json.toString('utf8')) as ResolvedPlaylist };
      } catch {
        warnings.push(`copy ${copy} of ${id.slice(0, 12)} is not valid JSON`);
      }
    }
    return undefined;
  }

  /** A copy read from the rows and verified against its id (the hub's hand-back by name builds on it). */
  readResolved(id: string): Uint8Array | undefined {
    return this.readCopy(id, [])?.json;
  }

  /**
   * The ids a restore may need: the in-memory service's, those the retained snapshots name (the current and the
   * previous ones), and those a goLive journal row newer than the oldest retained snapshot names (a restore from
   * a retained snapshot replays it).
   */
  resolvedIdsInUse(): Set<string> {
    return this.idsInUse().copies;
  }

  /** The copies' ids (`resolvedIdsInUse`) and the cue lists' ids a restore or the running service may need. */
  private idsInUse(): { copies: Set<string>; cues: Set<string> } {
    const used = new Set<string>();
    const cueIds = new Set<string>();
    if (this.state.mode === 'live' && this.copy?.object === this.state.resolved && this.copy)
      used.add(this.copy.id);
    if (this.state.mode === 'live' && this.cueCache?.cues === this.state.cues && this.cueCache.row)
      cueIds.add(this.cueCache.row.id);
    let oldest = Infinity;
    try {
      // The ids are the last characters of a by-name snapshot, after their keys: read as bytes, no parse (a whole
      // snapshot of the older form is not read at all, and costs the CASE one comparison).
      const rows = this.db
        .prepare(
          `SELECT seq,
                CASE WHEN CAST(substr(CAST(json AS BLOB), -${SNAPSHOT_TAIL.length + RID_FROM_END}, ${SNAPSHOT_TAIL.length}) AS TEXT) = ?
                THEN CAST(substr(CAST(json AS BLOB), -${RID_FROM_END}, 64) AS TEXT) END AS rid,
                CASE WHEN CAST(substr(CAST(json AS BLOB), -${CID_FROM_END + CUES_KEY.length}, ${CUES_KEY.length}) AS TEXT) = ?
                THEN CAST(substr(CAST(json AS BLOB), -${CID_FROM_END}, 64) AS TEXT) END AS cid
             FROM (SELECT seq, json FROM live_snapshot UNION ALL SELECT seq, json FROM live_snapshot_prev)`,
        )
        .all(SNAPSHOT_TAIL, CUES_KEY) as { seq: number; rid: string | null; cid: string | null }[];
      for (const r of rows) {
        oldest = Math.min(oldest, r.seq);
        if (r.rid && RESOLVED_ID.test(r.rid)) used.add(r.rid);
        if (r.cid && RESOLVED_ID.test(r.cid)) cueIds.add(r.cid);
      }
      const journal = this.db
        .prepare(
          `SELECT substr(event_json, ${JOURNAL_GOLIVE_HEAD.length + 1}, 64) AS rid FROM live_journal
            WHERE kind = 'event' AND seq > ? AND substr(event_json, 1, ${JOURNAL_GOLIVE_HEAD.length}) = ?`,
        )
        .all(Number.isFinite(oldest) ? oldest : -1, JOURNAL_GOLIVE_HEAD) as { rid: string }[];
      for (const r of journal) if (RESOLVED_ID.test(r.rid)) used.add(r.rid);
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'could not read which copies are in use');
      return {
        copies: new Set([...used, ...this.allRowIds()]),
        cues: new Set([...cueIds, ...this.allCueIds()]),
      };
    }
    return { copies: used, cues: cueIds };
  }

  private allRowIds(): string[] {
    try {
      return (
        this.db.prepare(`SELECT DISTINCT resolved_id AS id FROM live_resolved`).all() as { id: string }[]
      ).map((r) => r.id);
    } catch {
      return [];
    }
  }

  private allCueIds(): string[] {
    try {
      return (this.db.prepare(`SELECT cues_id AS id FROM live_cues`).all() as { id: string }[]).map(
        (r) => r.id,
      );
    } catch {
      return [];
    }
  }

  /**
   * Delete the rows of copies and cue lists nothing names (after a snapshot rotated, a goLive, an End service, an
   * adopt). A cue list is named by the snapshots only: a replayed goLive builds its own from the copy.
   */
  private collect(): void {
    try {
      const all = this.allRowIds();
      const allCues = this.allCueIds();
      if (!all.length && !allCues.length) return;
      const used = this.idsInUse();
      const del = this.db.prepare(`DELETE FROM live_resolved WHERE resolved_id = ?`);
      for (const id of all) if (!used.copies.has(id)) del.run(id);
      const delCues = this.db.prepare(`DELETE FROM live_cues WHERE cues_id = ?`);
      for (const id of allCues) if (!used.cues.has(id)) delCues.run(id);
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'could not collect unused copies');
    }
  }

  /** Playlist, presentations, media and fonts currently frozen in the live session (edit locks). */
  locks(): { playlistId?: string; presentations: Set<string>; media: Set<string>; fonts: Set<string> } {
    const r = this.state.mode === 'live' ? this.state.resolved : undefined;
    return {
      playlistId: r?.playlist.id,
      presentations: new Set(Object.keys(r?.presentations ?? {})),
      media: new Set(Object.keys(r?.media ?? {})),
      // The faces the frozen copy draws with (goLive keeps the families its slides and looks name): a font
      // removed under a running service would leave an output that reloads without it (design/28 §5.1).
      fonts: new Set((r?.fonts ?? []).map((f) => f.id)),
    };
  }

  /**
   * Resolve a playlist into the frozen copy a goLive carries, on this loop: the in-process source only (a
   * remote source's goLive is prepared in golive-worker.ts, `prepare`). Every presentation is validated
   * against the schema; what fails is quarantined (design/25) and listed in `degraded`, and the service still
   * goes live. Missing presentations, media that is not ready and a service past GOLIVE_MAX_BYTES (W58) still
   * refuse the goLive. Throws LiveRejection.
   */
  resolve(playlistId: string): ResolvedPlaylist {
    try {
      return resolvePlaylist(this.source.goLiveInputs(playlistId), playlistId, {
        ...this.pictureOptions(),
        digest: (parts) => {
          const h = createHash('sha256');
          for (const p of parts) h.update(p);
          return h.digest('hex').slice(0, 24);
        },
        warn: (message, detail) => this.log.warn(detail ?? {}, message),
      });
    } catch (e) {
      if (e instanceof GoLiveRejection) throw new LiveRejection(e.message);
      throw e;
    }
  }

  /** What the hub's switch adds to a goLive resolve: nothing when the option was not given. */
  private pictureOptions(): { prerenderOn?: boolean; pictures?: boolean } {
    const p = this.opts.prerender;
    return p ? { prerenderOn: p.on, pictures: p.store } : {};
  }

  /**
   * The output whose reports of media.ended/audio.ended count: the audio master (design/18). Undefined when
   * no master is configured, in which case any output window is believed.
   */
  audioMasterId(): string | undefined {
    return this.source.settings().outputs.find((o) => o.audioMaster && o.kind !== 'stage')?.id;
  }

  /** Message presets for the /actions bridge. */
  messagePresets(): string[] {
    return this.source.settings().surfaces.messagePresets ?? [];
  }

  /** Validate a command against its origin and turn it into a reducer event. */
  toEvent(cmd: LiveCommand | LiveEvent, origin: Origin): LiveEvent {
    if (origin.role === 'output' || origin.role === 'stage') {
      if (cmd.k !== 'media.ended' && cmd.k !== 'audio.ended')
        throw new LiveRejection('Output windows may only report media.ended and audio.ended');
      if (origin.role === 'stage') throw new LiveRejection('The stage display does not play media');
      const master = this.audioMasterId();
      if (master && origin.outputId !== master)
        throw new LiveRejection(`Only the audio master output reports ${cmd.k}`);
      const s = this.state;
      if (cmd.k === 'media.ended') {
        const m = s.layers.media.content;
        if (!m || m.cueIndex !== cmd.cueIndex || m.state === 'ended' || m.loop)
          throw new LiveRejection('stale media.ended');
      } else {
        const a = s.audio.content;
        if (!a || a.cueIndex !== cmd.cueIndex || a.loop) throw new LiveRejection('stale audio.ended');
      }
      return cmd;
    }
    if (cmd.k === 'goLive') {
      if (!('playlistId' in cmd) || 'resolved' in cmd)
        throw new LiveRejection('goLive must carry only playlistId; the hub resolves it');
      return { k: 'goLive', resolved: this.resolve(cmd.playlistId) };
    }
    if (origin.role === 'operate') return this.clampAt(cmd as LiveEvent);
    return cmd as LiveEvent;
  }

  /**
   * An operator clock that is off (a bad offset estimate, a laptop that slept) must not seek videos or skew
   * timers: `at` outside a short window around the hub clock is replaced by now + 33 ms.
   */
  clampAt(ev: LiveEvent): LiveEvent {
    if (!('at' in ev) || typeof ev.at !== 'number') return ev;
    const now = this.now();
    if (ev.at >= now - AT_PAST_MS && ev.at <= now + AT_FUTURE_MS) return ev;
    this.log.warn(
      { k: ev.k, at: ev.at, offsetMs: Math.round(ev.at - now) },
      'operator at out of range; replaced',
    );
    return { ...ev, at: now + AT_REPLACE_MS };
  }

  /** Submit a command: validate, reduce, journal, broadcast. Returns the new seq. */
  submit(cmd: LiveCommand | LiveEvent, origin: Origin): number {
    return this.apply(this.toEvent(cmd, origin), origin.id);
  }

  /**
   * Submit in arrival order. With a remote source a goLive enters the queue only once it is prepared
   * (design/29 §2.3 M8): fetched and checked beside the running service, so GO, Next and Clear sent meanwhile
   * apply to the running service at once; the goLive then applies with one parse of the prepared copy.
   * goLives keep their order among themselves. The operator sends goLive once POST /live/prepare reports it
   * ready, so a `next` it sends after Go live still applies to the new playlist. End service keeps its place
   * after a goLive still being prepared: that goLive is cancelled (its fetch abandoned) and refused with
   * GOLIVE_ENDED_REASON, so the screens never go live again after the operator ended the service.
   */
  submitQueued(cmd: LiveCommand | LiveEvent, origin: Origin): Promise<number> {
    const trusted = origin.role === 'operate' || origin.role === 'system';
    if (cmd.k === 'goLive' && 'playlistId' in cmd && !('resolved' in cmd) && this.source.bundle && trusted) {
      const playlistId = cmd.playlistId;
      const gen = this.goLiveGen;
      this.pendingGoLives.set(playlistId, (this.pendingGoLives.get(playlistId) ?? 0) + 1);
      const prepared = this.preparedFor(playlistId);
      const p = this.goLiveChain
        .then(() => prepared)
        .then((r) =>
          this.enqueue(() => {
            if (gen !== this.goLiveGen) throw new LiveRejection(GOLIVE_ENDED_REASON);
            return this.applyPrepared(playlistId, r, origin);
          }),
        )
        .finally(() => {
          const n = (this.pendingGoLives.get(playlistId) ?? 1) - 1;
          if (n > 0) this.pendingGoLives.set(playlistId, n);
          else this.pendingGoLives.delete(playlistId);
        });
      this.goLiveChain = p.catch(() => undefined);
      return p;
    }
    if (cmd.k === 'endService' && trusted) this.cancelPendingGoLives();
    return this.enqueue(() => this.submit(cmd, origin));
  }

  /** End service: the goLives sent before it and still being prepared are cancelled (see submitQueued). */
  private cancelPendingGoLives(): void {
    if (!this.pendingGoLives.size) return;
    this.goLiveGen++;
    for (const playlistId of this.pendingGoLives.keys()) {
      const p = this.preps.get(playlistId);
      if (!p || p.result) continue;
      p.ctrl.abort();
      // A goLive sent after End service prepares afresh instead of joining the abandoned fetch.
      this.preps.delete(playlistId);
    }
  }

  private enqueue<T>(run: () => T): Promise<T> {
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Apply a prepared goLive: one parse of the copy the worker serialised (design/29 M8, D13). */
  private applyPrepared(playlistId: string, r: Prepared, origin: Origin): number {
    if (!r.ok) throw new LiveRejection(r.reason);
    const text = Buffer.from(r.buffer.buffer, r.buffer.byteOffset, r.buffer.byteLength).toString('utf8');
    const resolved = JSON.parse(text) as ResolvedPlaylist;
    // The prepared bytes stay as the copy's bytes (named by the id the worker hashed them with): nothing that
    // follows serialises the copy again (live-by-ref).
    const seq = this.apply({ k: 'goLive', resolved }, origin.id, { id: r.resolvedId, json: r.buffer });
    this.resolvedId = r.resolvedId;
    this.source.applied?.(playlistId);
    return seq;
  }

  // ---- prepare (design/29 §2.3 M8) ----

  /**
   * Start preparing a playlist's goLive (POST /live/prepare), or report the prepare under way. `saved`: go
   * live from the hub's saved copy instead of waiting for the library (W41's button); a fresh copy already
   * prepared is kept. `seen` (a poll that continues a Go live) gets the fresh result of the prepare it
   * watched; only a first request starts afresh after one that finished (a failure is not repeated, and a
   * prepare that ended between two polls is not fetched again). Without a remote source there is nothing to
   * prepare: ready at once.
   */
  prepare(playlistId: string, opts: { saved?: boolean; seen?: number } = {}): PrepareState {
    if (!this.source.bundle) return { playlistId, state: 'ready', pct: 100 };
    const cur = this.preps.get(playlistId);
    const fresh = cur?.result && this.now() - (cur.doneAt ?? 0) <= PREPARED_TTL_MS;
    if (opts.saved) {
      if (cur && fresh && cur.result?.ok) return cur.state;
      if (cur && !cur.result && cur.saved) return cur.state;
      if (cur && !cur.result) cur.ctrl.abort();
      return this.startPrepare(playlistId, true).state;
    }
    if (cur && !cur.result) return cur.state;
    if (cur && fresh && opts.seen !== undefined) return cur.state;
    return this.startPrepare(playlistId, false).state;
  }

  /**
   * `prepare`, then wait (up to `waitMs`) until it is done or its progress differs from `seen` (the operator
   * long-polls POST /live/prepare; without `seen` it waits for the prepare to end).
   */
  async prepareWait(
    playlistId: string,
    opts: { saved?: boolean; seen?: number; waitMs: number },
  ): Promise<PrepareState> {
    const first = this.prepare(playlistId, opts);
    const prep = this.preps.get(playlistId);
    if (!prep || first.state !== 'preparing') return first;
    const changed = () => {
      const s = this.preps.get(playlistId)?.state;
      return s?.state !== 'preparing' || (opts.seen !== undefined && s.pct !== opts.seen);
    };
    if (!changed()) {
      await new Promise<void>((resolve) => {
        // Watches the prepare and any that replaces it meanwhile (the saved copy chosen).
        const watched = new Set<Prep>();
        const check = () => {
          if (changed()) finish();
        };
        const watch = (p: Prep) => {
          if (p.playlistId !== playlistId) return;
          p.waiters.add(check);
          watched.add(p);
          check();
        };
        const finish = () => {
          clearTimeout(t);
          for (const p of watched) p.waiters.delete(check);
          this.onReplace.delete(watch);
          resolve();
        };
        const t = setTimeout(finish, opts.waitMs);
        this.onReplace.add(watch);
        watch(prep);
      });
    }
    return this.preps.get(playlistId)?.state ?? first;
  }

  private onReplace = new Set<(p: Prep) => void>();

  private startPrepare(playlistId: string, saved: boolean): Prep {
    const prev = this.preps.get(playlistId);
    if (prev) clearTimeout(prev.expiry);
    let inFlight = 0;
    for (const [id, p] of this.preps) {
      if (id === playlistId) continue;
      if (!p.result) inFlight++;
      else {
        // Only the latest prepare's copy is kept ready; a goLive already waiting on an older one still has it.
        clearTimeout(p.expiry);
        this.preps.delete(id);
      }
    }
    const prep: Prep = {
      playlistId,
      saved,
      busy: inFlight >= PREPARES_IN_FLIGHT_MAX,
      ctrl: new AbortController(),
      state: { playlistId, state: 'preparing', pct: 0, ...this.savedAtOf(playlistId) },
      promise: Promise.resolve({ ok: false, reason: CANCELLED }),
      emittedAt: 0,
      waiters: new Set(),
    };
    this.preps.set(playlistId, prep);
    for (const f of this.onReplace) f(prep);
    prep.promise = this.runPrepare(prep).then((result) => {
      prep.result = result;
      prep.doneAt = this.now();
      prep.state = result.ok
        ? { ...prep.state, state: 'ready', pct: 100, bytes: result.buffer.byteLength }
        : { ...prep.state, state: 'failed', pct: 100, reason: result.reason };
      this.changed(prep, true);
      if (this.preps.get(playlistId) === prep) {
        prep.expiry = setTimeout(() => {
          if (this.preps.get(playlistId) === prep) this.preps.delete(playlistId);
        }, PREPARED_TTL_MS);
        prep.expiry.unref();
      }
      return result;
    });
    return prep;
  }

  private savedAtOf(playlistId: string): { savedAt?: number } {
    const at = this.source.savedAt?.(playlistId);
    return at !== undefined ? { savedAt: at } : {};
  }

  private changed(prep: Prep, force = false): void {
    const now = Date.now();
    if (!force && now - prep.emittedAt < PROGRESS_EVERY_MS) return;
    prep.emittedAt = now;
    for (const w of [...prep.waiters]) w();
  }

  private async runPrepare(prep: Prep): Promise<Prepared> {
    const { playlistId } = prep;
    if (prep.busy) {
      this.log.warn(
        { playlistId, inFlight: PREPARES_IN_FLIGHT_MAX },
        'goLive prepare refused: others in flight',
      );
      return { ok: false, reason: PREPARE_BUSY_REASON };
    }
    let bundle: RawBundle | undefined;
    try {
      bundle = await this.source.bundle!(playlistId, {
        saved: prep.saved,
        signal: prep.ctrl.signal,
        onProgress: (received, total) => {
          if (!total) return;
          const pct = Math.min(90, Math.floor((received / total) * 90));
          if (pct === prep.state.pct) return;
          prep.state = { ...prep.state, pct };
          this.changed(prep);
        },
      });
    } catch (e) {
      if (e instanceof LiveRejection) return { ok: false, reason: e.message };
      if (prep.ctrl.signal.aborted) return { ok: false, reason: CANCELLED };
      this.log.error({ playlistId, err: (e as Error).message }, 'goLive prepare failed');
      return { ok: false, reason: `Could not get the playlist ready: ${(e as Error).message}` };
    }
    if (prep.ctrl.signal.aborted) return { ok: false, reason: CANCELLED };
    if (!bundle) return { ok: false, reason: `Playlist ${playlistId} not found` };
    prep.state = { ...prep.state, pct: 90, ...this.savedAtOf(playlistId) };
    this.changed(prep, true);
    let out: PrepareOutput;
    try {
      this.worker ??= new GoLiveWorker();
      out = await this.worker.run({
        playlistId,
        bundle: bundle.bytes,
        takenAt: bundle.takenAt,
        ...(bundle.cachedCopy ? { cachedCopy: bundle.cachedCopy } : {}),
        ...this.pictureOptions(),
      });
      if (this.worker.inline)
        this.log.warn('goLive check ran on the live loop: no worker thread could start');
    } catch (e) {
      this.log.error({ playlistId, err: (e as Error).message }, 'goLive check failed');
      return { ok: false, reason: `Could not check the service: ${(e as Error).message}` };
    }
    for (const w of out.warnings) this.log.warn(w.detail ?? {}, w.message);
    if (!out.ok) return { ok: false, reason: out.reason };
    this.log.info(
      { playlistId, bytes: out.buffer.byteLength, resolvedId: out.resolvedId.slice(0, 12), ...out.ms },
      'goLive prepared',
    );
    return { ok: true, buffer: out.buffer, resolvedId: out.resolvedId };
  }

  /**
   * What a goLive of `playlistId` applies: the prepare under way or a fresh one ready (used once), else a
   * new prepare. A prepare replaced meanwhile (the saved copy chosen) is followed to its replacement.
   */
  private preparedFor(playlistId: string): Promise<Prepared> {
    const cur = this.preps.get(playlistId);
    const usable = cur && (!cur.result || this.now() - (cur.doneAt ?? 0) <= PREPARED_TTL_MS);
    const prep = usable ? cur : this.startPrepare(playlistId, false);
    const follow = (p: Prep): Promise<Prepared> =>
      p.promise.then((r) => {
        const next = this.preps.get(playlistId);
        if (!r.ok && r.reason === CANCELLED && next && next !== p) return follow(next);
        if (next === p) {
          clearTimeout(p.expiry);
          this.preps.delete(playlistId);
        }
        return r;
      });
    return follow(prep);
  }

  /**
   * The bytes of the running service's resolved copy and their SHA-256 (hex): what a socket that does not hold
   * the copy is sent, and the name a snapshot, a journal row and a window give it. A copy that came without bytes
   * (an in-process goLive, an adopted or restored state) is serialised once here and the result kept.
   */
  resolvedCopy(): { id: string; json: Uint8Array } | undefined {
    const r = this.state.mode === 'live' ? this.state.resolved : undefined;
    if (!r) return undefined;
    if (this.copy?.object !== r) {
      const json = Buffer.from(JSON.stringify(r));
      this.copy = { id: createHash('sha256').update(json).digest('hex'), json, object: r };
    }
    return this.copy;
  }

  /** The JSON of `state.cues`, made once per cue list (it is built at the goLive and never changes after). */
  cuesJson(cues: Cue[] = this.state.cues): string {
    if (this.cueCache?.cues !== cues) this.cueCache = { cues };
    const c = this.cueCache;
    c.json ??= c.row ? c.row.json.toString('utf8') : JSON.stringify(cues);
    return c.json;
  }

  /** The cue list's bytes and their SHA-256 (hex), made once per cue list: its row's content and its name. */
  private cuesRow(cues: Cue[]): { id: string; json: Buffer } {
    this.cuesJson(cues);
    const c = this.cueCache!;
    if (!c.row) {
      const json = Buffer.from(c.json!);
      c.row = { id: createHash('sha256').update(json).digest('hex'), json };
    }
    return c.row;
  }

  apply(event: LiveEvent, id?: string, prepared?: { id: string; json: Uint8Array }): number {
    const fromSeq = this.state.seq;
    // An event whose write fails (the disk is full) is not applied: the state and the copy it had are put back, the
    // caller gets the error, nothing is sent, and the next event follows `fromSeq` with no gap. The whole write is one
    // transaction (the journal row, the copy's rows and the snapshot), so nothing of a failed event is half-saved.
    const prev = { state: this.state, copy: this.copy };
    this.state = reduce(this.state, event);
    const seq = this.state.seq;
    if (event.k === 'goLive')
      this.copy = prepared && this.state.resolved ? { ...prepared, object: this.state.resolved } : undefined;
    else if (event.k === 'endService') this.copy = undefined;
    // A goLive is journalled by name (its copy is in the rows, written in the same transaction as the journal row
    // and the snapshot: a snapshot never names a copy that is not there); every other event is its small self.
    const copy = event.k === 'goLive' && this.byRef ? this.resolvedCopy() : undefined;
    const write = () => {
      if (copy) this.writeRows(copy, true);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO live_journal (seq, at, cmd_id, kind, event_json) VALUES (?, ?, ?, 'event', ?)`,
        )
        .run(
          seq,
          this.now(),
          id ?? null,
          copy ? `${JOURNAL_GOLIVE_HEAD}${copy.id}"}` : JSON.stringify(event),
        );
      if (seq % 500 === 0) this.db.prepare(`DELETE FROM live_journal WHERE seq < ?`).run(seq - JOURNAL_KEEP);
      this.dirty = true;
      if (event.k === 'goLive' || event.k === 'endService') this.snapshot(true);
    };
    try {
      this.db.transaction(write)();
    } catch (e) {
      this.state = prev.state;
      this.copy = prev.copy;
      throw e;
    }
    for (const l of this.deltaListeners) l({ seq, fromSeq, event, id, ...(copy ? { copy } : {}) });
    this.scheduleAdvance();
    return seq;
  }

  /**
   * Operator reconciliation after degraded mode (design/17): accepted when the hub is idle, or live with
   * the same playlist and a lower seq, or when forced. The incoming state must pass the structural check
   * and the invariants: a broken state is never adopted.
   */
  adopt(incoming: unknown, force = false): { ok: true; seq: number } | { ok: false; reason: string } {
    const why = LiveService.unsound(incoming);
    if (why) return { ok: false, reason: `invalid state: ${why}` };
    const st = incoming as LiveState;
    const hub = this.state;
    const samePlaylist =
      hub.mode === 'live' && st.mode === 'live' && hub.resolved?.playlist.id === st.resolved?.playlist.id;
    if (!force && hub.mode !== 'idle' && !(samePlaylist && hub.seq < st.seq)) {
      return {
        ok: false,
        reason: samePlaylist ? 'hub state is newer' : 'hub is live with a different playlist',
      };
    }
    const seq = Math.max(st.seq, hub.seq + 1);
    const prevCopy = this.copy;
    this.state = { ...st, seq };
    this.copy = undefined;
    // The adopted copy is named (one serialisation), its rows, the journal row and the snapshot in one transaction;
    // when it cannot be written the hub keeps the state it had (and the operator, told so, keeps its own).
    try {
      this.db.transaction(() => {
        if (this.byRef && this.state.mode === 'live') this.resolvedCopy();
        this.db
          .prepare(
            `INSERT OR REPLACE INTO live_journal (seq, at, cmd_id, kind, event_json) VALUES (?, ?, ?, 'adopt', ?)`,
          )
          .run(seq, this.now(), null, JSON.stringify({ k: 'adopt', fromSeq: hub.seq, force }));
        this.snapshot(true);
      })();
    } catch (e) {
      this.state = hub;
      this.copy = prevCopy;
      this.log.error(
        { err: (e as Error).message },
        'could not write the operator state; the hub keeps its own',
      );
      return { ok: false, reason: 'the hub could not save the state' };
    }
    this.log.info({ fromSeq: hub.seq, seq, force }, 'adopted operator state');
    for (const l of this.stateListeners) l(this.state);
    this.scheduleAdvance();
    return { ok: true, seq };
  }

  /** The newest `n` client command ids in the journal with their seqs, oldest first. */
  recentCommandIds(n: number): { id: string; seq: number }[] {
    try {
      return (
        this.db
          .prepare(
            `SELECT cmd_id AS id, seq FROM live_journal WHERE cmd_id IS NOT NULL AND kind = 'event' AND cmd_id != 'auto-advance' ORDER BY seq DESC LIMIT ?`,
          )
          .all(n) as { id: string; seq: number }[]
      ).reverse();
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'could not read recent command ids from the journal');
      return [];
    }
  }

  journalTail(n = 500): { seq: number; at: number; id?: string; kind: string; event: unknown }[] {
    return (
      this.db
        .prepare(`SELECT seq, at, cmd_id, kind, event_json FROM live_journal ORDER BY seq DESC LIMIT ?`)
        .all(n) as { seq: number; at: number; cmd_id: string | null; kind: string; event_json: string }[]
    )
      .reverse()
      .map((r) => {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(r.event_json) as Record<string, unknown>;
        } catch {
          ev = { corrupt: true };
        }
        // The goLive payload is large; keep only its identity in exports (a row by name has the id and no payload).
        if (ev.k === 'goLive' && ev.resolved)
          ev.resolved = {
            manifestId: (ev.resolved as ResolvedPlaylist).manifestId,
            playlistId: (ev.resolved as ResolvedPlaylist).playlist?.id,
          };
        else if (ev.k === 'goLive' && typeof ev.resolvedId === 'string') {
          const r = this.copy?.id === ev.resolvedId ? this.state.resolved : undefined;
          ev.resolved = { resolvedId: ev.resolvedId, manifestId: r?.manifestId, playlistId: r?.playlist?.id };
        }
        return { seq: r.seq, at: r.at, id: r.cmd_id ?? undefined, kind: r.kind, event: ev };
      });
  }

  /** Loop presentations: schedule the next automatic `go`. */
  private scheduleAdvance(): void {
    const next = autoAdvance(this.state);
    const key = next ? `${next.dueAt}:${next.target}` : '';
    if (key === this.advanceKey) return;
    clearTimeout(this.advanceTimer);
    this.advanceKey = key;
    if (!next) return;
    const delay = Math.max(0, next.dueAt - 100 - this.now());
    this.armAdvance(next, key, delay);
  }

  private armAdvance(next: { dueAt: number; target: number }, key: string, delay: number): void {
    this.advanceTimer = setTimeout(() => this.advanceDue(next, key), delay);
    this.advanceTimer.unref();
  }

  /**
   * The auto-advance timer fired: send the loop's next `go` unless the state moved on. A write that fails (the data
   * folder's disk is full) has already put the state back and throws out of `apply`; out of a timer's callback that
   * would be an uncaught exception, which the live process answers with a restart (main.ts), in the middle of a
   * service. So it is caught here: the cue stays where it is, and the same advance is tried again after
   * ADVANCE_RETRY_MS (never at once: the cue is overdue, so a timer armed again from the state would fire in a loop).
   * The first failure and then one in 30 are logged.
   */
  private advanceDue(next: { dueAt: number; target: number }, key: string): void {
    this.advanceKey = '';
    const again = autoAdvance(this.state);
    if (!again || again.dueAt !== next.dueAt || again.target !== next.target) {
      this.scheduleAdvance();
      return;
    }
    try {
      this.apply(
        { k: 'go', cueIndex: next.target, at: Math.max(next.dueAt, this.now() + 33) },
        'auto-advance',
      );
      this.advanceFailures = 0;
    } catch (e) {
      if (this.advanceFailures++ % 30 === 0)
        this.log.error(
          { err: (e as Error).message, cue: next.target, failures: this.advanceFailures },
          'the loop could not advance: the write failed; the cue stays and the advance is tried again',
        );
      this.advanceKey = key;
      this.armAdvance(next, key, ADVANCE_RETRY_MS);
    }
  }
}

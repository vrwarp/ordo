import { createHash } from 'node:crypto';
import {
  DEGRADED_MAX,
  type Degraded as DomainDegraded,
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
import type { DB } from './db.ts';
import { GoLiveWorker, type PrepareOutput } from './golive-worker.ts';
import type { Library } from './library.ts';

export class LiveRejection extends Error {}

export type Origin =
  | { role: 'operate'; id?: string }
  | { role: 'output' | 'stage'; outputId: string; id?: string }
  | { role: 'system'; id?: string };

export type DeltaListener = (d: { seq: number; fromSeq: number; event: LiveEvent; id?: string }) => void;
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

  private db: DB;
  private source: LiveSource;
  private log: Logger;
  private opts: { snapshotIntervalMs: number; now?: () => number };
  constructor(
    db: DB,
    source: LiveSource,
    log: Logger,
    opts: { snapshotIntervalMs: number; now?: () => number },
  ) {
    this.db = db;
    this.source = source;
    this.log = log;
    this.opts = opts;
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
    for (const c of candidates) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(c.json);
      } catch {
        warnings.push(`${c.where} (seq ${c.seq}) is not valid JSON`);
        continue;
      }
      const why = LiveService.unsound(parsed);
      if (why) {
        warnings.push(`${c.where} (seq ${c.seq}) failed validation: ${why}`);
        continue;
      }
      s = parsed as LiveState;
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
        replayed++;
      }
    } catch (e) {
      warnings.push(`journal unreadable: ${(e as Error).message}`);
    }
    this.state = s;
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
        const cur = this.db.prepare(`SELECT seq FROM live_snapshot WHERE id = 1`).get() as
          | { seq: number }
          | undefined;
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
          .run(this.state.seq, JSON.stringify(this.state), Date.now());
      })();
      this.dirty = false;
    } catch (e) {
      this.log.error({ err: (e as Error).message }, 'live snapshot failed');
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
    const seq = this.apply({ k: 'goLive', resolved }, origin.id);
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

  apply(event: LiveEvent, id?: string): number {
    const fromSeq = this.state.seq;
    this.state = reduce(this.state, event);
    const seq = this.state.seq;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO live_journal (seq, at, cmd_id, kind, event_json) VALUES (?, ?, ?, 'event', ?)`,
      )
      .run(seq, this.now(), id ?? null, JSON.stringify(event));
    if (seq % 500 === 0) this.db.prepare(`DELETE FROM live_journal WHERE seq < ?`).run(seq - JOURNAL_KEEP);
    this.dirty = true;
    if (event.k === 'goLive' || event.k === 'endService') this.snapshot(true);
    for (const l of this.deltaListeners) l({ seq, fromSeq, event, id });
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
    this.state = { ...st, seq };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO live_journal (seq, at, cmd_id, kind, event_json) VALUES (?, ?, ?, 'adopt', ?)`,
      )
      .run(seq, this.now(), null, JSON.stringify({ k: 'adopt', fromSeq: hub.seq, force }));
    this.snapshot(true);
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
        // The goLive payload is large; keep only its identity in exports.
        if (ev.k === 'goLive' && ev.resolved)
          ev.resolved = {
            manifestId: (ev.resolved as ResolvedPlaylist).manifestId,
            playlistId: (ev.resolved as ResolvedPlaylist).playlist?.id,
          };
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
    this.advanceTimer = setTimeout(() => {
      this.advanceKey = '';
      const again = autoAdvance(this.state);
      if (!again || again.dueAt !== next.dueAt || again.target !== next.target) return this.scheduleAdvance();
      this.apply(
        { k: 'go', cueIndex: next.target, at: Math.max(next.dueAt, this.now() + 33) },
        'auto-advance',
      );
    }, delay);
    this.advanceTimer.unref();
  }
}

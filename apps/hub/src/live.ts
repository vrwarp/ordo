import { createHash } from 'node:crypto';
import {
  DEGRADED_MAX,
  type Degraded as DomainDegraded,
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
  /** Awaited before a goLive is resolved: a remote source refreshes its copy here. Never throws. */
  prepare?(playlistId: string): Promise<void>;
  goLiveInputs(playlistId: string): GoLiveInputs | undefined;
  settings(): LiveSettings;
}

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
        fonts: () => lib.listFonts(),
        looks: s.looks,
        general: s.general,
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
  /** Warnings from the last restore (tests and diagnostics). */
  restoreWarnings: string[] = [];

  constructor(
    private db: DB,
    private source: LiveSource,
    private log: Logger,
    private opts: { snapshotIntervalMs: number; now?: () => number },
  ) {}

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
  locks(): { playlistId?: string; presentations: Set<string>; media: Set<string> } {
    const r = this.state.mode === 'live' ? this.state.resolved : undefined;
    return {
      playlistId: r?.playlist.id,
      presentations: new Set(Object.keys(r?.presentations ?? {})),
      media: new Set(Object.keys(r?.media ?? {})),
    };
  }

  /**
   * Resolve a playlist into the frozen copy a goLive carries. Every presentation is validated against the
   * schema; what fails is quarantined (design/25) and listed in `degraded`, and the service still goes
   * live. Missing presentations and media that is not ready still refuse the goLive. Throws LiveRejection.
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
   * Submit in arrival order, letting a goLive first refresh the source's copy of the library (the live
   * process fetches it from the library process). Commands behind a goLive wait for it, so a `next` sent
   * right after GO live applies to the new playlist.
   */
  submitQueued(cmd: LiveCommand | LiveEvent, origin: Origin): Promise<number> {
    const run = async () => {
      if (cmd.k === 'goLive' && 'playlistId' in cmd && this.source.prepare)
        await this.source.prepare(cmd.playlistId);
      return this.submit(cmd, origin);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
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

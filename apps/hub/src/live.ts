import { createHash } from 'node:crypto';
import {
  type Font,
  type LiveCommand,
  type LiveEvent,
  type LiveState,
  type Media,
  manifestFiles,
  type Presentation,
  type ResolvedPlaylist,
  referencedFontFamilies,
  referencedMediaIds,
} from '@ordo/domain';
import { autoAdvance, initialState, reduce } from '@ordo/live-state';
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

const JOURNAL_KEEP = 5000;
/** Operator `at` values outside [now - AT_PAST_MS, now + AT_FUTURE_MS] are replaced by now + AT_REPLACE_MS. */
export const AT_PAST_MS = 500;
export const AT_FUTURE_MS = 2000;
export const AT_REPLACE_MS = 33;

/** Hub-authoritative live state: resolve, reduce, journal, snapshot, broadcast. */
export class LiveService {
  state: LiveState = initialState();
  private deltaListeners: DeltaListener[] = [];
  private stateListeners: StateListener[] = [];
  private dirty = false;
  private snapshotTimer?: NodeJS.Timeout;
  private advanceTimer?: NodeJS.Timeout;
  private advanceKey = '';

  constructor(
    private db: DB,
    private lib: Library,
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

  /** Load the last snapshot and replay journal events after it. */
  restore(): void {
    const snap = this.db.prepare(`SELECT seq, json FROM live_snapshot WHERE id = 1`).get() as
      | { seq: number; json: string }
      | undefined;
    let s = snap ? (JSON.parse(snap.json) as LiveState) : initialState();
    const rows = this.db
      .prepare(`SELECT seq, kind, event_json FROM live_journal WHERE seq > ? ORDER BY seq`)
      .all(s.seq) as { seq: number; kind: string; event_json: string }[];
    let replayed = 0;
    for (const r of rows) {
      if (r.kind !== 'event' || r.seq !== s.seq + 1) break;
      s = reduce(s, JSON.parse(r.event_json) as LiveEvent);
      replayed++;
    }
    this.state = s;
    if (snap || replayed) this.log.info({ seq: s.seq, mode: s.mode, replayed }, 'live state restored');
  }

  snapshot(force = false): void {
    if (!this.dirty && !force) return;
    this.db
      .prepare(`INSERT OR REPLACE INTO live_snapshot (id, seq, json, saved_at) VALUES (1, ?, ?, ?)`)
      .run(this.state.seq, JSON.stringify(this.state), Date.now());
    this.dirty = false;
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

  /** Resolve a playlist into the frozen copy a goLive carries. Throws LiveRejection with a reason. */
  resolve(playlistId: string): ResolvedPlaylist {
    const playlist = this.lib.playlists.get(playlistId);
    if (!playlist) throw new LiveRejection(`Playlist ${playlistId} not found`);
    const presentations: Record<string, Presentation> = {};
    for (const item of playlist.items) {
      if (item.kind !== 'presentation' || presentations[item.presentationId]) continue;
      const p = this.lib.presentations.get(item.presentationId);
      if (!p) throw new LiveRejection(`Presentation ${item.presentationId} in the playlist no longer exists`);
      presentations[p.id] = p;
    }
    const settings = this.lib.getSettings();
    const looks = settings.looks;
    const logoId = settings.general.logoMediaId;
    const optional = new Set<string>(
      [...looks.map((l) => l.holdingMediaId ?? ''), logoId ?? ''].filter(Boolean),
    );
    const media: Record<string, Media> = {};
    const problems: string[] = [];
    for (const id of referencedMediaIds(playlist, presentations, looks, logoId)) {
      const m = this.lib.media.get(id);
      if (!m) {
        if (!optional.has(id)) problems.push(`media ${id} is missing`);
        continue;
      }
      if (m.state !== 'ready') {
        if (optional.has(id)) continue;
        problems.push(`"${m.name}" is ${m.state === 'failed' ? 'failed' : 'still processing'}`);
        continue;
      }
      media[id] = m;
    }
    if (problems.length) throw new LiveRejection(`Cannot go live: ${problems.slice(0, 5).join('; ')}`);
    const families = referencedFontFamilies(Object.values(presentations), looks);
    const fonts: Font[] = this.lib.listFonts().filter((f) => families.has(f.family));
    const files = manifestFiles(Object.values(media), fonts);
    const h = createHash('sha256');
    h.update(`${playlist.id}:${playlist.rev}`);
    for (const p of Object.values(presentations)) h.update(`${p.id}:${p.rev}`);
    for (const f of files) h.update(f.hash);
    h.update(JSON.stringify(looks));
    return {
      playlist,
      presentations,
      media,
      fonts,
      looks,
      logoMediaId: logoId && media[logoId] ? logoId : undefined,
      files,
      manifestId: h.digest('hex').slice(0, 24),
    };
  }

  /**
   * The output whose reports of media.ended/audio.ended count: the audio master (design/18). Undefined when
   * no master is configured, in which case any output window is believed.
   */
  audioMasterId(): string | undefined {
    return this.lib.getSetting('outputs').find((o) => o.audioMaster && o.kind !== 'stage')?.id;
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
   * the same playlist and a lower seq, or when forced.
   */
  adopt(incoming: unknown, force = false): { ok: true; seq: number } | { ok: false; reason: string } {
    const st = incoming as LiveState;
    if (
      !st ||
      typeof st !== 'object' ||
      typeof st.seq !== 'number' ||
      !Array.isArray(st.cues) ||
      !st.layers ||
      (st.mode !== 'live' && st.mode !== 'idle')
    )
      return { ok: false, reason: 'invalid state' };
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

  journalTail(n = 500): { seq: number; at: number; id?: string; kind: string; event: unknown }[] {
    return (
      this.db
        .prepare(`SELECT seq, at, cmd_id, kind, event_json FROM live_journal ORDER BY seq DESC LIMIT ?`)
        .all(n) as { seq: number; at: number; cmd_id: string | null; kind: string; event_json: string }[]
    )
      .reverse()
      .map((r) => {
        const ev = JSON.parse(r.event_json) as Record<string, unknown>;
        // The goLive payload is large; keep only its identity in exports.
        if (ev.k === 'goLive' && ev.resolved)
          ev.resolved = {
            manifestId: (ev.resolved as ResolvedPlaylist).manifestId,
            playlistId: (ev.resolved as ResolvedPlaylist).playlist.id,
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

import { createHash } from 'node:crypto';
import {
  expandCues,
  type Font,
  type GeneralSettings,
  type LiveCommand,
  type LiveEvent,
  type LiveState,
  type Look,
  type Media,
  manifestFiles,
  newId,
  type Output,
  Playlist,
  PlaylistItem,
  Presentation,
  type ResolvedPlaylist,
  referencedFontFamilies,
  referencedMediaIds,
  Section,
  Slide,
  type SurfaceSettings,
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

/** What the live service needs from the library for one goLive (read lazily; may be unvalidated). */
export type GoLiveInputs = {
  /** The stored playlist, not yet validated. */
  playlist: unknown;
  /** A stored presentation, not yet validated; undefined when it does not exist. */
  presentation(id: string): unknown;
  media(id: string): Media | undefined;
  fonts(): Font[];
  looks: Look[];
  general: Pick<GeneralSettings, 'logoMediaId'>;
  /** When the copy was taken (remote sources serve a cached copy while the library is down). */
  takenAt?: number;
  /**
   * Set when this is a cached copy because the library did not answer: the reason, naming the copy's time.
   * The goLive carries it as a `degraded` entry (cueIndex -1) so the operator sees it.
   */
  cachedCopy?: string;
};

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

export type Degraded = NonNullable<ResolvedPlaylist['degraded']>[number];

/** A playlist entry whose content failed validation and was replaced (before cue indices are known). */
type Problem = { presentationId?: string; slideId?: string; reason: string };

const JOURNAL_KEEP = 5000;
/** Snapshots kept besides the current one; restore falls back through them (design/25). */
export const SNAPSHOTS_PREV_KEEP = 2;
/** Operator `at` values outside [now - AT_PAST_MS, now + AT_FUTURE_MS] are replaced by now + AT_REPLACE_MS. */
export const AT_PAST_MS = 500;
export const AT_FUTURE_MS = 2000;
export const AT_REPLACE_MS = 33;
/** At most this many degraded entries are carried in a resolved playlist. */
export const DEGRADED_MAX = 200;

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown, d: string) => (typeof x === 'string' && x ? x : d);
function issue(e: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join('.') || 'value'}: ${i.message}`.slice(0, 200) : 'invalid';
}

/**
 * Validate a stored presentation for goLive (design/25 "quarantine"). A slide that fails the schema is
 * replaced by an empty slide with the same id; a presentation whose own fields are broken keeps its valid
 * sections; one that cannot be read at all becomes an empty presentation. Never throws.
 */
export function quarantinePresentation(
  raw: unknown,
  id: string,
): { presentation: Presentation; problems: Problem[] } {
  const first = Presentation.safeParse(raw);
  if (first.success) return { presentation: first.data, problems: [] };
  const obj = isObj(raw) ? raw : {};
  const title = str(obj.title, 'Untitled');
  const problems: Problem[] = [];
  const sections = (Array.isArray(obj.sections) ? obj.sections : []).map((sec, si) => {
    const s = isObj(sec) ? sec : {};
    const label = str(s.label, `Section ${si + 1}`);
    const slides = (Array.isArray(s.slides) ? s.slides : []).map((sl, k) => {
      const ok = Slide.safeParse(sl);
      if (ok.success) return ok.data;
      const slideId = isObj(sl) && typeof sl.id === 'string' && sl.id ? sl.id.slice(0, 200) : newId();
      problems.push({
        presentationId: id,
        slideId,
        reason: `"${title}" ${label} slide ${k + 1} is invalid (${issue(ok.error)}); shown empty`,
      });
      return { id: slideId, objects: [] };
    });
    return {
      ...s,
      id: typeof s.id === 'string' && s.id ? s.id : newId(),
      label,
      short: typeof s.short === 'string' ? s.short : '',
      slides,
    };
  });
  const second = Presentation.safeParse({ ...obj, id, sections });
  if (second.success) return { presentation: second.data, problems };
  // The presentation's own fields are broken: keep what is valid, reset the rest.
  const goodSections = sections.flatMap((s) => {
    const r = Section.safeParse(s);
    return r.success ? [r.data] : [];
  });
  const kind = obj.kind === 'song' || obj.kind === 'loop' || obj.kind === 'slides' ? obj.kind : 'slides';
  const minimal = {
    id,
    rev: typeof obj.rev === 'number' && Number.isInteger(obj.rev) ? obj.rev : 1,
    title: title.slice(0, 300),
    kind,
    meta: { tags: [] },
    sections: goodSections,
    arrangements: (Array.isArray(obj.arrangements) ? obj.arrangements : []).filter(
      (a) => isObj(a) && typeof a.id === 'string' && Array.isArray(a.sectionIds),
    ),
    ...(kind === 'loop' ? { loop: { defaultSlideMs: 8000 } } : {}),
    archived: false,
  };
  const third = Presentation.safeParse(minimal);
  if (third.success) {
    problems.push({
      presentationId: id,
      reason: `"${title}" is damaged (${issue(second.error)}); its settings were reset`,
    });
    return { presentation: third.data, problems };
  }
  problems.push({
    presentationId: id,
    reason: `"${title}" cannot be read (${issue(third.error)}); it shows no slides`,
  });
  return {
    presentation: {
      id,
      rev: 1,
      title: title.slice(0, 300),
      kind: 'slides',
      meta: { tags: [] },
      sections: [],
      arrangements: [],
      archived: false,
    },
    problems,
  };
}

/** Validate a stored playlist: invalid items are dropped (and reported); throws LiveRejection when hopeless. */
export function validatePlaylist(raw: unknown): { playlist: Playlist; problems: Problem[] } {
  const first = Playlist.safeParse(raw);
  if (first.success) return { playlist: first.data, problems: [] };
  const obj = isObj(raw) ? raw : {};
  const problems: Problem[] = [];
  const items = (Array.isArray(obj.items) ? obj.items : []).flatMap((it, i) => {
    const r = PlaylistItem.safeParse(it);
    if (r.success) return [r.data];
    problems.push({ reason: `playlist item ${i + 1} is invalid (${issue(r.error)}); skipped` });
    return [];
  });
  const second = Playlist.safeParse({ ...obj, items });
  if (second.success) return { playlist: second.data, problems };
  throw new LiveRejection(`Cannot go live: the playlist is damaged (${issue(second.error)})`);
}

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
    const inputs = this.source.goLiveInputs(playlistId);
    if (!inputs) throw new LiveRejection(`Playlist ${playlistId} not found`);
    const { playlist, problems } = validatePlaylist(inputs.playlist);
    if (inputs.cachedCopy) {
      problems.unshift({ reason: inputs.cachedCopy.slice(0, 500) });
      this.log.warn({ playlistId, takenAt: inputs.takenAt }, 'goLive from a cached copy of the playlist');
    }
    const presentations: Record<string, Presentation> = {};
    for (const item of playlist.items) {
      if (item.kind !== 'presentation' || presentations[item.presentationId]) continue;
      const raw = inputs.presentation(item.presentationId);
      if (raw === undefined || raw === null)
        throw new LiveRejection(`Presentation ${item.presentationId} in the playlist no longer exists`);
      const q = quarantinePresentation(raw, item.presentationId);
      presentations[item.presentationId] = q.presentation;
      problems.push(...q.problems);
    }
    const looks = inputs.looks;
    const logoId = inputs.general.logoMediaId;
    const optional = new Set<string>(
      [...looks.map((l) => l.holdingMediaId ?? ''), logoId ?? ''].filter(Boolean),
    );
    const media: Record<string, Media> = {};
    const missing: string[] = [];
    for (const id of referencedMediaIds(playlist, presentations, looks, logoId)) {
      const m = inputs.media(id);
      if (!m) {
        if (!optional.has(id)) missing.push(`media ${id} is missing`);
        continue;
      }
      if (m.state !== 'ready') {
        if (optional.has(id)) continue;
        missing.push(`"${m.name}" is ${m.state === 'failed' ? 'failed' : 'still processing'}`);
        continue;
      }
      media[id] = m;
    }
    if (missing.length) throw new LiveRejection(`Cannot go live: ${missing.slice(0, 5).join('; ')}`);
    const families = referencedFontFamilies(Object.values(presentations), looks);
    const fonts: Font[] = inputs.fonts().filter((f) => families.has(f.family));
    const files = manifestFiles(Object.values(media), fonts);
    const h = createHash('sha256');
    h.update(`${playlist.id}:${playlist.rev}`);
    for (const p of Object.values(presentations)) h.update(`${p.id}:${p.rev}`);
    for (const f of files) h.update(f.hash);
    h.update(JSON.stringify(looks));
    const resolved: ResolvedPlaylist = {
      playlist,
      presentations,
      media,
      fonts,
      looks,
      logoMediaId: logoId && media[logoId] ? logoId : undefined,
      files,
      manifestId: h.digest('hex').slice(0, 24),
    };
    if (problems.length) {
      resolved.degraded = this.degradedEntries(resolved, problems);
      for (const d of resolved.degraded)
        this.log.warn({ cueIndex: d.cueIndex, reason: d.reason }, 'goLive: content quarantined');
    }
    return resolved;
  }

  /** Map problems to the cue indices they affect (every repeat of a slide); -1 when no cue shows them. */
  private degradedEntries(resolved: ResolvedPlaylist, problems: Problem[]): Degraded[] {
    let cues: ReturnType<typeof expandCues> = [];
    try {
      cues = expandCues(resolved);
    } catch {
      /* cue indices unknown: report -1 */
    }
    const out: Degraded[] = [];
    for (const p of problems) {
      const hits = cues.filter((c) =>
        p.slideId
          ? c.presentationId === p.presentationId && c.slideId === p.slideId
          : p.presentationId !== undefined && c.presentationId === p.presentationId,
      );
      const base = {
        reason: p.reason,
        ...(p.presentationId ? { presentationId: p.presentationId } : {}),
        ...(p.slideId ? { slideId: p.slideId } : {}),
      };
      if (!hits.length) out.push({ cueIndex: -1, ...base });
      // A damaged presentation is reported once, at its first cue; a bad slide at every cue showing it.
      else for (const c of p.slideId ? hits : hits.slice(0, 1)) out.push({ cueIndex: c.index, ...base });
    }
    return out.slice(0, DEGRADED_MAX);
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

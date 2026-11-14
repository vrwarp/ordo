/**
 * The live process's view of the library process (design/25 "Hub"): a LiveSource backed by copies.
 *
 * - The **context** (all settings including output tokens, fonts, the logo media) is fetched when the
 *   library comes up and again after a settings, font or media change. It answers output tokens, the
 *   output config, the audio master and message presets.
 * - A **goLive bundle** (the playlist, its stored presentations, the media they reference, fonts, looks) is
 *   fetched when the operator goes live. The last few are kept.
 *
 * Both are persisted in live.db, so a live-process restart while the library process is down still has
 * them: a library outage does not block a reconnect, a GO, or a goLive of a playlist that was fetched
 * before. A goLive of a playlist never fetched is refused with a clear reason until the library is back.
 *
 * goLive and the library's health (design/25, review 2026-11-04 items 12 and 13):
 * - library merely restarting (`starting`/`down`): wait up to UP_WAIT_MS for it before falling back;
 * - library up but silent (stalled) past FETCH_TIMEOUT_MS, or down: a cached copy is used and the goLive
 *   carries a `degraded` entry naming the copy's time, so the operator sees it is not the current playlist;
 * - no cached copy: refused with a reason that says to try again (never "playlist not found").
 */
import {
  DEFAULT_SURFACES,
  type FileRef,
  type Font,
  type GeneralSettings,
  type Look,
  type Media,
  type Output,
} from '@ordo/domain';
import type { OutputConfigRes, Settings } from '@ordo/protocol';
import type { Logger } from 'pino';
import type { DB } from './db.ts';
import { HEADER_INTERNAL } from './http.ts';
import type { ChildState } from './ipc.ts';
import type { Change } from './library.ts';
import { type GoLiveInputs, LiveRejection, type LiveSettings, type LiveSource } from './live.ts';

export type LiveContext = {
  settings: Settings;
  fonts: Font[];
  logo?: Media;
  takenAt: number;
  /** The library sequence the copy reflects (absent from copies saved by older versions). */
  seq?: number;
};
export type GoLiveBundle = {
  playlist: unknown;
  presentations: Record<string, unknown>;
  media: Record<string, Media>;
  /** The geometry files the presentations' shapes name (`ShapeGeom.ref`); absent in a copy saved before them. */
  files?: Record<string, FileRef>;
  fonts: Font[];
  looks: Look[];
  general: GeneralSettings;
  takenAt: number;
};

export const FETCH_TIMEOUT_MS = 1500;
/** How long a goLive waits for a library that is restarting before it falls back to the cached copy. */
export const UP_WAIT_MS = 1500;
const BUNDLES_KEEP = 8;

/** Why the last prepare() of a playlist did not get a fresh copy. */
type Fallback = 'unanswered' | 'down';

/** Does a library change affect the live process's context copy (settings, fonts, the logo media)? */
export function affectsContext(c: Change, logoId: string | undefined): boolean {
  return c.kind === 'settings' || c.kind === 'font' || (c.kind === 'media' && (!logoId || c.id === logoId));
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** The degraded reason for a goLive from a cached copy. */
export function cachedCopyReason(takenAt: number, why: Fallback, now = Date.now()): string {
  const when = new Date(takenAt).toISOString().slice(0, 16).replace('T', ' ');
  const cause = why === 'down' ? 'the library is not running' : 'the library did not answer';
  return `Went live from the copy of this playlist saved ${ago(now - takenAt)} (${when} UTC): ${cause}. Changes made since then are not included; go live again once the library is back.`;
}

export class LibraryLink implements LiveSource {
  private url?: string;
  state: ChildState = 'starting';
  context?: LiveContext;
  private bundles = new Map<string, GoLiveBundle>();
  /** Playlists whose last prepare() fell back (absent: the copy is fresh). */
  private fallbacks = new Map<string, Fallback>();
  private upWaiters = new Set<() => void>();
  private contextListeners: ((prev: LiveContext | undefined, next: LiveContext) => void)[] = [];
  /** Last fetch failure (diagnostics). */
  lastError?: string;

  private db: DB;
  private log: Logger;
  private secret: string;
  private fetcher: typeof fetch;
  constructor(db: DB, log: Logger, secret: string, fetcher: typeof fetch = globalThis.fetch) {
    this.db = db;
    this.log = log;
    this.secret = secret;
    this.fetcher = fetcher;
    this.load();
  }

  onContext(fn: (prev: LiveContext | undefined, next: LiveContext) => void): void {
    this.contextListeners.push(fn);
  }

  /** The supervisor reports where the library process listens (or that it is down). */
  setLibrary(url: string | undefined, state: ChildState): void {
    const changed = url !== this.url || state !== this.state;
    this.url = state === 'up' ? url : undefined;
    this.state = state;
    if (changed && this.url) void this.refreshContext();
    if (this.url || state === 'failed' || state === 'stopped') for (const w of [...this.upWaiters]) w();
  }

  /** Resolve once the library is up, or has failed, or after `ms`. */
  private waitUp(ms: number): Promise<void> {
    if (this.up || this.state === 'failed' || this.state === 'stopped') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.upWaiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      t.unref();
      this.upWaiters.add(done);
    });
  }

  get up(): boolean {
    return !!this.url;
  }

  /** The library's address while it is up (the proxy target). */
  target(): string | undefined {
    return this.url;
  }

  /** Do these library changes affect the context copy (so it must be refreshed before they are broadcast)? */
  affects(changes: Change[]): boolean {
    const logoId = this.context?.settings.general.logoMediaId;
    return changes.some((c) => affectsContext(c, logoId));
  }

  /** Is this one change part of what outputs read from their config? */
  forOutputs(c: Change): boolean {
    return affectsContext(c, this.context?.settings.general.logoMediaId);
  }

  stop(): void {
    for (const w of [...this.upWaiters]) w();
  }

  private async get<T>(path: string): Promise<T | undefined> {
    const base = this.url;
    if (!base) return undefined;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetcher(`${base}${path}`, {
        headers: { [HEADER_INTERNAL]: this.secret },
        signal: ctrl.signal,
      });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastError = undefined;
      return (await res.json()) as T;
    } catch (e) {
      this.lastError = `${path}: ${(e as Error).message}`;
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  async refreshContext(): Promise<boolean> {
    try {
      const ctx = await this.get<Omit<LiveContext, 'takenAt'>>('/internal/context');
      if (!ctx) return false;
      const prev = this.context;
      this.context = { ...ctx, takenAt: Date.now() };
      this.save('context', this.context);
      for (const l of this.contextListeners) l(prev, this.context);
      return true;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'library context fetch failed; keeping the last copy');
      return false;
    }
  }

  /** Fetch the playlist's goLive bundle; on failure the cached copy (if any) stands. Never throws. */
  async prepare(playlistId: string): Promise<void> {
    this.fallbacks.delete(playlistId);
    // A library that is merely restarting is back within about a second: wait for it rather than go live
    // from an old copy (or refuse) needlessly.
    if (!this.up) await this.waitUp(UP_WAIT_MS);
    if (!this.up) {
      this.fallbacks.set(playlistId, 'down');
      if (this.bundles.has(playlistId))
        this.log.warn({ playlistId }, 'library process is down; going live from the cached copy');
      return;
    }
    try {
      const b = await this.get<Omit<GoLiveBundle, 'takenAt'>>(
        `/internal/golive/${encodeURIComponent(playlistId)}`,
      );
      if (!b) {
        this.bundles.delete(playlistId);
        return;
      }
      this.bundles.delete(playlistId);
      this.bundles.set(playlistId, { ...b, takenAt: Date.now() });
      while (this.bundles.size > BUNDLES_KEEP) this.bundles.delete(this.bundles.keys().next().value!);
      this.save('bundles', [...this.bundles.entries()]);
    } catch (e) {
      this.fallbacks.set(playlistId, 'unanswered');
      this.log.warn(
        { playlistId, err: (e as Error).message, cached: this.bundles.has(playlistId) },
        'goLive fetch from the library failed; using the cached copy if there is one',
      );
    }
  }

  goLiveInputs(playlistId: string): GoLiveInputs | undefined {
    const b = this.bundles.get(playlistId);
    // Without prepare() (never on the goLive path) a library that is down still means a cached copy.
    const fallback = this.fallbacks.get(playlistId) ?? (this.up ? undefined : 'down');
    if (!b) {
      if (fallback === 'unanswered')
        throw new LiveRejection('The library did not answer; try Go live again in a moment');
      if (fallback === 'down')
        throw new LiveRejection(
          this.state === 'failed'
            ? 'The library has stopped and this playlist was never live before; restart the hub to go live with it'
            : 'The library is restarting; try Go live again in a moment',
        );
      return undefined;
    }
    return {
      playlist: b.playlist,
      presentation: (id) => b.presentations[id],
      media: (id) => b.media[id],
      file: (hash) => (b.files && Object.hasOwn(b.files, hash) ? b.files[hash] : undefined),
      fonts: () => b.fonts,
      looks: b.looks,
      general: b.general,
      takenAt: b.takenAt,
      ...(fallback ? { cachedCopy: cachedCopyReason(b.takenAt, fallback) } : {}),
    };
  }

  settings(): LiveSettings {
    return {
      outputs: this.context?.settings.outputs ?? [],
      surfaces: this.context?.settings.surfaces ?? DEFAULT_SURFACES,
    };
  }

  outputs(): Output[] {
    return this.context?.settings.outputs ?? [];
  }

  outputConfig(outputId: string): OutputConfigRes | undefined {
    const c = this.context;
    const output = c?.settings.outputs.find((o) => o.id === outputId);
    if (!c || !output) return undefined;
    const { token: _t, ...out } = output;
    return {
      output: out,
      looks: c.settings.looks,
      audio: c.settings.audio,
      general: c.settings.general,
      logo: c.logo,
      fonts: c.fonts,
    };
  }

  private save(key: string, value: unknown): void {
    try {
      this.db
        .prepare(`INSERT OR REPLACE INTO live_kv (key, json, saved_at) VALUES (?, ?, ?)`)
        .run(key, JSON.stringify(value), Date.now());
    } catch (e) {
      this.log.warn({ key, err: (e as Error).message }, 'could not persist the library copy');
    }
  }

  private load(): void {
    const read = (key: string): unknown => {
      try {
        const r = this.db.prepare(`SELECT json FROM live_kv WHERE key = ?`).get(key) as
          | { json: string }
          | undefined;
        return r ? JSON.parse(r.json) : undefined;
      } catch {
        return undefined;
      }
    };
    const ctx = read('context') as LiveContext | undefined;
    if (ctx && typeof ctx === 'object' && ctx.settings && Array.isArray(ctx.settings.outputs))
      this.context = ctx;
    const b = read('bundles');
    if (Array.isArray(b))
      for (const e of b)
        if (Array.isArray(e) && typeof e[0] === 'string' && e[1] && typeof e[1] === 'object')
          this.bundles.set(e[0], e[1] as GoLiveBundle);
  }
}

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
 */
import {
  DEFAULT_SURFACES,
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

export type LiveContext = { settings: Settings; fonts: Font[]; logo?: Media; takenAt: number };
export type GoLiveBundle = {
  playlist: unknown;
  presentations: Record<string, unknown>;
  media: Record<string, Media>;
  fonts: Font[];
  looks: Look[];
  general: GeneralSettings;
  takenAt: number;
};

const FETCH_TIMEOUT_MS = 1500;
const BUNDLES_KEEP = 8;

export class LibraryLink implements LiveSource {
  private url?: string;
  state: ChildState = 'starting';
  context?: LiveContext;
  private bundles = new Map<string, GoLiveBundle>();
  private refreshTimer?: NodeJS.Timeout;
  private contextListeners: ((prev: LiveContext | undefined, next: LiveContext) => void)[] = [];
  /** Last fetch failure (diagnostics). */
  lastError?: string;

  constructor(
    private db: DB,
    private log: Logger,
    private secret: string,
    private fetcher: typeof fetch = globalThis.fetch,
  ) {
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
  }

  get up(): boolean {
    return !!this.url;
  }

  /** The library's address while it is up (the proxy target). */
  target(): string | undefined {
    return this.url;
  }

  /** Library changes relayed by the supervisor: refresh the context when it is affected. */
  onChanges(changes: Change[]): void {
    const logoId = this.context?.settings.general.logoMediaId;
    if (
      changes.some(
        (c) =>
          c.kind === 'settings' || c.kind === 'font' || (c.kind === 'media' && (!logoId || c.id === logoId)),
      )
    )
      this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refreshContext(), 50);
    this.refreshTimer.unref();
  }

  stop(): void {
    clearTimeout(this.refreshTimer);
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
    if (!this.up) {
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
      this.log.warn(
        { playlistId, err: (e as Error).message, cached: this.bundles.has(playlistId) },
        'goLive fetch from the library failed; using the cached copy if there is one',
      );
    }
  }

  goLiveInputs(playlistId: string): GoLiveInputs | undefined {
    const b = this.bundles.get(playlistId);
    if (!b) {
      if (!this.up) throw new LiveRejection('The library is restarting; try GO live again in a moment');
      return undefined;
    }
    return {
      playlist: b.playlist,
      presentation: (id) => b.presentations[id],
      media: (id) => b.media[id],
      fonts: () => b.fonts,
      looks: b.looks,
      general: b.general,
      takenAt: b.takenAt,
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

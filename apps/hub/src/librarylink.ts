/**
 * The live process's view of the library process (design/25 "Hub"): a LiveSource backed by copies.
 *
 * - The **context** (all settings including output tokens, fonts, the logo media) is fetched when the
 *   library comes up and again after a settings, font or media change. It answers output tokens, the
 *   output config, the audio master and message presets.
 * - A **goLive bundle** (the playlist, its stored presentations, the media they reference, fonts, looks) is
 *   fetched when the operator goes live, beside the running service (design/29 §2.3 M8): FETCH_TIMEOUT_MS to
 *   the response headers, then the body for as long as it keeps arriving (no bytes for PROGRESS_TIMEOUT_MS
 *   ends it) under BUNDLE_CEILING_MS. It is kept as the JSON bytes the library sent (never parsed on this
 *   loop: golive-worker.ts checks it); the last BUNDLES_KEEP are kept, one live_kv row each (`bundle:<id>`,
 *   its saved_at the time the copy was taken), written after the goLive applied.
 *
 * Both are persisted in live.db, so a live-process restart while the library process is down still has
 * them: a library outage does not block a reconnect, a GO, or a goLive of a playlist that was fetched
 * before. A goLive of a playlist never fetched is refused with a clear reason until the library is back.
 *
 * goLive and the library's health (design/25, review 2026-11-04 items 12 and 13):
 * - library merely restarting (`starting`/`down`): wait up to UP_WAIT_MS for it before falling back;
 * - library up but silent (stalled) past FETCH_TIMEOUT_MS or PROGRESS_TIMEOUT_MS, past the ceiling, or down:
 *   a cached copy is used and the goLive carries a `degraded` entry naming the copy's time, so the operator
 *   sees it is not the current playlist (the operator may also choose the saved copy after 5 s, W41);
 * - no cached copy: refused with a reason that says to try again (never "playlist not found").
 */
import {
  DEFAULT_SURFACES,
  type Font,
  GOLIVE_MAX_BYTES,
  type Media,
  type Output,
  resolvedSizeRefusal,
} from '@ordo/domain';
import type { OutputConfigRes, Settings } from '@ordo/protocol';
import type { Logger } from 'pino';
import type { DB } from './db.ts';
import { bundleInputs, type GoLiveBundle } from './golive-worker.ts';
import { HEADER_INTERNAL } from './http.ts';
import type { ChildState } from './ipc.ts';
import type { Change } from './library.ts';
import {
  type BundleOptions,
  type GoLiveInputs,
  LiveRejection,
  type LiveSettings,
  type LiveSource,
  type RawBundle,
} from './live.ts';

export type { GoLiveBundle };

export type LiveContext = {
  settings: Settings;
  fonts: Font[];
  logo?: Media;
  takenAt: number;
  /** The library sequence the copy reflects (absent from copies saved by older versions). */
  seq?: number;
};

/** The library has this long to answer a request with its headers (the context's body too). */
export const FETCH_TIMEOUT_MS = 1500;
/** A goLive bundle's body that sends no bytes for this long is given up (design/29 M8). */
export const PROGRESS_TIMEOUT_MS = 1500;
/** However long it keeps sending, a goLive bundle is given up after this (design/29 M8). */
export const BUNDLE_CEILING_MS = 30_000;
/** A bundle larger than this is never read whole: its service would be refused at goLive (W58). */
export const BUNDLE_MAX_BYTES = 2 * GOLIVE_MAX_BYTES;
/** The longest stretch of body chunks read without letting the live loop turn (design/29 M8). */
const YIELD_MS = 2;
/** How long a goLive waits for a library that is restarting before it falls back to the cached copy. */
export const UP_WAIT_MS = 1500;
const BUNDLES_KEEP = 8;
/** live_kv key of a cached bundle. */
const BUNDLE_KEY = 'bundle:';
/** The single row of every cached bundle that versions before design/29 M8 wrote; read once and replaced. */
const LEGACY_BUNDLES_KEY = 'bundles';

/** Why the last prepare() of a playlist did not get a fresh copy. */
type Fallback = 'unanswered' | 'down';

/** A cached bundle: the JSON bytes the library sent (shared with the check's worker), when it was taken. */
type StoredBundle = { bytes: Uint8Array; takenAt: number; saved: boolean };

/** Fetch timings (tests shorten them). */
export type FetchTiming = { headerMs: number; progressMs: number; ceilingMs: number };

/** Bytes in a SharedArrayBuffer, so the check's worker reads them without a copy on the live loop. */
function shared(bytes: Uint8Array): Uint8Array {
  if (bytes.buffer instanceof SharedArrayBuffer) return bytes;
  const out = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}

/** Collects a body's chunks into shared memory as they arrive (in place when its length is announced). */
class SharedSink {
  length = 0;
  private buf?: Uint8Array;
  private chunks: Uint8Array[] = [];
  constructor(total: number | undefined) {
    if (total && total > 0) this.buf = new Uint8Array(new SharedArrayBuffer(total));
  }
  push(c: Uint8Array): void {
    if (this.buf && this.length + c.byteLength <= this.buf.byteLength) this.buf.set(c, this.length);
    else {
      // More than announced: keep the rest as chunks and join them at the end.
      if (this.buf) {
        this.chunks.push(this.buf.subarray(0, this.length));
        this.buf = undefined;
      }
      this.chunks.push(c);
    }
    this.length += c.byteLength;
  }
  bytes(): Uint8Array {
    if (this.buf) return this.buf.subarray(0, this.length);
    const out = new Uint8Array(new SharedArrayBuffer(this.length));
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

/**
 * The settings fields that name a media item the outputs' config depends on (design/28 §3.4): the logo and
 * each look's holding image. phones-context.test.ts walks the settings schemas and fails on a `*MediaId` field
 * missing here.
 */
export const CONTEXT_MEDIA_FIELDS = ['general.logoMediaId', 'looks[].holdingMediaId'] as const;

/** Every media id the settings name (CONTEXT_MEDIA_FIELDS). */
export function contextMediaIds(
  settings:
    | { general?: { logoMediaId?: string }; looks?: readonly { holdingMediaId?: string }[] }
    | undefined,
): Set<string> {
  const out = new Set<string>();
  const logo = settings?.general?.logoMediaId;
  if (logo) out.add(logo);
  for (const l of settings?.looks ?? []) if (l?.holdingMediaId) out.add(l.holdingMediaId);
  return out;
}

/**
 * Does a library change affect the live process's context copy and the outputs' config: a settings or font
 * change, or a change to a media item the settings name (the logo, a holding image). Before P0 every media
 * change counted when no logo was set, so a photo upload made every output refetch its config three times.
 */
export function affectsContext(c: Change, mediaIds: ReadonlySet<string>): boolean {
  return c.kind === 'settings' || c.kind === 'font' || (c.kind === 'media' && mediaIds.has(c.id));
}

/**
 * Settings keys the live process reads (its context copy) but outputs never do: their changes refresh the copy
 * and reach no output socket. `phones` (design/28): toggling the switch sent every output a library delta and a
 * mid-service /output/config refetch (review of P0); the live process needs it for the x-ordo check.
 */
export const SETTINGS_NOT_FOR_OUTPUTS: ReadonlySet<string> = new Set(['phones']);

/** Is a library change part of what outputs read from their config (`affectsContext` less the keys above)? */
export function forOutputs(c: Change, mediaIds: ReadonlySet<string>): boolean {
  if (c.kind === 'settings' && SETTINGS_NOT_FOR_OUTPUTS.has(c.id)) return false;
  return affectsContext(c, mediaIds);
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
  private bundles = new Map<string, StoredBundle>();
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
  private timing: FetchTiming;
  constructor(
    db: DB,
    log: Logger,
    secret: string,
    fetcher: typeof fetch = globalThis.fetch,
    timing: Partial<FetchTiming> = {},
  ) {
    this.db = db;
    this.log = log;
    this.secret = secret;
    this.fetcher = fetcher;
    this.timing = {
      headerMs: FETCH_TIMEOUT_MS,
      progressMs: PROGRESS_TIMEOUT_MS,
      ceilingMs: BUNDLE_CEILING_MS,
      ...timing,
    };
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

  /** The media ids the current context's settings name, computed once per context copy. */
  private mediaIdsOf: { context?: LiveContext; ids: ReadonlySet<string> } = { ids: new Set() };
  private contextMedia(): ReadonlySet<string> {
    if (this.mediaIdsOf.context !== this.context)
      this.mediaIdsOf = { context: this.context, ids: contextMediaIds(this.context?.settings) };
    return this.mediaIdsOf.ids;
  }

  /** Do these library changes affect the context copy (so it must be refreshed before they are broadcast)? */
  affects(changes: Change[]): boolean {
    const ids = this.contextMedia();
    return changes.some((c) => affectsContext(c, ids));
  }

  /** Is this one change part of what outputs read from their config? */
  forOutputs(c: Change): boolean {
    return forOutputs(c, this.contextMedia());
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

  /**
   * The goLive bundle's bytes, fetched by progress (design/29 M8): FETCH_TIMEOUT_MS to the headers, then the body
   * while bytes keep arriving (PROGRESS_TIMEOUT_MS) under BUNDLE_CEILING_MS. Throws on any failure (the reason
   * as the message); undefined when the library does not know the playlist. Aborted by `signal`.
   */
  private async fetchBundle(playlistId: string, opts: BundleOptions): Promise<Uint8Array | undefined> {
    const base = this.url;
    if (!base) throw new Error('the library is not running');
    const path = `/internal/golive/${encodeURIComponent(playlistId)}`;
    const ctrl = new AbortController();
    let why = '';
    const abort = (reason: string) => {
      if (ctrl.signal.aborted) return;
      why = reason;
      ctrl.abort();
    };
    const onCancel = () => abort('cancelled');
    opts.signal?.addEventListener('abort', onCancel);
    if (opts.signal?.aborted) onCancel();
    const { headerMs, progressMs, ceilingMs } = this.timing;
    let quiet = setTimeout(() => abort(`no answer within ${headerMs / 1000} s`), headerMs);
    const ceiling = setTimeout(() => abort(`not complete within ${ceilingMs / 1000} s`), ceilingMs);
    try {
      const res = await this.fetcher(`${base}${path}`, {
        headers: { [HEADER_INTERNAL]: this.secret },
        signal: ctrl.signal,
      });
      clearTimeout(quiet);
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const announced = Number(res.headers.get('content-length')) || undefined;
      if (announced && announced > BUNDLE_MAX_BYTES) throw new BundleTooLarge(announced);
      // One watchdog for the whole body (not a timer per chunk): it fires every PROGRESS_TIMEOUT_MS and gives
      // up only when no byte came in that long.
      let lastByte = Date.now();
      const watch = () => {
        const quietFor = Date.now() - lastByte;
        if (quietFor >= progressMs) abort(`no data for ${progressMs / 1000} s`);
        else quiet = setTimeout(watch, progressMs - quietFor);
      };
      quiet = setTimeout(watch, progressMs);
      const sink = new SharedSink(announced);
      const reader = res.body.getReader();
      // Chunks that arrive in a burst are read in slices of at most YIELD_MS, the loop free between them, so
      // a GO arriving meanwhile is never held behind the copy.
      let slice = performance.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sink.push(value);
        if (sink.length > BUNDLE_MAX_BYTES) {
          ctrl.abort();
          throw new BundleTooLarge(sink.length);
        }
        lastByte = Date.now();
        opts.onProgress?.(sink.length, announced);
        if (performance.now() - slice > YIELD_MS) {
          await new Promise((r) => setImmediate(r));
          slice = performance.now();
        }
      }
      this.lastError = undefined;
      return sink.bytes();
    } catch (e) {
      if (e instanceof BundleTooLarge) throw e;
      const message = why || (e as Error).message;
      this.lastError = `${path}: ${message}`;
      throw new Error(message);
    } finally {
      clearTimeout(quiet);
      clearTimeout(ceiling);
      opts.signal?.removeEventListener('abort', onCancel);
    }
  }

  /**
   * The playlist's goLive bundle (LiveSource.bundle, design/29 M8): a fresh copy from the library, or the
   * cached copy with the reason the goLive carries when the library is down or does not answer in time (or
   * `saved`: the operator chose the saved copy). Undefined: the library does not know the playlist. Throws
   * LiveRejection when there is no copy to go live from, or a bundle past BUNDLE_MAX_BYTES (W58).
   */
  async bundle(playlistId: string, opts: BundleOptions = {}): Promise<RawBundle | undefined> {
    if (opts.saved && this.bundles.has(playlistId)) return this.cached(playlistId, 'unanswered');
    this.fallbacks.delete(playlistId);
    // A library that is merely restarting is back within about a second: wait for it rather than go live
    // from an old copy (or refuse) needlessly.
    if (!this.up) await this.waitUp(UP_WAIT_MS);
    if (!this.up) {
      this.fallbacks.set(playlistId, 'down');
      if (this.bundles.has(playlistId))
        this.log.warn({ playlistId }, 'library process is down; going live from the cached copy');
      return this.cached(playlistId, 'down');
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.fetchBundle(playlistId, opts);
    } catch (e) {
      if (e instanceof BundleTooLarge) throw new LiveRejection(resolvedSizeRefusal(e.bytes) ?? e.message);
      if (opts.signal?.aborted) throw e;
      this.fallbacks.set(playlistId, 'unanswered');
      this.log.warn(
        { playlistId, err: (e as Error).message, cached: this.bundles.has(playlistId) },
        'goLive fetch from the library failed; using the cached copy if there is one',
      );
      return this.cached(playlistId, 'unanswered');
    }
    if (!bytes) {
      this.forget(playlistId);
      return undefined;
    }
    const takenAt = Date.now();
    this.bundles.delete(playlistId);
    this.bundles.set(playlistId, { bytes, takenAt, saved: false });
    while (this.bundles.size > BUNDLES_KEEP) this.forget(this.bundles.keys().next().value!);
    return { bytes, takenAt };
  }

  /** The cached copy of a playlist with the reason a goLive from it carries; LiveRejection without one. */
  private cached(playlistId: string, why: Fallback): RawBundle {
    const b = this.bundles.get(playlistId);
    if (!b) {
      if (why === 'unanswered')
        throw new LiveRejection('The library did not answer; try Go live again in a moment');
      throw new LiveRejection(
        this.state === 'failed'
          ? 'The library has stopped and this playlist was never live before; restart the hub to go live with it'
          : 'The library is restarting; try Go live again in a moment',
      );
    }
    return { bytes: b.bytes, takenAt: b.takenAt, cachedCopy: cachedCopyReason(b.takenAt, why) };
  }

  /** When the cached copy of a playlist was taken (the operator's "Go live from the copy saved ..."). */
  savedAt(playlistId: string): number | undefined {
    return this.bundles.get(playlistId)?.takenAt;
  }

  /**
   * A goLive of this playlist applied (design/29 A18): its fresh copy becomes its own live_kv row, written
   * after the goLive and its broadcast, never on the goLive's path.
   */
  applied(playlistId: string): void {
    const b = this.bundles.get(playlistId);
    if (!b || b.saved) return;
    b.saved = true;
    setImmediate(() => {
      if (this.bundles.get(playlistId) !== b) return;
      try {
        this.db
          .prepare(`INSERT OR REPLACE INTO live_kv (key, json, saved_at) VALUES (?, ?, ?)`)
          .run(
            `${BUNDLE_KEY}${playlistId}`,
            Buffer.from(b.bytes.buffer, b.bytes.byteOffset, b.bytes.byteLength),
            b.takenAt,
          );
      } catch (e) {
        b.saved = false;
        this.log.warn({ playlistId, err: (e as Error).message }, 'could not persist the goLive copy');
      }
    });
  }

  /** Drop a cached bundle and its row. */
  private forget(playlistId: string): void {
    if (!this.bundles.delete(playlistId)) return;
    try {
      this.db.prepare(`DELETE FROM live_kv WHERE key = ?`).run(`${BUNDLE_KEY}${playlistId}`);
    } catch (e) {
      this.log.warn({ playlistId, err: (e as Error).message }, 'could not remove a cached goLive copy');
    }
  }

  /** Fetch the playlist's goLive bundle into the cache; on failure the cached copy (if any) stands. Never throws. */
  async prepare(playlistId: string): Promise<void> {
    await this.bundle(playlistId).catch(() => undefined);
  }

  /**
   * The cached bundle as goLive inputs, parsed here (tests and diagnostics; a goLive goes through `bundle()`
   * and the check's worker).
   */
  goLiveInputs(playlistId: string): GoLiveInputs | undefined {
    const b = this.bundles.get(playlistId);
    // Without prepare() a library that is down still means a cached copy.
    const fallback = this.fallbacks.get(playlistId) ?? (this.up ? undefined : 'down');
    if (!b) {
      if (fallback) this.cached(playlistId, fallback);
      return undefined;
    }
    const parsed = JSON.parse(new TextDecoder().decode(b.bytes)) as Omit<GoLiveBundle, 'takenAt'>;
    return bundleInputs(parsed, {
      takenAt: b.takenAt,
      ...(fallback ? { cachedCopy: cachedCopyReason(b.takenAt, fallback) } : {}),
    });
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
    // The single row older versions kept (every copy re-serialised on each goLive): one row per copy now.
    const legacy = read(LEGACY_BUNDLES_KEY);
    if (Array.isArray(legacy)) {
      const encoder = new TextEncoder();
      for (const e of legacy)
        if (Array.isArray(e) && typeof e[0] === 'string' && e[1] && typeof e[1] === 'object') {
          const { takenAt, ...rest } = e[1] as GoLiveBundle;
          const at = typeof takenAt === 'number' && Number.isFinite(takenAt) ? takenAt : 0;
          this.bundles.set(e[0], {
            bytes: shared(encoder.encode(JSON.stringify(rest))),
            takenAt: at,
            saved: false,
          });
        }
      for (const id of [...this.bundles.keys()]) this.applied(id);
      try {
        this.db.prepare(`DELETE FROM live_kv WHERE key = ?`).run(LEGACY_BUNDLES_KEY);
      } catch {
        /* read again next start */
      }
    }
    try {
      const rows = this.db
        .prepare(`SELECT key, json, saved_at FROM live_kv WHERE key LIKE 'bundle:%' ORDER BY saved_at`)
        .all() as { key: string; json: unknown; saved_at: number }[];
      for (const r of rows) {
        const id = r.key.slice(BUNDLE_KEY.length);
        const raw = r.json;
        const bytes =
          raw instanceof Uint8Array
            ? raw
            : typeof raw === 'string'
              ? new TextEncoder().encode(raw)
              : undefined;
        if (!id || !bytes || this.bundles.has(id)) continue;
        this.bundles.set(id, { bytes: shared(bytes), takenAt: r.saved_at, saved: true });
      }
    } catch {
      /* no copies */
    }
    while (this.bundles.size > BUNDLES_KEEP) this.forget(this.bundles.keys().next().value!);
  }
}

/** A goLive bundle past BUNDLE_MAX_BYTES: never read whole. */
class BundleTooLarge extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`the playlist is too large to go live (${bytes} bytes)`);
    this.bytes = bytes;
  }
}

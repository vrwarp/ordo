/**
 * The stage link worker's logic (design/16, design/25), separated from the worker bootstrap so it runs in
 * Node tests with fakes: live link, config, flip timing, fonts from the service cache, the view model,
 * IndexedDB persistence, invariant checks and health.
 */
import { type FileStore, fillCache } from '@ordo/cache';
import { clock as defaultClock, fileUrl, type HubClock, type OutputLink } from '@ordo/client';
import {
  DEFAULT_GENERAL,
  type Font,
  type LiveState,
  type Look,
  type ManifestFile,
  type SlideContent,
} from '@ordo/domain';
import { checkInvariants, isLiveStateShape } from '@ordo/live-state';
import { APP_VERSION, type OutputConfigRes, type OutputHealth } from '@ordo/protocol';
import { flipDelay, resolveStageLook, stageFontFamilies, stageLayout } from './model.ts';
import type { FontPayload, HostStats, LinkToMain, StageView } from './protocol.ts';
import { buildView, viewSignature } from './view.ts';

export type KV = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
};

export type CoreDeps = {
  link: OutputLink;
  json: KV;
  store: FileStore;
  post: (m: LinkToMain, transfer?: Transferable[]) => void;
  loadConfig: () => Promise<OutputConfigRes>;
  /** Fetch a file from the hub (default: `fetch(fileUrl(hash))`). */
  fetchHub?: (hash: string) => Promise<Blob>;
  clock?: HubClock;
  /** Wall clock for intervals and the watchdog (tests inject a fake). */
  now?: () => number;
  testMode?: boolean;
  /** Fonts already in the host's document.fonts. */
  loadedFonts?: string[];
};

/** The state is saved at most this often while it changes. */
const SAVE_DEBOUNCE_MS = 500;
const LOG_MAX = 50;
/** Fonts that failed to download are tried again after this long. */
const FONT_RETRY_MS = 10_000;

/**
 * Owns everything of the stage window that is not DOM. Posts `view` whenever what the stage draws
 * changes (state, flip, config, or the clock text on the quarter-second tick).
 */
export class StageLinkCore {
  readonly link: OutputLink;
  private config?: OutputConfigRes;
  private shown: SlideContent | null = null;
  private shownSeq = -1;
  private flipTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAt = 0;
  private lateFlips = 0;
  private cache = { ready: 0, total: 0 };
  private fontsSig = '';
  private sentFonts = new Set<string>();
  private loadedFonts: Set<string>;
  private fontRetry: ReturnType<typeof setTimeout> | null = null;
  private lastError?: string;
  private lastViewSig = '';
  private lastView?: StageView;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private intervals: ReturnType<typeof setInterval>[] = [];
  private host: HostStats = { presented: 0, missed: 0, fps: 0, longTasks: 0, workers: [], fontErrors: [] };
  /** When the host's last 250 ms watchdog tick arrived, and the longest gap since the last health. */
  private lastTick: number;
  private maxStall = 0;
  /** The value sent in the last health (diagnostics shows it). */
  private reportedStall = 0;
  private log: string[] = [];
  private gaps = 0;
  private resyncPending = false;
  private invariantResyncs = 0;
  private offlineStart = false;
  private lastGapResync = 0;
  /** The spent resync budget was logged (once until a state applies again). */
  private budgetLogged = false;
  /** The last state that passed the invariant checks: what the stage draws. */
  private good: LiveState;
  private hasGood = false;
  private readonly clock: HubClock;
  private readonly now: () => number;
  private stopped = false;

  constructor(private deps: CoreDeps) {
    this.link = deps.link;
    this.clock = deps.clock ?? defaultClock;
    this.now = deps.now ?? (() => Date.now());
    this.loadedFonts = new Set(deps.loadedFonts ?? []);
    this.lastTick = this.now();
    this.good = deps.link.state;
  }

  diagLog(line: string): void {
    const ts = new Date(this.now()).toISOString().slice(11, 19);
    this.log.push(`${ts} ${line}`.slice(0, 300));
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }

  get outputId(): string {
    return this.link.outputId;
  }

  /** Paint from IndexedDB first (offline start), then connect. */
  async start(reloadReason?: string): Promise<void> {
    if (reloadReason) this.diagLog(`window reloaded itself: ${reloadReason}`);
    const link = this.link;
    link.mirror.on('change', ({ event }) => this.onState(!event));
    link.mirror.on('gap', ({ have, got, reason }) => {
      this.gaps++;
      // A rejected delta already asked (OutputLink); a rejected full state has not: ask, rate-limited and
      // within the link's resync budget. Past the budget the last good view stays and health says why.
      if (reason !== 'malformed-state') {
        this.diagLog(`live state ${reason} (have ${have}, got ${got}): resync`);
        return;
      }
      if (this.now() - this.lastGapResync <= 500) return;
      this.lastGapResync = this.now();
      const asked = link.requestResync();
      if (asked) this.diagLog(`malformed live state (have ${have}, got ${got}): resync`);
      else if (!this.budgetLogged) {
        this.budgetLogged = true;
        this.diagLog(link.resyncError ?? 'resync budget spent');
      }
    });
    link.mirror.on('change', () => {
      this.budgetLogged = false;
    });
    link.on('bus', ({ bus, reason }) => {
      this.diagLog(`bus ${bus}${reason ? ` (${reason})` : ''}`);
      if (bus === 'hub') void this.loadConfig();
      this.publish();
    });
    link.on('library', (m) => {
      if (m.changes.some((c) => c.kind === 'settings' || c.kind === 'font')) void this.loadConfig();
    });
    link.hub.on('welcome', () => void this.loadConfig());
    link.hub.on('bye', (m) => {
      this.diagLog(`hub said bye: ${m.reason}`);
      // Inside a worker HubConnection cannot reload the page: the host does.
      if (m.reason === 'version') this.deps.post({ t: 'reload', reason: 'new app version' });
      if (m.reason === 'superseded') {
        this.stop();
        this.deps.post({ t: 'close', reason: 'superseded' });
      }
    });

    // Offline start: the last config and state from IndexedDB, before any connection.
    const [cfg, saved, held] = await Promise.all([
      this.deps.json.get<OutputConfigRes>(`config:${this.outputId}`).catch(() => undefined),
      this.deps.json.get<{ state: LiveState }>(`state:${this.outputId}`).catch(() => undefined),
      this.deps.json.get<{ at: number }>(`held:${this.outputId}`).catch(() => undefined),
    ]);
    if (this.stopped) return;
    // See the output's link core: a held service survives a reload, for at most a service day.
    if (held && typeof held.at === 'number' && Date.now() - held.at < 8 * 60 * 60 * 1000)
      link.restoreHeld(true);
    link.on('held', ({ held: on, refresh }) => {
      if (!refresh)
        this.diagLog(
          on ? 'the operator holds this service (started without the hub)' : 'operator hold released',
        );
      void this.deps.json.set(`held:${this.outputId}`, on ? { at: this.now() } : null).catch(() => undefined);
    });
    if (cfg && !this.config) this.applyConfig(cfg);
    if (saved?.state && !link.mirror.ready && isLiveStateShape(saved.state)) {
      const bad = checkInvariants(saved.state);
      if (bad.length) this.diagLog(`cached state violates invariants (${bad[0]}); not painted`);
      else {
        this.offlineStart = true;
        link.mirror.applyState(saved.state);
        this.diagLog(`painted cached state seq ${saved.state.seq}`);
      }
    }
    link.start();
    void this.loadConfig();
    this.intervals.push(setInterval(() => this.sendHealth(), 1000));
    this.intervals.push(setInterval(() => this.postDiag(), 1000));
    this.scheduleTick();
    this.publish();
  }

  stop(): void {
    this.stopped = true;
    this.link.stop();
    for (const t of this.intervals) clearInterval(t);
    for (const t of [this.flipTimer, this.saveTimer, this.tickTimer, this.expiryTimer, this.fontRetry])
      if (t) clearTimeout(t);
  }

  // ---- host input ----

  onHost(stats: HostStats): void {
    this.host = stats;
    for (const e of stats.fontErrors) {
      this.lastError = e;
      this.diagLog(e);
    }
  }

  /** The host's 250 ms main-thread tick. */
  onTick(): void {
    this.sampleStall();
    this.lastTick = this.now();
  }

  /** The gap since the last tick counts too: a main thread stalled right now has sent nothing. */
  private sampleStall(): void {
    this.maxStall = Math.max(this.maxStall, this.now() - this.lastTick);
  }

  onFontAck(hash: string, ok: boolean, error?: string): void {
    if (ok) this.loadedFonts.add(hash);
    else {
      this.sentFonts.delete(hash);
      this.lastError = `font ${hash.slice(0, 8)}: ${error ?? 'could not be added'}`;
      this.diagLog(this.lastError);
    }
  }

  setOpenerClosed(closed: boolean): void {
    const fb = this.link.fallback;
    if (fb && fb.openerClosed !== closed) {
      fb.openerClosed = closed;
      this.diagLog(closed ? 'opener window closed' : 'opener window back');
      this.link.watchFallback();
    }
  }

  /** Test hook: feed a message as if the hub sent it; malformed ones must resync, never crash. */
  injectFromHub(kind: 'delta' | 'state', msg: unknown): void {
    this.diagLog(`chaos: injected ${kind}`);
    if (kind === 'delta') this.link.hub.emit('delta', msg as never);
    else this.link.hub.emit('state', msg as never);
  }

  /** Test hook: the current state with its live cue out of range, as if the hub sent it. */
  injectBadState(): void {
    const s = this.link.state;
    const bad = { ...s, seq: s.seq + 1, live: s.cues.length + 5 };
    this.injectFromHub('state', { t: 'live.state', v: 1, seq: bad.seq, state: bad });
  }

  // ---- config ----

  private async loadConfig(): Promise<void> {
    try {
      const cfg = await this.deps.loadConfig();
      if (this.stopped) return;
      this.applyConfig(cfg);
      void this.deps.json.set(`config:${this.outputId}`, cfg).catch(() => undefined);
      if (this.lastError?.startsWith('config:')) this.lastError = undefined;
    } catch (e) {
      this.lastError = `config: ${(e as Error).message}`;
    }
  }

  private applyConfig(cfg: OutputConfigRes): void {
    this.config = cfg;
    this.ensureFonts();
    this.publish();
  }

  private look(): Look {
    return resolveStageLook(this.config?.output.lookId, this.config?.looks, this.good.resolved?.looks);
  }

  // ---- live state ----

  /** Apply a new live state: check invariants, schedule the slide flip at the layer's `at`, persist. */
  private onState(fullState: boolean): void {
    if (!this.checkState(fullState)) return;
    const s = this.link.state;
    this.good = s;
    this.hasGood = true;
    const layer = s.layers.slide;
    if (layer.seq !== this.shownSeq || (layer.content === null) !== (this.shown === null)) {
      this.shownSeq = layer.seq;
      const content = layer.content;
      const delay = flipDelay(layer.at, this.clock.now());
      if (this.flipTimer) clearTimeout(this.flipTimer);
      this.flipTimer = null;
      if (delay <= 0 || !Number.isFinite(delay)) this.shown = content;
      else {
        this.pendingAt = layer.at;
        this.flipTimer = setTimeout(
          () => {
            this.flipTimer = null;
            if (this.clock.now() - this.pendingAt > 50) this.lateFlips++;
            this.shown = content;
            this.publish();
          },
          Math.min(delay, 10_000),
        );
      }
    }
    if (this.shown && !s.cues[this.shown.cueIndex]) this.shown = null;
    this.ensureFonts();
    this.publish();
    this.scheduleSave();
  }

  /**
   * Invariants as code (design/25): every applied state is checked. A violation asks for a full state; if
   * the full state that answers it still violates, the window reloads (crash-only restart). Returns false
   * while the state is not trustworthy (the last good view stays on screen).
   */
  private checkState(fullState: boolean): boolean {
    const bad = checkInvariants(this.link.state);
    if (bad.length === 0) {
      if (fullState) this.resyncPending = false;
      return true;
    }
    if (this.resyncPending && fullState) {
      this.diagLog(`invariants still violated after a resync (${bad[0]}): reloading`);
      this.resyncPending = false;
      this.deps.post({ t: 'reload', reason: `live state invariants: ${bad[0]}` });
    } else if (!this.resyncPending) {
      this.resyncPending = true;
      this.invariantResyncs++;
      this.diagLog(`live state invariant violated (${bad.join('; ').slice(0, 200)}): resync`);
      this.resync();
    }
    return false;
  }

  private resync(): void {
    const fb = this.link.fallback;
    if (this.link.bus === 'fallback' && fb) fb.ready(-1);
    else this.link.hub.send({ t: 'live.resync' });
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const state = this.good;
      if (!this.hasGood) return;
      this.deps.json.set(`state:${this.outputId}`, { state, savedAt: this.now() }).catch((e: Error) => {
        this.diagLog(`state not saved: ${e.message}`);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  // ---- view ----

  /** Post the view when it changed. */
  publish(): void {
    if (this.stopped) return;
    const g = this.config?.general ?? DEFAULT_GENERAL;
    const look = this.look();
    const view = buildView({
      state: this.good,
      ready: this.hasGood,
      shown: this.shown,
      layout: stageLayout(look),
      general: { timeZone: g.timeZone, clock24h: g.clock24h },
      bus: this.link.bus,
      now: this.clock.now(),
      title: this.config?.output.name,
      clockOffset: this.clock.offset,
      clockFallback: this.clock.fallback,
    });
    const sig = viewSignature(view);
    if (sig === this.lastViewSig) return;
    this.lastViewSig = sig;
    this.lastView = view;
    this.deps.post({ t: 'view', view });
    this.scheduleExpiry();
  }

  get view(): StageView | undefined {
    return this.lastView;
  }

  /** Re-publish on every quarter second, aligned so the clock flips on the second. */
  private scheduleTick(): void {
    if (this.stopped) return;
    const n = this.clock.now();
    this.tickTimer = setTimeout(
      () => {
        this.publish();
        this.scheduleTick();
      },
      250 - (((n % 250) + 250) % 250) + 2,
    );
  }

  /** Wake exactly at the next message expiry instead of waiting for the tick. */
  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const now = this.clock.now();
    let t: number | undefined;
    for (const m of this.good.messages ?? [])
      if (m.expiresAt !== undefined && m.expiresAt > now && (t === undefined || m.expiresAt < t))
        t = m.expiresAt;
    if (t === undefined) return;
    this.expiryTimer = setTimeout(() => this.publish(), Math.min(t - now, 60_000) + 5);
  }

  // ---- fonts ----

  private fontsFor(): Font[] {
    const families = stageFontFamilies(stageLayout(this.look()));
    const all = [...(this.config?.fonts ?? []), ...(this.good.resolved?.fonts ?? [])];
    const byHash = new Map<string, Font>();
    for (const f of all) if (families.has(f.family)) byHash.set(f.file.hash, f);
    return [...byHash.values()];
  }

  private ensureFonts(): void {
    const fonts = this.fontsFor();
    const sig = fonts
      .map((f) => f.file.hash)
      .sort()
      .join(',');
    if (sig === this.fontsSig) return;
    this.fontsSig = sig;
    void this.loadFonts(fonts);
  }

  private async fetchFile(hash: string): Promise<Blob> {
    const fb = this.link.fallback;
    if (this.link.bus === 'fallback' && fb) {
      const b = await fb.requestFile(hash);
      if (b) return b;
    }
    try {
      if (this.deps.fetchHub) return await this.deps.fetchHub(hash);
      const res = await fetch(fileUrl(hash));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.blob();
    } catch (err) {
      if (fb?.available) {
        const b = await fb.requestFile(hash);
        if (b) return b;
      }
      throw err;
    }
  }

  /** Download into the service cache (Cache API), then hand the bytes to the host for document.fonts. */
  private async loadFonts(fonts: Font[]): Promise<void> {
    const files: ManifestFile[] = fonts.map((f) => ({
      hash: f.file.hash,
      bytes: f.file.bytes,
      mime: f.file.mime,
    }));
    this.cache = { ready: 0, total: files.length };
    const p = await fillCache(
      this.deps.store,
      files,
      (h) => this.fetchFile(h),
      (pr) => {
        this.cache = { ready: pr.ready, total: pr.total };
      },
      { concurrency: 3, retries: 2 },
    );
    if (this.stopped) return;
    for (const f of fonts) {
      const hash = f.file.hash;
      if (this.loadedFonts.has(hash) || this.sentFonts.has(hash)) continue;
      try {
        const blob = await this.deps.store.get(hash);
        if (!blob) continue;
        const font: FontPayload = {
          hash,
          family: f.family,
          weight: f.weight,
          style: f.style === 'italic' ? 'italic' : 'normal',
          data: await blob.arrayBuffer(),
        };
        this.sentFonts.add(hash);
        this.deps.post({ t: 'font', font }, [font.data]);
      } catch (e) {
        this.lastError = `font ${f.family}: ${(e as Error).message}`;
      }
    }
    if (p.failed.length && !this.fontRetry) {
      // Retry later (hub back, or the operator can serve them over the fallback bus).
      this.fontRetry = setTimeout(() => {
        this.fontRetry = null;
        this.fontsSig = '';
        this.ensureFonts();
      }, FONT_RETRY_MS);
    }
  }

  // ---- health and diagnostics ----

  private sendHealth(): void {
    const s = this.link.state;
    this.sampleStall();
    this.reportedStall = Math.round(this.maxStall);
    this.maxStall = 0;
    const h: OutputHealth = {
      presented: this.host.presented,
      missed: this.host.missed,
      longTasks: this.host.longTasks,
      lateFlips: this.lateFlips,
      live: s.live,
      cache: this.cache,
      gpuLost: 0,
      videoDropped: 0,
      fps: this.host.fps,
      appVersion: APP_VERSION,
      mainThreadStallMs: this.reportedStall,
      workers: this.host.workers.slice(0, 8).map((w) => ({
        name: w.name.slice(0, 40),
        generation: w.generation,
        restarts: w.restarts,
        lastReason: w.lastReason?.slice(0, 300),
        gaveUp: w.gaveUp,
      })),
      recentLog: this.log.slice(-20),
    };
    if (this.lastError) h.error = this.lastError.slice(0, 300);
    this.link.sendHealth(h);
  }

  diag(): Record<string, unknown> {
    const s = this.link.state;
    return {
      outputId: this.outputId,
      bus: this.link.bus,
      fallbackTransport: this.link.fallback?.transport,
      seq: s.seq,
      mode: s.mode,
      live: s.live,
      shown: this.shown,
      ready: this.link.mirror.ready,
      offlineStart: this.offlineStart,
      clockOffset: this.clock.offset,
      fonts: [...this.loadedFonts],
      cache: this.cache,
      resyncs: this.gaps,
      resyncError: this.link.resyncError,
      invariantResyncs: this.invariantResyncs,
      lateFlips: this.lateFlips,
      mainThreadStallMs: this.reportedStall,
      error: this.lastError,
      log: this.log.slice(-20),
    };
  }

  private postDiag(): void {
    this.deps.post({ t: 'diag', diag: this.diag() });
  }
}

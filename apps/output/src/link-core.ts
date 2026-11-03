import { ErrorBudget, type OutputLink, api, clock, fileUrl } from '@ordo/client';
import {
  DEFAULT_LOOKS,
  type Font,
  LOOK_MAIN,
  type LiveState,
  type Look,
  type ManifestFile,
  type Media,
  type Presentation,
  type Slide,
  playableFile,
} from '@ordo/domain';
import { checkInvariants, reduce } from '@ordo/live-state';
import { APP_VERSION, type OutputConfigRes, type OutputHealth, ROUTES } from '@ordo/protocol';
import {
  type AssetJob,
  DroppedFrames,
  EMPTY_TELEMETRY,
  FIT_CONTAIN,
  FIT_COVER,
  type FramePlan,
  type FromAsset,
  type FromRender,
  type HeldKeys,
  LAYER_INDEX,
  type LayerPlan,
  type RecentManifest,
  type RenderTelemetry,
  SRC_VIDEO,
  type ToAsset,
  type ToRender,
  armStatus,
  buildHealth,
  clampLook,
  fontLoads,
  keepSet,
  lookSignature,
  mayPrune,
  planFrame,
  planPreview,
  propsEvalTime,
  propsModel,
  propsTickDelay,
  rememberManifest,
  resolveLook,
} from '@ordo/renderer';
import type {
  AudioRoute,
  HostStatus,
  LinkToMain,
  LinkView,
  MediaCommand,
  MediaEvent,
  Transport,
  WorkerName,
} from './host-protocol.ts';
import { SlotPair } from './media.ts';
import { type FileBody, type StreamStore, findCorrupt, fillStreaming } from './opfs.ts';

const DELIVERED_GRACE_MS = 1500;
const ERROR_RETRY_MS = 3000;
const STATE_CACHE_MAX_AGE_MS = 12 * 3600_000;
/** The props tick wakes this long before each whole second to rasterize that second's text. */
const PROPS_LEAD_MS = 150;
/** Arm failures of one key within a minute before it is quarantined for the rest of the service. */
const ARM_FAILURES_BEFORE_QUARANTINE = 3;
/** While live, no frame presented for this long (with the page painting) means the renderer is stuck. */
const NO_FRAME_MS = 3000;
/** A rebuilt renderer gets this long to present before the stall check applies to it. */
const RENDER_GRACE_MS = 10_000;
/** A second renderer stall within this window reloads the window instead of restarting the renderer. */
const STALL_RELOAD_WINDOW_MS = 120_000;
/** Cached files are checked against the manifest this often while live. */
const INTEGRITY_EVERY_MS = 30_000;
/** How long a hidden render rebuild may wait for its live content before the hold is removed anyway. */
const COVER_TIMEOUT_MS = 8000;
const IDB_READ_TIMEOUT_MS = 1500;

/** What "Send to preview" asked an idle output to show (prd/03). */
export type PreviewRequest = {
  presentation: Presentation;
  slideId?: string;
  /** Media the slide references (background, images), when the sender included them. */
  media?: Media[];
};

type PlanLayer = 'background' | 'slide' | 'lowerThird' | 'media';
const PLAN_LAYERS: PlanLayer[] = ['background', 'slide', 'lowerThird', 'media'];

export type JsonKv = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
};

export type LinkCoreDeps = {
  link: OutputLink;
  store: StreamStore;
  json: JsonKv;
  post: (m: LinkToMain, transfer?: Transferable[]) => void;
  width: number;
  height: number;
  testMode: boolean;
  /** Output config (default: GET /output/config through the hub). */
  fetchConfig?: () => Promise<OutputConfigRes>;
  /** A service-cache file body from the hub (default: fetch fileUrl). */
  fetchNetwork?: (hash: string, signal?: AbortSignal) => Promise<FileBody>;
};

/**
 * Mirror of one of the host's media slots, so slot choice (pick, busy, protect) runs in the link worker
 * with exactly the rules the main thread used before (design/25: the host only executes commands).
 */
export class SlotMirror {
  key = '';
  hash = '';
  ready = false;
  busyUntil = 0;
  error?: string;
  gen = 0;
  waiter?: { key: string; promise: Promise<void>; resolve: () => void; reject: (e: Error) => void };
  constructor(readonly id: number) {}
}

/**
 * The output window's link worker: link, live mirror, service cache, persistence, cue planning, arming,
 * props, health. Every state, config or cache change runs `sync()`, which plans the live and armed frames
 * for this output's look, prepares any content the render worker does not hold, schedules the flips and
 * drives the host's media elements.
 */
export class LinkCore {
  readonly link: OutputLink;
  private store: StreamStore;
  private json: JsonKv;
  private post: LinkCoreDeps['post'];
  private width: number;
  private height: number;
  private renderPort?: MessagePort;
  private assetPort?: MessagePort;
  private gens: Record<WorkerName, number> = { link: -1, render: -1, asset: -1 };

  config?: OutputConfigRes;
  look: Look = LOOK_MAIN;
  private lookSig = '';
  private cachedState?: LiveState;
  private compositor: 'webgpu' | '2d' | 'none' = 'none';
  private renderNote?: string;
  private fatal?: string;

  // Arm bookkeeping
  private held: HeldKeys[] = [];
  private heldSet = new Set<string>();
  private inflight = new Set<string>();
  private delivered = new Map<string, number>();
  private errors = new Map<string, { error: string; at: number }>();
  private flips: { key: string; at: number; fadeMs: number; cue: number }[] = [];
  private livePlan?: FramePlan;
  private armedPlan?: FramePlan;
  private clearSent = '';

  // Quarantine (design/25): keys that failed too often are skipped for the rest of the service.
  private budget = new ErrorBudget({ opfs: { max: 5, windowMs: 60_000 } }, () => Date.now(), {
    max: ARM_FAILURES_BEFORE_QUARANTINE - 1,
    windowMs: 60_000,
  });
  private quarantine = new Map<string, string>();
  private quarantineService = '';
  private fontFallbacks = new Set<string>();
  private cacheRepairs = 0;

  // Media (mirrors of the host's slots)
  readonly slots = [0, 1, 2, 3, 4, 5].map((i) => new SlotMirror(i));
  private bgPair = new SlotPair<SlotMirror>([this.slots[0]!, this.slots[1]!]);
  private mdPair = new SlotPair<SlotMirror>([this.slots[2]!, this.slots[3]!]);
  private auPair = new SlotPair<SlotMirror>([this.slots[4]!, this.slots[5]!]);
  private prevBgLive = '';
  private prevMdLive = '';
  private prevAuLive = '';
  private endedSent = new Set<string>();
  private dropped = new DroppedFrames();
  private wasBlack = false;
  private host?: HostStatus;

  // Props
  private propsKey = '';
  private propsSeq = -1;
  private propsTimer?: ReturnType<typeof setTimeout>;

  // Preview (shown only while no playlist is live)
  private preview?: PreviewRequest;

  // Cache
  private manifestSig = '';
  private manifestFiles: ManifestFile[] = [];
  private fillAbort?: AbortController;
  private cacheProgress: { ready: number; total: number } = { ready: 0, total: 0 };
  private fontsSig = '';
  /** Manifests filled while live, newest first; their files survive prunes (review item 8). */
  private recentManifests: RecentManifest[] = [];
  private recentLoaded = false;

  // Telemetry; render counters accumulate across render-worker generations.
  private tel: RenderTelemetry = { ...EMPTY_TELEMETRY };
  private telBase = { presented: 0, missed: 0, lateFlips: 0, longTasks: 0, gpuLost: 0 };
  private frames: number[] = [];
  private lastTick = performance.now();
  private maxStall = 0;
  private lastHealth?: OutputHealth;
  private clockOffsetSent = Number.NaN;
  private syncQueued = false;
  private log: string[] = [];

  // Crash-only checks
  private renderStartedAt = Date.now();
  private presentedSeen = { count: -1, at: Date.now(), raf: -1, rafAt: Date.now() };
  private stallRestarts: number[] = [];
  private resyncPending = false;
  private invariantResyncs = 0;
  private gaps = 0;
  private awaitingCover = false;
  private coverSince = 0;
  private saving?: Promise<void>;
  private saveAgain = false;
  private viewQueued = false;
  private started = false;

  constructor(private deps: LinkCoreDeps) {
    this.link = deps.link;
    this.store = deps.store;
    this.json = deps.json;
    this.post = deps.post;
    this.width = deps.width;
    this.height = deps.height;
  }

  // ---------------------------------------------------------------- logging and view

  diagLog(line: string): void {
    const t = new Date().toISOString().slice(11, 23);
    this.log.push(`${t} ${line}`);
    if (this.log.length > 50) this.log.shift();
  }

  /** Publish the view the host shows (diagnostics) and serves synchronously (`__ordo`). */
  publishView(): void {
    const view: LinkView = {
      telemetry: this.telemetry(),
      state: this.introspect(),
      diag: this.diagnostics(),
      log: [...this.log],
      covered: !this.awaitingCover,
    };
    this.post({ t: 'view', view });
  }

  private queueView(): void {
    if (this.viewQueued) return;
    this.viewQueued = true;
    setTimeout(() => {
      this.viewQueued = false;
      this.publishView();
    }, 30);
  }

  // ---------------------------------------------------------------- startup

  /**
   * Start from persisted state: the cached config and live state paint the last cue before any
   * connection exists (design/17, design/25 crash-only restart), then the link starts.
   */
  async start(reloadReason?: string): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (reloadReason) this.diagLog(`window reloaded itself: ${reloadReason}`);
    const timeout = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), IDB_READ_TIMEOUT_MS))]);
    const outputId = this.link.outputId;
    const [cfg, saved, recent] = await Promise.all([
      timeout(this.json.get<OutputConfigRes>(`config:${outputId}`)).catch(() => undefined),
      timeout(this.json.get<{ state: LiveState; savedAt: number }>(`state:${outputId}`)).catch(
        () => undefined,
      ),
      timeout(this.json.get<RecentManifest[]>(`manifests:${outputId}`)).catch(() => undefined),
    ]);
    if (Array.isArray(recent) && !this.recentLoaded) {
      this.recentManifests = recent;
      this.recentLoaded = true;
    }
    if (cfg && !this.config) this.applyConfig(cfg);
    if (saved && Date.now() - saved.savedAt < STATE_CACHE_MAX_AGE_MS && !this.link.mirror.ready) {
      const bad = checkInvariants(saved.state);
      if (bad.length) this.diagLog(`cached state has invariant violations (${bad[0]}); painting it anyway`);
      this.cachedState = saved.state;
      this.onState();
    }

    this.link.mirror.on('change', ({ event }) => {
      this.cachedState = undefined;
      this.onMirrorChange(event === undefined);
    });
    this.link.mirror.on('gap', ({ have, got }) => {
      this.gaps++;
      this.diagLog(`live state gap or rejected delta (have ${have}, got ${got}): resync`);
      this.queueView();
    });
    this.link.on('library', (m) => {
      if (m.changes.some((c) => c.kind === 'settings' || c.kind === 'font' || c.kind === 'media'))
        void this.loadConfig();
    });
    this.link.on('bus', ({ bus, reason }) => {
      this.diagLog(`bus: ${bus}${reason ? ` (${reason})` : ''}`);
      this.sendClock();
      if (bus === 'hub' && !this.config) void this.loadConfig();
      this.queueView();
    });
    this.link.on('rtc', (m) => this.post({ t: 'rtc', m }));
    this.link.hub.on('welcome', () => void this.loadConfig());
    this.link.hub.on('bye', (m) => {
      this.diagLog(`hub bye: ${m.reason}`);
      // A newer window for this output connected (Relaunch from another operator tab): leave the screen to it.
      if (m.reason === 'superseded') this.post({ t: 'close', reason: 'superseded' });
      // A new app version is deployed: the host reloads (inside a worker HubConnection cannot).
      if (m.reason === 'version') this.post({ t: 'reload', reason: 'new app version' });
    });
    this.link.hub.on('preview', (m) => this.onPreview(m));
    this.link.start();
    void this.loadConfig();
    void this.probeStore();

    setInterval(() => this.sendClock(), 500);
    setInterval(() => this.sendHealth(), 1000);
    setInterval(() => this.sampleStall(), 50);
    setInterval(() => this.postRender({ t: 'frames' }), 1000);
    setInterval(() => this.sync(), 2000); // retries (errors, busy slots) and media transport upkeep
    setInterval(() => this.publishView(), 250);
    setInterval(() => void this.verifyCache(false), INTEGRITY_EVERY_MS);
    this.scheduleProps();
    setTimeout(() => {
      if (this.tel.presented + this.telBase.presented === 0)
        this.post({
          t: 'fatal',
          title: 'This output has not presented a frame.',
          detail: this.fatal ?? this.renderNote ?? 'Waiting for the renderer…',
        });
    }, 10_000);
  }

  private async probeStore(): Promise<void> {
    try {
      await this.store.probe();
    } catch (err) {
      this.storeError(err, 'OPFS unavailable');
    }
  }

  /** A storage failure that is not a full disk. Too many in a minute: the window reloads (crash-only). */
  private storeError(err: unknown, what = 'OPFS error'): void {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'QuotaExceededError') {
      this.diagLog(`${what}: storage full`);
      return;
    }
    this.diagLog(`${what}: ${(err as Error)?.message ?? String(err)}`);
    if (this.budget.record('opfs', (err as Error)?.message).exceeded || what === 'OPFS unavailable')
      this.post({ t: 'reload', reason: `${what}: the service cache is unusable` });
  }

  private async loadConfig(): Promise<void> {
    try {
      const cfg = await (this.deps.fetchConfig ?? (() => api<OutputConfigRes>(ROUTES.outputConfig)))();
      this.applyConfig(cfg);
      void this.json.set(`config:${this.link.outputId}`, cfg).catch(() => undefined);
    } catch (err) {
      this.diagLog(`config fetch failed: ${(err as Error).message}`);
    }
  }

  applyConfig(cfg: OutputConfigRes): void {
    this.config = cfg;
    const state = this.state();
    this.look = clampLook(
      resolveLook(cfg.output.lookId, [cfg.looks, state.resolved?.looks ?? [], DEFAULT_LOOKS], LOOK_MAIN),
    );
    this.lookSig = lookSignature(this.look, this.width, this.height);
    this.post({ t: 'title', text: `ordo — ${cfg.output.name}` });
    this.post({ t: 'audio', cmd: { k: 'config', master: !!cfg.output.audioMaster, settings: cfg.audio } });
    this.ensureFiles();
    this.requestSync();
  }

  // ---------------------------------------------------------------- ports and workers

  /** New channel ends to the render and asset workers (first start, or after any worker restart). */
  onPorts(render: MessagePort, asset: MessagePort, gens: Record<WorkerName, number>): void {
    const renderChanged = gens.render !== this.gens.render;
    const assetChanged = gens.asset !== this.gens.asset;
    const firstStart = this.gens.render < 0;
    this.gens = { ...gens };
    try {
      this.renderPort?.close();
      this.assetPort?.close();
    } catch {
      /* already closed */
    }
    this.renderPort = render;
    this.assetPort = asset;
    render.onmessage = (ev: MessageEvent<FromRender>) => this.onRender(ev.data);
    asset.onmessage = (ev: MessageEvent<FromAsset>) => this.onAsset(ev.data);
    // Content travelling through the old channels is lost: forget what was in flight and arm again.
    this.inflight.clear();
    for (const s of this.slots) if (s.waiter) this.inflight.add(s.waiter.key);
    if (renderChanged) {
      this.held = [];
      this.heldSet.clear();
      this.delivered.clear();
      this.flips = [];
      this.clearSent = '';
      this.propsKey = '';
      this.clockOffsetSent = Number.NaN;
      this.telBase = {
        presented: this.telBase.presented + this.tel.presented,
        missed: this.telBase.missed + this.tel.missed,
        lateFlips: this.telBase.lateFlips + this.tel.lateFlips,
        longTasks: this.telBase.longTasks + this.tel.longTasks,
        gpuLost: this.telBase.gpuLost + this.tel.gpuLost,
      };
      this.tel = { ...EMPTY_TELEMETRY };
      this.renderStartedAt = Date.now();
      if (!firstStart) {
        this.awaitingCover = true;
        this.coverSince = Date.now();
        this.diagLog(`render worker generation ${gens.render}: re-arming the live and armed cues`);
      }
    }
    if (assetChanged) {
      this.fontsSig = '';
      if (!firstStart) {
        this.diagLog(`asset worker generation ${gens.asset}: reloading fonts, checking the cache`);
        void this.verifyCache(true);
      }
    }
    this.ensureFiles();
    this.sendClock();
    this.requestSync();
  }

  private postRender(m: ToRender, transfer: Transferable[] = []): void {
    try {
      this.renderPort?.postMessage(m, transfer);
    } catch {
      /* channel gone: the next ports message re-arms */
    }
  }

  private postAsset(m: ToAsset, transfer: Transferable[] = []): void {
    try {
      this.assetPort?.postMessage(m, transfer);
    } catch {
      /* channel gone: the next ports message re-arms */
    }
  }

  private media(cmd: MediaCommand): void {
    this.post({ t: 'media', cmd });
  }

  // ---------------------------------------------------------------- host input

  onTick(): void {
    this.sampleStall();
    this.lastTick = performance.now();
  }

  private sampleStall(): void {
    this.maxStall = Math.max(this.maxStall, performance.now() - this.lastTick);
  }

  onHost(status: HostStatus): void {
    this.host = status;
    if (status.compositor) this.compositor = status.compositor;
    if (status.renderNote !== undefined) this.renderNote = status.renderNote;
    if (status.fatal) this.fatal = status.fatal;
    for (const l of status.log) this.diagLog(l);
    if (status.rafTicks !== this.presentedSeen.raf) {
      this.presentedSeen.raf = status.rafTicks;
      this.presentedSeen.rafAt = Date.now();
    }
  }

  onMediaEvent(ev: MediaEvent): void {
    const slot = this.slots[ev.slot];
    if (!slot) return;
    switch (ev.k) {
      case 'loaded': {
        if (slot.key !== ev.key) return;
        slot.ready = true;
        slot.error = undefined;
        const w = slot.waiter;
        if (w && w.key === ev.key) {
          slot.waiter = undefined;
          w.resolve();
        }
        return;
      }
      case 'loadError': {
        if (slot.key !== ev.key) return;
        slot.ready = false;
        slot.error = ev.error;
        const w = slot.waiter;
        if (w && w.key === ev.key) {
          slot.waiter = undefined;
          w.reject(new Error(ev.error));
        }
        return;
      }
      case 'error':
        if (!slot.key || slot.key !== ev.key) return;
        slot.error = ev.error;
        this.diagLog(`media slot ${slot.id} (${slot.key}): ${ev.error}`);
        this.errors.set(slot.key, { error: ev.error, at: Date.now() });
        return;
      case 'ended':
        if (slot.key === ev.key) this.onMediaEnded(slot);
        return;
    }
  }

  setOpenerClosed(closed: boolean): void {
    const fb = this.link.fallback;
    if (!fb || fb.openerClosed === closed) return;
    fb.openerClosed = closed;
    if (closed) {
      this.diagLog('opener window closed');
      this.link.watchFallback();
    }
  }

  /** Test hook: feed a delta as if the hub sent it (malformed ones must resync, never crash). */
  injectDelta(delta: unknown): void {
    this.diagLog('chaos: injected delta');
    (this.link.hub as unknown as { emit(k: 'delta', v: unknown): void }).emit('delta', delta);
  }

  // ---------------------------------------------------------------- state

  /** The state to render: the mirror once it has one, else the cached state from the last session. */
  state(): LiveState {
    return this.link.mirror.ready || !this.cachedState ? this.link.mirror.state : this.cachedState;
  }

  /**
   * Every applied state is checked (design/25 invariants as code). A violation asks for a full state; if
   * the full state that answers it still violates, the window reloads (crash-only restart).
   */
  private onMirrorChange(fullState: boolean): void {
    const bad = checkInvariants(this.link.mirror.state);
    if (bad.length) {
      if (this.resyncPending && fullState) {
        this.diagLog(`invariants still violated after a resync (${bad[0]}): reloading`);
        this.resyncPending = false;
        this.post({ t: 'reload', reason: `live state invariants: ${bad[0]}` });
      } else if (!this.resyncPending) {
        this.resyncPending = true;
        this.invariantResyncs++;
        this.diagLog(`live state invariant violated (${bad.join('; ').slice(0, 200)}): resync`);
        this.resync();
      }
    } else if (fullState) this.resyncPending = false;
    this.onState();
  }

  private resync(): void {
    if (this.link.bus === 'fallback') this.link.fallback?.ready(-1);
    else this.link.hub.send({ t: 'live.resync' });
  }

  private onState(): void {
    const s = this.state();
    // Re-resolve the look when the playlist carries looks and no config yet.
    if (!this.config && s.resolved?.looks.length) {
      this.look = clampLook(resolveLook(undefined, [s.resolved.looks], this.look));
      this.lookSig = lookSignature(this.look, this.width, this.height);
    }
    // A new service (or End service) lifts the quarantine: the operator may have fixed the slide.
    const service = `${s.mode}|${s.resolved?.manifestId ?? ''}`;
    if (service !== this.quarantineService) {
      this.quarantineService = service;
      if (this.quarantine.size)
        this.diagLog(`quarantine lifted for a new service (${this.quarantine.size} keys)`);
      this.quarantine.clear();
      this.fontFallbacks.clear();
    }
    this.ensureFiles();
    this.sync();
    if (this.link.mirror.ready) this.saveState();
    this.queueView();
  }

  /** Persist the live state, coalesced: one write in flight, the newest state wins. */
  private saveState(): void {
    if (this.saving) {
      this.saveAgain = true;
      return;
    }
    const outputId = this.link.outputId;
    this.saving = this.json
      .set(`state:${outputId}`, { state: this.link.mirror.state, savedAt: Date.now() })
      .catch(() => undefined)
      .finally(() => {
        this.saving = undefined;
        if (this.saveAgain) {
          this.saveAgain = false;
          this.saveState();
        }
      });
  }

  private requestSync(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      this.sync();
    });
  }

  private configMedia = (id: string): Media | undefined =>
    this.config?.logo?.id === id ? this.config.logo : undefined;

  /** Media by id from the live state, the output config and the preview request, in that order. */
  private mediaById = (id: string): Media | undefined =>
    this.state().resolved?.media[id] ?? this.configMedia(id) ?? this.preview?.media?.find((m) => m.id === id);

  // ---------------------------------------------------------------- preview

  /**
   * "Send to preview" (prd/03): while no playlist is live, show the given presentation's slide with this
   * output's look; `clear` returns to idle. Ignored while live (the live playlist owns the screen).
   */
  onPreview(m: { presentation?: unknown; slideId?: string; clear?: boolean }): void {
    if (this.state().mode === 'live') {
      this.diagLog('preview ignored: a playlist is live');
      return;
    }
    if (m.clear || !m.presentation) {
      if (this.preview) this.diagLog('preview cleared');
      this.preview = undefined;
      this.requestSync();
      return;
    }
    const p = m.presentation as Presentation & { media?: Media[] };
    if (!p || typeof p !== 'object' || !Array.isArray(p.sections)) {
      this.diagLog('preview ignored: no presentation');
      return;
    }
    this.preview = {
      presentation: p,
      slideId: typeof m.slideId === 'string' ? m.slideId : undefined,
      media: Array.isArray(p.media) ? p.media.slice(0, 50) : undefined,
    };
    this.diagLog(`preview: ${String(p.title ?? p.id).slice(0, 80)} ${m.slideId ?? '(first slide)'}`);
    this.ensureFiles();
    this.requestSync();
  }

  /** Plan live and armed frames, prepare content, schedule flips, drive media. */
  sync(): void {
    const state = this.state();
    const look = this.look;
    const planOpts = { lookSig: this.lookSig, media: this.mediaById };
    if (state.mode === 'live' && this.preview) this.preview = undefined;
    let live: FramePlan;
    try {
      live = this.preview
        ? planPreview(this.preview.presentation, this.preview.slideId, look, planOpts)
        : planFrame(state, look, planOpts);
    } catch (err) {
      // The planner clamps and never throws by contract; if it does, keep what is on screen.
      this.diagLog(`plan failed: ${(err as Error).message}`);
      return;
    }
    let armed: FramePlan | undefined;
    if (state.mode === 'live' && state.armed !== undefined && state.armed !== state.live) {
      try {
        armed = planFrame(reduce(state, { k: 'go', cueIndex: state.armed, at: 0 }), look, planOpts);
      } catch {
        armed = undefined;
      }
    }
    this.livePlan = live;
    this.armedPlan = armed;

    const clearSig = JSON.stringify(look.clearColor);
    if (clearSig !== this.clearSent && this.renderPort) {
      this.clearSent = clearSig;
      this.postRender({ t: 'clear', color: look.clearColor });
    }

    for (const name of PLAN_LAYERS) {
      const lp = live[name] as LayerPlan<{ key: string }>;
      this.ensureContent(name, lp, live, state);
      const ap = armed?.[name] as LayerPlan<{ key: string }> | undefined;
      if (ap && ap.key !== lp.key) this.ensureContent(name, ap, armed!, state);
      this.sendFlip(name, this.shown(lp.key), lp.at, lp.fadeMs, name === 'slide' ? live.slideCue : -1);
    }
    this.syncVideos(live, armed);
    this.syncAudio(live, armed, state);
    this.syncProps(false);
    this.checkCover();
  }

  /** A quarantined key is never flipped to; the layer shows nothing instead of retrying. */
  private shown(key: string): string {
    return key && this.quarantine.has(key) ? '' : key;
  }

  // ---------------------------------------------------------------- content

  private has(key: string): boolean {
    if (!key) return true;
    if (this.heldSet.has(key) || this.inflight.has(key)) return true;
    const d = this.delivered.get(key);
    return d !== undefined && Date.now() - d < DELIVERED_GRACE_MS;
  }

  private errorBlocks(key: string): boolean {
    if (this.quarantine.has(key)) return true;
    const e = this.errors.get(key);
    return !!e && Date.now() - e.at < ERROR_RETRY_MS;
  }

  /**
   * An arm of `key` failed. Within the budget it is retried after ERROR_RETRY_MS; past it the key is
   * quarantined for the rest of the service and reported in health (never retried in a loop).
   */
  private armFailed(key: string, error: string): void {
    this.errors.set(key, { error, at: Date.now() });
    if (this.quarantine.has(key)) return;
    if (this.budget.record(`arm:${key}`, error).exceeded) {
      this.quarantine.set(key, error);
      this.diagLog(`quarantined ${key.slice(0, 80)}: ${error}`);
      this.queueView();
    }
  }

  private ensureContent(
    name: PlanLayer,
    lp: LayerPlan<{ key: string }>,
    plan: FramePlan,
    _state: LiveState,
  ): void {
    const key = lp.key;
    if (!key || this.errorBlocks(key) || !this.renderPort) return;
    const layer = LAYER_INDEX[name];
    const video =
      (name === 'background' && plan.background.desc?.kind === 'video') ||
      (name === 'media' && plan.media.desc?.kind === 'video');
    if (video) {
      // A video key is only valid while a media slot still holds that video (slots are reused).
      const pair = name === 'background' ? this.bgPair : this.mdPair;
      const slot = pair.find(key);
      if (this.inflight.has(key)) return;
      if (slot?.ready && this.has(key)) return;
    } else if (this.has(key)) return;
    if (name === 'background' && plan.background.desc) {
      const d = plan.background.desc;
      if (d.kind === 'image') this.job({ kind: 'image', layer, key, hash: d.hash, fit: 'cover' });
      else this.armVideo(this.bgPair, layer, key, d.hash, true, FIT_COVER);
    } else if (name === 'slide' && plan.slide.desc) {
      const d = plan.slide.desc;
      this.job({
        kind: 'slide',
        layer,
        key,
        cueIndex: d.cueIndex,
        slide: d.slide,
        nextSlide: d.nextSlide,
        isSong: d.isSong,
        look: this.look,
        images: this.slideImages(d.slide, d.nextSlide),
      });
    } else if (name === 'lowerThird' && plan.lowerThird.desc) {
      this.job({ kind: 'lowerThird', layer, key, text: plan.lowerThird.desc.text, look: this.look });
    } else if (name === 'media' && plan.media.desc) {
      const d = plan.media.desc;
      if (d.kind === 'image')
        this.job({ kind: 'image', layer, key, hash: d.hash, fit: 'contain', cueIndex: d.cueIndex });
      else this.armVideo(this.mdPair, layer, key, d.hash, d.loop, FIT_CONTAIN, d.cueIndex);
    }
  }

  private slideImages(...slides: (Slide | undefined)[]): Record<string, string> {
    const out: Record<string, string> = {};
    const add = (id?: string) => {
      if (!id) return;
      const m = this.mediaById(id);
      const f = m ? playableFile(m) : undefined;
      if (f) out[id] = f.hash;
    };
    for (const s of slides) {
      if (!s) continue;
      add(s.imported?.imageMediaId);
      for (const o of s.objects) if (o.type === 'image') add(o.mediaId);
    }
    return out;
  }

  private job(job: AssetJob): void {
    if (!this.assetPort) return;
    this.inflight.add(job.key);
    this.postAsset({ t: 'job', job });
  }

  /** Load a file into a host media slot; resolves when its first frame is available. */
  private loadSlot(
    slot: SlotMirror,
    key: string,
    hash: string,
    loop: boolean,
    muted: boolean,
  ): Promise<void> {
    if (slot.key === key && slot.waiter) return slot.waiter.promise;
    const gen = ++slot.gen;
    if (slot.key !== key) {
      slot.ready = false;
      slot.error = undefined;
    }
    slot.key = key;
    slot.hash = hash;
    // Any earlier waiter on this slot was superseded (like MediaSlot.load: resolves, the caller re-checks).
    slot.waiter?.resolve();
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    slot.waiter = { key, promise, resolve, reject };
    void (async () => {
      const blob = await this.store.get(hash).catch(() => undefined);
      if (gen !== slot.gen) return;
      this.media({ k: 'load', slot: slot.id, key, hash, blob, url: fileUrl(hash), loop, muted });
    })();
    return promise;
  }

  private armVideo(
    pair: SlotPair<SlotMirror>,
    layer: number,
    key: string,
    hash: string,
    loop: boolean,
    fit: number,
    cueIndex?: number,
  ): void {
    const protect = this.protectedKeys(pair);
    const now = clock.now();
    const slot = pair.pick(key, protect, now);
    if (!slot) {
      // Both slots busy (one fading out): retry when the fade ends.
      const wait = Math.min(...pair.slots.map((s) => s.busyUntil)) - now;
      setTimeout(() => this.requestSync(), Math.max(20, wait + 10));
      return;
    }
    const muted = !(pair === this.mdPair && this.config?.output.audioMaster);
    this.inflight.add(key);
    // Whatever the render worker held for this slot's previous video is no longer valid.
    if (slot.key && slot.key !== key) {
      this.heldSet.delete(slot.key);
      this.delivered.delete(slot.key);
    }
    this.loadSlot(slot, key, hash, loop, muted)
      .then(() => {
        this.inflight.delete(key);
        if (slot.key !== key) return;
        this.delivered.set(key, Date.now());
        this.errors.delete(key);
        // A media video hidden by this look still plays (for audio) but is not offered to the renderer.
        const visible =
          layer !== LAYER_INDEX.media ||
          this.livePlan?.media.key === key ||
          this.armedPlan?.media.key === key;
        if (visible)
          this.postRender({ t: 'content', layer, key, kind: SRC_VIDEO, videoSlot: slot.id, fit, cueIndex });
        this.syncVideos(this.livePlan, this.armedPlan);
      })
      .catch((err: Error) => {
        this.inflight.delete(key);
        this.diagLog(`arm ${key}: ${err.message}`);
        this.armFailed(key, err.message);
        // A cached copy that does not play may be corrupt: drop it so the next arm streams a fresh one.
        void this.dropCached(hash, `video ${hash.slice(0, 8)} failed to load`);
      });
  }

  private protectedKeys(pair: SlotPair<SlotMirror>): string[] {
    const keys: string[] = [];
    const add = (p?: FramePlan) => {
      if (!p) return;
      if (pair === this.bgPair && p.background.desc?.kind === 'video') keys.push(p.background.key);
      if (pair === this.mdPair && p.media.desc?.kind === 'video') keys.push(p.media.desc.key);
      if (pair === this.auPair && p.audio.desc) keys.push(p.audio.key);
    };
    add(this.livePlan);
    add(this.armedPlan);
    return keys;
  }

  private sendFlip(name: PlanLayer, key: string, at: number, fadeMs: number, cue: number): void {
    if (!this.renderPort) return;
    const layer = LAYER_INDEX[name];
    const prev = this.flips[layer];
    if (prev && prev.key === key && prev.at === at && prev.fadeMs === fadeMs && prev.cue === cue) return;
    this.flips[layer] = { key, at, fadeMs, cue };
    this.postRender({ t: 'flip', layer, key, at, fadeMs, cueIndex: name === 'slide' ? cue : undefined });
  }

  // ---------------------------------------------------------------- media transport

  private apply(slot: SlotMirror, transport: Transport): void {
    if (!slot.ready) return;
    this.media({ k: 'apply', slot: slot.id, transport });
  }

  private pauseAt(slot: SlotMirror, at: number): void {
    this.media({ k: 'pauseAt', slot: slot.id, at });
  }

  private syncVideos(live?: FramePlan, armed?: FramePlan): void {
    if (!live) return;
    const now = clock.now();
    // Backgrounds: loop, muted, keep playing across slides; synced to the layer's start time.
    const bg = live.background.desc?.kind === 'video' ? live.background : undefined;
    const bgKey = bg?.key ?? '';
    if (bgKey !== this.prevBgLive) {
      const old = this.bgPair.find(this.prevBgLive);
      if (old) {
        this.pauseAt(old, live.background.at + live.background.fadeMs);
        old.busyUntil = Math.max(now, live.background.at) + live.background.fadeMs + 100;
      }
      this.prevBgLive = bgKey;
    }
    const bgSlot = this.bgPair.find(bgKey);
    if (bg && bgSlot) this.apply(bgSlot, { state: 'playing', startedAt: bg.at, positionMs: 0, loop: true });

    // Media video: transport from the reducer state; audio through the engine on the master.
    const md = live.media.desc?.kind === 'video' ? live.media.desc : undefined;
    const mdKey = md?.key ?? '';
    if (mdKey !== this.prevMdLive) {
      const old = this.mdPair.find(this.prevMdLive);
      if (old) {
        // On clear-all the sound fades over 500 ms; keep the element running until then.
        this.pauseAt(old, live.media.at + Math.max(live.media.fadeMs, live.black ? 520 : 0));
        old.busyUntil = Math.max(now, live.media.at) + live.media.fadeMs + 100;
      }
      this.prevMdLive = mdKey;
    }
    const mdSlot = this.mdPair.find(mdKey);
    if (
      md &&
      !mdSlot &&
      !live.media.key &&
      this.config?.output.audioMaster &&
      !this.inflight.has(md.key) &&
      !this.errorBlocks(md.key)
    )
      // Hidden by this look but the audio master still plays it for the sound.
      this.armVideo(this.mdPair, LAYER_INDEX.media, md.key, md.hash, md.loop, FIT_CONTAIN, md.cueIndex);
    if (md && mdSlot) {
      this.routeAudio(mdSlot, md.audio);
      this.apply(mdSlot, {
        state: md.state,
        startedAt: md.startedAt,
        positionMs: md.positionMs,
        loop: md.loop,
      });
    }
    // Armed media video stays paused on its first frame.
    const amd = armed?.media.desc?.kind === 'video' ? armed.media.desc : undefined;
    const amSlot = amd && amd.key !== mdKey ? this.mdPair.find(amd.key) : undefined;
    if (amSlot?.ready) this.media({ k: 'holdPaused', slot: amSlot.id });
  }

  private routeAudio(slot: SlotMirror, a: AudioRoute): void {
    this.media({ k: 'route', slot: slot.id, master: !!this.config?.output.audioMaster, audio: a });
  }

  private syncAudio(live: FramePlan, armed: FramePlan | undefined, state: LiveState): void {
    if (!this.config?.output.audioMaster) return;
    // Clear-all fades audio out.
    if (state.black && !this.wasBlack) this.post({ t: 'audio', cmd: { k: 'fadeOut', ms: 500 } });
    this.wasBlack = state.black;

    const a = live.audio.desc;
    const key = a?.key ?? '';
    if (key !== this.prevAuLive) {
      const old = this.auPair.find(this.prevAuLive);
      if (old) this.pauseAt(old, state.black ? live.audio.at + 520 : live.audio.at);
      this.prevAuLive = key;
    }
    const protect = this.protectedKeys(this.auPair);
    const want = [a, armed?.audio.desc && armed.audio.desc.key !== key ? armed.audio.desc : undefined];
    for (const d of want) {
      if (!d || this.auPair.find(d.key) || this.inflight.has(d.key) || this.errorBlocks(d.key)) continue;
      const slot = this.auPair.pick(d.key, protect, clock.now());
      if (!slot) continue;
      this.inflight.add(d.key);
      this.loadSlot(slot, d.key, d.hash, d.loop, false)
        .then(() => {
          this.inflight.delete(d.key);
          this.requestSync();
        })
        .catch((err: Error) => {
          this.inflight.delete(d.key);
          this.armFailed(d.key, err.message);
        });
    }
    const slot = this.auPair.find(key);
    if (a && slot) {
      this.routeAudio(slot, a.audio);
      this.apply(slot, { state: a.state, startedAt: a.startedAt, positionMs: a.positionMs, loop: a.loop });
    }
  }

  private onMediaEnded(slot: SlotMirror): void {
    if (!this.config?.output.audioMaster) return;
    const live = this.livePlan;
    if (!live) return;
    const md = live.media.desc;
    if (md && md.kind === 'video' && slot.key === md.key && md.state === 'playing' && !md.loop) {
      const id = `m|${md.key}|${md.startedAt}`;
      if (this.endedSent.has(id)) return;
      this.endedSent.add(id);
      // Queued by the link until a bus is up (review item 25).
      this.link.sendEvent({ k: 'media.ended', cueIndex: md.cueIndex, at: clock.now() });
      this.diagLog(`media.ended cue ${md.cueIndex}`);
      return;
    }
    const au = live.audio.desc;
    if (au && slot.key === au.key && au.state === 'playing' && !au.loop) {
      const id = `a|${au.key}|${au.startedAt}`;
      if (this.endedSent.has(id)) return;
      this.endedSent.add(id);
      this.link.sendEvent({ k: 'audio.ended', cueIndex: au.cueIndex, at: clock.now() });
      this.diagLog(`audio.ended cue ${au.cueIndex}`);
    }
  }

  // ---------------------------------------------------------------- props

  /**
   * Re-rasterize the props layer when its text changes; runs on state changes and each second. Every
   * caller evaluates the model at `propsEvalTime` (the coming second boundary inside the lead), so a
   * state-driven sync agrees with the scheduled tick instead of cancelling its flip (review item 23).
   */
  private syncProps(fromTick: boolean): void {
    if (!this.renderPort) return;
    const state = this.state();
    const now = propsEvalTime(clock.now(), PROPS_LEAD_MS);
    const general = this.config?.general;
    const logoMediaId = general?.logoMediaId ?? state.resolved?.logoMediaId;
    let model: ReturnType<typeof propsModel>;
    try {
      model = propsModel(state, this.look, {
        now,
        timeZone: general?.timeZone ?? 'UTC',
        clock24h: general?.clock24h ?? false,
        logoMediaId,
        lookSig: this.lookSig,
      });
    } catch (err) {
      this.diagLog(`props failed: ${(err as Error).message}`);
      return;
    }
    const layer = LAYER_INDEX.props;
    const stateChange = state.props.seq !== this.propsSeq;
    if (model.key === this.propsKey && !stateChange) return;
    if (model.key === this.propsKey) {
      this.propsSeq = state.props.seq;
      return;
    }
    const fade =
      stateChange && !fromTick
        ? this.look.transition.kind === 'crossfade'
          ? this.look.transition.ms
          : 0
        : 0;
    // A text change driven by time (clock, countdown) flips on the second boundary it was evaluated
    // for, whichever caller noticed it first; a state change flips when the state says.
    const at = stateChange && !fromTick ? Math.max(state.props.at, 0) : now;
    this.propsSeq = state.props.seq;
    this.propsKey = model.key;
    if (model.key && !this.has(model.key) && !this.errorBlocks(model.key)) {
      const images: Record<string, string> = {};
      if (model.logo) {
        const m = state.resolved?.media[model.logo.mediaId] ?? this.configMedia(model.logo.mediaId);
        const f = m ? playableFile(m) : undefined;
        if (f) images[model.logo.mediaId] = f.hash;
      }
      this.job({ kind: 'props', layer, key: model.key, model, look: this.look, images });
    }
    const key = this.shown(model.key);
    this.flips[layer] = { key, at, fadeMs: fade, cue: -1 };
    this.postRender({ t: 'flip', layer, key, at, fadeMs: fade });
  }

  private scheduleProps(): void {
    clearTimeout(this.propsTimer);
    // Wake PROPS_LEAD_MS before each second, rasterize the text for that second, flip exactly on it.
    // The delay is never 0 (inside the lead the next boundary is targeted), so there is no busy loop.
    this.propsTimer = setTimeout(
      () => {
        this.syncProps(true);
        this.scheduleProps();
      },
      propsTickDelay(clock.now(), PROPS_LEAD_MS),
    );
  }

  // ---------------------------------------------------------------- cache

  private ensureFiles(): void {
    const state = this.state();
    const files = new Map<string, ManifestFile>();
    for (const f of state.resolved?.files ?? []) files.set(f.hash, f);
    for (const m of this.preview?.media ?? []) {
      const f = playableFile(m);
      if (f) files.set(f.hash, { hash: f.hash, bytes: f.bytes, mime: f.mime });
    }
    const fonts = new Map<string, Font>();
    for (const f of [...(this.config?.fonts ?? []), ...(state.resolved?.fonts ?? [])])
      fonts.set(f.file.hash, f);
    for (const f of fonts.values())
      files.set(f.file.hash, { hash: f.file.hash, bytes: f.file.bytes, mime: f.file.mime });
    const extra = [
      this.config?.logo,
      this.look.holdingMediaId ? state.resolved?.media[this.look.holdingMediaId] : undefined,
    ];
    for (const m of extra) {
      const f = m ? playableFile(m) : undefined;
      if (f) files.set(f.hash, { hash: f.hash, bytes: f.bytes, mime: f.mime });
    }
    // Fonts go to the asset worker before any text job (its queue is ordered).
    const fsig = [...fonts.keys()].sort().join(',');
    if (fsig !== this.fontsSig && this.assetPort) {
      this.fontsSig = fsig;
      this.postAsset({ t: 'fonts', fonts: fontLoads([...fonts.values()]) });
    }
    // Before the first state (hub or cached) the manifest is fonts and logo only: filling it would race
    // the real one and, worse, prune the service files. Wait for a state (review item 8).
    if (!this.link.mirror.ready && !this.cachedState) return;
    const sig = [...files.keys()].sort().join(',');
    if (sig === this.manifestSig) return;
    this.manifestSig = sig;
    this.manifestFiles = [...files.values()];
    void this.fill(this.manifestFiles, new Set(fonts.keys()), sig, state.mode === 'live');
  }

  /** The body of a service-cache file: from the operator while it is the authority, else the hub. */
  private async fetchBody(hash: string, signal?: AbortSignal): Promise<FileBody> {
    const fb = this.link.fallback;
    if (this.link.bus === 'fallback' && fb) {
      const b = await fb.requestFile(hash);
      if (b) return b;
    }
    try {
      if (this.deps.fetchNetwork) return await this.deps.fetchNetwork(hash, signal);
      const res = await fetch(fileUrl(hash), { signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      return res.body;
    } catch (err) {
      if (fb?.available) {
        const b = await fb.requestFile(hash);
        if (b) return b;
      }
      throw err;
    }
  }

  private async fill(
    files: ManifestFile[],
    fontHashes: Set<string>,
    sig: string,
    live: boolean,
  ): Promise<void> {
    this.fillAbort?.abort();
    const ac = new AbortController();
    this.fillAbort = ac;
    // Fonts first, then images, then everything else (videos).
    const rank = (f: ManifestFile) => (fontHashes.has(f.hash) ? 0 : f.mime.startsWith('image/') ? 1 : 2);
    const sorted = [...files].sort((a, b) => rank(a) - rank(b));
    this.cacheProgress = { ready: 0, total: sorted.length };
    const t0 = performance.now();
    let p: Awaited<ReturnType<typeof fillStreaming>>;
    try {
      p = await fillStreaming(
        this.store,
        sorted,
        (h, signal) => this.fetchBody(h, signal),
        (pr) => {
          if (ac.signal.aborted) return;
          this.cacheProgress = { ready: pr.ready, total: pr.total };
        },
        { concurrency: 3, retries: 2, signal: ac.signal, onStoreError: (e) => this.storeError(e) },
      );
    } catch (err) {
      this.diagLog(`cache fill failed: ${(err as Error).message}`);
      return;
    }
    if (ac.signal.aborted) return;
    this.cacheProgress = { ready: p.ready, total: p.total };
    if (p.repaired.length) {
      this.cacheRepairs += p.repaired.length;
      this.diagLog(`cache: ${p.repaired.length} corrupt file(s) fetched again`);
    }
    this.diagLog(
      `cache: ${p.ready}/${p.total} files in ${Math.round(performance.now() - t0)} ms${p.failed.length ? `, ${p.failed.length} failed` : ''}`,
    );
    if (p.failed.length) {
      // Retry the missing ones later (hub may be back, or the operator can serve them).
      setTimeout(() => {
        if (this.fillAbort === ac) {
          this.manifestSig = '';
          this.ensureFiles();
        }
      }, 10_000);
    } else if (mayPrune(live, p.failed.length)) {
      // Only a complete live fill prunes, and only what no recent service used: End service (an idle
      // manifest of fonts and logo) leaves the cache intact, so the next Go live downloads nothing.
      this.recentManifests = rememberManifest(this.recentManifests, sig, files, Date.now());
      this.recentLoaded = true;
      void this.json.set(`manifests:${this.link.outputId}`, this.recentManifests).catch(() => undefined);
      const keep = keepSet(files, this.recentManifests);
      this.postAsset({ t: 'prune', keep: [...keep] });
      const n = await this.store.prune?.(keep).catch(() => 0);
      if (n)
        this.diagLog(`cache: pruned ${n} files unused by the last ${this.recentManifests.length} services`);
    }
    // Keys that failed for want of a file get a fresh chance (quarantined ones stay quarantined).
    this.errors.clear();
    this.requestSync();
  }

  /** Remove one cached file and refill (a decode failure on an OPFS copy, or a size mismatch). */
  private async dropCached(hash: string, why: string): Promise<void> {
    const size = await this.store.size(hash).catch(() => undefined);
    if (size === undefined) return;
    await this.store.remove(hash).catch(() => undefined);
    this.cacheRepairs++;
    this.diagLog(`cache: ${why}; fetching it again`);
    this.manifestSig = '';
    this.ensureFiles();
  }

  /**
   * Compare cached files with the manifest (sizes): a truncated or overwritten file is removed and fetched
   * again. Runs every 30 s while live, after an asset-worker restart, and from the chaos hook.
   */
  async verifyCache(force: boolean): Promise<number> {
    if (!force && this.state().mode !== 'live') return 0;
    if (!this.manifestFiles.length) return 0;
    const bad = await findCorrupt(this.store, this.manifestFiles).catch(() => [] as string[]);
    if (!bad.length) return 0;
    for (const h of bad) await this.store.remove(h).catch(() => undefined);
    this.cacheRepairs += bad.length;
    this.diagLog(`cache: ${bad.length} file(s) did not match the manifest; fetching again`);
    // Content decoded from a corrupt copy may be wrong: let it be prepared again once the file is back.
    for (const [k] of this.errors) if (bad.some((h) => k.includes(h))) this.errors.delete(k);
    this.manifestSig = '';
    this.ensureFiles();
    this.queueView();
    return bad.length;
  }

  // ---------------------------------------------------------------- workers

  private onRender(m: FromRender): void {
    switch (m.t) {
      case 'ready':
        this.compositor = m.compositor;
        this.renderNote = m.note;
        this.renderStartedAt = Date.now();
        this.diagLog(`renderer ready: ${m.compositor}${m.note ? ` (${m.note})` : ''}`);
        this.requestSync();
        return;
      case 'telemetry':
        this.tel = m.tel;
        this.compositor = m.tel.compositor;
        return;
      case 'frames':
        this.frames = m.frames;
        return;
      case 'held': {
        this.held = m.layers;
        this.heldSet = new Set();
        for (const h of m.layers) {
          if (h.live) this.heldSet.add(h.live);
          if (h.armed) this.heldSet.add(h.armed);
          if (h.queued) this.heldSet.add(h.queued);
        }
        // Content delivered a while ago that the renderer no longer holds was evicted: arm it again.
        const now = Date.now();
        for (const [k, t] of this.delivered)
          if (now - t > 250 && !this.heldSet.has(k)) this.delivered.delete(k);
        this.requestSync();
        this.queueView();
        return;
      }
      case 'lost':
        this.diagLog(`GPU device lost: ${m.reason}; rebuilding`);
        return;
      case 'restored':
        this.compositor = m.compositor;
        if (m.compositor === 'webgpu') this.renderNote = undefined;
        this.diagLog(`renderer restored (${m.compositor})`);
        return;
      case 'fatal':
        this.fatal = m.error;
        this.diagLog(`fatal: ${m.error}`);
        return;
      default:
        return;
    }
  }

  private onAsset(m: FromAsset): void {
    switch (m.t) {
      case 'done':
        this.inflight.delete(m.key);
        this.delivered.set(m.key, Date.now());
        this.errors.delete(m.key);
        for (const f of m.fontFallbacks ?? []) {
          if (!this.fontFallbacks.has(f) && this.fontFallbacks.size < 20) {
            this.fontFallbacks.add(f);
            this.diagLog(`font "${f}" is not loaded: drawn in the fallback font`);
          }
        }
        if (m.skippedImages)
          this.diagLog(`${m.key.slice(0, 60)}: ${m.skippedImages} image(s) over the cue budget`);
        return;
      case 'error':
        this.inflight.delete(m.key);
        this.diagLog(`arm ${m.key.slice(0, 60)}: ${m.error}`);
        this.armFailed(m.key, m.error);
        if (m.hash && m.source === 'opfs')
          void this.dropCached(m.hash, `cached ${m.hash.slice(0, 8)} failed to decode`);
        setTimeout(() => this.requestSync(), ERROR_RETRY_MS + 50);
        return;
      case 'fonts':
        this.diagLog(`fonts loaded: ${m.loaded}${m.failed.length ? `, failed: ${m.failed.join(', ')}` : ''}`);
        return;
    }
  }

  private clockOffset(): number {
    return clock.now() - (performance.timeOrigin + performance.now());
  }

  private sendClock(): void {
    const off = this.clockOffset();
    if (Math.abs(off - this.clockOffsetSent) < 0.5) return;
    this.clockOffsetSent = off;
    this.postRender({ t: 'clock', offset: off });
    this.post({ t: 'clock', offset: clock.now() - Date.now() });
  }

  /** After a render rebuild, tell the host when the live content is held again (it removes the hold). */
  private checkCover(): void {
    if (!this.awaitingCover) return;
    const live = this.livePlan;
    let ok = !!live;
    if (live)
      for (const name of PLAN_LAYERS) {
        const key = this.shown(live[name].key);
        const h = this.held[LAYER_INDEX[name]];
        if (key && h?.live !== key) ok = false;
      }
    if (ok || Date.now() - this.coverSince > COVER_TIMEOUT_MS) {
      this.awaitingCover = false;
      this.diagLog(
        ok ? 'live content re-armed after the render rebuild' : 'render rebuild: uncovering after timeout',
      );
      this.queueView();
    }
  }

  // ---------------------------------------------------------------- health and crash-only checks

  private armRequired(): string[] {
    const keys: string[] = [];
    for (const p of [this.livePlan, this.armedPlan]) {
      if (!p) continue;
      for (const name of PLAN_LAYERS) keys.push(this.shown((p[name] as LayerPlan<unknown>).key));
    }
    return keys;
  }

  /** Accumulated render counters (across render-worker generations). */
  private renderTel(): RenderTelemetry {
    return {
      ...this.tel,
      presented: this.telBase.presented + this.tel.presented,
      missed: this.telBase.missed + this.tel.missed,
      lateFlips: this.telBase.lateFlips + this.tel.lateFlips,
      longTasks: this.telBase.longTasks + this.tel.longTasks,
      gpuLost: this.telBase.gpuLost + this.tel.gpuLost,
    };
  }

  buildHealth(): OutputHealth {
    const state = this.state();
    const errMap = new Map<string, string>();
    for (const [k, v] of this.errors) errMap.set(k, v.error);
    const arm = armStatus(this.armRequired(), this.heldSet, errMap);
    const host = this.host;
    const hs = new Map((host?.slots ?? []).map((s) => [s.id, s]));
    for (const s of host?.slots ?? []) this.dropped.sample(`slot${s.id}`, s.srcId, s.dropped);
    const md = this.livePlan?.media.desc;
    const mdSlot = md?.kind === 'video' ? this.mdPair.find(md.key) : undefined;
    const au = this.livePlan?.audio.desc;
    const auSlot = au ? this.auPair.find(au.key) : undefined;
    const pos = hs.get((mdSlot ?? (this.config?.output.audioMaster ? auSlot : undefined))?.id ?? -1);
    const errors: string[] = [];
    if (this.fatal) errors.push(this.fatal);
    for (const s of host?.slots ?? []) if (s.key && s.error) errors.push(s.error);
    if (this.quarantine.size) errors.push(`${this.quarantine.size} quarantined`);
    const master = !!this.config?.output.audioMaster;
    const h = buildHealth({
      render: this.renderTel(),
      mainLongTasks: host?.longTasks ?? 0,
      live: state.live,
      armed: state.armed,
      arm,
      cache: this.cacheProgress,
      videoDropped: this.dropped.total,
      audio: master ? (host?.audio ?? 'none') : undefined,
      meters: master ? host?.meters : undefined,
      mediaPositionMs: pos ? pos.positionMs : undefined,
      mediaDurationMs: pos?.durationMs ?? md?.durationMs,
      errors,
      appVersion: APP_VERSION,
    });
    const out: OutputHealth = {
      ...(h as OutputHealth),
      compositor: this.compositor === 'none' ? undefined : this.compositor,
      mainThreadStallMs: Math.round(this.maxStall),
      recentLog: this.log.slice(-20).map((l) => l.slice(0, 300)),
      workers: host?.workers.map((w) => ({
        name: w.name,
        generation: w.generation,
        restarts: w.restarts,
        lastReason: w.lastReason?.slice(0, 300),
        gaveUp: w.gaveUp,
      })),
      quarantined: this.quarantine.size
        ? {
            count: this.quarantine.size,
            items: [...this.quarantine.keys()].slice(0, 20).map((k) => k.slice(0, 300)),
          }
        : undefined,
      fontFallbacks: this.fontFallbacks.size ? [...this.fontFallbacks].slice(0, 20) : undefined,
      cacheRepairs: this.cacheRepairs || undefined,
      busTransport: this.link.fallback?.transport,
    };
    return out;
  }

  private sendHealth(): void {
    this.sampleStall();
    let h: OutputHealth;
    try {
      h = this.buildHealth();
    } catch (err) {
      this.diagLog(`health failed: ${(err as Error).message}`);
      return;
    }
    this.maxStall = 0;
    this.lastHealth = h;
    this.link.sendHealth(h);
    this.checkRenderer();
    this.checkCover();
  }

  /**
   * While live, a renderer that presented nothing for 3 s while the page is being painted is stuck: the
   * first time its worker is restarted (the hold covers the rebuild); a second time within two minutes
   * the window reloads (crash-only restart).
   */
  private checkRenderer(): void {
    const now = Date.now();
    const presented = this.tel.presented;
    if (presented !== this.presentedSeen.count) {
      this.presentedSeen.count = presented;
      this.presentedSeen.at = now;
      return;
    }
    const host = this.host;
    if (!host || !host.visible || this.state().mode !== 'live') {
      this.presentedSeen.at = now;
      return;
    }
    const painting = now - this.presentedSeen.rafAt < 1500;
    if (!painting || now - this.renderStartedAt < RENDER_GRACE_MS || this.compositor === 'none') return;
    if (now - this.presentedSeen.at < NO_FRAME_MS) return;
    this.presentedSeen.at = now;
    this.stallRestarts = this.stallRestarts.filter((t) => now - t < STALL_RELOAD_WINDOW_MS);
    if (this.stallRestarts.length) {
      this.diagLog('renderer stalled again: reloading the window');
      this.post({ t: 'reload', reason: 'no frame presented for 3 s while live (twice)' });
      return;
    }
    this.stallRestarts.push(now);
    this.diagLog('no frame presented for 3 s while live: restarting the render worker');
    this.post({ t: 'restartWorker', name: 'render', reason: 'no frame presented for 3 s while live' });
  }

  // ---------------------------------------------------------------- introspection

  telemetry(): Record<string, unknown> {
    const h = this.lastHealth ?? this.buildHealth();
    return {
      ...h,
      compositor: this.compositor,
      bus: this.link.bus,
      frameMs: this.tel.frameMs,
      frames: this.frames,
      resyncs: this.gaps,
      invariantResyncs: this.invariantResyncs,
    };
  }

  introspect(): Record<string, unknown> {
    const s = this.state();
    return {
      outputId: this.link.outputId,
      look: this.look.id,
      mode: s.mode,
      seq: s.seq,
      live: s.live,
      armed: s.armed,
      slideCue: this.livePlan?.slideCue ?? -1,
      keys: {
        live: this.livePlan ? Object.fromEntries(PLAN_LAYERS.map((n) => [n, this.livePlan![n].key])) : {},
        armed: this.armedPlan ? Object.fromEntries(PLAN_LAYERS.map((n) => [n, this.armedPlan![n].key])) : {},
        props: this.propsKey,
      },
      held: this.held,
      inflight: [...this.inflight],
      errors: Object.fromEntries([...this.errors].map(([k, v]) => [k, v.error])),
      quarantined: [...this.quarantine.keys()],
      cache: this.cacheProgress,
      cacheRepairs: this.cacheRepairs,
      recentManifests: this.recentManifests.map((r) => ({ at: r.at, files: r.files.length })),
      preview: this.preview
        ? { presentation: this.preview.presentation.id, slideId: this.preview.slideId }
        : null,
      compositor: this.compositor,
      bus: this.link.bus,
      transport: this.link.fallback?.transport,
      gens: this.gens,
      size: `${this.width}x${this.height}`,
      resyncs: this.gaps,
      invariantResyncs: this.invariantResyncs,
      log: [...this.log],
    };
  }

  private diagnostics(): Record<string, unknown> {
    const h = this.lastHealth ?? this.buildHealth();
    const s = this.state();
    const workers = (this.host?.workers ?? [])
      .map(
        (w) =>
          `${w.name} g${w.generation}${w.restarts ? ` (${w.restarts} restarts)` : ''}${w.gaveUp ? ' GAVE UP' : ''}`,
      )
      .join(', ');
    return {
      output: `${this.config?.output.name ?? '?'} (${this.link.outputId})`,
      look: `${this.look.name} [${this.look.id}]`,
      bus: this.link.bus,
      compositor: this.compositor + (this.renderNote ? ` — ${this.renderNote}` : ''),
      resolution: `${this.width}x${this.height}`,
      fps: h.fps,
      presented: h.presented,
      missed: h.missed,
      longTasks: h.longTasks,
      lateFlips: h.lateFlips,
      gpuLost: h.gpuLost,
      videoDropped: h.videoDropped,
      mainStallMs: h.mainThreadStallMs,
      cache: `${h.cache.ready}/${h.cache.total}${this.cacheRepairs ? ` (${this.cacheRepairs} repaired)` : ''}`,
      live: s.live,
      armed: `${s.armed ?? '-'} ${h.armedOk ? 'ok' : h.armError ? `error: ${h.armError}` : 'pending'}`,
      quarantined: this.quarantine.size
        ? [...this.quarantine.keys()].map((k) => k.slice(0, 40)).join(', ')
        : '-',
      fonts: this.fontFallbacks.size ? `fallback for ${[...this.fontFallbacks].join(', ')}` : 'ok',
      workers: workers || '-',
      audio: h.audio ?? (this.config?.output.audioMaster ? 'none' : 'not master'),
      media:
        h.mediaPositionMs !== undefined
          ? `${Math.round(h.mediaPositionMs / 1000)}s / ${Math.round((h.mediaDurationMs ?? 0) / 1000)}s`
          : '-',
      clockOffset: `${Math.round(clock.offset)} ms (rtt ${Math.round(clock.rtt)} ms)`,
      error: h.error ?? '-',
    };
  }
}

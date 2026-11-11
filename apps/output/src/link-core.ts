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
  drawnMediaIds,
  playableFile,
  stillFile,
} from '@ordo/domain';
import { checkInvariants, reduce, startSlideSound } from '@ordo/live-state';
import { APP_VERSION, type OutputConfigRes, type OutputHealth, ROUTES } from '@ordo/protocol';
import {
  type AssetJob,
  type AudioDesc,
  DroppedFrames,
  EMPTY_TELEMETRY,
  FIT_CONTAIN,
  FIT_COVER,
  type FramePlan,
  type FromAsset,
  type FromRender,
  type HeldKeys,
  type JobRole,
  LAYER_INDEX,
  type LayerPlan,
  type MediaDesc,
  type RecentManifest,
  type RenderTelemetry,
  SRC_VIDEO,
  type SlideDesc,
  type ToAsset,
  type ToRender,
  type WarmJob,
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
import { LaneStats } from './lane-stats.ts';
import { SlotPair } from './media.ts';
import { PerfHealth, perfDiagnostics } from './perf-health.ts';
import {
  Downloads,
  type FileBody,
  type FillFailure,
  type StreamStore,
  findCorrupt,
  fillStreaming,
} from './opfs.ts';

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
/** A persisted operator hold is honoured after a reload for at most this long (one long service day). */
const HELD_MAX_AGE_MS = 8 * 60 * 60 * 1000;
/** Cached files are checked against the manifest this often while live. */
const INTEGRITY_EVERY_MS = 30_000;
/** How long a hidden render rebuild may wait for its live content before the hold is removed anyway. */
const COVER_TIMEOUT_MS = 8000;
const IDB_READ_TIMEOUT_MS = 1500;
/** An unavailable file (outage, not cached yet) is retried after 1, 2, 4, 8 s, then every 15 s. */
const UNAVAILABLE_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000];
/** A GPU device rebuild longer than this is treated as a stuck renderer after all. */
const REBUILD_MAX_MS = 15_000;
/** Cache-fill retries of one file that could not be stored: backoff after each failed fill, doubling. */
const FILE_RETRY_BASE_MS = 10_000;
const FILE_RETRY_MAX_MS = 5 * 60_000;
const NETWORK_RETRY_BASE_MS = 4000;
const NETWORK_RETRY_MAX_MS = 30_000;
/** A file the hub does not have (404/410) is tried again after 60 s, doubling to FILE_RETRY_MAX_MS. */
const MISSING_RETRY_BASE_MS = 60_000;
/** A slide drawn without an image is drawn again for a file that arrived at most this often. */
const REFRESH_MIN_MS = 2000;
/** A file that cannot be stored (full disk, storage error) is given up on after this many fills. */
const FILE_ATTEMPTS = 4;
/** A media event replayed by the host is acted on only while this fresh. */
const PENDING_ENDED_MS = 60_000;

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
  /**
   * A restarted link worker (generation > 0): until it has a live state (persisted or from a bus) it
   * changes nothing on screen; the renderer still shows the right picture.
   */
  restarted?: boolean;
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
  /** The current load streams from the hub (no complete copy in the service cache). */
  streamed = false;
  gen = 0;
  /** The current load was told to play since it loaded: it is off its first frame. */
  played = false;
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
  /**
   * Asset jobs sent and not answered, in the order sent. The asset worker's lanes run each layer's jobs in
   * order and the most urgent first (design/27 §7.5), so the first is the likeliest to be the one it was
   * drawing when it stopped answering.
   */
  private assetInflight = new Set<string>();
  /**
   * Bulk work (design/27 §7.5): the warm job last sent (the pictures of the cue after the armed one), the
   * one still running ('' none), and the one the last sync wanted.
   */
  private warmSent = '';
  private warmRunning = '';
  private warmWanted = '';
  /** Per-lane timing of the asset worker's jobs, and the jobs cancelled as superseded. */
  private laneStats = new LaneStats();
  private delivered = new Map<string, number>();
  /** Arm errors by key; the key is not tried again before `until`. */
  private errors = new Map<string, { error: string; at: number; until: number }>();
  /** Consecutive "file unavailable" failures per key (backoff; never quarantined). */
  private unavailable = new Map<string, number>();
  /**
   * Slide keys drawn without some of their images (the hashes whose file was not cached and the hub did
   * not serve): planned again once such a file arrives (design/14 "Slide images that arrive late").
   */
  private missingImages = new Map<string, string[]>();
  /** Keys to draw again although the renderer holds them (a missing image's file arrived). */
  private refreshKeys = new Set<string>();
  private refreshedAt = new Map<string, number>();
  private rearmTimer?: ReturnType<typeof setTimeout>;
  private flips: { key: string; at: number; fadeMs: number; cue: number }[] = [];
  private livePlan?: FramePlan;
  private armedPlan?: FramePlan;
  /** The live slide's click-start sound that waits for F8, preloaded by the audio master. */
  private waitingSound?: AudioDesc;
  private clearSent = '';

  // Quarantine (design/25): keys that failed too often are skipped for the rest of the service.
  private budget = new ErrorBudget(
    { opfs: { max: 5, windowMs: 60_000 }, cache: { max: 8, windowMs: 10 * 60_000 } },
    () => Date.now(),
    {
      max: ARM_FAILURES_BEFORE_QUARANTINE - 1,
      windowMs: 60_000,
    },
  );
  private quarantine = new Map<string, string>();
  private quarantineService = '';
  private fontFallbacks = new Set<string>();
  /**
   * Slide keys drawn in a fallback font, with the families (lower-case) that were not loaded: drawn again
   * once the asset worker reports those families ready (a font added during the service, a retried load).
   */
  private fontFallbackKeys = new Map<string, string[]>();
  /** The asset worker's last font report had failures: the next complete cache fill asks it to retry. */
  private fontsFailed = false;
  /** Slide raster times, characters without a face and budget alarms (design/27 §13, M7). */
  private perf = new PerfHealth();
  private cacheRepairs = 0;

  // Media (mirrors of the host's slots)
  readonly slots = [0, 1, 2, 3, 4, 5].map((i) => new SlotMirror(i));
  private bgPair = new SlotPair<SlotMirror>([this.slots[0]!, this.slots[1]!]);
  private mdPair = new SlotPair<SlotMirror>([this.slots[2]!, this.slots[3]!]);
  private auPair = new SlotPair<SlotMirror>([this.slots[4]!, this.slots[5]!]);
  private prevBgLive = '';
  private prevMdLive = '';
  /** The live media video plays inside its slide (design/27 §7.2). */
  private prevMdInSlide = false;
  private prevAuLive = '';
  /**
   * Slide keys whose clip plays in their box: the media slot and load generation (`slot|gen`, '' none) the
   * last job of the key was drawn for. A key whose clip sits in another slot or generation now is drawn
   * again in place (`refresh`), so its scene never waits on, or shows, another load.
   */
  private sceneVideo = new Map<string, string>();
  private endedSent = new Set<string>();
  /** Ended reports (replayed by the host) that arrived before the live plan was known. */
  private pendingEnded: { key: string; at: number }[] = [];
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
  private downloads = new Downloads();
  /** Per-file fill failures: backoff, and give-up for a file that cannot be stored (review item 10). */
  private fileFail = new Map<string, { n: number; next: number; reason: FillFailure; gaveUp: boolean }>();
  /** Files kept at a size other than the manifest's after every download disagreed: hash -> size. */
  private acceptedSizes = new Map<string, number>();
  private retryFillTimer?: ReturnType<typeof setTimeout>;
  private configReq = 0;
  private configApplied = 0;
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
  /** A GPU device rebuild in progress since (0 none): the no-frame check waits for it. */
  private rebuildingSince = 0;
  private resyncPending = false;
  private invariantResyncs = 0;
  private gaps = 0;
  private awaitingCover = false;
  private coverSince = 0;
  private saving?: Promise<void>;
  private saveAgain = false;
  private viewQueued = false;
  private started = false;
  /** The persisted state has been read (or timed out): planning may start. */
  private persistedRead = false;

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
    const [cfg, saved, recent, accepted, held] = await Promise.all([
      timeout(this.json.get<OutputConfigRes>(`config:${outputId}`)).catch(() => undefined),
      timeout(this.json.get<{ state: LiveState; savedAt: number }>(`state:${outputId}`)).catch(
        () => undefined,
      ),
      timeout(this.json.get<RecentManifest[]>(`manifests:${outputId}`)).catch(() => undefined),
      timeout(this.json.get<[string, number][]>(`accepted:${outputId}`)).catch(() => undefined),
      timeout(this.json.get<{ at: number }>(`held:${outputId}`)).catch(() => undefined),
    ]);
    // A service the operator PC started without the hub: keep ignoring the hub after a reload until the
    // operator lets go (bounded, so a window is never stuck if that operator never comes back).
    if (held && typeof held.at === 'number' && Date.now() - held.at < HELD_MAX_AGE_MS)
      this.link.restoreHeld(true);
    this.link.on('held', ({ held: on, refresh }) => {
      if (!refresh)
        this.diagLog(
          on ? 'the operator holds this service (started without the hub)' : 'operator hold released',
        );
      void (
        on ? this.json.set(`held:${outputId}`, { at: Date.now() }) : this.json.set(`held:${outputId}`, null)
      ).catch(() => undefined);
    });
    if (Array.isArray(accepted))
      for (const [h, n] of accepted.slice(0, 200))
        if (typeof h === 'string' && typeof n === 'number') this.acceptedSizes.set(h, n);
    if (Array.isArray(recent) && !this.recentLoaded) {
      this.recentManifests = recent;
      this.recentLoaded = true;
    }
    this.persistedRead = true;
    if (cfg && !this.config) this.applyConfig(cfg);
    if (saved && Date.now() - saved.savedAt < STATE_CACHE_MAX_AGE_MS && !this.link.mirror.ready) {
      const bad = checkInvariants(saved.state);
      if (bad.length) this.diagLog(`cached state has invariant violations (${bad[0]}); painting it anyway`);
      this.cachedState = saved.state;
      this.onState();
    }
    this.requestSync();

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

  /**
   * Fetch the output config (at start, on every hub `welcome`, on a settings/font/media change). Fetches
   * may overlap; a response older than one already applied is dropped, so a slow stale answer never
   * overwrites a newer config (review 2026-11-04 items 4 and 21).
   */
  private async loadConfig(): Promise<void> {
    const n = ++this.configReq;
    try {
      const cfg = await (this.deps.fetchConfig ?? (() => api<OutputConfigRes>(ROUTES.outputConfig)))();
      if (n < this.configApplied) return;
      this.configApplied = n;
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
    // An asset worker restarted while drawing a job (it missed its heartbeat): that job counts as an arm
    // failure, so a slide whose content blocks the worker is quarantined after a few restarts instead of
    // being sent again until the supervisor gives the worker up for the rest of the service.
    if (assetChanged && !firstStart) {
      const stuck = this.assetInflight.values().next().value;
      if (stuck !== undefined) {
        this.diagLog(`asset worker restarted while drawing ${stuck.slice(0, 60)}`);
        this.armFailed(stuck, 'the asset worker stopped answering while drawing it');
      }
    }
    this.assetInflight.clear();
    // Content travelling through the old channels is lost: forget what was in flight and arm again.
    this.inflight.clear();
    for (const s of this.slots) if (s.waiter) this.inflight.add(s.waiter.key);
    if (renderChanged) {
      this.held = [];
      this.heldSet.clear();
      this.delivered.clear();
      this.flips = [];
      this.clearSent = '';
      this.sceneVideo.clear();
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
      this.rebuildingSince = 0;
      if (!firstStart) {
        this.awaitingCover = true;
        this.coverSince = Date.now();
        this.diagLog(`render worker generation ${gens.render}: re-arming the live and armed cues`);
      }
    }
    if (assetChanged) {
      this.fontsSig = '';
      this.warmSent = '';
      this.warmRunning = '';
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
    this.endedFromHost();
  }

  /**
   * A media element that ended while no link worker was alive (its `ended` event went to a dead worker)
   * is still reported: the host's status says which slots have ended (review 2026-11-04 item 2). Only for
   * the live, playing, non-looping item whose expected position has reached its end, and once per play
   * (`endedSent`); the master-only rule is in onMediaEnded.
   */
  private endedFromHost(): void {
    if (!this.host || !this.livePlan || !this.link.mirror.ready) return;
    const now = clock.now();
    for (const s of this.host.slots) {
      // `ended` outlives a src change until the new file loads: only a loaded element's end counts, and
      // only when the element holds the file the key names (review F4).
      if (!s.ended || !s.key || !s.ready) continue;
      const mirror = this.slotById(s.id);
      if (mirror?.hash && s.hash && s.hash !== mirror.hash) continue;
      const md = this.livePlan.media.desc;
      const au = this.livePlan.audio.desc;
      const d =
        md?.kind === 'video' && md.key === s.key && md.state === 'playing' && !md.loop
          ? md
          : au && au.key === s.key && au.state === 'playing' && !au.loop
            ? au
            : undefined;
      if (!d) continue;
      // An element still ended from an earlier play of the same file is not this play's end.
      const dur =
        (s.hash && mirror?.hash === s.hash ? s.durationMs : undefined) ??
        (d as { durationMs?: number }).durationMs ??
        s.durationMs ??
        0;
      if (now - d.startedAt < dur - 750) continue;
      this.onMediaEnded(s.key);
    }
  }

  private slotById(id: number): SlotMirror | undefined {
    for (const p of [this.bgPair, this.mdPair, this.auPair])
      for (const s of p.slots) if (s.id === id) return s;
    return undefined;
  }

  onMediaEvent(ev: MediaEvent, replay = false): void {
    if (replay) {
      // A previous link generation died with this event queued: only an end still matters (the new
      // generation re-arms everything else itself).
      if (ev.k === 'ended') {
        if (this.livePlan && this.link.mirror.ready) this.onMediaEnded(ev.key);
        else this.pendingEnded.push({ key: ev.key, at: Date.now() });
      }
      return;
    }
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
        this.errors.set(slot.key, { error: ev.error, at: Date.now(), until: Date.now() + ERROR_RETRY_MS });
        return;
      case 'ended':
        if (slot.key === ev.key) this.onMediaEnded(slot.key);
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
      this.fontFallbackKeys.clear();
      this.perf.newService();
      this.unavailable.clear();
      this.missingImages.clear();
      this.refreshKeys.clear();
      this.refreshedAt.clear();
      // A file given up on (full disk) gets a fresh budget with the new service.
      for (const [h, f] of this.fileFail) if (f.gaveUp) this.fileFail.delete(h);
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
    // Nothing is planned before the persisted state is read: an empty state would flip every layer to
    // nothing (black) under a picture the renderer still holds, e.g. right after a link-worker restart.
    if (!this.persistedRead) return;
    if (this.deps.restarted && !this.link.mirror.ready && !this.cachedState && !this.preview) return;
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
    /** The state after a GO to the armed cue: its `armed` is the cue after it (warmed, design/27 §7.5). */
    let afterGo: LiveState | undefined;
    if (state.mode === 'live' && state.armed !== undefined && state.armed !== state.live) {
      try {
        afterGo = reduce(state, { k: 'go', cueIndex: state.armed, at: 0 });
        armed = planFrame(afterGo, look, planOpts);
      } catch {
        armed = undefined;
        afterGo = undefined;
      }
    }
    // The live slide's click-start sound waits for F8 (design/27 §8): the audio master preloads it, paused.
    let waitingSound: AudioDesc | undefined;
    const started = state.mode === 'live' && !this.preview ? startSlideSound(state, 0) : undefined;
    if (started) {
      try {
        waitingSound = planFrame(started, look, planOpts).audio.desc ?? undefined;
      } catch {
        waitingSound = undefined;
      }
    }
    this.livePlan = live;
    this.armedPlan = armed;
    this.waitingSound = waitingSound;
    // Before anything is armed: a video that just left keeps its slot until its fade ends, and the clips
    // playing inside the live and armed slides get their slots (the slide jobs below carry them).
    this.markOutgoing(live);
    this.armSlideClips(live, armed);

    const clearSig = JSON.stringify(look.clearColor);
    if (clearSig !== this.clearSent && this.renderPort) {
      this.clearSent = clearSig;
      this.postRender({ t: 'clear', color: look.clearColor });
    }

    for (const name of PLAN_LAYERS) {
      const lp = live[name] as LayerPlan<{ key: string }>;
      this.ensureContent(name, lp, live, state, 'live');
      const ap = armed?.[name] as LayerPlan<{ key: string }> | undefined;
      if (ap && ap.key !== lp.key) this.ensureContent(name, ap, armed!, state, 'armed');
      // Re-arming a restarted render worker: the hold covers it, and it comes down 200 ms after the live
      // keys are held, so a crossfade into the re-armed content (a late flip fades from its arrival)
      // would be seen half-done. Cuts, until the screen is covered by the renderer again.
      const fade = this.awaitingCover ? 0 : lp.fadeMs;
      this.sendFlip(name, this.shown(lp.key), lp.at, fade, name === 'slide' ? live.slideCue : -1);
    }
    this.syncVideos(live, armed);
    this.syncAudio(live, armed, state);
    if (this.pendingEnded.length && this.link.mirror.ready) {
      const now = Date.now();
      for (const p of this.pendingEnded.splice(0))
        if (now - p.at < PENDING_ENDED_MS) this.onMediaEnded(p.key);
    }
    this.syncProps(false);
    this.syncWarm(afterGo, planOpts);
    this.cancelSuperseded();
    this.checkCover();
  }

  /**
   * Bulk work for the asset worker's raster lanes (design/27 §7.5): the pictures of the cue after the armed
   * one, prepared into its cache while nothing more urgent runs, so arming that cue after the next GO only
   * draws. Sent once per content (its plan keys); a newer one supersedes it (`cancelSuperseded`).
   */
  private syncWarm(afterGo: LiveState | undefined, planOpts: Parameters<typeof planFrame>[2]): void {
    let warm: WarmJob | undefined;
    const next = afterGo?.armed;
    if (afterGo && next !== undefined && next !== afterGo.live) {
      try {
        warm = this.warmJob(
          planFrame(reduce(afterGo, { k: 'go', cueIndex: next, at: 0 }), this.look, planOpts),
        );
      } catch {
        warm = undefined;
      }
    }
    this.warmWanted = warm?.key ?? '';
    if (!warm || warm.key === this.warmSent || !this.assetPort) return;
    // The one still running is superseded: cancelled before this one is sent.
    this.cancelSuperseded();
    this.warmSent = warm.key;
    this.warmRunning = warm.key;
    this.postAsset({ t: 'warm', warm });
  }

  /** What warming a planned cue prepares: its slide's pictures as its slide job asks, and image cues. */
  private warmJob(plan: FramePlan): WarmJob | undefined {
    const d = plan.slide.desc;
    const images = d ? this.slideImages(d.slide, d.nextSlide) : {};
    const sources: string[] = [];
    for (const desc of [plan.background.desc, plan.media.desc])
      if (desc?.kind === 'image' && !sources.includes(desc.hash)) sources.push(desc.hash);
    if (!Object.keys(images).length && !sources.length) return undefined;
    return {
      key: `wm|${plan.slide.key}|${plan.background.key}|${plan.media.key}`,
      ...(d ? { slide: d.slide, nextSlide: d.nextSlide } : {}),
      look: this.look,
      images,
      ...(sources.length ? { sources } : {}),
    };
  }

  /**
   * Cancel the asset jobs that no plan needs any more (design/27 §7.5): the armed cue changed before its
   * job ran (Next pressed quickly), a props second passed, the warm cue moved on. The asset worker drops
   * them, or stops them at their next step, and answers nothing; they are forgotten here at once, so a
   * key needed again later is simply sent again. A slide that waited for a late image keeps waiting for it.
   */
  private cancelSuperseded(): void {
    const need = new Set<string>();
    for (const p of [this.livePlan, this.armedPlan])
      if (p) for (const n of PLAN_LAYERS) need.add((p[n] as LayerPlan<{ key: string }>).key);
    if (this.propsKey) need.add(this.propsKey);
    const gone = [...this.assetInflight].filter((k) => !need.has(k));
    for (const k of gone) {
      this.assetInflight.delete(k);
      this.inflight.delete(k);
      if (this.missingImages.has(k)) this.refreshKeys.add(k);
    }
    if (this.warmRunning && this.warmRunning !== this.warmWanted) {
      gone.push(this.warmRunning);
      this.warmRunning = '';
    }
    if (!gone.length) return;
    this.laneStats.cancelled(gone.length);
    this.postAsset({ t: 'cancel', keys: gone });
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
    return !!e && Date.now() < e.until;
  }

  /**
   * An arm of `key` failed. `unavailable`: its file could not be read (an outage, a file not cached yet):
   * retried with backoff (1, 2, 4, 8, then every 15 s) and never quarantined; the backoff is lifted when
   * a cache fill completes (review 2026-11-04 item 3). Otherwise the content itself failed (decode,
   * raster, invalid data): within the budget it is retried after ERROR_RETRY_MS; past it the key is
   * quarantined for the rest of the service and reported in health (never retried in a loop).
   */
  private armFailed(
    key: string,
    error: string,
    cause: boolean | 'unavailable' | 'missing' | 'invalid' = false,
  ): void {
    const now = Date.now();
    const unavailable = cause === true || cause === 'unavailable' || cause === 'missing';
    if (unavailable) {
      const n = (this.unavailable.get(key) ?? 0) + 1;
      this.unavailable.set(key, n);
      // A file the hub does not have (404/410) is tried again slowly, and said once (review F1).
      const wait =
        cause === 'missing'
          ? Math.min(FILE_RETRY_MAX_MS, MISSING_RETRY_BASE_MS * 2 ** (n - 1))
          : UNAVAILABLE_BACKOFF_MS[Math.min(n, UNAVAILABLE_BACKOFF_MS.length) - 1]!;
      if (cause === 'missing' && this.errors.get(key)?.error !== error)
        this.diagLog(`arm ${key.slice(0, 60)}: ${error}`);
      this.errors.set(key, { error, at: now, until: now + wait });
      setTimeout(() => this.requestSync(), wait + 20);
      return;
    }
    this.errors.set(key, { error, at: now, until: now + ERROR_RETRY_MS });
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
    role: JobRole,
  ): void {
    const key = lp.key;
    if (!key || this.errorBlocks(key) || !this.renderPort) return;
    const layer = LAYER_INDEX[name];
    const video =
      (name === 'background' && plan.background.desc?.kind === 'video') ||
      (name === 'media' && plan.media.desc?.kind === 'video');
    // A slide whose clip plays in its box: a scene drawn for another slot or load generation (none was
    // free then, or the slot was loaded again since) is drawn again in place.
    const scene = name === 'slide' && plan.slide.desc ? this.slideVideo(plan.slide.desc, plan) : undefined;
    const stale = !!scene && this.sceneVideo.get(key) !== sceneSig(scene);
    if (video) {
      // A video key is only valid while a media slot still holds that video (slots are reused).
      const pair = name === 'background' ? this.bgPair : this.mdPair;
      const slot = pair.find(key);
      if (this.inflight.has(key)) return;
      if (slot?.ready && this.has(key)) return;
    } else if (this.has(key) && !this.refreshKeys.has(key) && !stale) return;
    if (this.inflight.has(key) && !stale) return;
    if (name === 'background' && plan.background.desc) {
      const d = plan.background.desc;
      if (d.kind === 'image') this.job({ kind: 'image', layer, key, hash: d.hash, fit: 'cover' }, role);
      else this.armVideo(this.bgPair, layer, key, d.hash, true, FIT_COVER);
    } else if (name === 'slide' && plan.slide.desc) {
      const d = plan.slide.desc;
      // A re-draw for an image that arrived late replaces the renderer's copy in place.
      const images = this.refreshKeys.delete(key);
      if (images) this.refreshedAt.set(key, Date.now());
      const refresh = images || (stale && this.has(key));
      this.sceneVideo.set(key, scene ? sceneSig(scene) : '');
      this.job(
        {
          kind: 'slide',
          layer,
          key,
          cueIndex: d.cueIndex,
          slide: d.slide,
          nextSlide: d.nextSlide,
          isSong: d.isSong,
          presentationKind: d.presentationKind,
          look: this.look,
          images: this.slideImages(d.slide, d.nextSlide),
          refresh: refresh || undefined,
          video: scene,
        },
        role,
      );
    } else if (name === 'lowerThird' && plan.lowerThird.desc) {
      this.job({ kind: 'lowerThird', layer, key, text: plan.lowerThird.desc.text, look: this.look }, role);
    } else if (name === 'media' && plan.media.desc) {
      const d = plan.media.desc;
      if (d.kind === 'image')
        this.job({ kind: 'image', layer, key, hash: d.hash, fit: 'contain', cueIndex: d.cueIndex }, role);
      else this.armVideo(this.mdPair, layer, key, d.hash, d.loop, FIT_CONTAIN, d.cueIndex);
    }
  }

  /**
   * The media slot of the slide's in-slide clip (`d.video`) and the slot's load generation (design/27
   * §7.2), picked synchronously with the same pair.pick armVideo uses: the slide job never waits for the
   * clip to load, so a slow clip never delays the flip. Undefined when no slot is free (both busy fading):
   * the slide is drawn with its poster and drawn again once a slot is armed (`sceneVideo`).
   */
  private slideVideo(
    d: SlideDesc,
    plan: FramePlan,
  ): { objectId: string; slot: number; gen: number; w?: number; h?: number } | undefined {
    const md = plan.media.desc;
    const v = d.video;
    if (!v || md?.kind !== 'video' || !md.inSlide || md.cueIndex !== d.cueIndex) return undefined;
    this.armInSlide(md);
    const slot = this.inSlideSlot(md);
    if (!slot) return undefined;
    const size = v.w && v.h ? { w: v.w, h: v.h } : {};
    return { objectId: v.objectId, slot: slot.id, gen: slot.gen, ...size };
  }

  /**
   * The clips playing inside the live and armed slides are armed on every output, not only on the audio
   * master (design/27 §7.2): in the media pair under the media desc key, so transport, routing, holdPaused,
   * protection and `media.ended` find them as for a media video.
   */
  private armSlideClips(...plans: (FramePlan | undefined)[]): void {
    for (const p of plans) {
      const md = p?.media.desc;
      if (md?.kind === 'video' && md.inSlide) this.armInSlide(md);
    }
  }

  /** Arm an in-slide clip unless a slot holds it: muted unless the audio master, never offered as SRC_VIDEO. */
  private armInSlide(md: MediaDesc): void {
    if (this.inSlideSlot(md) || this.inflight.has(md.key) || this.errorBlocks(md.key)) return;
    this.armVideo(this.mdPair, LAYER_INDEX.media, md.key, md.hash, md.loop, FIT_CONTAIN, md.cueIndex, false);
  }

  /** The media slot holding an in-slide clip, loaded or loading. */
  private inSlideSlot(md: MediaDesc): SlotMirror | undefined {
    const slot = this.mdPair.find(md.key);
    return slot && (slot.ready || slot.waiter) ? slot : undefined;
  }

  /**
   * mediaId -> file hash of every picture the slides draw (`drawnMediaIds`: the slide's picture, its
   * PowerPoint reference picture or imported page, then its image objects, only the operator's own on a
   * reference picture; design/27 §5): an image itself, a video's poster (an ImageObject whose media is a
   * video shows its poster, as thumbnails and the editor do; design/27 §8).
   */
  private slideImages(...slides: (Slide | undefined)[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const s of slides) {
      if (!s) continue;
      for (const id of drawnMediaIds(s)) {
        const m = this.mediaById(id);
        const f = m ? stillFile(m) : undefined;
        if (f) out[id] = f.hash;
      }
    }
    return out;
  }

  /** Send a job to the asset worker; `role`: whether it draws for the live or the armed cue (its lane). */
  private job(job: AssetJob, role?: JobRole): void {
    if (!this.assetPort) return;
    this.inflight.add(job.key);
    this.assetInflight.delete(job.key);
    this.assetInflight.add(job.key);
    this.postAsset(role ? { t: 'job', job, role } : { t: 'job', job });
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
    slot.played = false;
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
      slot.streamed = !blob;
      this.media({ k: 'load', slot: slot.id, key, hash, blob, url: fileUrl(hash), loop, muted, gen });
    })();
    return promise;
  }

  /**
   * Load a video into a slot of `pair` and, once its first frame is there, offer it to the renderer as
   * SRC_VIDEO content of `layer`. `render: false` (a clip playing inside its slide) never offers it: the
   * slide's scene draws the slot.
   */
  private armVideo(
    pair: SlotPair<SlotMirror>,
    layer: number,
    key: string,
    hash: string,
    loop: boolean,
    fit: number,
    cueIndex?: number,
    render = true,
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
    // A file the fill found missing on the hub (404/410) is not streamed into an element: the element
    // would report a format error every few seconds (review F1). Tried again on the slow backoff.
    if (this.fileFail.get(hash)?.reason === 'missing' && !(slot.key === key && slot.ready)) {
      this.armFailed(key, `file ${hash.slice(0, 8)} missing on the hub (HTTP 404)`, 'missing');
      return;
    }
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
        this.errors.delete(key);
        this.unavailable.delete(key);
        if (render) {
          this.delivered.set(key, Date.now());
          // A media video hidden by this look still plays (for audio) but is not offered to the renderer.
          const visible =
            layer !== LAYER_INDEX.media ||
            this.livePlan?.media.key === key ||
            this.armedPlan?.media.key === key;
          if (visible)
            this.postRender({ t: 'content', layer, key, kind: SRC_VIDEO, videoSlot: slot.id, fit, cueIndex });
        }
        this.syncVideos(this.livePlan, this.armedPlan);
      })
      .catch((err: Error) => {
        this.inflight.delete(key);
        this.diagLog(`arm ${key}: ${err.message}`);
        // Streaming a file the cache does not hold yet fails during an outage (a network error, or an
        // HTTP error the element reports as "not supported"): unavailable, not invalid.
        const unavailable = slot.streamed || /timed out/.test(err.message);
        const missing = unavailable && this.fileFail.get(hash)?.reason === 'missing';
        this.armFailed(key, err.message, missing ? 'missing' : unavailable);
        // A cached copy that does not play may be corrupt: drop it so the next arm streams a fresh one.
        if (!unavailable) void this.dropCached(hash, `video ${hash.slice(0, 8)} failed to load`);
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
    if (pair === this.auPair && this.waitingSound) keys.push(this.waitingSound.key);
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

  /**
   * The live background and media videos that just left: paused when their fade ends and not reused before
   * (`busyUntil`). Runs before anything is armed in a sync, so the next clip never takes the slot of one
   * still fading out. An in-slide clip leaves with its slide: it plays on while the slide layer fades it
   * out, then its picture leaves the renderer (`vclear`), so a slide still on screen (Clear media, onEnd
   * 'black') shows its poster.
   */
  private markOutgoing(live: FramePlan): void {
    const now = clock.now();
    const bgKey = live.background.desc?.kind === 'video' ? live.background.key : '';
    if (bgKey !== this.prevBgLive) {
      const old = this.bgPair.find(this.prevBgLive);
      if (old) {
        this.pauseAt(old, live.background.at + live.background.fadeMs);
        old.busyUntil = Math.max(now, live.background.at) + live.background.fadeMs + 100;
      }
      this.prevBgLive = bgKey;
    }
    const md = live.media.desc?.kind === 'video' ? live.media.desc : undefined;
    const mdKey = md?.key ?? '';
    if (mdKey !== this.prevMdLive) {
      const old = this.mdPair.find(this.prevMdLive);
      if (old) {
        const slideFade = this.prevMdInSlide && live.slide.at >= live.media.at ? live.slide.fadeMs : 0;
        const fadeMs = Math.max(live.media.fadeMs, slideFade);
        // On clear-all the sound fades over 500 ms; keep the element running until then.
        const pauseAt = live.media.at + Math.max(fadeMs, live.black ? 520 : 0);
        this.pauseAt(old, pauseAt);
        old.busyUntil = Math.max(now, live.media.at) + fadeMs + 100;
        // GO then a quick Prev: the clip that left is the armed one again. Its picture stays (it is the
        // outgoing side of the fade, and armed), and it goes back to its first frame when the fade ends.
        const armedMd = this.armedPlan?.media.desc;
        if (armedMd && old.key === armedMd.key) this.rewindAt(old, old.key, armedMd.loop, pauseAt);
        else if (this.prevMdInSlide) this.media({ k: 'vclear', slot: old.id, key: old.key, at: pauseAt });
      }
      this.prevMdLive = mdKey;
    }
    this.prevMdInSlide = !!md?.inSlide;
  }

  private syncVideos(live?: FramePlan, armed?: FramePlan): void {
    if (!live) return;
    this.markOutgoing(live);
    // Backgrounds: loop, muted, keep playing across slides; synced to the layer's start time.
    const bg = live.background.desc?.kind === 'video' ? live.background : undefined;
    const bgSlot = this.bgPair.find(bg?.key ?? '');
    if (bg && bgSlot) this.apply(bgSlot, { state: 'playing', startedAt: bg.at, positionMs: 0, loop: true });

    // Media video: transport from the reducer state; audio through the engine on the master. A clip
    // playing inside its slide is found by its desc key exactly the same way (armSlideClips arms it).
    const md = live.media.desc?.kind === 'video' ? live.media.desc : undefined;
    const mdKey = md?.key ?? '';
    const mdSlot = this.mdPair.find(mdKey);
    if (
      md &&
      !md.inSlide &&
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
      if (mdSlot.ready && md.state === 'playing') mdSlot.played = true;
      if (hiddenWhileStopped(md)) this.media({ k: 'vclear', slot: mdSlot.id, key: md.key });
    }
    // Armed media video stays paused on its first frame. One that played (it was live: GO then Prev) is
    // sought back to it; while it still fades out as the outgoing side, markOutgoing does that at the fade
    // end, so the fade never shows it frozen or jumping.
    const amd = armed?.media.desc?.kind === 'video' ? armed.media.desc : undefined;
    const amSlot = amd && amd.key !== mdKey ? this.mdPair.find(amd.key) : undefined;
    if (amd && amSlot?.ready && amSlot.busyUntil <= clock.now()) {
      if (amSlot.played) this.rewindAt(amSlot, amSlot.key, amd.loop);
      else this.media({ k: 'holdPaused', slot: amSlot.id });
    }
    if (amd && amSlot && hiddenWhileStopped(amd)) this.media({ k: 'vclear', slot: amSlot.id, key: amd.key });
  }

  /**
   * Pause the media slot holding `key` on its first frame (`apply` paused at 0 seeks there, and the
   * renderer gets that frame), at hub time `at` or now, unless by then it is live again or holds another
   * clip.
   */
  private rewindAt(slot: SlotMirror, key: string, loop: boolean, at?: number): void {
    const run = () => {
      if (slot.key !== key || !slot.ready || this.livePlan?.media.desc?.key === key) return;
      slot.played = false;
      this.media({
        k: 'apply',
        slot: slot.id,
        transport: { state: 'paused', startedAt: 0, positionMs: 0, loop },
      });
    };
    const delay = at === undefined ? 0 : at - clock.now();
    if (delay > 2) setTimeout(run, delay);
    else run();
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
    const waiting = this.waitingSound && this.waitingSound.key !== key ? this.waitingSound : undefined;
    const want = [
      a,
      waiting,
      armed?.audio.desc && armed.audio.desc.key !== key ? armed.audio.desc : undefined,
    ];
    for (const d of want) {
      if (!d || this.auPair.find(d.key) || this.inflight.has(d.key) || this.errorBlocks(d.key)) continue;
      const slot = this.auPair.pick(d.key, protect, clock.now());
      if (!slot) continue;
      this.inflight.add(d.key);
      this.loadSlot(slot, d.key, d.hash, d.loop, false)
        .then(() => {
          this.inflight.delete(d.key);
          this.unavailable.delete(d.key);
          this.requestSync();
        })
        .catch((err: Error) => {
          this.inflight.delete(d.key);
          this.armFailed(d.key, err.message, slot.streamed || /timed out/.test(err.message));
        });
    }
    const slot = this.auPair.find(key);
    if (a && slot) {
      this.routeAudio(slot, a.audio);
      this.apply(slot, { state: a.state, startedAt: a.startedAt, positionMs: a.positionMs, loop: a.loop });
    }
  }

  /** The element playing `key` ended: report it for the live item (the audio master only, once per play). */
  private onMediaEnded(key: string): void {
    if (!this.config?.output.audioMaster) return;
    const live = this.livePlan;
    if (!live) return;
    const md = live.media.desc;
    if (md && md.kind === 'video' && key === md.key && md.state === 'playing' && !md.loop) {
      const id = `m|${md.key}|${md.startedAt}`;
      if (this.endedSent.has(id)) return;
      this.endedSent.add(id);
      // Queued by the link until a bus is up (review item 25).
      this.link.sendEvent({ k: 'media.ended', cueIndex: md.cueIndex, at: clock.now() });
      this.diagLog(`media.ended cue ${md.cueIndex}`);
      return;
    }
    const au = live.audio.desc;
    if (au && key === au.key && au.state === 'playing' && !au.loop) {
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
      // A props job of an earlier second still waiting is superseded by this one.
      if (fromTick) this.cancelSuperseded();
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
    for (const m of this.preview?.media ?? [])
      for (const f of [playableFile(m), m.poster])
        if (f) files.set(f.hash, { hash: f.hash, bytes: f.bytes, mime: f.mime });
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
      if (!res.ok || !res.body) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
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
    // The previous fill's queue stops; of its downloads only those whose file left the manifest are
    // cancelled, the rest keep going and this fill joins them (review 2026-11-04 item 11).
    this.fillAbort?.abort();
    clearTimeout(this.retryFillTimer);
    const ac = new AbortController();
    this.fillAbort = ac;
    const cancelled = this.downloads.retain(new Set(files.map((f) => f.hash)));
    if (cancelled) this.diagLog(`cache: ${cancelled} download(s) cancelled (no longer in the manifest)`);
    // Files in backoff after a failed fill (or given up on: a full disk) are not fetched this time.
    const now = Date.now();
    const due = files.filter((f) => {
      const ff = this.fileFail.get(f.hash);
      return !ff || (!ff.gaveUp && ff.next <= now);
    });
    const deferred = files.length - due.length;
    // Fonts first, then images, then everything else (videos).
    const rank = (f: ManifestFile) => (fontHashes.has(f.hash) ? 0 : f.mime.startsWith('image/') ? 1 : 2);
    const sorted = [...due].sort((a, b) => rank(a) - rank(b));
    const total = new Set(files.map((f) => f.hash)).size;
    this.cacheProgress = { ready: 0, total };
    const t0 = performance.now();
    let p: Awaited<ReturnType<typeof fillStreaming>>;
    try {
      p = await fillStreaming(
        this.store,
        sorted,
        (h, signal) => this.fetchBody(h, signal),
        (pr) => {
          if (ac.signal.aborted) return;
          this.cacheProgress = { ready: pr.ready, total };
        },
        {
          concurrency: 3,
          retries: 2,
          signal: ac.signal,
          onStoreError: (e) => this.storeError(e),
          accepted: this.acceptedSizes,
          downloads: this.downloads,
        },
      );
    } catch (err) {
      this.diagLog(`cache fill failed: ${(err as Error).message}`);
      return;
    }
    if (ac.signal.aborted) return;
    this.cacheProgress = { ready: p.ready, total };
    if (p.repaired.length) {
      this.cacheRepairs += p.repaired.length;
      this.diagLog(`cache: ${p.repaired.length} corrupt file(s) fetched again`);
    }
    this.noteFillOutcome(sorted, p.failures, p.mismatched);
    const failed = p.failed.length + deferred;
    this.diagLog(
      `cache: ${p.ready}/${total} files in ${Math.round(performance.now() - t0)} ms${failed ? `, ${failed} not cached` : ''}`,
    );
    if (failed) this.scheduleFillRetry(ac);
    else if (mayPrune(live, failed)) {
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
    // Keys that failed for want of a file get a fresh chance at once (quarantined ones stay quarantined):
    // all of them when the fill completed, else those whose file is now cached (review item 3).
    if (!failed) {
      this.errors.clear();
      this.unavailable.clear();
    } else {
      const cached = sorted.filter((f) => !p.failures[f.hash]).map((f) => f.hash);
      for (const k of [...this.errors.keys()])
        if (cached.some((h) => k.includes(h))) {
          this.errors.delete(k);
          this.unavailable.delete(k);
        }
    }
    await this.rearmMissing();
    // A font the asset worker could not read may be in the cache now: it retries the failed ones at once.
    if (!failed && this.fontsFailed) {
      this.fontsSig = '';
      this.ensureFiles();
    }
    this.requestSync();
  }

  /**
   * Slides drawn without an image: once a missing image's file is in the cache, the key is planned again
   * (`refresh`) and the renderer swaps its held copy in place, without a flip (design/14). Checked after
   * every fill (a hub fill or a fallback-bus file lands in the same store) and when the asset worker
   * reports the gap, since the file may have arrived while the job ran. A key is re-drawn at most once per
   * REFRESH_MIN_MS, so a cached file the asset worker still cannot read never becomes a tight loop.
   */
  private async rearmMissing(): Promise<void> {
    let changed = false;
    let later = false;
    const now = Date.now();
    for (const [key, hashes] of [...this.missingImages]) {
      if (this.refreshKeys.has(key)) continue;
      if (now - (this.refreshedAt.get(key) ?? 0) < REFRESH_MIN_MS) {
        later = true;
        continue;
      }
      let arrived = false;
      for (const h of hashes) {
        const size = await this.store.size(h).catch(() => undefined);
        if (size !== undefined && size > 0) arrived = true;
      }
      if (arrived && this.missingImages.has(key)) {
        this.refreshKeys.add(key);
        changed = true;
      }
    }
    if (later && !this.rearmTimer)
      this.rearmTimer = setTimeout(() => {
        this.rearmTimer = undefined;
        void this.rearmMissing();
      }, REFRESH_MIN_MS);
    if (changed) this.requestSync();
  }

  /**
   * Per-file bookkeeping after a fill (review 2026-11-04 item 10): a file that failed backs off
   * (10 s doubling to 5 min); one that cannot be stored (full disk, storage error) is given up on after
   * FILE_ATTEMPTS fills, or at once when the cache budget is spent; both are counted in the error budget
   * and shown red in health. A size the manifest disagrees with is accepted once and remembered.
   */
  private noteFillOutcome(
    tried: ManifestFile[],
    failures: Record<string, FillFailure>,
    mismatched: Record<string, number>,
  ): void {
    const now = Date.now();
    for (const f of tried) {
      const reason = failures[f.hash];
      if (!reason) {
        this.fileFail.delete(f.hash);
        continue;
      }
      const prev = this.fileFail.get(f.hash);
      const n = (prev?.n ?? 0) + 1;
      // A download that arrives empty every time is treated like a storage failure: counted, and given
      // up on after FILE_ATTEMPTS fills instead of being retried every 30 s for ever (review F10).
      const storage = reason === 'quota' || reason === 'store' || reason === 'size';
      let gaveUp = false;
      if (storage) {
        const b = this.budget.record('cache', `${reason}: ${f.hash.slice(0, 8)}`);
        gaveUp = n >= FILE_ATTEMPTS || b.exceeded;
        if (gaveUp) this.diagLog(`cache: giving up on ${f.hash.slice(0, 8)} (${reason}, ${n} attempts)`);
      } else if (reason === 'missing') {
        // Not on the hub (404/410): logged once, counted, tried again slowly; a fill after a manifest
        // change or the backoff fetches it again (review F1).
        this.budget.record('cache', `missing: ${f.hash.slice(0, 8)}`);
        if (prev?.reason !== 'missing')
          this.diagLog(`cache: ${f.hash.slice(0, 8)} missing on the hub (HTTP 404)`);
      }
      // A network failure (outage, slow NAS) is retried sooner than a storage one.
      const wait = storage
        ? Math.min(FILE_RETRY_MAX_MS, FILE_RETRY_BASE_MS * 2 ** (n - 1))
        : reason === 'missing'
          ? Math.min(FILE_RETRY_MAX_MS, MISSING_RETRY_BASE_MS * 2 ** (n - 1))
          : Math.min(NETWORK_RETRY_MAX_MS, NETWORK_RETRY_BASE_MS * 2 ** (n - 1));
      this.fileFail.set(f.hash, { n, next: now + wait, reason, gaveUp });
    }
    let accepted = false;
    for (const [h, size] of Object.entries(mismatched)) {
      if (this.acceptedSizes.get(h) === size) continue;
      this.acceptedSizes.set(h, size);
      accepted = true;
      this.budget.record('cache', `size: ${h.slice(0, 8)}`);
      this.diagLog(`cache: ${h.slice(0, 8)} is ${size} bytes, not the manifest's size; kept as it is`);
    }
    if (accepted)
      void this.json
        .set(`accepted:${this.link.outputId}`, [...this.acceptedSizes].slice(-200))
        .catch(() => undefined);
  }

  /** Fill again when the earliest file in backoff is due (never for files given up on). */
  private scheduleFillRetry(ac: AbortController): void {
    let next = Number.POSITIVE_INFINITY;
    for (const h of this.manifestFiles.map((f) => f.hash)) {
      const ff = this.fileFail.get(h);
      if (ff && !ff.gaveUp) next = Math.min(next, ff.next);
    }
    if (!Number.isFinite(next)) return;
    clearTimeout(this.retryFillTimer);
    this.retryFillTimer = setTimeout(
      () => {
        if (this.fillAbort === ac) {
          this.manifestSig = '';
          this.ensureFiles();
        }
      },
      Math.max(1000, next - Date.now() + 50),
    );
  }

  /** Health errors of the service cache: files not stored, sizes kept against the manifest. */
  private cacheErrors(): string[] {
    const out: string[] = [];
    const want = new Set(this.manifestFiles.map((f) => f.hash));
    let quota = 0;
    let store = 0;
    let gaveUp = 0;
    let missing = 0;
    let empty = 0;
    for (const [h, f] of this.fileFail) {
      if (!want.has(h)) continue;
      if (f.reason === 'quota') quota++;
      else if (f.reason === 'store') store++;
      else if (f.reason === 'missing') missing++;
      else if (f.reason === 'size') empty++;
      if (f.gaveUp) gaveUp++;
    }
    if (quota) out.push(`storage full: ${quota} file(s) not cached${gaveUp ? ' (gave up)' : ''}`);
    else if (store)
      out.push(`cache storage failing: ${store} file(s) not cached${gaveUp ? ' (gave up)' : ''}`);
    if (missing) out.push(`${missing} file(s) missing on the hub (HTTP 404)`);
    if (empty) out.push(`${empty} file(s) arrive empty from the hub`);
    let sized = 0;
    for (const f of this.manifestFiles) {
      const a = this.acceptedSizes.get(f.hash);
      if (a !== undefined && f.bytes && a !== f.bytes) sized++;
    }
    if (sized) out.push(`${sized} cached file(s) differ in size from the manifest`);
    if (this.budget.exceeded('cache')) out.push('cache error budget exceeded');
    return out;
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
    const bad = await findCorrupt(this.store, this.manifestFiles, this.acceptedSizes).catch(
      () => [] as string[],
    );
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
        // A slide the renderer no longer holds needs no re-draw for its late images.
        for (const k of this.missingImages.keys()) if (!this.has(k)) this.missingImages.delete(k);
        for (const k of this.fontFallbackKeys.keys()) if (!this.has(k)) this.fontFallbackKeys.delete(k);
        for (const k of this.refreshKeys) if (!this.has(k)) this.refreshKeys.delete(k);
        for (const k of this.sceneVideo.keys()) if (!this.has(k)) this.sceneVideo.delete(k);
        this.requestSync();
        this.queueView();
        return;
      }
      case 'lost':
        // A rebuild may take seconds: it is not a stuck renderer (review 2026-11-04 item 8).
        this.diagLog(`GPU device lost: ${m.reason}; rebuilding`);
        this.rebuildingSince = Date.now();
        this.renderStartedAt = Date.now();
        return;
      case 'restored':
        this.compositor = m.compositor;
        if (m.compositor === 'webgpu') this.renderNote = undefined;
        this.diagLog(`renderer restored (${m.compositor})`);
        this.rebuildingSince = 0;
        this.renderStartedAt = Date.now();
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
        this.assetInflight.delete(m.key);
        this.delivered.set(m.key, Date.now());
        if (m.lane) this.laneStats.add(m.lane, m.waitMs ?? 0, m.busyMs ?? 0, m.longestMs ?? 0);
        this.errors.delete(m.key);
        this.unavailable.delete(m.key);
        for (const f of m.fontFallbacks ?? []) {
          if (!this.fontFallbacks.has(f) && this.fontFallbacks.size < 20) {
            this.fontFallbacks.add(f);
            this.diagLog(`font "${f}" is not loaded: drawn in the fallback font`);
          }
        }
        // Only slide keys can be drawn again in place (`refresh`).
        if (m.fontFallbacks?.length && m.key.startsWith('sl|'))
          this.fontFallbackKeys.set(m.key, m.fontFallbacks.slice(0, 20));
        else this.fontFallbackKeys.delete(m.key);
        {
          const line = this.perf.done(m);
          if (line) this.diagLog(line);
        }
        if (m.skippedImages)
          this.diagLog(`${m.key.slice(0, 60)}: ${m.skippedImages} image(s) over the cue budget`);
        if (m.missingImages?.length) {
          if (!this.missingImages.has(m.key))
            this.diagLog(
              `${m.key.slice(0, 60)}: drawn without ${m.missingImages.length} image(s) not cached yet`,
            );
          this.missingImages.set(m.key, m.missingImages.slice(0, 20));
          // The file may have arrived while the job ran: check now, not only after the next fill.
          void this.rearmMissing();
        } else if (this.missingImages.delete(m.key))
          this.diagLog(`${m.key.slice(0, 60)}: drawn again with its images`);
        return;
      case 'error': {
        this.inflight.delete(m.key);
        this.assetInflight.delete(m.key);
        if (m.cause !== 'missing') this.diagLog(`arm ${m.key.slice(0, 60)}: ${m.error}`);
        const unavailable = m.cause === 'unavailable' || m.cause === 'missing';
        this.armFailed(m.key, m.error, m.cause === 'missing' ? 'missing' : unavailable);
        if (m.hash && m.source === 'opfs')
          void this.dropCached(m.hash, `cached ${m.hash.slice(0, 8)} failed to decode`);
        if (!unavailable) setTimeout(() => this.requestSync(), ERROR_RETRY_MS + 50);
        return;
      }
      case 'warmed':
        if (m.key === this.warmRunning) this.warmRunning = '';
        this.laneStats.add('bulk', m.waitMs, m.busyMs, m.longestMs);
        return;
      case 'fonts':
        this.diagLog(
          `fonts loaded: ${m.loaded}${m.failed.length ? `, failed: ${m.failed.join(', ')}` : ''}${m.ready?.length ? `; ready: ${m.ready.join(', ')}` : ''}`,
        );
        this.fontsFailed = m.failed.length > 0;
        if (m.ready?.length) this.fontsReady(m.ready);
        return;
    }
  }

  /**
   * Families became available in the asset worker (design/27 §10): they no longer count as fallbacks, and
   * slides the renderer holds that were drawn without them are drawn again in place.
   */
  private fontsReady(families: string[]): void {
    const ready = new Set(families);
    for (const f of ready) this.fontFallbacks.delete(f);
    let changed = false;
    for (const [key, missing] of this.fontFallbackKeys) {
      if (!missing.some((f) => ready.has(f))) continue;
      this.fontFallbackKeys.delete(key);
      if (!this.has(key)) continue;
      this.refreshKeys.add(key);
      changed = true;
    }
    // A face that loaded may have the characters no face had: those slides are drawn again too.
    for (const key of this.perf.fontsReady()) {
      if (!key.startsWith('sl|') || !this.has(key)) continue;
      this.refreshKeys.add(key);
      changed = true;
    }
    if (changed) this.requestSync();
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

  /**
   * Keys the live and armed frames need. A quarantined key is still required: the layer shows nothing
   * instead of it, so the cue is not armed (`armedOk` false, the key in `health.quarantined`).
   */
  private armRequired(): string[] {
    const keys: string[] = [];
    for (const p of [this.livePlan, this.armedPlan]) {
      if (!p) continue;
      for (const name of PLAN_LAYERS) keys.push((p[name] as LayerPlan<unknown>).key);
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
    for (const [k, v] of this.quarantine) errMap.set(k, `quarantined: ${v}`);
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
    if (this.missingImages.size)
      errors.push(`${this.missingImages.size} slide(s) drawn without image(s) not cached yet`);
    errors.push(...this.cacheErrors());
    if (host?.reloadRefused) errors.push(host.reloadRefused);
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
      raster: this.perf.raster.summary(),
      rasterAlarm: this.perf.rasterAlarm.summary(),
      rasterHeavy: this.perf.rasterHeavy,
      size: { width: this.width, height: this.height },
      fontCoverage: this.perf.fontCoverage(),
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
    for (const line of this.perf.alarmChanges(h, `${this.width}x${this.height}`)) this.diagLog(line);
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
    if (this.rebuildingSince && now - this.rebuildingSince < REBUILD_MAX_MS) {
      this.presentedSeen.at = now;
      return;
    }
    if (!painting || now - this.renderStartedAt < RENDER_GRACE_MS || this.compositor === 'none') return;
    if (now - this.presentedSeen.at < NO_FRAME_MS) return;
    this.presentedSeen.at = now;
    this.stallRestarts = this.stallRestarts.filter((t) => now - t < STALL_RELOAD_WINDOW_MS);
    if (this.stallRestarts.length) {
      this.diagLog('renderer stalled again: reloading the window');
      // A refused reload (budget spent) restarts the render worker instead (review 2026-11-04 item 9).
      this.post({ t: 'reload', reason: 'no frame presented for 3 s while live (twice)', fallback: 'render' });
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
      // The slide cue on screen and the hub time of the frame that first drew it (e2e flip skew).
      slideFlip: { cue: this.tel.slideCue ?? -1, at: this.tel.slideFlipAt ?? 0 },
      resyncs: this.gaps,
      invariantResyncs: this.invariantResyncs,
      // The asset worker's raster lanes (design/27 §7.5): per-lane wait and busy percentiles.
      lanes: this.laneStats.summary(),
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
      warm: { sent: this.warmSent, running: this.warmRunning },
      errors: Object.fromEntries([...this.errors].map(([k, v]) => [k, v.error])),
      quarantined: [...this.quarantine.keys()],
      missingImages: Object.fromEntries(this.missingImages),
      scenes: Object.fromEntries(this.sceneVideo),
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
      gpuMB: h.gpuMB,
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
      ...perfDiagnostics(h),
      rasterLanes: this.laneStats.line(),
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

/** The slot and load generation a slide's scene was drawn for. */
function sceneSig(v: { slot: number; gen: number }): string {
  return `${v.slot}|${v.gen}`;
}

/**
 * An in-slide clip with "Hide while not playing" (`showWhenStopped: false`) shows no frame while the
 * reducer's state is not 'playing' (design/27 §8 "Output"); its slide's base has no poster either.
 */
function hiddenWhileStopped(md: MediaDesc): boolean {
  return md.inSlide?.showWhenStopped === false && md.state !== 'playing';
}

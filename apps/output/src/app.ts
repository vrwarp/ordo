import { AudioEngine, type SourceHandle } from '@ordo/audio';
import { type FillProgress, type FileStore, JsonStore, OpfsStore, fillCache, requestPersistence } from '@ordo/cache';
import { OutputLink, api, clock, fileUrl } from '@ordo/client';
import {
  type Font,
  LOOK_MAIN,
  DEFAULT_LOOKS,
  type LiveState,
  type Look,
  type ManifestFile,
  type Media,
  type Slide,
  playableFile,
} from '@ordo/domain';
import { reduce } from '@ordo/live-state';
import { API_PREFIX, APP_VERSION, type OutputConfigRes, type OutputHealth, ROUTES } from '@ordo/protocol';
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
  type RenderTelemetry,
  SRC_VIDEO,
  type ToAsset,
  type ToRender,
  armStatus,
  buildHealth,
  fontLoads,
  lookSignature,
  msToNextSecond,
  planFrame,
  propsModel,
  resolveLook,
} from '@ordo/renderer';
import { Diagnostics } from './diagnostics.ts';
import { MediaSlot, SlotPair } from './media.ts';
import { ProgramSender } from './program.ts';

const DELIVERED_GRACE_MS = 1500;
const ERROR_RETRY_MS = 3000;
const STATE_CACHE_MAX_AGE_MS = 12 * 3600_000;

export type OutputOptions = {
  canvas: HTMLCanvasElement;
  hold: HTMLCanvasElement;
  mediaBox: HTMLElement;
  width: number;
  height: number;
  testMode: boolean;
  forceCanvas2d: boolean;
};

type PlanLayer = 'background' | 'slide' | 'lowerThird' | 'media';
const PLAN_LAYERS: PlanLayer[] = ['background', 'slide', 'lowerThird', 'media'];

/**
 * The output window's main thread: owns the link, the workers, the media elements and the audio engine.
 * Every state, config or cache change runs `sync()`, which plans the live and armed frames for this
 * output's look, prepares any content the render worker does not hold, and schedules the flips.
 */
export class OutputApp {
  readonly link: OutputLink;
  readonly diag: Diagnostics;
  private render: Worker;
  private asset: Worker;
  private program: ProgramSender;
  private store: FileStore = new OpfsStore();
  private json = new JsonStore('ordo-output');

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

  // Media
  private slots: MediaSlot[] = [];
  private bgPair: SlotPair;
  private mdPair: SlotPair;
  private auPair: SlotPair;
  private prevBgLive = '';
  private prevMdLive = '';
  private prevAuLive = '';
  private endedSent = new Set<string>();
  private dropped = new DroppedFrames();
  private engine?: AudioEngine;
  private engineStarted = false;
  private handles = new Map<HTMLMediaElement, SourceHandle>();
  private wasBlack = false;

  // Props
  private propsKey = '';
  private propsSeq = -1;
  private propsTimer?: ReturnType<typeof setTimeout>;

  // Cache
  private manifestSig = '';
  private fillAbort?: AbortController;
  private cacheProgress: { ready: number; total: number } = { ready: 0, total: 0 };
  private fontsSig = '';

  // Telemetry
  private tel: RenderTelemetry = { ...EMPTY_TELEMETRY };
  private frames: number[] = [];
  private mainLongTasks = 0;
  private lastHealth?: OutputHealth;
  private lastSnapshot?: ImageBitmap;
  private lost = false;
  private clockOffsetSent = Number.NaN;
  private syncQueued = false;

  constructor(private opts: OutputOptions) {
    this.link = new OutputLink({ role: 'output', appVersion: APP_VERSION });
    this.diag = new Diagnostics(() => this.diagnostics());
    this.program = new ProgramSender(this.link);
    this.program.onActiveChange = () => this.updateSnapshotRate();

    const mk = (id: number, video: boolean): MediaSlot => {
      const el = document.createElement(video ? 'video' : 'audio');
      el.muted = true;
      opts.mediaBox.appendChild(el);
      return new MediaSlot(id, el, {
        hubNow: () => clock.now(),
        getBlob: (h) => this.store.get(h),
        fileUrl: (h) => fileUrl(h),
        onFrame: video ? (slot, frame) => this.postRender({ t: 'vframe', slot, frame }, [frame]) : undefined,
        onEnded: (s) => this.onMediaEnded(s),
        onError: (s, e) => {
          this.diag.log(`media slot ${s.id} (${s.key}): ${e}`);
          if (s.key) this.errors.set(s.key, { error: e, at: Date.now() });
        },
        log: (m) => this.diag.log(m),
      });
    };
    this.slots = [mk(0, true), mk(1, true), mk(2, true), mk(3, true), mk(4, false), mk(5, false)];
    this.bgPair = new SlotPair([this.slots[0]!, this.slots[1]!]);
    this.mdPair = new SlotPair([this.slots[2]!, this.slots[3]!]);
    this.auPair = new SlotPair([this.slots[4]!, this.slots[5]!]);

    this.render = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module', name: 'ordo-render' });
    this.asset = new Worker(new URL('./asset.worker.ts', import.meta.url), { type: 'module', name: 'ordo-asset' });
    this.render.onmessage = (ev: MessageEvent<FromRender>) => this.onRender(ev.data);
    this.asset.onmessage = (ev: MessageEvent<FromAsset>) => this.onAsset(ev.data);
    this.render.onerror = (ev) => this.onFatal(`render worker: ${ev.message}`);
    this.asset.onerror = (ev) => this.diag.log(`asset worker error: ${ev.message}`);
  }

  // ---------------------------------------------------------------- startup

  async start(): Promise<void> {
    const { width, height } = this.opts;
    const channel = new MessageChannel();
    this.postAsset(
      { t: 'init', port: channel.port1, width, height, token: this.link.token, apiPrefix: API_PREFIX },
      [channel.port1],
    );
    const offscreen = this.opts.canvas.transferControlToOffscreen();
    this.postRender(
      {
        t: 'init',
        canvas: offscreen,
        width,
        height,
        testPixel: this.opts.testMode,
        forceCanvas2d: this.opts.forceCanvas2d,
        assetPort: channel.port2,
        clear: this.look.clearColor,
        clockOffset: this.clockOffset(),
      },
      [offscreen, channel.port2],
    );

    // Paint the cached live cue first (design/17: a relaunch shows the last content before anything else).
    const [cfg, saved] = await Promise.all([
      this.json.get<OutputConfigRes>(`config:${this.link.outputId}`).catch(() => undefined),
      this.json.get<{ state: LiveState; savedAt: number }>(`state:${this.link.outputId}`).catch(() => undefined),
    ]);
    if (cfg && !this.config) this.applyConfig(cfg);
    if (saved && Date.now() - saved.savedAt < STATE_CACHE_MAX_AGE_MS && !this.link.mirror.ready) {
      this.cachedState = saved.state;
      this.onState();
    }

    this.link.mirror.on('change', () => {
      this.cachedState = undefined;
      this.onState();
    });
    this.link.on('library', (m) => {
      if (m.changes.some((c) => c.kind === 'settings' || c.kind === 'font' || c.kind === 'media'))
        void this.loadConfig();
    });
    this.link.on('bus', ({ bus }) => {
      this.diag.log(`bus: ${bus}`);
      this.sendClock();
      if (bus === 'hub' && !this.config) void this.loadConfig();
    });
    this.link.hub.on('welcome', () => void this.loadConfig());
    this.link.start();
    void this.loadConfig();
    void requestPersistence();

    setInterval(() => this.sendClock(), 500);
    setInterval(() => this.sendHealth(), 1000);
    setInterval(() => this.postRender({ t: 'frames' }), 1000);
    setInterval(() => this.sync(), 2000); // retries (errors, busy slots) and media transport upkeep
    this.observeLongTasks();
    this.scheduleProps();
    setTimeout(() => {
      if (this.tel.presented === 0)
        this.diag.showFatal('This output has not presented a frame.', this.fatal ?? this.renderNote ?? 'Waiting for the renderer…');
    }, 10_000);
  }

  private async loadConfig(): Promise<void> {
    try {
      const cfg = await api<OutputConfigRes>(ROUTES.outputConfig);
      this.applyConfig(cfg);
      void this.json.set(`config:${this.link.outputId}`, cfg).catch(() => undefined);
    } catch (err) {
      this.diag.log(`config fetch failed: ${(err as Error).message}`);
    }
  }

  private applyConfig(cfg: OutputConfigRes): void {
    this.config = cfg;
    const state = this.state();
    this.look = resolveLook(cfg.output.lookId, [cfg.looks, state.resolved?.looks ?? [], DEFAULT_LOOKS], LOOK_MAIN);
    this.lookSig = lookSignature(this.look, this.opts.width, this.opts.height);
    document.title = `ordo — ${cfg.output.name}`;
    if (cfg.output.audioMaster) {
      if (!this.engine) {
        this.engine = new AudioEngine(cfg.audio);
        void this.startAudio();
      } else this.engine.setSettings(cfg.audio);
    }
    this.ensureFiles();
    this.requestSync();
  }

  async startAudio(): Promise<void> {
    if (!this.engine || this.engineStarted) return;
    try {
      await this.engine.start();
      this.engineStarted = true;
      this.diag.log('audio engine started');
    } catch (err) {
      this.diag.log(`audio engine start failed (will retry on click): ${(err as Error).message}`);
    }
  }

  /** A user gesture happened: retry audio and unmute anything muted by the autoplay policy. */
  onGesture(): void {
    void this.startAudio();
    if (this.config?.output.audioMaster) {
      for (const s of [...this.mdPair.slots, ...this.auPair.slots])
        if (s.key && s.el.muted && s.error?.startsWith('audio blocked')) {
          s.el.muted = false;
          s.error = undefined;
        }
    }
  }

  // ---------------------------------------------------------------- state

  /** The state to render: the mirror once it has one, else the cached state from the last session. */
  state(): LiveState {
    return this.link.mirror.ready || !this.cachedState ? this.link.mirror.state : this.cachedState;
  }

  private saveTimer?: ReturnType<typeof setTimeout>;
  private onState(): void {
    const s = this.state();
    // Re-resolve the look when the playlist carries looks and no config yet.
    if (!this.config && s.resolved?.looks.length) {
      this.look = resolveLook(undefined, [s.resolved.looks], this.look);
    }
    this.ensureFiles();
    this.sync();
    if (this.link.mirror.ready) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => {
        void this.json
          .set(`state:${this.link.outputId}`, { state: this.link.mirror.state, savedAt: Date.now() })
          .catch(() => undefined);
      }, 1000);
    }
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

  /** Plan live and armed frames, prepare content, schedule flips, drive media. */
  sync(): void {
    const state = this.state();
    const look = this.look;
    const planOpts = { lookSig: this.lookSig, media: this.configMedia };
    const live = planFrame(state, look, planOpts);
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
    if (clearSig !== this.clearSent) {
      this.clearSent = clearSig;
      this.postRender({ t: 'clear', color: look.clearColor });
    }

    for (const name of PLAN_LAYERS) {
      const lp = live[name] as LayerPlan<{ key: string }>;
      this.ensureContent(name, lp, live, state);
      const ap = armed?.[name] as LayerPlan<{ key: string }> | undefined;
      if (ap && ap.key !== lp.key) this.ensureContent(name, ap, armed!, state);
      this.sendFlip(name, lp.key, lp.at, lp.fadeMs, name === 'slide' ? live.slideCue : -1);
    }
    this.syncVideos(live, armed);
    this.syncAudio(live, armed, state);
    this.syncProps(false);
  }

  // ---------------------------------------------------------------- content

  private has(key: string): boolean {
    if (!key) return true;
    if (this.heldSet.has(key) || this.inflight.has(key)) return true;
    const d = this.delivered.get(key);
    return d !== undefined && Date.now() - d < DELIVERED_GRACE_MS;
  }

  private errorBlocks(key: string): boolean {
    const e = this.errors.get(key);
    return !!e && Date.now() - e.at < ERROR_RETRY_MS;
  }

  private ensureContent(name: PlanLayer, lp: LayerPlan<{ key: string }>, plan: FramePlan, state: LiveState): void {
    const key = lp.key;
    if (!key || this.errorBlocks(key)) return;
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
        images: this.slideImages(state, d.slide, d.nextSlide),
      });
    } else if (name === 'lowerThird' && plan.lowerThird.desc) {
      this.job({ kind: 'lowerThird', layer, key, text: plan.lowerThird.desc.text, look: this.look });
    } else if (name === 'media' && plan.media.desc) {
      const d = plan.media.desc;
      if (d.kind === 'image') this.job({ kind: 'image', layer, key, hash: d.hash, fit: 'contain', cueIndex: d.cueIndex });
      else this.armVideo(this.mdPair, layer, key, d.hash, d.loop, FIT_CONTAIN, d.cueIndex);
    }
  }

  private slideImages(state: LiveState, ...slides: (Slide | undefined)[]): Record<string, string> {
    const out: Record<string, string> = {};
    const add = (id?: string) => {
      if (!id) return;
      const m = state.resolved?.media[id];
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
    this.inflight.add(job.key);
    this.postAsset({ t: 'job', job });
  }

  private armVideo(
    pair: SlotPair,
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
    slot
      .load(key, hash, loop, muted)
      .then(() => {
        this.inflight.delete(key);
        if (slot.key !== key) return;
        this.delivered.set(key, Date.now());
        this.errors.delete(key);
        // A media video hidden by this look still plays (for audio) but is not offered to the renderer.
        const visible = layer !== LAYER_INDEX.media || this.livePlan?.media.key === key || this.armedPlan?.media.key === key;
        if (visible)
          this.postRender({ t: 'content', layer, key, kind: SRC_VIDEO, videoSlot: slot.id, fit, cueIndex });
        this.syncVideos(this.livePlan, this.armedPlan);
      })
      .catch((err: Error) => {
        this.inflight.delete(key);
        this.errors.set(key, { error: err.message, at: Date.now() });
        this.diag.log(`arm ${key}: ${err.message}`);
      });
  }

  private protectedKeys(pair: SlotPair): string[] {
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
    const layer = LAYER_INDEX[name];
    const prev = this.flips[layer];
    if (prev && prev.key === key && prev.at === at && prev.fadeMs === fadeMs && prev.cue === cue) return;
    this.flips[layer] = { key, at, fadeMs, cue };
    this.postRender({ t: 'flip', layer, key, at, fadeMs, cueIndex: name === 'slide' ? cue : undefined });
  }

  // ---------------------------------------------------------------- media transport

  private syncVideos(live?: FramePlan, armed?: FramePlan): void {
    if (!live) return;
    const now = clock.now();
    // Backgrounds: loop, muted, keep playing across slides; synced to the layer's start time.
    const bg = live.background.desc?.kind === 'video' ? live.background : undefined;
    const bgKey = bg?.key ?? '';
    if (bgKey !== this.prevBgLive) {
      const old = this.bgPair.find(this.prevBgLive);
      if (old) {
        old.pauseAt(live.background.at + live.background.fadeMs);
        old.busyUntil = Math.max(now, live.background.at) + live.background.fadeMs + 100;
      }
      this.prevBgLive = bgKey;
    }
    const bgSlot = this.bgPair.find(bgKey);
    if (bg && bgSlot) bgSlot.apply({ state: 'playing', startedAt: bg.at, positionMs: 0, loop: true });

    // Media video: transport from the reducer state; audio through the engine on the master.
    const md = live.media.desc?.kind === 'video' ? live.media.desc : undefined;
    const mdKey = md?.key ?? '';
    if (mdKey !== this.prevMdLive) {
      const old = this.mdPair.find(this.prevMdLive);
      if (old) {
        // On clear-all the sound fades over 500 ms; keep the element running until then.
        old.pauseAt(live.media.at + Math.max(live.media.fadeMs, live.black ? 520 : 0));
        old.busyUntil = Math.max(now, live.media.at) + live.media.fadeMs + 100;
      }
      this.prevMdLive = mdKey;
    }
    const mdSlot = this.mdPair.find(mdKey);
    if (md && !mdSlot && !live.media.key && this.config?.output.audioMaster && !this.inflight.has(md.key))
      // Hidden by this look but the audio master still plays it for the sound.
      this.armVideo(this.mdPair, LAYER_INDEX.media, md.key, md.hash, md.loop, FIT_CONTAIN, md.cueIndex);
    if (md && mdSlot) {
      this.routeAudio(mdSlot, md.audio);
      mdSlot.apply({ state: md.state, startedAt: md.startedAt, positionMs: md.positionMs, loop: md.loop });
    }
    // Armed media video stays paused on its first frame.
    const amd = armed?.media.desc?.kind === 'video' ? armed.media.desc : undefined;
    const amSlot = amd && amd.key !== mdKey ? this.mdPair.find(amd.key) : undefined;
    if (amSlot?.ready && !amSlot.el.paused) amSlot.el.pause();
  }

  private routeAudio(slot: MediaSlot, a: { pairId?: string; gainDb?: number; loudnessLufs?: number }): void {
    const master = !!this.config?.output.audioMaster;
    if (!master || !this.engine) {
      slot.el.muted = true;
      return;
    }
    if (!slot.error?.startsWith('audio blocked')) slot.el.muted = false;
    const opts = { pairId: a.pairId, gainDb: a.gainDb, loudnessLufs: a.loudnessLufs };
    const h = this.handles.get(slot.el);
    try {
      if (h) this.engine.update(h, opts);
      else this.handles.set(slot.el, this.engine.attach(slot.el, opts));
    } catch (err) {
      this.diag.log(`audio attach failed: ${(err as Error).message}`);
    }
  }

  private syncAudio(live: FramePlan, armed: FramePlan | undefined, state: LiveState): void {
    if (!this.config?.output.audioMaster) return;
    // Clear-all fades audio out.
    if (state.black && !this.wasBlack) void this.engine?.fadeOut(500);
    this.wasBlack = state.black;

    const a = live.audio.desc;
    const key = a?.key ?? '';
    if (key !== this.prevAuLive) {
      const old = this.auPair.find(this.prevAuLive);
      if (old) old.pauseAt(state.black ? live.audio.at + 520 : live.audio.at);
      this.prevAuLive = key;
    }
    const protect = this.protectedKeys(this.auPair);
    const want = [a, armed?.audio.desc && armed.audio.desc.key !== key ? armed.audio.desc : undefined];
    for (const d of want) {
      if (!d || this.auPair.find(d.key) || this.inflight.has(d.key) || this.errorBlocks(d.key)) continue;
      const slot = this.auPair.pick(d.key, protect, clock.now());
      if (!slot) continue;
      this.inflight.add(d.key);
      slot
        .load(d.key, d.hash, d.loop, false)
        .then(() => {
          this.inflight.delete(d.key);
          this.requestSync();
        })
        .catch((err: Error) => {
          this.inflight.delete(d.key);
          this.errors.set(d.key, { error: err.message, at: Date.now() });
        });
    }
    const slot = this.auPair.find(key);
    if (a && slot) {
      this.routeAudio(slot, a.audio);
      slot.apply({ state: a.state, startedAt: a.startedAt, positionMs: a.positionMs, loop: a.loop });
    }
  }

  private onMediaEnded(slot: MediaSlot): void {
    if (!this.config?.output.audioMaster) return;
    const live = this.livePlan;
    if (!live) return;
    const md = live.media.desc;
    if (md && md.kind === 'video' && slot.key === md.key && md.state === 'playing' && !md.loop) {
      const id = `m|${md.key}|${md.startedAt}`;
      if (this.endedSent.has(id)) return;
      this.endedSent.add(id);
      this.link.sendEvent({ k: 'media.ended', cueIndex: md.cueIndex, at: clock.now() });
      this.diag.log(`media.ended cue ${md.cueIndex}`);
      return;
    }
    const au = live.audio.desc;
    if (au && slot.key === au.key && au.state === 'playing' && !au.loop) {
      const id = `a|${au.key}|${au.startedAt}`;
      if (this.endedSent.has(id)) return;
      this.endedSent.add(id);
      this.link.sendEvent({ k: 'audio.ended', cueIndex: au.cueIndex, at: clock.now() });
      this.diag.log(`audio.ended cue ${au.cueIndex}`);
    }
  }

  // ---------------------------------------------------------------- props

  /** Re-rasterize the props layer when its text changes; runs on state changes and each second. */
  private syncProps(fromTick: boolean, boundary?: number): void {
    const state = this.state();
    const now = boundary ?? clock.now();
    const general = this.config?.general;
    const logoMediaId = general?.logoMediaId ?? state.resolved?.logoMediaId;
    const model = propsModel(state, this.look, {
      now,
      timeZone: general?.timeZone ?? 'UTC',
      clock24h: general?.clock24h ?? false,
      logoMediaId,
      lookSig: this.lookSig,
    });
    const layer = LAYER_INDEX.props;
    const stateChange = state.props.seq !== this.propsSeq;
    if (model.key === this.propsKey && !stateChange) return;
    if (model.key === this.propsKey) {
      this.propsSeq = state.props.seq;
      return;
    }
    const fade = stateChange && !fromTick ? (this.look.transition.kind === 'crossfade' ? this.look.transition.ms : 0) : 0;
    const at = fromTick ? now : Math.max(state.props.at, 0);
    this.propsSeq = state.props.seq;
    this.propsKey = model.key;
    if (model.key && !this.has(model.key)) {
      const images: Record<string, string> = {};
      if (model.logo) {
        const m = state.resolved?.media[model.logo.mediaId] ?? this.configMedia(model.logo.mediaId);
        const f = m ? playableFile(m) : undefined;
        if (f) images[model.logo.mediaId] = f.hash;
      }
      this.job({ kind: 'props', layer, key: model.key, model, look: this.look, images });
    }
    this.flips[layer] = { key: model.key, at, fadeMs: fade, cue: -1 };
    this.postRender({ t: 'flip', layer, key: model.key, at, fadeMs: fade });
  }

  private scheduleProps(): void {
    clearTimeout(this.propsTimer);
    // Wake 150 ms before each second, rasterize the text for that second, flip exactly on it.
    const now = clock.now();
    const wait = msToNextSecond(now, 150);
    this.propsTimer = setTimeout(() => {
      const boundary = Math.round((clock.now() + 150) / 1000) * 1000;
      this.syncProps(true, boundary);
      this.scheduleProps();
    }, wait + 1);
  }

  // ---------------------------------------------------------------- cache

  private ensureFiles(): void {
    const state = this.state();
    const files = new Map<string, ManifestFile>();
    for (const f of state.resolved?.files ?? []) files.set(f.hash, f);
    const fonts = new Map<string, Font>();
    for (const f of [...(this.config?.fonts ?? []), ...(state.resolved?.fonts ?? [])]) fonts.set(f.file.hash, f);
    for (const f of fonts.values()) files.set(f.file.hash, { hash: f.file.hash, bytes: f.file.bytes, mime: f.file.mime });
    const extra = [this.config?.logo, this.look.holdingMediaId ? state.resolved?.media[this.look.holdingMediaId] : undefined];
    for (const m of extra) {
      const f = m ? playableFile(m) : undefined;
      if (f) files.set(f.hash, { hash: f.hash, bytes: f.bytes, mime: f.mime });
    }
    // Fonts go to the asset worker before any text job (its queue is ordered).
    const fsig = [...fonts.keys()].sort().join(',');
    if (fsig !== this.fontsSig) {
      this.fontsSig = fsig;
      this.postAsset({ t: 'fonts', fonts: fontLoads([...fonts.values()]) });
    }
    const sig = [...files.keys()].sort().join(',');
    if (sig === this.manifestSig) return;
    this.manifestSig = sig;
    void this.fill([...files.values()], new Set(fonts.keys()));
  }

  private async fetchFile(hash: string): Promise<Blob> {
    const fb = this.link.fallback;
    if (this.link.bus === 'fallback' && fb) {
      const b = await fb.requestFile(hash);
      if (b) return b;
    }
    try {
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

  private async fill(files: ManifestFile[], fontHashes: Set<string>): Promise<void> {
    this.fillAbort?.abort();
    const ac = new AbortController();
    this.fillAbort = ac;
    // Fonts first, then images, then everything else (videos).
    const rank = (f: ManifestFile) => (fontHashes.has(f.hash) ? 0 : f.mime.startsWith('image/') ? 1 : 2);
    const sorted = [...files].sort((a, b) => rank(a) - rank(b));
    this.cacheProgress = { ready: 0, total: sorted.length };
    const t0 = performance.now();
    let p: FillProgress;
    try {
      p = await fillCache(
        this.store,
        sorted,
        (h) => this.fetchFile(h),
        (pr) => {
          if (ac.signal.aborted) return;
          this.cacheProgress = { ready: pr.ready, total: pr.total };
        },
        { concurrency: 3, retries: 2, signal: ac.signal },
      );
    } catch (err) {
      this.diag.log(`cache fill failed: ${(err as Error).message}`);
      return;
    }
    if (ac.signal.aborted) return;
    this.cacheProgress = { ready: p.ready, total: p.total };
    this.diag.log(
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
    } else {
      this.postAsset({ t: 'prune', keep: files.map((f) => f.hash) });
      void this.store.prune?.(new Set(files.map((f) => f.hash))).catch(() => undefined);
    }
    this.errors.clear();
    this.requestSync();
  }

  // ---------------------------------------------------------------- workers

  private postRender(m: ToRender, transfer: Transferable[] = []): void {
    this.render.postMessage(m, transfer);
  }

  private postAsset(m: ToAsset, transfer: Transferable[] = []): void {
    this.asset.postMessage(m, transfer);
  }

  private onRender(m: FromRender): void {
    switch (m.t) {
      case 'ready':
        this.compositor = m.compositor;
        this.renderNote = m.note;
        this.diag.log(`renderer ready: ${m.compositor}${m.note ? ` (${m.note})` : ''}`);
        this.updateSnapshotRate();
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
        this.requestSync();
        return;
      }
      case 'snapshot':
        this.lastSnapshot?.close();
        this.lastSnapshot = m.bitmap;
        this.program.paint(m.bitmap);
        if (this.lost) this.paintHold();
        return;
      case 'lost':
        this.lost = true;
        this.diag.log(`GPU device lost: ${m.reason}; rebuilding`);
        this.paintHold();
        this.opts.hold.hidden = false;
        return;
      case 'restored':
        this.lost = false;
        this.diag.log(`renderer restored (${m.compositor})`);
        // Give the rebuilt device a couple of frames before uncovering it.
        setTimeout(() => {
          if (!this.lost) this.opts.hold.hidden = true;
        }, 100);
        return;
      case 'fatal':
        this.onFatal(m.error);
        return;
      case 'needCanvas':
        this.replaceCanvas();
        return;
    }
  }

  private onFatal(error: string): void {
    this.fatal = error;
    this.diag.log(`fatal: ${error}`);
    if (this.tel.presented === 0) this.diag.showFatal('The output renderer failed to start.', error);
  }

  /** Give the render worker a fresh canvas (its old one is bound to a WebGPU context it gave up on). */
  private replaceCanvas(): void {
    const old = this.opts.canvas;
    const c = document.createElement('canvas');
    c.className = old.className;
    c.width = this.opts.width;
    c.height = this.opts.height;
    old.replaceWith(c);
    this.opts.canvas = c;
    const off = c.transferControlToOffscreen();
    this.postRender({ t: 'canvas', canvas: off }, [off]);
    this.diag.log('renderer switched to a fresh canvas');
  }

  private paintHold(): void {
    const b = this.lastSnapshot;
    const c = this.opts.hold;
    if (!b) return;
    if (c.width !== this.opts.width) {
      c.width = this.opts.width;
      c.height = this.opts.height;
    }
    c.getContext('2d')?.drawImage(b, 0, 0, c.width, c.height);
  }

  private onAsset(m: FromAsset): void {
    switch (m.t) {
      case 'done':
        this.inflight.delete(m.key);
        this.delivered.set(m.key, Date.now());
        this.errors.delete(m.key);
        return;
      case 'error':
        this.inflight.delete(m.key);
        this.errors.set(m.key, { error: m.error, at: Date.now() });
        this.diag.log(`arm ${m.key.slice(0, 60)}: ${m.error}`);
        setTimeout(() => this.requestSync(), ERROR_RETRY_MS + 50);
        return;
      case 'fonts':
        this.diag.log(`fonts loaded: ${m.loaded}${m.failed.length ? `, failed: ${m.failed.join(', ')}` : ''}`);
        return;
    }
  }

  private updateSnapshotRate(): void {
    const everyMs = this.program.active ? 100 : 1000;
    this.postRender({ t: 'snapshot', everyMs, width: 640, height: 360 });
  }

  private clockOffset(): number {
    return clock.now() - (performance.timeOrigin + performance.now());
  }

  private sendClock(): void {
    const off = this.clockOffset();
    if (Math.abs(off - this.clockOffsetSent) < 0.5) return;
    this.clockOffsetSent = off;
    this.postRender({ t: 'clock', offset: off });
  }

  private observeLongTasks(): void {
    try {
      new PerformanceObserver((list) => {
        this.mainLongTasks += list.getEntries().length;
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      /* unsupported */
    }
  }

  // ---------------------------------------------------------------- health

  private armRequired(): string[] {
    const keys: string[] = [];
    for (const p of [this.livePlan, this.armedPlan]) {
      if (!p) continue;
      for (const name of PLAN_LAYERS) keys.push((p[name] as LayerPlan<unknown>).key);
    }
    return keys;
  }

  buildHealth(): OutputHealth {
    const state = this.state();
    const errMap = new Map<string, string>();
    for (const [k, v] of this.errors) errMap.set(k, v.error);
    const arm = armStatus(this.armRequired(), this.heldSet, errMap);
    for (const s of this.slots) this.dropped.sample(`slot${s.id}`, s.srcId, s.droppedFrames());
    const md = this.livePlan?.media.desc;
    const mdSlot = md?.kind === 'video' ? this.mdPair.find(md.key) : undefined;
    const au = this.livePlan?.audio.desc;
    const auSlot = au ? this.auPair.find(au.key) : undefined;
    const posSlot = mdSlot ?? (this.config?.output.audioMaster ? auSlot : undefined);
    const errors: string[] = [];
    if (this.fatal) errors.push(this.fatal);
    for (const s of this.slots) if (s.key && s.error) errors.push(s.error);
    const master = !!this.config?.output.audioMaster;
    const h = buildHealth({
      render: this.tel,
      mainLongTasks: this.mainLongTasks,
      live: state.live,
      armed: state.armed,
      arm,
      cache: this.cacheProgress,
      videoDropped: this.dropped.total,
      audio: master ? (this.engine?.status ?? 'none') : undefined,
      meters: master ? this.engine?.meters() : undefined,
      mediaPositionMs: posSlot ? posSlot.el.currentTime * 1000 : undefined,
      mediaDurationMs:
        posSlot && Number.isFinite(posSlot.el.duration) ? posSlot.el.duration * 1000 : md?.durationMs,
      errors,
      appVersion: APP_VERSION,
    });
    return h as OutputHealth;
  }

  private sendHealth(): void {
    const h = this.buildHealth();
    this.lastHealth = h;
    this.link.sendHealth(h);
  }

  // ---------------------------------------------------------------- introspection

  telemetry(): Record<string, unknown> {
    return {
      ...(this.lastHealth ?? this.buildHealth()),
      compositor: this.compositor,
      bus: this.link.bus,
      frameMs: this.tel.frameMs,
      frames: this.frames,
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
      cache: this.cacheProgress,
      compositor: this.compositor,
      bus: this.link.bus,
      size: `${this.opts.width}x${this.opts.height}`,
      log: this.diag.recent,
    };
  }

  private diagnostics(): Record<string, unknown> {
    const h = this.lastHealth ?? this.buildHealth();
    const s = this.state();
    return {
      output: `${this.config?.output.name ?? '?'} (${this.link.outputId})`,
      look: `${this.look.name} [${this.look.id}]`,
      bus: this.link.bus,
      compositor: this.compositor + (this.renderNote ? ` — ${this.renderNote}` : ''),
      resolution: `${this.opts.width}x${this.opts.height}`,
      fps: h.fps,
      presented: h.presented,
      missed: h.missed,
      longTasks: h.longTasks,
      lateFlips: h.lateFlips,
      gpuLost: h.gpuLost,
      videoDropped: h.videoDropped,
      cache: `${h.cache.ready}/${h.cache.total}`,
      live: s.live,
      armed: `${s.armed ?? '-'} ${h.armedOk ? 'ok' : h.armError ? `error: ${h.armError}` : 'pending'}`,
      audio: h.audio ?? (this.config?.output.audioMaster ? 'none' : 'not master'),
      media: h.mediaPositionMs !== undefined ? `${Math.round(h.mediaPositionMs / 1000)}s / ${Math.round((h.mediaDurationMs ?? 0) / 1000)}s` : '-',
      clockOffset: `${Math.round(clock.offset)} ms (rtt ${Math.round(clock.rtt)} ms)`,
      error: h.error ?? '-',
    };
  }
}

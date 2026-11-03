import { AudioEngine, type SourceHandle } from '@ordo/audio';
import { requestPersistence } from '@ordo/cache';
import {
  type BusEndpoint,
  type SupervisorClock,
  Supervisor,
  acceptPorts,
  appEnv,
  operatorOrigin,
  requestPort,
  windowEndpoint,
} from '@ordo/client';
import { API_PREFIX } from '@ordo/protocol';
import type { FromRender, ToAsset, ToRender } from '@ordo/renderer';
import { Diagnostics } from './diagnostics.ts';
import type {
  AudioCommand,
  ChaosHooks,
  HostStatus,
  LinkToMain,
  LinkView,
  MainToLink,
  MediaCommand,
  MediaEvent,
  WorkerName,
  WorkerStat,
} from './host-protocol.ts';
import { MediaSlot } from './media.ts';
import { ProgramSender } from './program.ts';

export type HostOptions = {
  canvas: HTMLCanvasElement;
  hold: HTMLCanvasElement;
  mediaBox: HTMLElement;
  width: number;
  height: number;
  testMode: boolean;
  forceCanvas2d: boolean;
};

const RELOAD_KEY = 'ordo.output.reloads';
const RELOAD_REASON_KEY = 'ordo.output.reloadReason';
/** Crash-only reloads allowed within RELOAD_WINDOW_MS before the window stops reloading itself. */
const RELOAD_MAX = 3;
const RELOAD_WINDOW_MS = 10 * 60_000;
/** A hold raised for a render rebuild comes down after this long even if the link never says so. */
const HOLD_MAX_MS = 12_000;

/**
 * A supervisor clock that does not count main-thread stalls: each tick advances it by at most 500 ms,
 * so a frozen main thread (whose heartbeat messages are merely queued) never makes healthy workers look
 * dead. A dead worker still misses heartbeats for real time once the main thread runs.
 */
function stallTolerantClock(): SupervisorClock {
  let virt = Date.now();
  let last = performance.now();
  const advance = () => {
    const p = performance.now();
    virt += Math.min(Math.max(0, p - last), 500);
    last = p;
    return virt;
  };
  return {
    now: advance,
    setInterval: (fn, ms) =>
      setInterval(() => {
        advance();
        fn();
      }, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
}

/**
 * The output window's main thread (design/25 "a main thread hosts; it does not compute"): the canvas and
 * its hold, media elements and requestVideoFrameCallback, the audio engine, the program-view peer
 * connection, the diagnostics overlay, the opener's ports, and a supervisor of the link, render and asset
 * workers. All decisions are the link worker's; this class executes its commands.
 */
export class OutputHost {
  readonly diag: Diagnostics;
  readonly sup: Supervisor;
  private program: ProgramSender;
  private slots: MediaSlot[] = [];
  private engine?: AudioEngine;
  private engineStarted = false;
  private master = false;
  private handles = new Map<HTMLMediaElement, SourceHandle>();
  private hubOffset = 0;
  private pendingBlob = new Map<string, { blob?: Blob; url: string }>();

  private view?: LinkView;
  private compositor?: 'webgpu' | '2d';
  private renderNote?: string;
  private fatal?: string;
  private lastSnapshot?: ImageBitmap;
  private pendingCanvas?: HTMLCanvasElement;
  private holdReasons = new Set<'lost' | 'restart'>();
  private holdSince = 0;
  private mainLongTasks = 0;
  private rafTicks = 0;
  private logBuffer: string[] = [];
  private gens: Record<WorkerName, number> = { link: 0, render: 0, asset: 0 };
  private wireQueued = false;

  // Fallback bus carriers
  private readonly outputId: string;
  private readonly token: string;
  private readonly operatorOrigin: string;
  private bridgeMain?: MessagePort;
  private winEp?: BusEndpoint;
  private pendingBusPort?: MessagePort;
  private openerClosedSent = false;
  /** Whether the window was opened by the operator; Chrome nulls window.opener once that tab closes. */
  private readonly hadOpener = !!window.opener;

  constructor(private opts: HostOptions) {
    const env = appEnv();
    this.outputId = env.outputId ?? 'unknown';
    this.token = env.token ?? '';
    this.operatorOrigin = operatorOrigin(env);
    this.diag = new Diagnostics(
      () => this.view?.diag ?? { status: 'starting…' },
      () => this.view?.log ?? [],
    );
    this.program = new ProgramSender((msg) => this.toLink({ t: 'hubSend', msg }));
    this.program.onActiveChange = () => this.updateSnapshotRate();

    const mk = (id: number, video: boolean): MediaSlot => {
      const el = document.createElement(video ? 'video' : 'audio');
      el.muted = true;
      opts.mediaBox.appendChild(el);
      return new MediaSlot(id, el, {
        hubNow: () => Date.now() + this.hubOffset,
        getBlob: async (h) => this.pendingBlob.get(h)?.blob,
        fileUrl: (h) => this.pendingBlob.get(h)?.url ?? `${API_PREFIX}/files/${h}`,
        onFrame: video ? (slot, frame) => this.toRender({ t: 'vframe', slot, frame }, [frame]) : undefined,
        onEnded: (s) => this.mediaEvent({ k: 'ended', slot: s.id, key: s.key }),
        onError: (s, e) => this.mediaEvent({ k: 'error', slot: s.id, key: s.key, error: e }),
        log: (m) => this.log(m),
      });
    };
    this.slots = [mk(0, true), mk(1, true), mk(2, true), mk(3, true), mk(4, false), mk(5, false)];

    this.sup = new Supervisor(stallTolerantClock());
    this.sup.on('restart', ({ name, generation, reason }) => {
      this.log(`worker ${name} restarted (generation ${generation}): ${reason}`);
    });
    this.sup.on('gaveUp', ({ name, reason }) => {
      this.log(`worker ${name} keeps failing; supervisor gave up: ${reason}`);
      if (name === 'render' || name === 'link')
        this.diag.showFatal(`The output's ${name} worker keeps crashing.`, reason);
    });
  }

  // ---------------------------------------------------------------- startup

  start(): void {
    this.sup.add({
      name: 'link',
      deadAfterMs: 4000,
      create: () =>
        new Worker(new URL('./link.worker.ts', import.meta.url), { type: 'module', name: 'ordo-link' }),
      start: (w, gen) => this.startLink(w, gen),
    });
    this.sup.add({
      name: 'render',
      deadAfterMs: 3000,
      create: () =>
        new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module', name: 'ordo-render' }),
      start: (w, gen) => this.startRender(w, gen),
    });
    this.sup.add({
      name: 'asset',
      deadAfterMs: 5000,
      create: () =>
        new Worker(new URL('./asset.worker.ts', import.meta.url), { type: 'module', name: 'ordo-asset' }),
      start: (w, gen) => this.startAsset(w, gen),
    });
    this.wire();

    // Fallback-bus ports from the opener (the operator's worker then talks to the link worker directly).
    acceptPorts(this.operatorOrigin, (port) => {
      const link = this.sup.worker<Worker>('link');
      if (link) link.postMessage({ t: 'busPort', port } satisfies MainToLink, [port]);
      else this.pendingBusPort = port;
    });
    void requestPersistence();

    // Main-thread watchdog tick: the link worker measures the gaps (health.mainThreadStallMs).
    setInterval(() => this.toLink({ t: 'tick' }), 250);
    setInterval(() => this.sendStatus(), 500);
    setInterval(() => this.watchOpener(), 1000);
    setInterval(() => this.checkHold(), 500);
    const raf = () => {
      this.rafTicks++;
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
    this.observeLongTasks();
  }

  private startLink(w: Worker, gen: number): void {
    this.gens.link = gen;
    w.onmessage = (ev: MessageEvent<LinkToMain | { __ordo?: string }>) => {
      const d = ev.data as LinkToMain & { __ordo?: string };
      if (d.__ordo) return;
      this.onLink(d);
    };
    // The legacy relay of window.postMessage from the opener, on a fresh channel per link generation.
    const bridge = new MessageChannel();
    this.bridgeMain?.close();
    this.bridgeMain = bridge.port1;
    this.attachBridge(bridge.port1);
    const busPort = this.pendingBusPort;
    this.pendingBusPort = undefined;
    let reloadReason: string | undefined;
    try {
      reloadReason = sessionStorage.getItem(RELOAD_REASON_KEY) ?? undefined;
      if (gen === 0) sessionStorage.removeItem(RELOAD_REASON_KEY);
    } catch {
      /* storage blocked */
    }
    const init: MainToLink = {
      t: 'init',
      outputId: this.outputId,
      token: this.token,
      width: this.opts.width,
      height: this.opts.height,
      testMode: this.opts.testMode,
      generation: gen,
      bridge: bridge.port2,
      busPort,
      reloadReason: gen === 0 ? reloadReason : undefined,
    };
    w.postMessage(init, busPort ? [bridge.port2, busPort] : [bridge.port2]);
    if (this.openerClosedSent) w.postMessage({ t: 'opener', closed: true } satisfies MainToLink);
    if (gen > 0) {
      // The bus port died with the old worker: ask the operator for a new one (the relay works meanwhile).
      requestPort(this.operatorOrigin, this.outputId);
      this.scheduleWire();
    }
  }

  private startRender(w: Worker, gen: number): void {
    this.gens.render = gen;
    w.onmessage = (ev: MessageEvent<FromRender | { __ordo?: string }>) => {
      const d = ev.data as FromRender & { __ordo?: string };
      if (d.__ordo) return;
      this.onRender(d);
    };
    let target = this.opts.canvas;
    if (gen > 0) {
      // The old worker took its canvas with it: cover the screen with the last frame, give the new
      // worker a fresh canvas, show it once the link worker has re-armed the live content.
      this.raiseHold('restart');
      const c = document.createElement('canvas');
      c.className = this.opts.canvas.className;
      c.width = this.opts.width;
      c.height = this.opts.height;
      this.pendingCanvas = c;
      target = c;
    }
    const offscreen = target.transferControlToOffscreen();
    const init: ToRender = {
      t: 'init',
      canvas: offscreen,
      width: this.opts.width,
      height: this.opts.height,
      testPixel: this.opts.testMode,
      forceCanvas2d: this.opts.forceCanvas2d,
      clear: { r: 0, g: 0, b: 0, a: 1 },
      clockOffset: this.hubOffset,
    };
    w.postMessage(init, [offscreen]);
    if (gen > 0) this.scheduleWire();
  }

  private startAsset(w: Worker, gen: number): void {
    this.gens.asset = gen;
    w.onmessage = null;
    const init: ToAsset = {
      t: 'init',
      width: this.opts.width,
      height: this.opts.height,
      token: this.token,
      apiPrefix: API_PREFIX,
    };
    w.postMessage(init);
    if (gen > 0) this.scheduleWire();
  }

  private scheduleWire(): void {
    if (this.wireQueued) return;
    this.wireQueued = true;
    queueMicrotask(() => {
      this.wireQueued = false;
      this.wire();
    });
  }

  /**
   * Fresh channels between the workers (asset↔render, link↔render, link↔asset), sent to each. Runs at
   * startup and after any worker restart, so arming never crosses the main thread.
   */
  private wire(): void {
    const link = this.sup.worker<Worker>('link');
    const render = this.sup.worker<Worker>('render');
    const asset = this.sup.worker<Worker>('asset');
    if (!link || !render || !asset) return;
    const ar = new MessageChannel();
    const lr = new MessageChannel();
    const la = new MessageChannel();
    render.postMessage({ t: 'ports', asset: ar.port2, link: lr.port2 } satisfies ToRender, [
      ar.port2,
      lr.port2,
    ]);
    asset.postMessage({ t: 'ports', render: ar.port1, link: la.port2 } satisfies ToAsset, [
      ar.port1,
      la.port2,
    ]);
    link.postMessage(
      { t: 'ports', render: lr.port1, asset: la.port1, gens: { ...this.gens } } satisfies MainToLink,
      [lr.port1, la.port1],
    );
  }

  // ---------------------------------------------------------------- fallback bus relay

  /** Relay the opener's window.postMessage bus to the link worker (legacy carrier). */
  private attachBridge(port: MessagePort): void {
    if (!window.opener) return;
    this.winEp?.close();
    const ep = windowEndpoint(() => window.opener as Window | null, this.operatorOrigin);
    this.winEp = ep;
    ep.onMessage((m) => {
      try {
        port.postMessage(m);
      } catch {
        /* closed */
      }
    });
    port.onmessage = (ev) => ep.post(ev.data);
  }

  private watchOpener(): void {
    if (this.openerClosedSent) return;
    if (!this.hadOpener) return;
    let closed = false;
    try {
      const op = window.opener as Window | null;
      closed = !op || op.closed;
    } catch {
      closed = true;
    }
    if (closed) {
      this.openerClosedSent = true;
      this.log('opener closed');
      this.toLink({ t: 'opener', closed: true });
    }
  }

  // ---------------------------------------------------------------- messages

  private toLink(m: MainToLink, transfer: Transferable[] = []): void {
    try {
      this.sup.worker<Worker>('link')?.postMessage(m, transfer);
    } catch {
      /* restarting */
    }
  }

  private toRender(m: ToRender, transfer: Transferable[] = []): void {
    const w = this.sup.worker<Worker>('render');
    if (!w) {
      if (m.t === 'vframe') m.frame.close();
      return;
    }
    try {
      w.postMessage(m, transfer);
    } catch {
      if (m.t === 'vframe') m.frame.close();
    }
  }

  private mediaEvent(ev: MediaEvent): void {
    this.toLink({ t: 'media', ev });
  }

  log(line: string): void {
    this.diag.log(line);
    this.logBuffer.push(line);
    if (this.logBuffer.length > 50) this.logBuffer.shift();
  }

  private onLink(m: LinkToMain): void {
    switch (m.t) {
      case 'view':
        this.view = m.view;
        // Lower a rebuild hold only on a view about the current render generation, after its canvas is on screen.
        if (
          m.view.covered &&
          this.holdReasons.has('restart') &&
          !this.pendingCanvas &&
          (m.view.state.gens as Record<WorkerName, number> | undefined)?.render === this.gens.render
        )
          this.lowerHold('restart');
        return;
      case 'media':
        this.onMedia(m.cmd);
        return;
      case 'audio':
        this.onAudio(m.cmd);
        return;
      case 'clock':
        this.hubOffset = m.offset;
        return;
      case 'title':
        document.title = m.text;
        return;
      case 'rtc':
        void this.program.onSignal(m.m);
        return;
      case 'fatal':
        this.diag.showFatal(m.title, m.detail);
        return;
      case 'close':
        this.log(`closing: ${m.reason}`);
        setTimeout(() => window.close(), 200);
        return;
      case 'reload':
        this.reload(m.reason);
        return;
      case 'restartWorker':
        this.sup.restart(m.name, m.reason);
        return;
      case 'portRequest':
        requestPort(this.operatorOrigin, this.outputId);
        return;
    }
  }

  /**
   * Crash-only restart: reload the window, at most RELOAD_MAX times in RELOAD_WINDOW_MS (a deterministic
   * failure must not become a reload loop). The reloaded window paints the last cue from IndexedDB first.
   */
  reload(reason: string): void {
    const now = Date.now();
    let recent: number[] = [];
    try {
      recent = (JSON.parse(sessionStorage.getItem(RELOAD_KEY) ?? '[]') as number[]).filter(
        (t) => typeof t === 'number' && now - t < RELOAD_WINDOW_MS,
      );
    } catch {
      recent = [];
    }
    if (recent.length >= RELOAD_MAX && reason !== 'new app version') {
      this.log(`reload refused (${recent.length} in 10 min): ${reason}`);
      return;
    }
    recent.push(now);
    try {
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify(recent));
      sessionStorage.setItem(RELOAD_REASON_KEY, reason.slice(0, 300));
    } catch {
      /* storage blocked: reload anyway */
    }
    this.log(`reloading: ${reason}`);
    setTimeout(() => location.reload(), 100);
  }

  private onMedia(c: MediaCommand): void {
    const slot = this.slots[c.slot];
    if (!slot) return;
    switch (c.k) {
      case 'load': {
        const already = slot.key === c.key && slot.ready;
        this.pendingBlob.set(c.hash, { blob: c.blob, url: c.url });
        slot
          .load(c.key, c.hash, c.loop, c.muted)
          .then(() => {
            if (already) slot.resendFrame();
            if (slot.key === c.key && slot.ready) this.mediaEvent({ k: 'loaded', slot: slot.id, key: c.key });
          })
          .catch((err: Error) =>
            this.mediaEvent({ k: 'loadError', slot: slot.id, key: c.key, error: err.message }),
          )
          .finally(() => {
            if (this.pendingBlob.get(c.hash)?.blob === c.blob) this.pendingBlob.delete(c.hash);
          });
        return;
      }
      case 'apply':
        slot.apply(c.transport);
        return;
      case 'pauseAt':
        slot.pauseAt(c.at);
        return;
      case 'holdPaused':
        if (slot.ready && !slot.el.paused) slot.el.pause();
        return;
      case 'route':
        this.routeAudio(slot, c.master, c.audio);
        return;
      case 'unload':
        slot.unload();
        return;
    }
  }

  private routeAudio(
    slot: MediaSlot,
    master: boolean,
    a: { pairId?: string; gainDb?: number; loudnessLufs?: number },
  ): void {
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
      this.log(`audio attach failed: ${(err as Error).message}`);
    }
  }

  private onAudio(c: AudioCommand): void {
    if (c.k === 'fadeOut') {
      void this.engine?.fadeOut(c.ms);
      return;
    }
    this.master = c.master;
    if (!c.master || !c.settings) return;
    if (!this.engine) {
      this.engine = new AudioEngine(c.settings);
      void this.startAudio();
    } else this.engine.setSettings(c.settings);
  }

  async startAudio(): Promise<void> {
    if (!this.engine || this.engineStarted) return;
    try {
      await this.engine.start();
      this.engineStarted = true;
      this.log('audio engine started');
    } catch (err) {
      this.log(`audio engine start failed (will retry on click): ${(err as Error).message}`);
    }
  }

  /** A user gesture happened: retry audio and unmute anything muted by the autoplay policy. */
  onGesture(): void {
    void this.startAudio();
    if (!this.master) return;
    for (const s of this.slots.slice(2))
      if (s.key && s.el.muted && s.error?.startsWith('audio blocked')) {
        s.el.muted = false;
        s.error = undefined;
      }
  }

  // ---------------------------------------------------------------- render worker

  private onRender(m: FromRender): void {
    switch (m.t) {
      case 'ready':
        this.compositor = m.compositor;
        this.renderNote = m.note;
        this.adoptCanvas();
        this.updateSnapshotRate();
        for (const s of this.slots) s.resendFrame();
        return;
      case 'snapshot':
        this.lastSnapshot?.close();
        this.lastSnapshot = m.bitmap;
        this.program.paint(m.bitmap);
        // While the device is lost the old frames still reflect the screen; a rebuilt worker's first
        // frames may not have the live content yet, so a restart hold keeps the pre-crash frame.
        if (this.holdReasons.size === 1 && this.holdReasons.has('lost')) this.paintHold();
        return;
      case 'lost':
        // The link worker logs render lifecycle events (it hears them on its port too).
        this.raiseHold('lost');
        return;
      case 'restored':
        this.compositor = m.compositor;
        if (m.compositor === 'webgpu') this.renderNote = undefined;
        this.adoptCanvas();
        // Give the rebuilt device a couple of frames before uncovering it.
        setTimeout(() => this.lowerHold('lost'), 100);
        return;
      case 'fatal':
        this.fatal = m.error;
        return;
      case 'needCanvas':
        this.replaceCanvas();
        return;
      case 'canvasUnused':
        this.pendingCanvas = undefined;
        return;
      default:
        return;
    }
  }

  /**
   * Give the render worker a fresh canvas (a canvas keeps its first context kind, so switching between
   * WebGPU and Canvas 2D needs a new one). It goes on screen only when the worker reports it draws there
   * (`ready` or `restored`); a WebGPU retry that fails hands it back with `canvasUnused`.
   */
  private replaceCanvas(): void {
    const old = this.opts.canvas;
    const c = document.createElement('canvas');
    c.className = old.className;
    c.width = this.opts.width;
    c.height = this.opts.height;
    this.pendingCanvas = c;
    const off = c.transferControlToOffscreen();
    this.toRender({ t: 'canvas', canvas: off }, [off]);
    this.log('renderer asked for a fresh canvas');
  }

  private adoptCanvas(): void {
    const c = this.pendingCanvas;
    if (!c) return;
    this.pendingCanvas = undefined;
    this.opts.canvas.replaceWith(c);
    this.opts.canvas = c;
    this.log('renderer switched to the fresh canvas');
  }

  private raiseHold(reason: 'lost' | 'restart'): void {
    if (!this.holdReasons.size) {
      this.paintHold();
      this.holdSince = Date.now();
    }
    this.holdReasons.add(reason);
    this.opts.hold.hidden = false;
  }

  private lowerHold(reason: 'lost' | 'restart'): void {
    this.holdReasons.delete(reason);
    if (!this.holdReasons.size) this.opts.hold.hidden = true;
  }

  private checkHold(): void {
    if (this.holdReasons.size && Date.now() - this.holdSince > HOLD_MAX_MS) {
      this.log('hold canvas removed after its time limit');
      this.holdReasons.clear();
      this.opts.hold.hidden = true;
    }
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

  private updateSnapshotRate(): void {
    const everyMs = this.program.active ? 100 : 1000;
    this.toRender({ t: 'snapshot', everyMs, width: 640, height: 360 });
  }

  // ---------------------------------------------------------------- status

  private observeLongTasks(): void {
    try {
      new PerformanceObserver((list) => {
        this.mainLongTasks += list.getEntries().length;
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      /* unsupported */
    }
  }

  workerStats(): WorkerStat[] {
    return this.sup.stats().map((s) => ({
      name: s.name as WorkerName,
      generation: s.generation,
      restarts: s.restarts,
      lastReason: s.lastReason,
      gaveUp: s.gaveUp,
    }));
  }

  private sendStatus(): void {
    const status: HostStatus = {
      slots: this.slots.map((s) => ({
        id: s.id,
        key: s.key,
        srcId: s.srcId,
        dropped: s.droppedFrames(),
        positionMs: s.el.currentTime * 1000,
        durationMs: Number.isFinite(s.el.duration) ? s.el.duration * 1000 : undefined,
        error: s.error,
      })),
      audio: this.master ? (this.engine?.status ?? 'none') : undefined,
      meters: this.master ? this.engine?.meters() : undefined,
      longTasks: this.mainLongTasks,
      workers: this.workerStats(),
      rafTicks: this.rafTicks,
      visible: document.visibilityState === 'visible',
      hold: !this.opts.hold.hidden,
      compositor: this.compositor,
      renderNote: this.renderNote,
      fatal: this.fatal,
      log: this.logBuffer.splice(0),
    };
    this.toLink({ t: 'host', status });
  }

  // ---------------------------------------------------------------- introspection (synchronous)

  telemetry(): Record<string, unknown> {
    return { ...(this.view?.telemetry ?? {}), workers: this.workerStats(), hold: !this.opts.hold.hidden };
  }

  state(): Record<string, unknown> {
    return {
      held: [],
      mode: 'idle',
      bus: 'none',
      ...(this.view?.state ?? {}),
      workers: this.workerStats(),
      hold: !this.opts.hold.hidden,
    };
  }

  chaos(): ChaosHooks {
    return {
      killWorker: (name) => {
        this.log(`chaos: terminating the ${name} worker`);
        this.sup.worker<Worker>(name)?.terminate();
      },
      injectDelta: (delta) => this.toLink({ t: 'chaos', action: 'injectDelta', delta }),
      verifyCache: () => this.toLink({ t: 'chaos', action: 'verifyCache' }),
    };
  }
}

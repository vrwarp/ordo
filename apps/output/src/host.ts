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
import { RELOAD_WINDOW_MS, planReload } from './reload.ts';

type HoldReason = 'lost' | 'restart' | 'silent';

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
/**
 * A hold comes down after this long even if nobody lowered it. Longer than the link's REBUILD_MAX_MS
 * (15 s, after which a stuck rebuild restarts the renderer): a 'lost' hold must outlive a slow WebGPU
 * rebuild, or the lost canvas (white) would show between the two limits (review F5). While a loss has
 * not been restored at all the hold stays up to HOLD_LOST_MAX_MS.
 */
const HOLD_MAX_MS = 20_000;
const HOLD_LOST_MAX_MS = 30_000;
/** No heartbeat from the render worker for this long: cover the screen with the hold until it beats again. */
const RENDER_SILENT_MS = 200;
/** Video frames are not posted to a render worker that has been silent this long (it may be dead). */
const VFRAME_SILENT_MS = 600;
/** Snapshot periods: idle (the hold image) and while the program view is watched. */
const SNAP_IDLE_MS = 500;
const SNAP_PROGRAM_MS = 150;
/**
 * The hold image is a copy at half the output's resolution, never below 640x360 (a 640x360 copy upscaled
 * 6x at 4K is a visible blur, review F6); the worker's createImageBitmap copy costs about the same.
 */
export function snapshotSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(640, Math.round(width / 2) & ~1);
  const h = Math.max(360, Math.round((w * height) / Math.max(1, width)) & ~1);
  return { width: w, height: h };
}
/** A rebuilt device must draw this long without another loss before the hold comes down. */
const RESTORE_PROBATION_MS = 750;
/** Media events kept for replay to a restarted link worker (unacknowledged by the current one). */
const MEDIA_REPLAY_MAX = 64;
const MEDIA_REPLAY_MS = 120_000;

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
  private pendingCanvas?: HTMLCanvasElement;
  private holdReasons = new Set<HoldReason>();
  private holdSince = 0;
  /** The hold canvas holds a copy of a frame (painted on the main thread from each snapshot). */
  private holdPainted = false;
  /** The slide cue of the frame on the hold canvas (-1 none). */
  private holdCue = -1;
  private holdCtx?: CanvasRenderingContext2D | null;
  private restoredAt = 0;
  /** A device rebuild finished: the hold comes down on the rebuilt compositor's first frame copy. */
  private restoredSnapPending = false;
  /** A device loss the renderer has not reported restored yet. */
  private lostPending = false;
  /** One pending lower per reason: lowering 'lost' is never cancelled by raising 'silent' (review F3). */
  private lowerTimers = new Map<HoldReason, ReturnType<typeof setTimeout>>();
  private renderBeat = performance.now();
  private lastHoldCheck = performance.now();
  private mediaSeq = 0;
  private mediaUnacked: { n: number; ev: MediaEvent; at: number }[] = [];
  private reloadRefused?: { at: number; text: string };
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
      // The hold (a main-thread copy of the last frame) is on screen before the worker is terminated.
      stop: () => this.raiseHold('restart'),
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
    // The same tick checks the opener: a closed operator tab is noticed within a tick, which keeps the
    // output's exit from the fallback bus prompt even when the window's timers are throttled.
    setInterval(() => {
      this.toLink({ t: 'tick' });
      this.watchOpener();
    }, 250);
    setInterval(() => this.sendStatus(), 500);
    setInterval(() => this.checkHold(), 50);
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
      if (this.sup.worker('link') !== w) return; // a message from a worker being replaced
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
    // What the media elements did is in the first status the link receives (review 2026-11-04 item 2):
    // a clip that ended while no link worker was alive is still reported by the new one.
    w.postMessage({ t: 'host', status: this.status(false) } satisfies MainToLink);
    // Media events the previous generation never acknowledged (it died with them queued) are replayed.
    const now = Date.now();
    this.mediaUnacked = this.mediaUnacked.filter((u) => now - u.at < MEDIA_REPLAY_MS);
    for (const u of this.mediaUnacked)
      w.postMessage({ t: 'media', ev: u.ev, n: u.n, replay: true } satisfies MainToLink);
    if (gen > 0) {
      // The bus port died with the old worker: ask the operator for a new one (the relay works meanwhile).
      requestPort(this.operatorOrigin, this.outputId);
      this.scheduleWire();
    }
  }

  private startRender(w: Worker, gen: number): void {
    this.gens.render = gen;
    this.renderBeat = performance.now();
    w.onmessage = (ev: MessageEvent<FromRender | { __ordo?: string }>) => {
      const d = ev.data as FromRender & { __ordo?: string };
      if (this.sup.worker('render') !== w) {
        // A worker being replaced: its frame copies are of no use.
        if ((d as { t?: string }).t === 'snapshot') (d as { bitmap: ImageBitmap }).bitmap.close();
        return;
      }
      if (d.__ordo) {
        if (d.__ordo === 'hb') this.renderBeat = performance.now();
        return;
      }
      this.onRender(d);
    };
    let target = this.opts.canvas;
    if (gen > 0) {
      // The old worker took its canvas with it: cover the screen with the last frame, give the new
      // worker a fresh canvas, show it once the link worker has re-armed the live content.
      this.raiseHold('restart');
      this.holdReasons.delete('silent');
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
    // The previous generation's relay goes first, also when the opener is already gone (review item 29).
    this.winEp?.close();
    this.winEp = undefined;
    if (!this.openerAlive()) return;
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

  private openerAlive(): boolean {
    try {
      const op = window.opener as Window | null;
      return !!op && !op.closed;
    } catch {
      return false;
    }
  }

  private watchOpener(): void {
    if (this.openerClosedSent) return;
    if (!this.hadOpener) return;
    if (!this.openerAlive()) {
      this.openerClosedSent = true;
      this.log('opener closed');
      this.toLink({ t: 'opener', closed: true });
      // The relay has nobody to talk to: release its window listener (after a moment, so a message the
      // operator posted on its way out, `fallback.hub` on pagehide, is still relayed).
      const ep = this.winEp;
      setTimeout(() => {
        ep?.close();
        if (this.winEp === ep) this.winEp = undefined;
      }, 2000);
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
    // A frame posted to a dead worker is never closed (review item 29): while the renderer is silent (it
    // may be dead, not yet restarted), frames are closed here; a restarted one gets the current frame.
    if (!w || (m.t === 'vframe' && performance.now() - this.renderBeat > VFRAME_SILENT_MS)) {
      if (m.t === 'vframe') m.frame.close();
      return;
    }
    try {
      w.postMessage(m, transfer);
    } catch {
      if (m.t === 'vframe') m.frame.close();
    }
  }

  /** Media events are kept until the link acknowledges them, and replayed to a restarted link worker. */
  private mediaEvent(ev: MediaEvent): void {
    const n = ++this.mediaSeq;
    this.mediaUnacked.push({ n, ev, at: Date.now() });
    if (this.mediaUnacked.length > MEDIA_REPLAY_MAX) this.mediaUnacked.shift();
    this.toLink({ t: 'media', ev, n });
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
          (m.view.state.gens as Record<WorkerName, number> | undefined)?.render === this.gens.render &&
          !this.lowerTimers.has('restart')
        )
          this.lowerHold('restart', 200);
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
        this.reload(m.reason, m.fallback);
        return;
      case 'mediaAck':
        this.mediaUnacked = this.mediaUnacked.filter((u) => u.n > m.n);
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
   * A refused reload falls back to restarting `fallback` (the render worker for a stuck renderer) and
   * says so in health (review 2026-11-04 item 9).
   */
  reload(reason: string, fallback?: WorkerName): void {
    const now = Date.now();
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(RELOAD_KEY);
    } catch {
      /* storage blocked */
    }
    const plan = planReload(stored, now, reason, fallback);
    if (plan.action !== 'reload') {
      this.log(plan.text);
      this.reloadRefused = { at: now, text: plan.text };
      if (plan.action === 'restart') this.sup.restart(plan.worker, `reload refused: ${reason}`.slice(0, 300));
      return;
    }
    try {
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify(plan.recent));
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
        if (
          this.holdReasons.has('lost') &&
          (!this.restoredSnapPending || performance.now() - this.restoredAt < RESTORE_PROBATION_MS)
        ) {
          // Taken around a device loss, or from a rebuilt device on probation (a failing GPU presents
          // garbage, white, until it reports the loss again). Keep the copy made before the loss.
          m.bitmap.close();
          return;
        }
        this.program.paint(m.bitmap);
        // Copied onto the (hidden) hold canvas on the main thread at once: a bitmap from the render
        // worker is backed by that worker's context and draws nothing once it dies (review item 1). A
        // restart hold keeps the pre-crash frame (a rebuilt worker's first frames may lack the content).
        if (!this.holdReasons.has('restart') && !this.holdReasons.has('silent'))
          this.paintHold(m.bitmap, m.cue ?? -1);
        m.bitmap.close();
        if (this.restoredSnapPending) {
          // The rebuilt compositor drew a frame: uncover it a moment later.
          this.restoredSnapPending = false;
          this.lowerHold('lost', 100);
        }
        return;
      case 'lost':
        // The link worker logs render lifecycle events (it hears them on its port too). The hold shows
        // the last copy; with none yet (a loss right after start) it shows black, never the lost
        // canvas (which reads white), until the rebuilt compositor has drawn a frame.
        this.restoredSnapPending = false;
        this.lostPending = true;
        if (!this.holdPainted) this.paintHoldBlack();
        this.raiseHold('lost');
        return;
      case 'restored':
        this.compositor = m.compositor;
        this.lostPending = false;
        if (m.compositor === 'webgpu') this.renderNote = undefined;
        this.adoptCanvas();
        // Uncovered on a frame copy the rebuilt compositor makes after RESTORE_PROBATION_MS without
        // another loss (or 2 s after that). Canvas 2D never presents garbage: no probation, the first
        // copy uncovers it (review F2).
        this.restoredSnapPending = true;
        this.restoredAt = m.compositor === '2d' ? performance.now() - RESTORE_PROBATION_MS : performance.now();
        setTimeout(() => {
          if (this.restoredSnapPending && performance.now() - this.restoredAt >= RESTORE_PROBATION_MS) {
            this.restoredSnapPending = false;
            this.lowerHold('lost');
          }
        }, RESTORE_PROBATION_MS + 2000);
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
    if (!this.opts.hold.hidden) c.style.visibility = 'hidden';
    this.opts.canvas.replaceWith(c);
    this.opts.canvas = c;
    this.log('renderer switched to the fresh canvas');
  }

  /** Show the hold canvas: it already holds the main thread's copy of the last frame. */
  private raiseHold(reason: HoldReason): void {
    clearTimeout(this.lowerTimers.get(reason));
    this.lowerTimers.delete(reason);
    if (!this.holdReasons.size) this.holdSince = Date.now();
    this.holdReasons.add(reason);
    if (this.holdPainted) this.showHold(true);
  }

  /**
   * Show or hide the hold. While it shows, the canvas underneath is taken off screen: a canvas whose
   * worker died or whose WebGPU device was lost can be composited white, above the hold.
   */
  private showHold(on: boolean): void {
    this.opts.hold.hidden = !on;
    this.opts.canvas.style.visibility = on ? 'hidden' : '';
  }

  private lowerHold(reason: HoldReason, delayMs = 0): void {
    clearTimeout(this.lowerTimers.get(reason));
    this.lowerTimers.delete(reason);
    if (delayMs > 0) {
      // Give the canvas underneath a few frames before uncovering it (never a fade from black).
      this.lowerTimers.set(
        reason,
        setTimeout(() => this.lowerHold(reason), delayMs),
      );
      return;
    }
    this.holdReasons.delete(reason);
    if (!this.holdReasons.size) this.showHold(false);
  }

  private checkHold(): void {
    const now = performance.now();
    const gap = now - this.lastHoldCheck;
    this.lastHoldCheck = now;
    // A renderer that stopped beating may be dead: cover the screen now rather than when the supervisor
    // restarts it. Not judged right after a main-thread stall (its heartbeats are merely queued).
    if (gap < 600) {
      const silent = now - this.renderBeat > RENDER_SILENT_MS && !!this.sup.worker('render');
      if (silent && !this.holdReasons.has('silent') && !this.holdReasons.has('restart')) {
        this.log('render worker silent: holding the last frame');
        this.raiseHold('silent');
      } else if (!silent && this.holdReasons.has('silent')) this.lowerHold('silent');
    }
    // The time limit never uncovers a canvas whose device is still lost (it reads white): that hold
    // waits for `restored`, up to HOLD_LOST_MAX_MS (the link restarts a stuck rebuild before then).
    const held = Date.now() - this.holdSince;
    const limit = this.lostPending && this.holdReasons.has('lost') ? HOLD_LOST_MAX_MS : HOLD_MAX_MS;
    if (this.holdReasons.size && held > limit) {
      this.log('hold canvas removed after its time limit');
      this.holdReasons.clear();
      for (const t of this.lowerTimers.values()) clearTimeout(t);
      this.lowerTimers.clear();
      this.showHold(false);
    }
  }

  /** An opaque black hold (a device lost before any frame was copied). */
  private paintHoldBlack(): void {
    const c = this.opts.hold;
    if (c.width !== this.opts.width || c.height !== this.opts.height) {
      c.width = this.opts.width;
      c.height = this.opts.height;
      this.holdCtx = undefined;
    }
    this.holdCtx ??= c.getContext('2d', { alpha: false });
    if (!this.holdCtx) return;
    this.holdCtx.fillStyle = '#000';
    this.holdCtx.fillRect(0, 0, c.width, c.height);
    this.holdCue = -1;
    this.holdPainted = true;
  }

  /** Copy a frame onto the hold canvas (main thread; at most a few times a second, 640x360 scaled). */
  private paintHold(b: ImageBitmap, cue: number): void {
    const c = this.opts.hold;
    if (c.width !== this.opts.width || c.height !== this.opts.height) {
      c.width = this.opts.width;
      c.height = this.opts.height;
      this.holdCtx = undefined;
    }
    this.holdCtx ??= c.getContext('2d', { alpha: false });
    const ctx = this.holdCtx;
    if (!ctx) return;
    try {
      ctx.drawImage(b, 0, 0, c.width, c.height);
    } catch {
      return; // a detached or broken bitmap: keep the previous copy
    }
    if (this.opts.testMode) {
      // The test pixel of the copied frame, exact (the downscaled copy blurs the renderer's 1 px marker).
      ctx.fillStyle = cue < 0 ? '#000' : `rgb(${cue & 255}, ${(cue >> 8) & 255}, 255)`;
      ctx.fillRect(0, 0, 1, 1);
    }
    this.holdCue = cue;
    if (!this.holdPainted) {
      this.holdPainted = true;
      if (this.holdReasons.size) this.showHold(true);
    }
  }

  private updateSnapshotRate(): void {
    const everyMs = this.program.active ? SNAP_PROGRAM_MS : SNAP_IDLE_MS;
    const size = snapshotSize(this.opts.width, this.opts.height);
    this.toRender({ t: 'snapshot', everyMs, width: size.width, height: size.height });
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

  private status(drainLog: boolean): HostStatus {
    return {
      slots: this.slots.map((s) => ({
        id: s.id,
        key: s.key,
        srcId: s.srcId,
        dropped: s.droppedFrames(),
        positionMs: s.el.currentTime * 1000,
        durationMs: Number.isFinite(s.el.duration) ? s.el.duration * 1000 : undefined,
        error: s.error,
        ended: !!s.key && s.el.ended,
        paused: s.el.paused,
        ready: s.ready,
        hash: s.hash,
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
      reloadRefused:
        this.reloadRefused && Date.now() - this.reloadRefused.at < RELOAD_WINDOW_MS
          ? this.reloadRefused.text
          : undefined,
      log: drainLog ? this.logBuffer.splice(0) : [],
    };
  }

  private sendStatus(): void {
    this.toLink({ t: 'host', status: this.status(true) });
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
      holdCue: this.holdPainted ? this.holdCue : undefined,
      holdReasons: [...this.holdReasons],
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

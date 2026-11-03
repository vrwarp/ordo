import type { AudioSettings } from '@ordo/domain';
import { masterGain, meterBallistics, peakOf, planRoute, type RoutePlan, sourceGain } from './math.ts';

export type AudioDevice = { deviceId: string; label: string; channels?: number };
export type AudioStatus = 'ok' | 'lost' | 'none';
export type SourceHandle = { readonly id: number };
export type SourceOptions = { pairId?: string; gainDb?: number; loudnessLufs?: number };

/** Chrome's AudioContext additions (sinkId, setSinkId, sinkchange) not in every lib.dom version. */
export type SinkAudioContext = AudioContext & {
  readonly sinkId?: string | object;
  setSinkId?: (id: string | { type: 'none' }) => Promise<void>;
  onsinkchange?: ((ev: Event) => void) | null;
};

export type ContextOptions = { sinkId?: string; latencyHint: AudioContextLatencyCategory };

/** Platform dependencies; injectable for tests. */
export type AudioDeps = {
  createContext: (opts: ContextOptions) => SinkAudioContext;
  mediaDevices?: Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  now: () => number;
};

export function browserDeps(): AudioDeps {
  return {
    createContext: (opts) => {
      const o: Record<string, unknown> = { latencyHint: opts.latencyHint };
      if (opts.sinkId) o.sinkId = opts.sinkId;
      return new AudioContext(o as AudioContextOptions) as SinkAudioContext;
    },
    mediaDevices: typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id as number),
    now: () => performance.now(),
  };
}

/** Ramp used for gain changes and re-routing so nothing clicks. */
export const RAMP_S = 0.02;
export const DEVICE_POLL_MS = 2000;
const MAX_CHANNELS = 32;

/**
 * Match a configured device in an enumeration. Device ids are per-origin in Chrome, so the operator's id may
 * not exist in the output window's origin: fall back to the stored label.
 */
export function resolveDevice(
  devices: readonly Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[],
  deviceId: string | undefined,
  label: string | undefined,
): string | undefined {
  const outs = devices.filter((d) => d.kind === 'audiooutput');
  if (deviceId) {
    const byId = outs.find((d) => d.deviceId === deviceId);
    if (byId) return byId.deviceId;
  }
  if (label) {
    const want = label.trim().toLowerCase();
    const byLabel = outs.find((d) => d.deviceId !== 'default' && d.label.trim().toLowerCase() === want);
    if (byLabel?.deviceId) return byLabel.deviceId;
  }
  return undefined;
}

/** Media element sources can be created once per element, ever: cache them. */
const elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

type Source = {
  id: number;
  el: HTMLMediaElement;
  opts: SourceOptions;
  node?: MediaElementAudioSourceNode;
  gain?: GainNode;
  splitter?: ChannelSplitterNode;
  route?: RoutePlan;
  /** Bus generation the splitter is connected to. */
  busGen: number;
  rerouteTimer?: unknown;
};

type PairMeter = {
  pairId: string;
  left: AnalyserNode;
  right: AnalyserNode;
  buf: Float32Array;
  level: number;
};

type Bus = {
  gen: number;
  channels: number;
  merger: ChannelMergerNode;
  master: GainNode;
  meterSplit: ChannelSplitterNode;
  meters: PairMeter[];
};

function setParam(ctx: BaseAudioContext, p: AudioParam, value: number, rampS = RAMP_S): void {
  const t = ctx.currentTime;
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(value, t + rampS);
}

export class AudioEngine {
  status: AudioStatus = 'none';
  /** Called whenever `status` changes. */
  onStatus?: (s: AudioStatus) => void;
  /** Diagnostics (device fallbacks, cross-context elements). */
  onLog?: (msg: string) => void;

  private settings: AudioSettings;
  private deps: AudioDeps;
  private ctx: SinkAudioContext | null = null;
  private bus: Bus | null = null;
  private busGen = 0;
  private sources = new Map<number, Source>();
  private nextId = 1;
  private masterDb: number;
  private muted = false;
  private fading = false;
  private pollId: unknown = null;
  private deviceListener = () => void this.checkDevice();
  private checking = false;
  /** The device id currently in use (resolved for this origin), '' for the default device. */
  private activeSink = '';
  private lastMeterAt = 0;
  private disposed = false;

  constructor(settings: AudioSettings, deps?: Partial<AudioDeps>) {
    this.settings = settings;
    this.masterDb = settings.masterDb ?? 0;
    this.deps = { ...browserDeps(), ...deps } as AudioDeps;
  }

  /** Physical channel count of the open device (0 before start). */
  get channels(): number {
    return this.bus?.channels ?? 0;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Create the AudioContext on the house device. Must be called after a user gesture or with autoplay allowed. */
  async start(): Promise<void> {
    if (this.ctx || this.disposed) return;
    const wanted = await this.resolveHouse();
    const ctx = await this.openContext(wanted);
    if (this.disposed) {
      void ctx.close();
      return;
    }
    this.ctx = ctx;
    ctx.onsinkchange = () => {
      this.log(`sink changed to ${String(ctx.sinkId ?? '')}`);
      this.onSinkChanged();
      void this.checkDevice();
    };
    ctx.onstatechange = () => {
      if ((ctx.state as string) === 'suspended' || (ctx.state as string) === 'interrupted') {
        void ctx.resume().catch(() => {});
      }
    };
    this.buildBus();
    for (const s of this.sources.values()) this.wire(s);
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    this.deps.mediaDevices?.addEventListener('devicechange', this.deviceListener);
    this.pollId = this.deps.setInterval(() => void this.checkDevice(), DEVICE_POLL_MS);
    const configured = !!(this.settings.houseDeviceId || this.settings.houseDeviceLabel);
    this.setStatus(configured && wanted === undefined ? 'lost' : 'ok');
  }

  setSettings(settings: AudioSettings): void {
    const prev = this.settings;
    this.settings = settings;
    if (settings.masterDb !== prev.masterDb) this.setMasterDb(settings.masterDb ?? 0);
    if (!this.ctx) return;
    if (
      settings.houseDeviceId !== prev.houseDeviceId ||
      settings.houseDeviceLabel !== prev.houseDeviceLabel
    ) {
      void this.checkDevice(true);
      return;
    }
    if (JSON.stringify(settings.pairs) !== JSON.stringify(prev.pairs)) {
      this.buildBus();
      for (const s of this.sources.values()) this.wire(s);
    } else if (settings.defaultPairId !== prev.defaultPairId) {
      for (const s of this.sources.values()) this.reroute(s);
    }
  }

  /**
   * Route a media element through the engine to a stereo pair. Returns a handle for detach/updates. The
   * element must not be muted (muted elements feed silence) and must be same-origin or CORS-enabled.
   */
  attach(el: HTMLMediaElement, opts: SourceOptions = {}): SourceHandle {
    for (const s of this.sources.values()) {
      if (s.el === el) {
        this.update(s, opts);
        return { id: s.id };
      }
    }
    const s: Source = { id: this.nextId++, el, opts: { ...opts }, busGen: -1 };
    this.sources.set(s.id, s);
    if (this.ctx) this.wire(s);
    return { id: s.id };
  }

  update(h: SourceHandle, opts: SourceOptions): void {
    const s = this.sources.get(h.id);
    if (!s) return;
    const prevPair = s.opts.pairId;
    s.opts = { ...s.opts, ...opts };
    if (!this.ctx || !s.gain) return;
    if (s.opts.pairId !== prevPair) this.reroute(s);
    else setParam(this.ctx, s.gain.gain, sourceGain(s.opts));
  }

  detach(h: SourceHandle): void {
    const s = this.sources.get(h.id);
    if (!s) return;
    this.sources.delete(h.id);
    try {
      s.node?.disconnect();
      s.gain?.disconnect();
      s.splitter?.disconnect();
    } catch {
      // already disconnected
    }
  }

  setMasterDb(db: number): void {
    this.masterDb = db;
    this.applyMaster();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMaster();
  }

  /** Ramp master to silence over `ms`, then restore gain (sources keep playing unless stopped by caller). */
  async fadeOut(ms = 500): Promise<void> {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    this.fading = true;
    const p = bus.master.gain;
    const t = ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(0, t + ms / 1000);
    await new Promise<void>((r) => this.deps.setTimeout(r, ms + 10));
    this.fading = false;
    if (this.bus !== bus || !this.ctx) return;
    // Restore after a short hold so the caller can pause/stop sources right after the await.
    const now = this.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(0, now);
    p.setValueAtTime(0, now + 0.08);
    p.linearRampToValueAtTime(masterGain(this.masterDb, this.muted), now + 0.08 + RAMP_S);
  }

  /** Peak level per configured pair (settings order), 0..1, with meter ballistics. */
  meters(): number[] {
    const bus = this.bus;
    const pairs = this.settings.pairs ?? [];
    if (!bus) return pairs.map(() => 0);
    const now = this.deps.now();
    const dt = this.lastMeterAt ? now - this.lastMeterAt : 50;
    this.lastMeterAt = now;
    const out: number[] = [];
    for (const pair of pairs) {
      const m = bus.meters.find((x) => x.pairId === pair.id);
      if (!m) {
        out.push(0);
        continue;
      }
      m.left.getFloatTimeDomainData(m.buf as Float32Array<ArrayBuffer>);
      let peak = peakOf(m.buf);
      m.right.getFloatTimeDomainData(m.buf as Float32Array<ArrayBuffer>);
      const r = peakOf(m.buf);
      if (r > peak) peak = r;
      m.level = meterBallistics(m.level, peak, dt);
      out.push(m.level);
    }
    return out;
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollId !== null) this.deps.clearInterval(this.pollId);
    this.pollId = null;
    this.deps.mediaDevices?.removeEventListener('devicechange', this.deviceListener);
    for (const s of this.sources.values()) this.detach(s);
    const ctx = this.ctx;
    this.ctx = null;
    this.bus = null;
    if (ctx) {
      ctx.onsinkchange = null;
      ctx.onstatechange = null;
      void ctx.close().catch(() => {});
    }
    this.setStatus('none');
  }

  // ---- internals ----

  private log(msg: string) {
    this.onLog?.(msg);
  }

  private setStatus(s: AudioStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s);
  }

  private async enumerate(): Promise<MediaDeviceInfo[] | null> {
    try {
      return (await this.deps.mediaDevices?.enumerateDevices()) ?? null;
    } catch {
      return null;
    }
  }

  /** The house device id for this origin, '' when none is configured, undefined when it is absent. */
  private async resolveHouse(): Promise<string | undefined> {
    const { houseDeviceId, houseDeviceLabel } = this.settings;
    if (!houseDeviceId && !houseDeviceLabel) return '';
    if (houseDeviceId === 'default') return '';
    const devices = await this.enumerate();
    if (!devices) return houseDeviceId; // cannot check: try the id as given
    return resolveDevice(devices, houseDeviceId, houseDeviceLabel);
  }

  /** Open a context on `sinkId` with the constructor option, then setSinkId, then the default device. */
  private async openContext(sinkId: string | undefined): Promise<SinkAudioContext> {
    const { createContext } = this.deps;
    if (sinkId) {
      try {
        const ctx = createContext({ sinkId, latencyHint: 'playback' });
        this.activeSink = sinkId;
        return ctx;
      } catch (e) {
        this.log(`AudioContext({ sinkId }) failed: ${(e as Error).message}`);
      }
    }
    const ctx = createContext({ latencyHint: 'playback' });
    this.activeSink = '';
    if (sinkId && ctx.setSinkId) {
      try {
        await ctx.setSinkId(sinkId);
        this.activeSink = sinkId;
      } catch (e) {
        this.log(`setSinkId failed, using the default device: ${(e as Error).message}`);
      }
    }
    if (sinkId === undefined) this.log('house device not found; using the default device until it returns');
    return ctx;
  }

  private onSinkChanged() {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return;
    const ch = this.deviceChannels(ctx);
    if (ch !== this.bus.channels) {
      this.buildBus();
      for (const s of this.sources.values()) this.wire(s);
    }
  }

  /** Called on devicechange, sinkchange and every 2 s: detect loss and recover. */
  private async checkDevice(force = false): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this.checking || this.disposed) return;
    this.checking = true;
    try {
      const { houseDeviceId, houseDeviceLabel } = this.settings;
      if ((ctx.state as string) === 'suspended' || (ctx.state as string) === 'interrupted') {
        void ctx.resume().catch(() => {});
      }
      if (!houseDeviceId && !houseDeviceLabel) {
        if (this.activeSink && ctx.setSinkId) {
          await ctx.setSinkId('');
          this.activeSink = '';
          this.onSinkChanged();
        }
        this.setStatus('ok');
        return;
      }
      const devices = await this.enumerate();
      if (!devices) return;
      const id =
        houseDeviceId === 'default' ? 'default' : resolveDevice(devices, houseDeviceId, houseDeviceLabel);
      if (!id) {
        if (this.status !== 'lost') this.log('house audio device lost');
        this.setStatus('lost');
        return;
      }
      const target = id === 'default' ? '' : id;
      const wasLost = this.status === 'lost';
      if (force || wasLost || target !== this.activeSink) {
        if (ctx.setSinkId) {
          try {
            // Re-selecting the same id can be a no-op after a device returns; bounce via the default device.
            if (wasLost && target && String(ctx.sinkId ?? '') === target) await ctx.setSinkId('');
            await ctx.setSinkId(target);
            this.activeSink = target;
          } catch (e) {
            this.log(`setSinkId failed: ${(e as Error).message}`);
            this.setStatus('lost');
            return;
          }
        }
        this.onSinkChanged();
        if (ctx.state !== 'running') await ctx.resume().catch(() => {});
        if (wasLost) this.log('house audio device back');
      }
      this.setStatus('ok');
    } finally {
      this.checking = false;
    }
  }

  private deviceChannels(ctx: AudioContext): number {
    const max = ctx.destination.maxChannelCount || 2;
    return Math.max(1, Math.min(MAX_CHANNELS, max));
  }

  private applyMaster() {
    if (!this.ctx || !this.bus || this.fading) return;
    setParam(this.ctx, this.bus.master.gain, masterGain(this.masterDb, this.muted));
  }

  private buildBus() {
    const ctx = this.ctx!;
    const old = this.bus;
    if (old) {
      try {
        old.merger.disconnect();
        old.master.disconnect();
        old.meterSplit.disconnect();
      } catch {
        // ignore
      }
    }
    const channels = this.deviceChannels(ctx);
    const dest = ctx.destination;
    try {
      dest.channelCount = channels;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
    } catch (e) {
      this.log(`destination channel setup failed: ${(e as Error).message}`);
    }
    const merger = ctx.createChannelMerger(channels);
    const master = ctx.createGain();
    master.channelCount = channels;
    master.channelCountMode = 'explicit';
    master.channelInterpretation = 'discrete';
    master.gain.value = this.fading ? 0 : masterGain(this.masterDb, this.muted);
    merger.connect(master);
    master.connect(dest);
    const meterSplit = ctx.createChannelSplitter(channels);
    master.connect(meterSplit);
    const meters: PairMeter[] = [];
    for (const pair of this.settings.pairs ?? []) {
      const plan = planRoute([pair], pair.id, undefined, channels);
      if (plan.fallback) continue;
      const left = ctx.createAnalyser();
      const right = ctx.createAnalyser();
      left.fftSize = 512;
      right.fftSize = 512;
      meterSplit.connect(left, plan.left);
      meterSplit.connect(right, plan.right);
      meters.push({ pairId: pair.id, left, right, buf: new Float32Array(left.fftSize), level: 0 });
    }
    this.bus = { gen: ++this.busGen, channels, merger, master, meterSplit, meters };
  }

  /** Create (once) and connect a source's nodes to the current bus. */
  private wire(s: Source) {
    const ctx = this.ctx!;
    const bus = this.bus!;
    if (!s.node) {
      let node = elementSources.get(s.el);
      if (node && node.context !== ctx) {
        this.log('media element already belongs to another AudioContext; it cannot be routed');
        return;
      }
      if (!node) {
        try {
          node = ctx.createMediaElementSource(s.el);
        } catch (e) {
          this.log(`createMediaElementSource failed: ${(e as Error).message}`);
          return;
        }
        elementSources.set(s.el, node);
      }
      s.node = node;
      const gain = ctx.createGain();
      // Up-mix mono to L=R, keep stereo as is.
      gain.channelCount = 2;
      gain.channelCountMode = 'explicit';
      gain.channelInterpretation = 'speakers';
      gain.gain.value = sourceGain(s.opts);
      const splitter = ctx.createChannelSplitter(2);
      try {
        node.disconnect();
      } catch {
        // not connected
      }
      node.connect(gain);
      gain.connect(splitter);
      s.gain = gain;
      s.splitter = splitter;
    }
    try {
      s.splitter!.disconnect();
    } catch {
      // not connected
    }
    const plan = this.plan(s, bus.channels);
    s.splitter!.connect(bus.merger, 0, plan.left);
    s.splitter!.connect(bus.merger, 1, plan.right);
    s.route = plan;
    s.busGen = bus.gen;
  }

  private plan(s: Source, channels: number): RoutePlan {
    const plan = planRoute(this.settings.pairs ?? [], s.opts.pairId, this.settings.defaultPairId, channels);
    if (plan.fallback && s.opts.pairId)
      this.log(`pair ${s.opts.pairId} unavailable; using channels ${plan.left + 1}/${plan.right + 1}`);
    return plan;
  }

  /** Move a source to its (possibly new) pair with a 20 ms fade out and in. */
  private reroute(s: Source) {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus || !s.gain || !s.splitter) return;
    const next = this.plan(s, bus.channels);
    const target = sourceGain(s.opts);
    if (s.route && s.busGen === bus.gen && next.left === s.route.left && next.right === s.route.right) {
      setParam(ctx, s.gain.gain, target);
      return;
    }
    setParam(ctx, s.gain.gain, 0);
    const gen = bus.gen;
    s.rerouteTimer = this.deps.setTimeout(
      () => {
        if (!this.ctx || !this.bus || !this.sources.has(s.id) || this.bus.gen !== gen) return;
        try {
          s.splitter!.disconnect();
        } catch {
          // ignore
        }
        const plan = this.plan(s, this.bus.channels);
        s.splitter!.connect(this.bus.merger, 0, plan.left);
        s.splitter!.connect(this.bus.merger, 1, plan.right);
        s.route = plan;
        s.busGen = this.bus.gen;
        setParam(this.ctx, s.gain!.gain, sourceGain(s.opts));
      },
      RAMP_S * 1000 + 5,
    );
  }
}

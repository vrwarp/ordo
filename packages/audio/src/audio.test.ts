import type { AudioSettings } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  AudioEngine,
  type AudioDeps,
  dbToGain,
  loudnessGainDb,
  masterGain,
  meterBallistics,
  peakOf,
  planRoute,
  resolveDevice,
  type SinkAudioContext,
  sourceGain,
} from './index.ts';

const pairs = [
  { id: 'house', name: 'House', left: 0, right: 1 },
  { id: 'lobby', name: 'Lobby', left: 2, right: 3 },
  { id: 'far', name: 'Far', left: 8, right: 9 },
];

describe('gain maths', () => {
  it('converts dB', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(dbToGain(20)).toBeCloseTo(10);
  });
  it('normalises loudness to -16 LUFS within ±12 dB', () => {
    expect(loudnessGainDb(-20)).toBe(4);
    expect(loudnessGainDb(-10)).toBe(-6);
    expect(loudnessGainDb(-40)).toBe(12);
    expect(loudnessGainDb(undefined)).toBe(0);
    expect(loudnessGainDb(Number.NaN)).toBe(0);
  });
  it('combines item gain and loudness', () => {
    expect(sourceGain({ gainDb: -6, loudnessLufs: -10 })).toBeCloseTo(dbToGain(-12));
    expect(sourceGain({})).toBe(1);
  });
  it('mutes and clamps master', () => {
    expect(masterGain(0, true)).toBe(0);
    expect(masterGain(-6, false)).toBeCloseTo(0.501, 3);
    expect(masterGain(100, false)).toBeCloseTo(dbToGain(12));
  });
});

describe('planRoute', () => {
  it('maps 0-based pair channels to merger inputs', () => {
    expect(planRoute(pairs, 'lobby', 'house', 8)).toEqual({
      left: 2,
      right: 3,
      pairId: 'lobby',
      fallback: false,
    });
  });
  it('uses the default pair when none is given', () => {
    expect(planRoute(pairs, undefined, 'lobby', 8)).toEqual({
      left: 2,
      right: 3,
      pairId: 'lobby',
      fallback: false,
    });
  });
  it('falls back when the pair is beyond the device', () => {
    expect(planRoute(pairs, 'far', 'house', 8)).toEqual({
      left: 0,
      right: 1,
      pairId: 'house',
      fallback: true,
    });
    expect(planRoute(pairs, 'lobby', 'lobby', 2)).toEqual({ left: 0, right: 1, fallback: true });
  });
  it('handles mono devices', () => {
    expect(planRoute([], undefined, undefined, 1)).toEqual({ left: 0, right: 0, fallback: true });
  });
});

describe('meters', () => {
  it('finds the absolute peak', () => {
    expect(peakOf(new Float32Array([0.1, -0.7, 0.3]))).toBeCloseTo(0.7);
    expect(peakOf(new Float32Array([2]))).toBe(1);
  });
  it('attacks instantly and releases 20 dB per 300 ms', () => {
    expect(meterBallistics(0.2, 0.8, 50)).toBe(0.8);
    expect(meterBallistics(1, 0, 300)).toBeCloseTo(0.1);
    expect(meterBallistics(1, 0.5, 300)).toBe(0.5);
  });
});

describe('resolveDevice', () => {
  const devs = [
    { deviceId: 'default', kind: 'audiooutput' as const, label: 'Default - Speakers' },
    { deviceId: 'abc', kind: 'audiooutput' as const, label: 'Focusrite 18i20' },
    { deviceId: 'mic', kind: 'audioinput' as const, label: 'Focusrite 18i20' },
  ];
  it('matches by id, then label', () => {
    expect(resolveDevice(devs, 'abc', 'x')).toBe('abc');
    expect(resolveDevice(devs, 'other-origin-id', 'focusrite 18i20')).toBe('abc');
    expect(resolveDevice(devs, 'gone', 'Gone')).toBeUndefined();
  });
});

// ---- Web Audio fakes ----

type Conn = { to: FakeNode; out: number; in: number };
class FakeParam {
  events: string[] = [];
  constructor(public value = 1) {}
  cancelScheduledValues() {
    return this;
  }
  setValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(`ramp ${v.toFixed(3)} @${t.toFixed(3)}`);
    this.value = v;
    return this;
  }
}
class FakeNode {
  conns: Conn[] = [];
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  gain = new FakeParam();
  fftSize = 2048;
  fill = 0;
  constructor(
    public kind: string,
    public context: unknown,
    public n = 0,
  ) {}
  connect(to: FakeNode, out = 0, inp = 0) {
    this.conns.push({ to, out, in: inp });
    return to;
  }
  disconnect() {
    this.conns = [];
  }
  getFloatTimeDomainData(buf: Float32Array) {
    buf.fill(this.fill);
  }
}
class FakeContext {
  currentTime = 1;
  state = 'running';
  sinkId: string;
  destination: FakeNode & { maxChannelCount: number };
  sinkCalls: string[] = [];
  onsinkchange: (() => void) | null = null;
  onstatechange: (() => void) | null = null;
  nodes: FakeNode[] = [];
  listeners = new Map<string, (() => void)[]>();
  resumes = 0;
  /** Device ids the fake refuses to route to (the context silently stays where it was). */
  deadSinks = new Set<string>();
  constructor(
    opts: { sinkId?: string },
    public channelsFor: (id: string) => number,
    dead: string[] = [],
  ) {
    for (const d of dead) this.deadSinks.add(d);
    this.sinkId = opts.sinkId && !this.deadSinks.has(opts.sinkId) ? opts.sinkId : '';
    this.destination = Object.assign(new FakeNode('destination', this), {
      maxChannelCount: channelsFor(this.sinkId),
    });
  }
  private mk(kind: string, n = 0) {
    const node = new FakeNode(kind, this, n);
    this.nodes.push(node);
    return node;
  }
  createGain() {
    return this.mk('gain');
  }
  createChannelMerger(n: number) {
    return this.mk('merger', n);
  }
  createChannelSplitter(n: number) {
    return this.mk('splitter', n);
  }
  createAnalyser() {
    return this.mk('analyser');
  }
  createMediaElementSource() {
    return this.mk('element');
  }
  async setSinkId(id: string) {
    this.sinkCalls.push(id);
    if (this.deadSinks.has(id)) return;
    this.sinkId = id;
    this.destination.maxChannelCount = this.channelsFor(id);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  async resume() {
    this.resumes++;
    this.state = 'running';
  }
  async close() {
    this.state = 'closed';
  }
}

function harness(
  settings: AudioSettings,
  devices: { deviceId: string; label: string }[],
  opts: { deadSinks?: string[] } = {},
) {
  const timers: (() => void)[] = [];
  const contexts: FakeContext[] = [];
  const devs = { list: devices };
  const clock = { now: 0 };
  const deps: Partial<AudioDeps> = {
    createContext: (o) => {
      const c = new FakeContext(o, (id) => (id === 'usb' ? 8 : 2), opts.deadSinks);
      contexts.push(c);
      return c as unknown as SinkAudioContext;
    },
    mediaDevices: {
      enumerateDevices: async () =>
        devs.list.map((d) => ({
          ...d,
          kind: 'audiooutput',
          groupId: '',
          toJSON: () => ({}),
        })) as MediaDeviceInfo[],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    setInterval: () => 1,
    clearInterval: () => {},
    now: () => clock.now,
  };
  const engine = new AudioEngine(settings, deps);
  return { engine, contexts, timers, devs, clock };
}

/** The master gain of the current bus: the last gain node wired to the destination. */
const masterOf = (ctx: FakeContext) =>
  ctx.nodes.filter((n) => n.kind === 'gain' && n.conns.some((c) => c.to === ctx.destination)).at(-1)!;
const checkDevice = (engine: AudioEngine, force = false) =>
  (engine as unknown as { checkDevice: (f?: boolean) => Promise<void> }).checkDevice(force);

const settings: AudioSettings = {
  houseDeviceId: 'usb',
  houseDeviceLabel: 'USB Interface',
  pairs,
  defaultPairId: 'house',
  masterDb: 0,
};

function mergerInputs(_ctx: FakeContext, source: FakeNode): number[] {
  // element -> gain -> splitter -> merger
  const gain = source.conns[0]!.to;
  const splitter = gain.conns[0]!.to;
  return splitter.conns.map((c) => c.in);
}

describe('AudioEngine graph', () => {
  it('opens the house device and routes a source to its pair only', async () => {
    const { engine, contexts } = harness(settings, [
      { deviceId: 'default', label: 'Default' },
      { deviceId: 'usb', label: 'USB Interface' },
    ]);
    const el = {} as HTMLMediaElement;
    const h = engine.attach(el, { pairId: 'lobby', gainDb: -6 });
    await engine.start();
    const ctx = contexts[0]!;
    expect(ctx.sinkId).toBe('usb');
    expect(engine.status).toBe('ok');
    expect(engine.channels).toBe(8);
    expect(ctx.destination.channelCount).toBe(8);
    expect(ctx.destination.channelCountMode).toBe('explicit');
    expect(ctx.destination.channelInterpretation).toBe('discrete');
    const merger = ctx.nodes.find((n) => n.kind === 'merger')!;
    expect(merger.n).toBe(8);
    const src = ctx.nodes.find((n) => n.kind === 'element')!;
    expect(mergerInputs(ctx, src)).toEqual([2, 3]);
    const gain = src.conns[0]!.to;
    expect(gain.gain.value).toBeCloseTo(dbToGain(-6));
    // Attaching the same element again reuses the handle and the source node.
    expect(engine.attach(el, { gainDb: 0 }).id).toBe(h.id);
    expect(ctx.nodes.filter((n) => n.kind === 'element')).toHaveLength(1);
    engine.dispose();
  });

  it('re-routes with a 20 ms ramp', async () => {
    const { engine, contexts, timers } = harness(settings, [{ deviceId: 'usb', label: 'USB Interface' }]);
    await engine.start();
    const h = engine.attach({} as HTMLMediaElement, {});
    const ctx = contexts[0]!;
    const src = ctx.nodes.find((n) => n.kind === 'element')!;
    expect(mergerInputs(ctx, src)).toEqual([0, 1]);
    engine.update(h, { pairId: 'lobby' });
    const gain = src.conns[0]!.to;
    expect(gain.gain.value).toBe(0);
    expect(gain.gain.events.at(-1)).toBe('ramp 0.000 @1.020');
    expect(mergerInputs(ctx, src)).toEqual([0, 1]);
    timers.shift()!();
    expect(mergerInputs(ctx, src)).toEqual([2, 3]);
    expect(gain.gain.value).toBe(1);
    engine.dispose();
  });

  it('fades the master out and restores it after a hold', async () => {
    const { engine, contexts, timers } = harness(settings, [{ deviceId: 'usb', label: 'USB Interface' }]);
    await engine.start();
    const master = contexts[0]!.nodes.filter((n) => n.kind === 'gain')[0]!;
    const done = engine.fadeOut(500);
    expect(master.gain.events.at(-1)).toBe('ramp 0.000 @1.500');
    // Master changes during the fade do not cancel it.
    engine.setMasterDb(-3);
    expect(master.gain.value).toBe(0);
    timers.shift()!();
    await done;
    expect(master.gain.events.at(-1)).toBe(`ramp ${dbToGain(-3).toFixed(3)} @1.100`);
    engine.dispose();
  });

  it('restores the master on a bus rebuilt during a fade (item 21)', async () => {
    const { engine, contexts, timers } = harness(settings, [{ deviceId: 'usb', label: 'USB Interface' }]);
    await engine.start();
    const ctx = contexts[0]!;
    const oldMaster = masterOf(ctx);
    const done = engine.fadeOut(500);
    expect(oldMaster.gain.events.at(-1)).toBe('ramp 0.000 @1.500');
    // A pair-settings change mid-fade rebuilds the bus; the new master starts silent.
    engine.setSettings({ ...settings, pairs: [pairs[0]!] });
    const newMaster = ctx.nodes.filter((n) => n.kind === 'gain').at(-1)!;
    expect(newMaster).not.toBe(oldMaster);
    expect(newMaster.gain.value).toBe(0);
    timers.shift()!();
    await done;
    expect(newMaster.gain.events.at(-1)).toBe('ramp 1.000 @1.100');
    expect(newMaster.gain.value).toBe(1);
    engine.dispose();
  });

  it('shares one fade between overlapping calls and restores after the longest (item 21)', async () => {
    const { engine, contexts, timers, clock } = harness(settings, [
      { deviceId: 'usb', label: 'USB Interface' },
    ]);
    await engine.start();
    const master = masterOf(contexts[0]!);
    const a = engine.fadeOut(500);
    clock.now = 100;
    const b = engine.fadeOut(1000);
    expect(b).toBe(a);
    expect(master.gain.events.filter((e) => e.startsWith('ramp 0.000'))).toHaveLength(1);
    expect(timers).toHaveLength(2);
    // The short fade's timer fires first: the gain must stay at zero.
    timers.shift()!();
    await Promise.resolve();
    expect(master.gain.value).toBe(0);
    timers.shift()!();
    await a;
    expect(master.gain.value).toBe(1);
    // A shorter overlapping fade does not schedule anything new.
    const c = engine.fadeOut(400);
    engine.fadeOut(100);
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await c;
    engine.dispose();
  });

  it('verifies the sink after opening and treats an unusable device as lost (item 32)', async () => {
    const h = harness(settings, [{ deviceId: 'usb', label: 'USB Interface' }], { deadSinks: ['usb'] });
    const log: string[] = [];
    h.engine.onLog = (m) => log.push(m);
    await h.engine.start();
    const ctx = h.contexts[0]!;
    expect(ctx.sinkId).toBe('');
    expect(ctx.sinkCalls).toEqual(['usb']);
    expect(h.engine.status).toBe('lost');
    expect(masterOf(ctx).gain.value).toBe(0);
    expect(log.some((m) => /instead of "usb"/.test(m))).toBe(true);
    expect(log.some((m) => /muted/.test(m))).toBe(true);
    // The device starts working: the poll recovers it and unmutes.
    ctx.deadSinks.clear();
    await checkDevice(h.engine);
    expect(ctx.sinkId).toBe('usb');
    expect(h.engine.status).toBe('ok');
    expect(masterOf(ctx).gain.value).toBe(1);
    h.engine.dispose();
  });

  it('re-checks the device on a context error event and throttles resume (item 32)', async () => {
    const h = harness(settings, [{ deviceId: 'usb', label: 'USB Interface' }]);
    await h.engine.start();
    const ctx = h.contexts[0]!;
    expect(ctx.listeners.get('error')).toHaveLength(1);
    h.devs.list = [];
    ctx.emit('error');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status).toBe('lost');
    // A context that keeps reporting 'suspended' is resumed at most once a second.
    const before = ctx.resumes;
    for (let i = 0; i < 20; i++) {
      ctx.state = 'suspended';
      ctx.onstatechange?.();
    }
    expect(ctx.resumes - before).toBe(1);
    h.clock.now = 1500;
    ctx.state = 'suspended';
    ctx.onstatechange?.();
    expect(ctx.resumes - before).toBe(2);
    h.engine.dispose();
  });

  it('mutes while the house device is lost instead of playing on the default device (item 33)', async () => {
    const h = harness(settings, [{ deviceId: 'default', label: 'Default' }]);
    await h.engine.start();
    const ctx = h.contexts[0]!;
    expect(h.engine.status).toBe('lost');
    expect(masterOf(ctx).gain.value).toBe(0);
    // Master changes while lost do not unmute.
    h.engine.setMasterDb(-6);
    expect(masterOf(ctx).gain.value).toBe(0);
    h.devs.list = [
      { deviceId: 'default', label: 'Default' },
      { deviceId: 'usb', label: 'USB Interface' },
    ];
    await checkDevice(h.engine);
    expect(h.engine.status).toBe('ok');
    expect(masterOf(ctx).gain.value).toBeCloseTo(dbToGain(-6));
    // Unplugged mid-service: silent again, and back when it returns.
    h.devs.list = [{ deviceId: 'default', label: 'Default' }];
    await checkDevice(h.engine);
    expect(h.engine.status).toBe('lost');
    expect(masterOf(ctx).gain.value).toBe(0);
    h.devs.list = [
      { deviceId: 'default', label: 'Default' },
      { deviceId: 'usb', label: 'USB Interface' },
    ];
    await checkDevice(h.engine);
    expect(masterOf(ctx).gain.value).toBeCloseTo(dbToGain(-6));
    // No house device configured: never muted by status.
    const open = harness({ ...settings, houseDeviceId: undefined, houseDeviceLabel: undefined }, []);
    await open.engine.start();
    expect(open.engine.status).toBe('ok');
    expect(masterOf(open.contexts[0]!).gain.value).toBe(1);
    open.engine.dispose();
    h.engine.dispose();
  });

  it('reports peak meters per pair', async () => {
    const { engine, contexts } = harness(settings, [{ deviceId: 'usb', label: 'USB Interface' }]);
    await engine.start();
    const analysers = contexts[0]!.nodes.filter((n) => n.kind === 'analyser');
    // House and Lobby fit in 8 channels; Far (9/10) does not get a meter.
    expect(analysers).toHaveLength(4);
    analysers[1]!.fill = -0.5;
    expect(engine.meters()).toEqual([0.5, 0, 0]);
    engine.dispose();
  });

  it('falls back to the default device when the house device is missing, then recovers', async () => {
    const h = harness(settings, [{ deviceId: 'default', label: 'Default' }]);
    const statuses: string[] = [];
    h.engine.onStatus = (s) => statuses.push(s);
    await h.engine.start();
    const ctx = h.contexts[0]!;
    expect(ctx.sinkId).toBe('');
    expect(h.engine.status).toBe('lost');
    expect(h.engine.channels).toBe(2);
    const src = h.engine.attach({} as HTMLMediaElement, { pairId: 'lobby' });
    void src;
    // Device returns (same label, id differs for this origin).
    h.devs.list = [
      { deviceId: 'default', label: 'Default' },
      { deviceId: 'usb', label: 'USB Interface' },
    ];
    await (h.engine as unknown as { checkDevice: () => Promise<void> }).checkDevice();
    expect(ctx.sinkCalls.at(-1)).toBe('usb');
    expect(h.engine.status).toBe('ok');
    expect(h.engine.channels).toBe(8);
    const el = ctx.nodes.find((n) => n.kind === 'element')!;
    expect(mergerInputs(ctx, el)).toEqual([2, 3]);
    // Unplugged again.
    h.devs.list = [{ deviceId: 'default', label: 'Default' }];
    await (h.engine as unknown as { checkDevice: () => Promise<void> }).checkDevice();
    expect(h.engine.status).toBe('lost');
    expect(statuses).toEqual(['lost', 'ok', 'lost']);
    h.engine.dispose();
  });
});

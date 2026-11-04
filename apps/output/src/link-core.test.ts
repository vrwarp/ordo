import { HubConnection, OutputLink } from '@ordo/client';
import type { LiveState } from '@ordo/domain';
import type { FromAsset, ToAsset, ToRender } from '@ordo/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveState, slideLive } from '../../../packages/renderer/src/fixtures.test-util.ts';
import type { OutputConfigRes } from '@ordo/protocol';
import type { HostStatus, LinkToMain, SlotStatus } from './host-protocol.ts';
import { LinkCore } from './link-core.ts';
import { MemoryStreamStore } from './opfs.ts';

/** A minimal output config: this output is (or is not) the audio master. */
const config = (audioMaster: boolean, name = 'Audience 1'): OutputConfigRes =>
  ({
    output: { id: 'o1', name, kind: 'output', hostIndex: 1, lookId: 'look-main', enabled: true, audioMaster },
    looks: [],
    audio: {},
    general: {},
    fonts: [],
  }) as unknown as OutputConfigRes;

/** The video cue of the fixture playlist live and playing since `startedAt` (hub ms). */
function videoLive(startedAt: number, seq = 2): LiveState {
  const s = liveState();
  const i = s.cues.findIndex((c) => c.mediaId === 'vid');
  return {
    ...s,
    seq,
    live: i,
    layers: {
      ...s.layers,
      media: {
        content: {
          kind: 'media',
          cueIndex: i,
          mediaId: 'vid',
          mediaKind: 'video',
          loop: false,
          onEnd: 'advance',
          state: 'playing',
          startedAt,
          positionMs: 0,
        },
        at: startedAt,
        seq,
      },
    },
  };
}

const hostStatus = (slots: Partial<SlotStatus>[] = []): HostStatus => ({
  slots: slots.map((x, i) => ({ id: i, key: '', srcId: '0', dropped: 0, positionMs: 0, ...x })),
  longTasks: 0,
  workers: [],
  rafTicks: 1,
  visible: true,
  hold: false,
  log: [],
});

/** The link worker's core with a fake hub, in-memory stores and real MessageChannels to fake workers. */
function setup(deps: Partial<ConstructorParameters<typeof LinkCore>[0]> = {}) {
  const hub = new HubConnection({ role: 'output', appVersion: 't', url: 'ws://unused' });
  const sent: unknown[] = [];
  hub.start = () => undefined;
  hub.send = (m) => {
    sent.push(m);
    return true;
  };
  const link = new OutputLink({
    role: 'output',
    appVersion: 't',
    hub,
    fallback: null,
    outputId: 'o1',
    token: 't',
  });
  const posts: LinkToMain[] = [];
  const kv = new Map<string, unknown>();
  const core = new LinkCore({
    link,
    store: new MemoryStreamStore(),
    json: { get: async (k) => kv.get(k) as never, set: async (k, v) => void kv.set(k, v) },
    post: (m) => posts.push(m),
    width: 640,
    height: 360,
    testMode: true,
    fetchConfig: () => Promise.reject(new Error('offline')),
    fetchNetwork: () => Promise.reject(new Error('offline')),
    ...deps,
  });
  const render = new MessageChannel();
  const asset = new MessageChannel();
  const toRender: ToRender[] = [];
  const toAsset: ToAsset[] = [];
  render.port2.onmessage = (e) => toRender.push(e.data);
  asset.port2.onmessage = (e) => toAsset.push(e.data);
  core.onPorts(render.port1, asset.port1, { link: 0, render: 0, asset: 0 });
  const close = () => {
    render.port1.close();
    render.port2.close();
    asset.port1.close();
    asset.port2.close();
  };
  return { core, hub, link, sent, posts, toRender, toAsset, asset, close };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const stateMsg = (state: LiveState) => ({ t: 'live.state' as const, v: 1 as const, seq: state.seq, state });

describe('link worker core', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resyncs on an invariant violation and reloads when the resync still violates', async () => {
    const t = setup();
    await t.core.start();
    t.hub.connected = true;
    t.hub.emit('status', { connected: true });
    t.hub.emit('state', stateMsg(slideLive(0)));
    expect(t.posts.some((p) => p.t === 'reload')).toBe(false);
    const bad = { ...slideLive(0), seq: 5, live: 99 };
    t.hub.emit('state', stateMsg(bad));
    expect(t.sent).toContainEqual({ t: 'live.resync' });
    expect(t.posts.some((p) => p.t === 'reload')).toBe(false);
    t.hub.emit('state', stateMsg({ ...bad, seq: 6 }));
    expect(t.posts.find((p) => p.t === 'reload')).toMatchObject({
      reason: expect.stringMatching(/invariants/),
    });
    t.close();
  });

  it('a malformed delta keeps the state and asks for a full one', async () => {
    const t = setup();
    await t.core.start();
    t.hub.connected = true;
    t.hub.emit('status', { connected: true });
    t.hub.emit('state', stateMsg(slideLive(0)));
    const before = t.core.state();
    t.core.injectDelta({
      t: 'live.delta',
      v: 1,
      seq: before.seq + 1,
      fromSeq: before.seq,
      event: { k: 'go', cueIndex: 'x' },
    });
    t.core.injectDelta({ nonsense: true });
    expect(t.core.state()).toBe(before);
    expect(t.sent.filter((m) => (m as { t: string }).t === 'live.resync').length).toBeGreaterThanOrEqual(1);
    t.close();
  });

  it('quarantines a slide that keeps failing to rasterize and stops flipping to it', async () => {
    const t = setup();
    await t.core.start();
    t.hub.emit('state', stateMsg(slideLive(0)));
    await tick();
    const job = t.toAsset.find((m) => m.t === 'job' && m.job.kind === 'slide' && m.job.cueIndex === 0);
    expect(job).toBeDefined();
    const key = job!.t === 'job' ? job!.job.key : '';
    for (let i = 0; i < 3; i++)
      t.asset.port2.postMessage({ t: 'error', layer: 1, key, error: 'boom' } satisfies FromAsset);
    await tick(30);
    const st = t.core.introspect() as { quarantined: string[] };
    expect(st.quarantined).toEqual([key]);
    expect(t.core.buildHealth().quarantined).toEqual({ count: 1, items: [key] });
    t.toRender.length = 0;
    t.core.sync();
    // A new flip of the slide layer never names the quarantined key.
    expect(t.toRender.some((m) => m.t === 'flip' && m.key === key)).toBe(false);
    // End service lifts the quarantine.
    t.hub.emit('state', stateMsg({ ...liveState(), mode: 'idle', cues: [], resolved: undefined, seq: 9 }));
    expect((t.core.introspect() as { quarantined: string[] }).quarantined).toEqual([]);
    t.close();
  });

  it('measures main-thread stalls from the host ticks', async () => {
    const t = setup();
    t.core.onTick();
    await tick(120);
    t.core.onTick();
    expect(t.core.buildHealth().mainThreadStallMs).toBeGreaterThanOrEqual(100);
    t.close();
  });

  it('reports a clip that ended while no link worker was alive, from the host status (once)', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(true));
    t.hub.connected = true;
    t.hub.emit('status', { connected: true });
    t.hub.emit('state', stateMsg(videoLive(Date.now() - 61_000)));
    const key = (t.core.introspect() as { keys: { live: { media: string } } }).keys.live.media;
    expect(key).toMatch(/^md\|/);
    const ended = () =>
      t.sent.filter((m) => (m as { event?: { k: string } }).event?.k === 'media.ended') as {
        event: { cueIndex: number };
      }[];
    t.core.onHost(hostStatus([{}, {}, { key, ended: true, durationMs: 60_000 }]));
    expect(ended()).toHaveLength(1);
    expect(ended()[0]!.event.cueIndex).toBe(t.core.state().live);
    t.core.onHost(hostStatus([{}, {}, { key, ended: true, durationMs: 60_000 }]));
    expect(ended()).toHaveLength(1);
    t.close();
  });

  it('does not report an end from an element still ended from an earlier play, nor when not the master', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(true));
    t.hub.connected = true;
    t.hub.emit('status', { connected: true });
    // Restarted a second ago: the element's "ended" is from the previous play.
    t.hub.emit('state', stateMsg(videoLive(Date.now() - 1000)));
    const key = (t.core.introspect() as { keys: { live: { media: string } } }).keys.live.media;
    t.core.onHost(hostStatus([{}, {}, { key, ended: true, durationMs: 60_000 }]));
    const isEnded = (m: unknown) => (m as { event?: { k: string } }).event?.k === 'media.ended';
    expect(t.sent.some(isEnded)).toBe(false);
    const u = setup();
    await u.core.start();
    u.core.applyConfig(config(false));
    u.hub.connected = true;
    u.hub.emit('status', { connected: true });
    u.hub.emit('state', stateMsg(videoLive(Date.now() - 61_000)));
    u.core.onHost(hostStatus([{}, {}, { key, ended: true, durationMs: 60_000 }]));
    expect(u.sent.some(isEnded)).toBe(false);
    t.close();
    u.close();
  });

  it('acts on an ended event replayed by the host once the live state is known', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(true));
    t.hub.connected = true;
    t.hub.emit('status', { connected: true });
    const st = videoLive(Date.now() - 61_000);
    // Replayed before any state: kept, not lost.
    const probe = setup();
    await probe.core.start();
    probe.hub.emit('state', stateMsg(st));
    const key = (probe.core.introspect() as { keys: { live: { media: string } } }).keys.live.media;
    probe.close();
    t.core.onMediaEvent({ k: 'ended', slot: 2, key }, true);
    const isEnded = (m: unknown) => (m as { event?: { k: string } }).event?.k === 'media.ended';
    expect(t.sent.some(isEnded)).toBe(false);
    t.hub.emit('state', stateMsg(st));
    expect(t.sent.filter(isEnded)).toHaveLength(1);
    t.close();
  });

  it('backs off a key whose file is unavailable and never quarantines it; a quarantined required key is not armed', async () => {
    const t = setup();
    await t.core.start();
    t.hub.emit('state', stateMsg(slideLive(0)));
    await tick();
    const job = t.toAsset.find((m) => m.t === 'job' && m.job.kind === 'slide' && m.job.cueIndex === 0);
    expect(job).toBeDefined();
    const key = job!.t === 'job' ? job!.job.key : '';
    for (let i = 0; i < 6; i++) {
      t.asset.port2.postMessage({
        t: 'error',
        layer: 1,
        key,
        error: 'file unavailable (HTTP 503)',
        cause: 'unavailable',
      } satisfies FromAsset);
      await tick(5);
    }
    expect((t.core.introspect() as { quarantined: string[] }).quarantined).toEqual([]);
    // Backing off: a sync now does not send the job again.
    t.toAsset.length = 0;
    t.core.sync();
    expect(t.toAsset.some((m) => m.t === 'job' && m.job.key === key)).toBe(false);
    // The same key failing deterministically is quarantined, and then it is not "armed".
    for (let i = 0; i < 3; i++)
      t.asset.port2.postMessage({ t: 'error', layer: 1, key, error: 'decode failed' } satisfies FromAsset);
    await tick(30);
    expect((t.core.introspect() as { quarantined: string[] }).quarantined).toEqual([key]);
    const h = t.core.buildHealth();
    expect(h.quarantined?.items).toEqual([key]);
    expect(h.armedOk).toBe(false);
    t.close();
  });

  it('a GPU rebuild in progress is not a stuck renderer; a second stall reloads with a render-restart fallback', async () => {
    const t = setup();
    await t.core.start();
    t.hub.emit('state', stateMsg(slideLive(0)));
    const c = t.core as unknown as {
      renderStartedAt: number;
      presentedSeen: { at: number; rafAt: number; count: number };
      compositor: string;
      checkRenderer(): void;
      onRender(m: unknown): void;
      host?: HostStatus;
    };
    c.host = hostStatus();
    c.compositor = '2d';
    const stuck = () => {
      c.renderStartedAt = Date.now() - 20_000;
      c.presentedSeen.at = Date.now() - 5000;
      c.presentedSeen.rafAt = Date.now();
      c.presentedSeen.count = 0;
    };
    c.onRender({ t: 'lost', reason: 'test' });
    stuck();
    c.checkRenderer();
    expect(t.posts.some((p) => p.t === 'restartWorker' || p.t === 'reload')).toBe(false);
    c.onRender({ t: 'restored', compositor: '2d' });
    stuck();
    c.checkRenderer();
    expect(t.posts.filter((p) => p.t === 'restartWorker')).toHaveLength(1);
    stuck();
    c.checkRenderer();
    expect(t.posts.find((p) => p.t === 'reload')).toMatchObject({ fallback: 'render' });
    t.close();
  });

  it('refetches its config on every hub welcome and settings change; a stale answer never wins', async () => {
    const answers: ((c: OutputConfigRes) => void)[] = [];
    const t = setup({ fetchConfig: () => new Promise<OutputConfigRes>((r) => answers.push(r)) });
    await t.core.start();
    const n0 = answers.length;
    t.hub.emit('welcome', {} as never);
    t.link.emit('library', { changes: [{ kind: 'settings' }] } as never);
    expect(answers.length).toBe(n0 + 2);
    // The newer request answers first; the older (stale) one afterwards must not overwrite it.
    answers.at(-1)!(config(true, 'New name'));
    await tick();
    answers.at(-2)!(config(true, 'Old name'));
    await tick();
    expect(t.core.config?.output.name).toBe('New name');
    t.close();
  });

  it('a full disk backs off per file, gives up after a budget, and shows red; it never loops', async () => {
    const store = new MemoryStreamStore();
    store.putStream = async () => {
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    };
    let fetches = 0;
    const t = setup({
      store,
      fetchNetwork: async () => {
        fetches++;
        return new Blob([new Uint8Array(10)]);
      },
    });
    await t.core.start();
    const files = [{ hash: 'big', bytes: 10, mime: 'video/mp4' }];
    t.hub.emit('state', stateMsg(liveState({ seq: 3, resolved: { ...liveState().resolved!, files } })));
    const c = t.core as unknown as {
      manifestSig: string;
      ensureFiles(): void;
      fileFail: Map<string, { n: number; next: number; gaveUp: boolean }>;
    };
    await tick(30);
    expect(fetches).toBe(1);
    expect(t.core.buildHealth().error).toMatch(/storage full/);
    // A refill before the backoff is due fetches nothing.
    c.manifestSig = '';
    c.ensureFiles();
    await tick(30);
    expect(fetches).toBe(1);
    // Due each time: after FILE_ATTEMPTS fills the file is given up on.
    for (let i = 0; i < 6; i++) {
      for (const f of c.fileFail.values()) f.next = 0;
      c.manifestSig = '';
      c.ensureFiles();
      await tick(30);
    }
    expect(fetches).toBe(4);
    expect(c.fileFail.get('big')?.gaveUp).toBe(true);
    expect(t.core.buildHealth().error).toMatch(/storage full: 1 file\(s\) not cached \(gave up\)/);
    t.close();
  });
});

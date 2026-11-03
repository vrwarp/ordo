import { HubConnection, OutputLink } from '@ordo/client';
import type { LiveState } from '@ordo/domain';
import type { FromAsset, ToAsset, ToRender } from '@ordo/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveState, slideLive } from '../../../packages/renderer/src/fixtures.test-util.ts';
import type { LinkToMain } from './host-protocol.ts';
import { LinkCore } from './link-core.ts';
import { MemoryStreamStore } from './opfs.ts';

/** The link worker's core with a fake hub, in-memory stores and real MessageChannels to fake workers. */
function setup() {
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
  return { core, hub, sent, posts, toRender, toAsset, asset, close };
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
});

import { MemoryStore } from '@ordo/cache';
import { Emitter, HubClock, type HubConnection, OutputLink } from '@ordo/client';
import {
  type LiveEvent,
  type LiveState,
  parseLyrics,
  type ResolvedPlaylist,
  songFromParsed,
} from '@ordo/domain';
import { initialState, reduce } from '@ordo/live-state';
import type { OutputConfigRes } from '@ordo/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type KV, StageLinkCore } from './link-core.ts';
import type { LinkToMain, StageView } from './protocol.ts';

class FakeHub extends Emitter<Record<string, unknown>> {
  sent: { t: string; [k: string]: unknown }[] = [];
  connected = false;
  start() {}
  stop() {}
  send(m: { t: string }) {
    this.sent.push(m);
    return true;
  }
  connect() {
    this.connected = true;
    this.emit('status', { connected: true });
  }
}

class MemKV implements KV {
  map = new Map<string, unknown>();
  async get<T>(k: string) {
    return structuredClone(this.map.get(k)) as T | undefined;
  }
  async set(k: string, v: unknown) {
    this.map.set(k, structuredClone(v));
  }
}

const song = songFromParsed(
  parseLyrics('Verse 1\nFirst line\nSecond line\n\nChorus\nChorus alpha\nChorus beta'),
  {
    linesPerSlide: 2,
  },
);
const resolved: ResolvedPlaylist = {
  playlist: {
    id: 'pl',
    rev: 1,
    name: 'x',
    items: [{ id: 'i0', kind: 'presentation', presentationId: song.id }],
  },
  presentations: { [song.id]: song },
  media: {},
  fonts: [],
  looks: [],
  files: [],
  manifestId: 'm',
};

function liveAt(cue: number): LiveState {
  let s = reduce(initialState(), { k: 'goLive', resolved } as LiveEvent);
  for (let i = 0; i <= cue; i++) s = reduce(s, { k: 'go', cueIndex: i, at: 0 } as LiveEvent);
  return s;
}

const config = {
  output: { id: 'stage', name: 'Stage', kind: 'stage', hostIndex: 0, lookId: 'look-stage', enabled: true },
  looks: [],
  audio: {},
  general: { timeZone: 'UTC', clock24h: true, venueName: 'x' },
  fonts: [],
} as unknown as OutputConfigRes;

function setup(kv = new MemKV()) {
  const hub = new FakeHub();
  const link = new OutputLink({
    role: 'stage',
    appVersion: '0',
    hub: hub as unknown as HubConnection,
    fallback: null,
    outputId: 'stage',
    token: 't',
  });
  const posted: LinkToMain[] = [];
  let now = 1_000_000;
  const core = new StageLinkCore({
    link,
    json: kv,
    store: new MemoryStore(),
    post: (m) => posted.push(m),
    loadConfig: async () => config,
    fetchHub: async (h) => new Blob([h]),
    clock: new HubClock(),
    now: () => now,
  });
  const views = () =>
    posted.filter((m): m is Extract<LinkToMain, { t: 'view' }> => m.t === 'view').map((m) => m.view);
  const last = (): StageView => views().at(-1)!;
  return { hub, link, core, posted, views, last, kv, advance: (ms: number) => (now += ms) };
}

describe('StageLinkCore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('paints the cached config and state from IndexedDB before any connection', async () => {
    const kv = new MemKV();
    await kv.set('config:stage', config);
    await kv.set('state:stage', { state: liveAt(1) });
    const { core, last, hub } = setup(kv);
    await core.start();
    expect(hub.connected).toBe(false);
    expect(last().ready).toBe(true);
    expect(last().current?.text).toBe('Chorus alpha\nChorus beta');
    expect(last().current?.label).toBe('Chorus');
    expect(core.diag().offlineStart).toBe(true);
    core.stop();
  });

  it('does not paint a cached state that violates the invariants', async () => {
    const kv = new MemKV();
    const bad = { ...liveAt(1), live: 99 };
    await kv.set('state:stage', { state: bad });
    const { core, last } = setup(kv);
    await core.start();
    expect(last().ready).toBe(false);
    core.stop();
  });

  it('shows the hub state, persists it and schedules the flip at `at`', async () => {
    const { core, hub, last, kv } = setup();
    await core.start();
    hub.connect();
    hub.emit('state', { t: 'live.state', v: 1, seq: liveAt(0).seq, state: liveAt(0) });
    expect(last().current?.text).toBe('First line\nSecond line');
    await vi.advanceTimersByTimeAsync(600);
    expect(((await kv.get<{ state: LiveState }>('state:stage'))!.state as LiveState).seq).toBe(liveAt(0).seq);
    // A GO scheduled 400 ms ahead flips when due, not before.
    const s0 = liveAt(0);
    const at = Date.now() + 400;
    hub.emit('delta', {
      t: 'live.delta',
      v: 1,
      seq: s0.seq + 1,
      fromSeq: s0.seq,
      event: { k: 'go', cueIndex: 1, at },
    });
    expect(last().current?.text).toBe('First line\nSecond line');
    await vi.advanceTimersByTimeAsync(450);
    expect(last().current?.text).toBe('Chorus alpha\nChorus beta');
    core.stop();
  });

  it('a malformed delta keeps the last good view and asks the hub for a full state', async () => {
    const { core, hub, last } = setup();
    await core.start();
    hub.connect();
    const s0 = liveAt(0);
    hub.emit('state', { t: 'live.state', v: 1, seq: s0.seq, state: s0 });
    hub.sent = [];
    core.injectFromHub('delta', {
      t: 'live.delta',
      v: 1,
      seq: s0.seq + 1,
      fromSeq: s0.seq,
      event: { k: 'go', cueIndex: 'x' },
    });
    core.injectFromHub('delta', { t: 'live.delta', v: 1, seq: s0.seq + 1, fromSeq: s0.seq, event: null });
    core.injectFromHub('delta', null);
    expect(hub.sent.some((m) => m.t === 'live.resync')).toBe(true);
    expect(last().current?.text).toBe('First line\nSecond line');
    expect(core.diag().resyncs).toBeGreaterThan(0);
    core.stop();
  });

  it('an invariant violation resyncs; a second one after the full state reloads the window', async () => {
    const { core, hub, last, posted } = setup();
    await core.start();
    hub.connect();
    const good = liveAt(0);
    hub.emit('state', { t: 'live.state', v: 1, seq: good.seq, state: good });
    hub.sent = [];
    const bad = { ...liveAt(1), live: 42 };
    hub.emit('state', { t: 'live.state', v: 1, seq: bad.seq, state: bad });
    expect(hub.sent.filter((m) => m.t === 'live.resync')).toHaveLength(1);
    expect(last().current?.text).toBe('First line\nSecond line');
    expect(posted.some((m) => m.t === 'reload')).toBe(false);
    hub.emit('state', { t: 'live.state', v: 1, seq: bad.seq, state: bad });
    expect(posted.find((m) => m.t === 'reload')).toMatchObject({
      reason: expect.stringMatching(/invariants/),
    });
    core.stop();
  });

  it('a sound full state after a violation clears it without a reload', async () => {
    const { core, hub, posted, last } = setup();
    await core.start();
    hub.connect();
    hub.emit('state', { t: 'live.state', v: 1, seq: 5, state: { ...liveAt(1), live: 42 } });
    hub.emit('state', { t: 'live.state', v: 1, seq: liveAt(1).seq, state: liveAt(1) });
    expect(posted.some((m) => m.t === 'reload')).toBe(false);
    expect(last().current?.text).toBe('Chorus alpha\nChorus beta');
    core.stop();
  });

  it('sends the stage fonts to the host as transferable bytes', async () => {
    const font = {
      id: 'f',
      family: 'Inter',
      weight: 700,
      style: 'normal',
      file: { hash: 'abc', bytes: 3, mime: 'font/woff2' },
    };
    const { core, posted } = setup();
    const withFont = { ...config, fonts: [font] } as unknown as OutputConfigRes;
    (core as unknown as { deps: { loadConfig: () => Promise<OutputConfigRes> } }).deps.loadConfig =
      async () => withFont;
    await core.start();
    await vi.advanceTimersByTimeAsync(10);
    const f = posted.find((m) => m.t === 'font');
    expect(f).toMatchObject({ t: 'font', font: { hash: 'abc', family: 'Inter', weight: 700 } });
    core.onFontAck('abc', true);
    expect(core.diag().fonts).toEqual(['abc']);
    core.stop();
  });

  it('health carries the host frame stats, the worker table and the main-thread stall', async () => {
    const { core, hub, advance } = setup();
    await core.start();
    hub.connect();
    core.onHost({
      presented: 60,
      missed: 1,
      fps: 60,
      longTasks: 0,
      workers: [{ name: 'link', generation: 1, restarts: 1, gaveUp: false }],
      fontErrors: [],
    });
    advance(2500);
    await vi.advanceTimersByTimeAsync(1000);
    const health = hub.sent.filter((m) => m.t === 'health').at(-1) as unknown as {
      health: Record<string, unknown>;
    };
    expect(health.health).toMatchObject({ presented: 60, fps: 60, workers: [{ name: 'link', restarts: 1 }] });
    expect(health.health.mainThreadStallMs).toBeGreaterThanOrEqual(2500);
    core.stop();
  });

  it('a superseded window stops and asks the host to close', async () => {
    const { core, hub, posted } = setup();
    await core.start();
    hub.emit('bye', { t: 'bye', v: 1, reason: 'superseded' });
    expect(posted.at(-1)).toEqual({ t: 'close', reason: 'superseded' });
  });
});

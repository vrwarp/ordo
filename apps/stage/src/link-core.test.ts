import { MemoryStore } from '@ordo/cache';
import { Emitter, HeldCopy, HubClock, type HubConnection, joinState, OutputLink } from '@ordo/client';
import {
  type LiveEvent,
  type LiveState,
  parseLyrics,
  type Presentation,
  type ResolvedPlaylist,
  songFromParsed,
} from '@ordo/domain';
import { initialState, reduce } from '@ordo/live-state';
import type { OutputConfigRes } from '@ordo/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type KV, StageLinkCore } from './link-core.ts';
import type { LinkToMain, StageView } from './protocol.ts';

class FakeHub extends Emitter<Record<string, unknown>> {
  /** What a real connection holds of the running service (live-by-ref). */
  copies = new HeldCopy();
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

  it('a persistently malformed full state stops resyncing past the budget, keeps the view, reports it', async () => {
    const { core, hub, last, advance } = setup();
    await core.start();
    hub.connect();
    const s0 = liveAt(0);
    hub.emit('state', { t: 'live.state', v: 1, seq: s0.seq, state: s0 });
    hub.sent = [];
    // Two minutes of a hub that answers every resync with the same malformed state, every 300 ms.
    for (let i = 0; i < 400; i++) {
      advance(300);
      await vi.advanceTimersByTimeAsync(300);
      core.injectFromHub('state', { t: 'live.state', v: 1, seq: 99, state: { seq: 99 } });
      expect(last().current?.text).toBe('First line\nSecond line');
    }
    const resyncs = hub.sent.filter((m) => m.t === 'live.resync').length;
    // The budget (10) plus one slow retry a minute; it used to be one every 500 ms (240 here).
    expect(resyncs).toBeGreaterThanOrEqual(10);
    expect(resyncs).toBeLessThanOrEqual(12);
    const health = hub.sent.filter((m) => m.t === 'health').at(-1) as unknown as {
      health: { error?: string };
    };
    expect(health.health.error).toMatch(/no valid state after 10 resyncs/);
    expect(core.diag().resyncError).toMatch(/showing the last good state/);
    // A sound state ends it.
    const s1 = liveAt(1);
    hub.emit('state', { t: 'live.state', v: 1, seq: s1.seq, state: s1 });
    expect(last().current?.text).toBe('Chorus alpha\nChorus beta');
    expect(core.diag().resyncError).toBeUndefined();
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

  it('a Go live during a service (design/29 M8): the notes and the Pulpit Lectern follow the new service', async () => {
    // The hub prepares the new service beside the running one and then applies its goLive as one delta: the
    // stage drops the old service's slide, notes and lectern slides at once, and shows the new one's from its GO.
    const deck = (id: string, words: string[]): Presentation => ({
      id,
      rev: 1,
      title: id,
      kind: 'slides',
      meta: { tags: [] },
      sections: [
        {
          id: `${id}-s`,
          label: 'Slides',
          short: 'S',
          slides: words.map((w, i) => ({
            id: `${id}-${i}`,
            objects: [
              {
                id: `${id}-t${i}`,
                type: 'text' as const,
                text: w,
                box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
                style: {} as never,
                opacity: 1,
              },
            ],
            notes: `${w}: notes`,
          })),
        },
      ],
      arrangements: [],
      archived: false,
    });
    const service = (id: string, p: Presentation): ResolvedPlaylist => ({
      ...resolved,
      playlist: {
        id,
        rev: 1,
        name: id,
        items: [{ id: `${id}-i`, kind: 'presentation', presentationId: p.id }],
      },
      presentations: { [p.id]: p },
    });
    const { core, hub, last } = setup();
    await core.start();
    hub.connect();
    let s = reduce(initialState(), {
      k: 'goLive',
      resolved: service('A', deck('a', ['Welcome', 'Offering'])),
    });
    s = reduce(s, { k: 'go', cueIndex: 1, at: 0 } as LiveEvent);
    hub.emit('state', { t: 'live.state', v: 1, seq: s.seq, state: s });
    expect(last().notes).toBe('Offering: notes');
    expect(last().lecternSlides?.map((x) => x.notes)).toEqual(['Welcome: notes', 'Offering: notes']);
    expect(last().activeSlideId).toBe('a-1');

    const landed = { k: 'goLive', resolved: service('B', deck('b', ['Sermon', 'Prayer'])) } as LiveEvent;
    hub.emit('delta', { t: 'live.delta', v: 1, seq: s.seq + 1, fromSeq: s.seq, event: landed });
    s = reduce(s, landed);
    expect(last().current).toBeNull();
    expect(last().notes).toBeNull();
    expect(last().lecternSlides).toEqual([]);
    expect(last().activeSlideId).toBeUndefined();

    const go = { k: 'go', cueIndex: 0, at: Date.now() } as LiveEvent;
    hub.emit('delta', { t: 'live.delta', v: 1, seq: s.seq + 1, fromSeq: s.seq, event: go });
    await vi.advanceTimersByTimeAsync(50);
    expect(last().notes).toBe('Sermon: notes');
    expect(last().lecternSlides?.map((x) => x.slideId)).toEqual(['b-0', 'b-1']);
    expect(last().activeSlideId).toBe('b-0');
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

  it('main-thread stall is the longest gap between 250 ms ticks since the last health, then resets', async () => {
    const { core, hub, advance } = setup();
    await core.start();
    hub.connect();
    const stalls = () =>
      hub.sent
        .filter((m) => m.t === 'health')
        .map((m) => (m as unknown as { health: { mainThreadStallMs: number } }).health.mainThreadStallMs);
    /** `ms` of wall time with the host ticking every 250 ms (the worker's timers advance alongside). */
    const ticking = async (ms: number) => {
      for (let t = 0; t < ms; t += 250) {
        advance(250);
        core.onTick();
        await vi.advanceTimersByTimeAsync(250);
      }
    };
    await ticking(3000);
    // A healthy host: the gap is the tick period, not the phase difference of two 1 s timers.
    expect(stalls().length).toBeGreaterThanOrEqual(2);
    for (const v of stalls()) expect(v).toBeLessThanOrEqual(250);
    // The main thread blocks for 900 ms between two ticks.
    advance(900);
    core.onTick();
    await ticking(2000);
    const after = stalls();
    expect(Math.max(...after)).toBe(900);
    // Reported once, then back to the tick period.
    expect(after.at(-1)).toBeLessThanOrEqual(250);
    expect(core.diag().mainThreadStallMs).toBeLessThanOrEqual(250);
    // A main thread stalled right now has sent nothing: the open gap counts.
    advance(1600);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stalls().at(-1)).toBeGreaterThanOrEqual(1600);
    core.stop();
  });

  it('a superseded window stops and asks the host to close', async () => {
    const { core, hub, posted } = setup();
    await core.start();
    hub.emit('bye', { t: 'bye', v: 1, reason: 'superseded' });
    expect(posted.at(-1)).toEqual({ t: 'close', reason: 'superseded' });
  });
});

// ---- the service by reference: a small record per GO, the copy once in pieces (live-by-ref) ----

const COPY_ID = 'c'.repeat(64);

/** The fixture service padded with unreferenced presentations of `kb` KB each, to about `mib` MiB. */
function bigLive(mib: number, kb = 100, huge = 0): LiveState {
  const base = liveAt(0);
  const presentations: Record<string, Presentation> = { ...resolved.presentations };
  const add = (id: string, bytes: number) => {
    presentations[id] = { ...song, id, title: id, pad: 'x'.repeat(bytes) } as unknown as Presentation;
  };
  for (let i = 0; i < Math.ceil((mib * 1024) / kb); i++) add(`pad${i}`, kb * 1024);
  if (huge) add('huge', huge);
  return { ...base, resolved: { ...resolved, presentations } };
}

class RecKV extends MemKV {
  sets: { key: string; bytes: number }[] = [];
  override async set(k: string, v: unknown) {
    this.sets.push({ key: k, bytes: JSON.stringify(v ?? null).length });
    await super.set(k, v);
  }
  records() {
    return this.sets.filter((x) => x.key === 'state:stage');
  }
  pieces() {
    return this.sets.filter((x) => x.key.startsWith('copy:'));
  }
}

async function runGos(core: StageLinkCore, hub: FakeHub, s: LiveState, n: number) {
  hub.connect();
  hub.copies.hold(COPY_ID, s.resolved!);
  for (let i = 0; i < n; i++) {
    hub.emit('state', { t: 'live.state', v: 1, seq: s.seq + i, state: { ...s, seq: s.seq + i } });
    await vi.advanceTimersByTimeAsync(600);
  }
  await vi.advanceTimersByTimeAsync(6000);
  void core;
}

describe('StageLinkCore saves by reference (live-by-ref)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the per-GO record is small and the same at 1.5 and 13 MiB; the copy is written once', async () => {
    const sizes: number[] = [];
    for (const mib of [1.5, 13]) {
      const kv = new RecKV();
      const { core, hub } = setup(kv);
      await core.start();
      const s = bigLive(mib);
      await runGos(core, hub, s, 5);
      const rec = kv.records().at(-1)!;
      sizes.push(rec.bytes);
      expect(rec.bytes).toBeLessThan(30_000);
      expect(kv.records().length).toBeGreaterThanOrEqual(5);
      const n = Object.keys(s.resolved!.presentations).length;
      expect(kv.pieces().length).toBe(n + 3);
      expect(kv.pieces().at(-1)!.key).toBe('copy:stage');
      core.stop();
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1.1 * Math.min(...sizes));
  });

  it('a restart paints the joined state and seeds the copy; a by-name state keeps the object', async () => {
    const kv = new RecKV();
    const first = setup(kv);
    await first.core.start();
    const s = bigLive(1);
    await runGos(first.core, first.hub, s, 3);
    first.core.stop();
    const second = setup(kv);
    await second.core.start();
    expect(second.hub.copies.id).toBe(COPY_ID);
    expect(second.hub.copies.value).toEqual(s.resolved);
    expect(second.last().ready).toBe(true);
    expect(second.last().current?.text).toBe('First line\nSecond line');
    const byName = {
      t: 'live.state' as const,
      v: 1 as const,
      seq: 99,
      resolvedId: COPY_ID,
      state: { ...s, seq: 99, resolved: undefined },
    };
    const joined = joinState(byName as never, second.hub.copies) as { state: LiveState };
    expect(joined.state.resolved).toBe(second.hub.copies.value);
    second.core.stop();
  });

  it('a missing part paints nothing; a record in the older whole form is still read', async () => {
    const kv = new RecKV();
    const first = setup(kv);
    await first.core.start();
    await runGos(first.core, first.hub, bigLive(1), 2);
    first.core.stop();
    const part = [...kv.map.keys()].find((k) => k.includes(':p:'))!;
    kv.map.delete(part);
    const second = setup(kv);
    await second.core.start();
    expect(second.last().ready).toBe(false);
    expect(second.hub.copies.id).toBeUndefined();
    second.core.stop();
    const old = new MemKV();
    await old.set('state:stage', { state: liveAt(1) });
    const third = setup(old);
    await third.core.start();
    expect(third.last().ready).toBe(true);
    third.core.stop();
  });

  it('a lectern and a display sharing one store do not corrupt each other', async () => {
    const kv = new RecKV();
    const display = setup(kv);
    const lectern = setup(kv);
    await display.core.start();
    await lectern.core.start();
    const s = bigLive(1);
    display.hub.connect();
    lectern.hub.connect();
    display.hub.copies.hold(COPY_ID, s.resolved!);
    lectern.hub.copies.hold(COPY_ID, s.resolved!);
    // interleave their GOs and their copy saves for one id
    for (let i = 0; i < 4; i++) {
      for (const w of [display, lectern]) {
        w.hub.emit('state', { t: 'live.state', v: 1, seq: s.seq + i, state: { ...s, seq: s.seq + i } });
        await vi.advanceTimersByTimeAsync(300);
      }
    }
    await vi.advanceTimersByTimeAsync(7000);
    display.core.stop();
    lectern.core.stop();
    const again = setup(kv);
    await again.core.start();
    expect(again.hub.copies.id).toBe(COPY_ID);
    expect(again.hub.copies.value).toEqual(s.resolved);
    again.core.stop();
  });
});

import { type FileStore, type JsonStore, MemoryStore } from '@ordo/cache';
import { type LiveState, parseLyrics, type ResolvedPlaylist, songFromParsed } from '@ordo/domain';
import { initialState, reduce } from '@ordo/live-state';
import { checkInvariants } from '@ordo/live-state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_KEY, CoreEngine, type CoreSnapshot } from '../src/core/engine.ts';
import type { CoreToMain, LibOp, ViewModelMsg } from '../src/core/protocol.ts';
import { emptyLibrary } from '../src/core/libraryStore.ts';
import { LiveCore } from '../src/lib/liveCore.ts';

function resolved(): ResolvedPlaylist {
  const a = songFromParsed(parseLyrics('Verse 1\na\nb\n\nChorus\nc\nd'), { linesPerSlide: 1 });
  return {
    playlist: {
      id: 'pl',
      rev: 1,
      name: 'Sunday',
      items: [{ id: 'i0', kind: 'presentation', presentationId: a.id }],
    },
    presentations: { [a.id]: a },
    media: {},
    fonts: [],
    looks: [],
    files: [],
    manifestId: 'm',
  };
}

function live(): LiveState {
  return reduce(initialState(), { k: 'goLive', resolved: resolved() });
}

function memStore(init: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(init));
  const store = {
    get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined,
    set: async (k: string, v: unknown) => {
      m.set(k, structuredClone(v));
    },
  };
  return { store: store as unknown as JsonStore, map: m };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('CoreEngine (operator core worker)', () => {
  let engine: CoreEngine | undefined;
  afterEach(() => engine?.dispose());

  async function start(snap?: CoreSnapshot) {
    const posts: CoreToMain[] = [];
    const { store, map } = memStore(snap ? { [CORE_KEY]: snap } : {});
    engine = new CoreEngine((m) => posts.push(m), store);
    await engine.init({ t: 'init', role: 'operate', appVersion: 't', generation: 1, test: true });
    await flush();
    return { posts, map, e: engine };
  }

  it('restores state, unconfirmed commands and processed ids; acknowledges a re-sent action without applying it', async () => {
    const st = live();
    const { posts, map, e } = await start({
      state: st,
      authority: 'hub',
      pending: [{ id: 'p1', event: { k: 'next', at: 1 }, at: Date.now() }],
      aids: ['done-1'],
      at: Date.now(),
    });
    expect(posts.find((p) => p.t === 'ready')).toEqual({ t: 'ready', generation: 1 });
    const vms = posts.filter((p): p is ViewModelMsg => p.t === 'vm');
    // The big immutable parts are posted once, apart from the live slice.
    expect(vms.some((v) => v.resolved?.value?.playlist.id === 'pl')).toBe(true);
    expect(vms.some((v) => (v.cues?.value.length ?? 0) > 0)).toBe(true);
    const lastLive = vms.filter((v) => v.live).at(-1)!.live!;
    expect(lastLive.state.resolved).toBeUndefined();
    expect(lastLive.state.cues).toEqual([]);
    expect(lastLive.state.live).toBe(0); // the restored command is proposed
    expect(lastLive.pending).toBe(1);

    posts.length = 0;
    e.handle({ t: 'action', aid: 'done-1', action: { id: 'next' }, source: 'keyboard' });
    expect(posts).toContainEqual({ t: 'ack', aid: 'done-1' });

    posts.length = 0;
    e.handle({ t: 'action', aid: 'a2', action: { id: 'next' }, source: 'keyboard' });
    await flush();
    await flush();
    expect(posts).toContainEqual({ t: 'ack', aid: 'a2' });
    const vm = posts.find((p): p is ViewModelMsg => p.t === 'vm' && !!p.live)!;
    expect(vm.live!.state.live).toBe(1);
    expect(vm.resolved).toBeUndefined(); // a GO costs only the small slice
    expect(vm.cues).toBeUndefined();
    const saved = map.get(CORE_KEY) as CoreSnapshot;
    expect(saved.aids).toContain('a2');
    expect(saved.pending.map((p) => p.id)).toEqual(['p1', 'a2']);
    expect(saved.state.live).toBeUndefined(); // the confirmed hub state, not the optimistic view
  });

  it('ignores a stored snapshot that fails validation', async () => {
    const bad = { ...live(), live: 99 } as LiveState; // out of range: violates the invariants
    const { posts } = await start({
      state: bad,
      authority: 'fallback',
      pending: [],
      aids: [],
      at: Date.now(),
    });
    const lastLive = posts.filter((p): p is ViewModelMsg => p.t === 'vm' && !!p.live).at(-1)!.live!;
    expect(lastLive.state.mode).toBe('idle');
    expect(lastLive.authority).toBe('hub');
    expect(posts.some((p) => p.t === 'log' && /failed validation/.test(p.text))).toBe(true);
  });

  it('resumes the fallback authority at once when it held it moments before the restart', async () => {
    const { posts } = await start({
      state: live(),
      authority: 'fallback',
      pending: [],
      aids: [],
      at: Date.now(),
    });
    const lastLive = posts.filter((p): p is ViewModelMsg => p.t === 'vm' && !!p.live).at(-1)!.live!;
    expect(lastLive.authority).toBe('fallback');
  });

  it('resumes a held service after a restart only within a service day', async () => {
    const snap = { state: live(), authority: 'fallback' as const, pending: [], aids: [], held: true };
    const fresh = await start({ ...snap, at: Date.now() - 3 * 60 * 60 * 1000 });
    const freshLive = fresh.posts.filter((p): p is ViewModelMsg => p.t === 'vm' && !!p.live).at(-1)!.live!;
    expect(freshLive.authority).toBe('fallback');
    expect(freshLive.held).toBe(true);
    fresh.e.dispose();
    // Left running a week ago: the hub is followed and nothing starts unasked.
    const stale = await start({ ...snap, at: Date.now() - 7 * 24 * 60 * 60 * 1000 });
    const staleLive = stale.posts.filter((p): p is ViewModelMsg => p.t === 'vm' && !!p.live).at(-1)!.live!;
    expect(staleLive.authority).toBe('hub');
    expect(staleLive.held).toBeFalsy();
    expect(stale.posts.some((p) => p.t === 'log' && /too long ago/.test(p.text))).toBe(true);
  });

  it('reports the main-thread stall it sees from the 250 ms ticks', async () => {
    let now = 1_000_000;
    const posts: CoreToMain[] = [];
    engine = new CoreEngine(
      (m) => posts.push(m),
      memStore().store,
      () => now,
    );
    await engine.init({ t: 'init', role: 'operate', appVersion: 't', generation: 0, test: true });
    engine.handle({ t: 'tick', at: now });
    now += 1800;
    expect(engine.stats().mainThreadStallMs).toBe(1800);
    engine.handle({ t: 'tick', at: now, hidden: true });
    now += 5000;
    // A hidden page's timers are throttled: not a stall (the watchdog refreshes the tick while hidden).
    (engine as unknown as { watch(): void }).watch();
    expect(engine.stats().mainThreadStallMs).toBe(0);
  });

  const lastLiveOf = (posts: CoreToMain[]) =>
    posts.filter((p): p is ViewModelMsg => p.t === 'vm' && !!p.live).at(-1)!.live!;
  /** Feed a raw server message to the engine's hub connection, as the socket would. */
  const fromHub = (e: CoreEngine, m: unknown) =>
    (e.hub as unknown as { onMessage(raw: string): void }).onMessage(JSON.stringify(m));

  it('a refused session is not a hub loss: no fallback, one auth event, no toast per attempt; sign-in resumes (item 5)', async () => {
    vi.useFakeTimers();
    try {
      const posts: CoreToMain[] = [];
      const { store } = memStore({
        [CORE_KEY]: { state: live(), authority: 'hub', pending: [], aids: [], at: Date.now() },
      });
      engine = new CoreEngine((m) => posts.push(m), store);
      const e = engine;
      await e.init({ t: 'init', role: 'operate', appVersion: 't', generation: 1, test: true });
      e.hub.emit('status', { connected: true });
      e.core.onStatus(true);
      // The session expired while connected: bye, then the close.
      fromHub(e, { t: 'bye', v: 1, reason: 'unauthorized' });
      e.hub.emit('status', { connected: false });
      // Each retry is refused again: still one auth event and no toast.
      fromHub(e, { t: 'bye', v: 1, reason: 'unauthorized' });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(e.core.authority).toBe('hub');
      expect(posts.filter((p) => p.t === 'hub' && p.e === 'auth')).toHaveLength(1);
      expect(posts.filter((p) => p.t === 'toast')).toHaveLength(0);
      expect(lastLiveOf(posts).hubRefused).toBe('unauthorized');
      // Signed in again: the core reconnects; if the hub is really gone now, the normal grace applies.
      e.handle({ t: 'hub.resume' });
      await vi.advanceTimersByTimeAsync(1);
      expect(lastLiveOf(posts).hubRefused).toBeUndefined();
      await vi.advanceTimersByTimeAsync(6000);
      expect(e.core.authority).toBe('fallback');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never persists a state that fails the invariants; the restarted core resumes the last good one (item 17)', async () => {
    const good = live();
    const { map, e } = await start({
      state: good,
      authority: 'fallback',
      pending: [],
      aids: [],
      at: Date.now(),
    });
    const fatal: string[] = [];
    e.onFatal = (r) => fatal.push(r);
    expect(e.core.authority).toBe('fallback');
    // A good change is persisted.
    e.handle({ t: 'action', aid: 'g1', action: { id: 'next' }, source: 'keyboard' });
    await flush();
    await flush();
    const afterGood = map.get(CORE_KEY) as CoreSnapshot;
    expect(afterGood.state.live).toBe(0);
    // Then the authoritative state breaks (a reducer bug): the core asks for a restart...
    const core = e.core as unknown as { local: LiveState; deps: { onChange(): void } };
    core.local = { ...core.local, seq: core.local.seq + 1, live: 99 } as LiveState;
    core.deps.onChange();
    await flush();
    await flush();
    expect(fatal).toHaveLength(1);
    // ...and the snapshot on disk is still the good one, with a fresh time so the authority resumes.
    const saved = map.get(CORE_KEY) as CoreSnapshot;
    expect(checkInvariants(saved.state)).toEqual([]);
    expect(saved.state.live).toBe(0);
    expect(saved.authority).toBe('fallback');
    expect(saved.at).toBeGreaterThanOrEqual(afterGood.at);
    e.dispose();

    // The restarted core resumes as the authority from it (GO keeps working without the hub).
    const posts2: CoreToMain[] = [];
    engine = new CoreEngine((m) => posts2.push(m), memStore({ [CORE_KEY]: saved }).store);
    await engine.init({ t: 'init', role: 'operate', appVersion: 't', generation: 2, test: true });
    await flush();
    const l = lastLiveOf(posts2);
    expect(l.authority).toBe('fallback');
    expect(l.state.mode).toBe('live');
    expect(l.state.live).toBe(0);
  });

  it('a library write before the cached copy loaded survives it and the first post is a full one (item 26)', async () => {
    const posts: CoreToMain[] = [];
    const cached = {
      ...emptyLibrary(),
      playlists: [{ id: 'old', rev: 1, name: 'Cached', items: [] }],
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const store = {
      get: async <T>(k: string) => {
        if (k === 'library') {
          await gate;
          return structuredClone(cached) as T;
        }
        return undefined;
      },
      set: async () => undefined,
    } as unknown as JsonStore;
    engine = new CoreEngine((m) => posts.push(m), store);
    const e = engine;
    await e.init({ t: 'init', role: 'operate', appVersion: 't', generation: 1, test: true });
    const op: LibOp = {
      k: 'upsert',
      key: 'playlists',
      entity: { id: 'new', rev: 1, name: 'Written', items: [] } as never,
    };
    e.handle({ t: 'lib.op', op });
    release();
    for (let i = 0; i < 5; i++) await flush();
    const libs = posts.filter((p): p is Extract<CoreToMain, { t: 'lib' }> => p.t === 'lib');
    expect(libs.length).toBeGreaterThan(0);
    // Never a patch that removes the written entity.
    for (const m of libs) expect(m.patch?.remove?.playlists ?? []).not.toContain('new');
    const first = libs[0]!;
    expect(first.full).toBeDefined();
    const ids = first.full!.data.playlists.map((p) => p.id).sort();
    expect(ids).toEqual(['new', 'old']);
    expect(e.lib.data.playlists.map((p) => p.id).sort()).toEqual(['new', 'old']);
  });

  it('an exceeded cache-fill budget resets the own-cache numbers to the new manifest (item 27)', async () => {
    const { posts, e } = await start();
    const eng = e as unknown as {
      ownCache: { ready: number; total: number; failed: number; manifestId?: string };
      fillOwnCache(files: { hash: string; bytes: number; mime: string }[], id: string): Promise<void>;
    };
    eng.ownCache = { ready: 4, total: 4, failed: 0, manifestId: 'previous' };
    for (let i = 0; i < 3; i++) e.budgets.record('cacheFill', 'quota');
    expect(e.budgets.exceeded('cacheFill')).toBe(true);
    await eng.fillOwnCache(
      [
        { hash: 'h1', bytes: 1, mime: 'image/png' },
        { hash: 'h2', bytes: 1, mime: 'image/png' },
      ],
      'm2',
    );
    await flush();
    expect(lastLiveOf(posts).ownCache).toEqual({ ready: 0, total: 2, failed: 2, manifestId: 'm2' });
  });

  it('a manifest change cancels only the own-cache downloads whose file left; the rest continue and the new fill joins them', async () => {
    const { posts, e } = await start();
    const eng = e as unknown as {
      files: FileStore;
      fillOwnCache(files: { hash: string; bytes: number; mime: string }[], id: string): Promise<void>;
    };
    eng.files = new MemoryStore();
    // A fetch that completes only when the test says so, recording the signal it was given.
    const inflight = new Map<string, { signal: AbortSignal; resolve(): void; calls: number }>();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const hash = url.split('/').pop()!;
      const signal = init?.signal as AbortSignal;
      const have = inflight.get(hash);
      if (have) have.calls++;
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        inflight.set(hash, {
          signal,
          calls: (have?.calls ?? 0) + 1,
          resolve: () => resolve(new Response(new Blob(['x']), { status: 200 })),
        });
      });
    }) as unknown as typeof fetch;
    try {
      const f = (h: string) => ({ hash: h, bytes: 1, mime: 'video/mp4' });
      const first = eng.fillOwnCache([f('h1'), f('h2')], 'm1');
      await flush();
      expect([...inflight.keys()].sort()).toEqual(['h1', 'h2']);
      // The manifest grows (goLive adds a file) and loses one: h2's download is cancelled, h1's goes on
      // and is not restarted, h3 starts.
      const second = eng.fillOwnCache([f('h1'), f('h3')], 'm2');
      await flush();
      expect(inflight.get('h2')!.signal.aborted).toBe(true);
      expect(inflight.get('h1')!.signal.aborted).toBe(false);
      expect(inflight.get('h1')!.calls).toBe(1);
      expect(inflight.has('h3')).toBe(true);
      expect(posts.some((p) => p.t === 'log' && /1 download\(s\) cancelled/.test(p.text))).toBe(true);
      inflight.get('h1')!.resolve();
      inflight.get('h3')!.resolve();
      await second;
      await first;
      await flush();
      expect(inflight.get('h1')!.calls).toBe(1);
      expect(await eng.files.has('h1')).toBe(true);
      expect(await eng.files.has('h3')).toBe(true);
      expect(lastLiveOf(posts).ownCache).toEqual({ ready: 2, total: 2, failed: 0, manifestId: 'm2' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('refused while the fallback authority: windows are re-introduced to the bus at once and when they go quiet', async () => {
    let now = 1_000_000;
    const posts: CoreToMain[] = [];
    const { store } = memStore({
      [CORE_KEY]: { state: live(), authority: 'fallback', pending: [], aids: [], at: Date.now() },
    });
    engine = new CoreEngine(
      (m) => posts.push(m),
      store,
      () => now,
    );
    const e = engine;
    await e.init({ t: 'init', role: 'operate', appVersion: 't', generation: 1, test: true });
    expect(e.core.authority).toBe('fallback');
    const ch = new MessageChannel();
    const hellos: number[] = [];
    ch.port2.onmessage = (ev) => {
      if (ev.data?.t === 'fallback.hello') hellos.push(now);
    };
    e.handle({ t: 'bus.port', outputId: 'o1', port: ch.port1 });
    const answer = async () => {
      ch.port2.postMessage({ t: 'fallback.ready', v: 1, outputId: 'o1', appliedSeq: 0 });
      for (let i = 0; i < 100 && !e.fallback.isReady('o1'); i++) await new Promise((r) => setTimeout(r, 5));
    };
    await answer();
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    const before = hellos.length;
    const watchBus = () => (e as unknown as { watchBus(): void }).watchBus();
    // Quiet windows are left alone while the hub merely has not answered yet (no refusal).
    now += 4000;
    watchBus();
    await settle();
    expect(hellos.length).toBe(before);
    // The hub is back and refuses the session: every window is re-introduced at once.
    e.hub.emit('status', { connected: true });
    e.core.onStatus(true);
    fromHub(e, { t: 'bye', v: 1, reason: 'unauthorized' });
    e.hub.emit('status', { connected: false });
    await settle();
    expect(e.core.authority).toBe('fallback');
    expect(hellos.length).toBe(before + 1);
    expect(e.fallback.isReady('o1')).toBe(false);
    await answer();
    // A window that answers and keeps reporting health is not recalled; one quiet for RECALL_MS is.
    now += 2000;
    watchBus();
    await settle();
    expect(hellos.length).toBe(before + 1);
    now += 2000;
    watchBus();
    await settle();
    expect(hellos.length).toBe(before + 2);
    expect(
      posts.some((p) => p.t === 'log' && /went quiet on the bus while the session is refused/.test(p.text)),
    ).toBe(true);
    // Throttled: not again within RECALL_MS of the last recall.
    now += 1000;
    watchBus();
    await settle();
    expect(hellos.length).toBe(before + 2);
  });

  it('refused while the fallback authority: the bus tells the windows the hub refuses this operator until it accepts it again (chaos-operator.spec.ts:818)', async () => {
    const posts: CoreToMain[] = [];
    const { store } = memStore({
      [CORE_KEY]: { state: live(), authority: 'fallback', pending: [], aids: [], at: Date.now() },
    });
    engine = new CoreEngine((m) => posts.push(m), store);
    const e = engine;
    await e.init({ t: 'init', role: 'operate', appVersion: 't', generation: 1, test: true });
    expect(e.core.authority).toBe('fallback');
    const ch = new MessageChannel();
    const got: { t: string; hubUp?: boolean; hubRefused?: boolean }[] = [];
    ch.port2.onmessage = (ev) => got.push(ev.data);
    e.handle({ t: 'bus.port', outputId: 'o1', port: ch.port1 });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const answer = async () => {
      ch.port2.postMessage({ t: 'fallback.ready', v: 1, outputId: 'o1', appliedSeq: 0 });
      for (let i = 0; i < 100 && !e.fallback.isReady('o1'); i++) await new Promise((r) => setTimeout(r, 5));
      await settle();
    };
    await answer();
    expect(got.some((m) => m.hubRefused)).toBe(false);
    // The hub is back and refuses the session: the re-introduction says so, before any window can take a
    // restarted hub's state (equal to its own) for a hand-back that cannot happen.
    got.length = 0;
    e.hub.emit('status', { connected: true });
    e.core.onStatus(true);
    fromHub(e, { t: 'bye', v: 1, reason: 'unauthorized' });
    e.hub.emit('status', { connected: false });
    await settle();
    expect(e.core.authority).toBe('fallback');
    expect(got.find((m) => m.t === 'fallback.hello')).toMatchObject({ hubRefused: true });
    expect(e.fallback.hubRefused).toBe(true);
    await answer();
    // Signed in: the flag stays until the hub accepts the operator (a welcome), then the hand-back proceeds.
    e.handle({ t: 'hub.resume' });
    expect(e.fallback.hubRefused).toBe(true);
    got.length = 0;
    fromHub(e, { t: 'welcome', v: 1, hubMs: Date.now(), seq: 0, role: 'operate', appVersion: 't' });
    await settle();
    expect(e.fallback.hubRefused).toBe(false);
    expect(got.at(0)).toEqual({ t: 'fallback.hub', v: 1, hubUp: false });
  });

  it('in hub mode a quiet proven port is never re-offered; an unproven one is, once per 10 s (item 16)', async () => {
    let now = 1_000_000;
    const posts: CoreToMain[] = [];
    engine = new CoreEngine(
      (m) => posts.push(m),
      memStore().store,
      () => now,
    );
    const e = engine;
    await e.init({ t: 'init', role: 'operate', appVersion: 't', generation: 0, test: true });
    const proven = new MessageChannel();
    const unproven = new MessageChannel();
    e.handle({ t: 'bus.port', outputId: 'o1', port: proven.port1 });
    e.handle({ t: 'bus.port', outputId: 'o2', port: unproven.port1 });
    // o1's window answers the introduction on its port (a fallback.ready), then falls quiet.
    proven.port2.postMessage({ t: 'fallback.ready', v: 1, outputId: 'o1', appliedSeq: 0 });
    for (let i = 0; i < 100 && e.stats().endpoints.o1?.sinceRxMs === -1; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(e.stats().endpoints.o1?.ready).toBe(true);
    const watchBus = () => (e as unknown as { watchBus(): void }).watchBus();
    posts.length = 0;
    for (let t = 0; t < 60_000; t += 2000) {
      now += 2000;
      watchBus();
    }
    const needs = (id: string) => posts.filter((p) => p.t === 'bus.need' && p.outputId === id).length;
    expect(needs('o1')).toBe(0);
    expect(needs('o2')).toBeGreaterThanOrEqual(5);
    expect(needs('o2')).toBeLessThanOrEqual(6);
    // The `fallback ready` line is logged once per window in hub mode, not per re-introduction.
    proven.port2.postMessage({ t: 'fallback.ready', v: 1, outputId: 'o1', appliedSeq: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(posts.filter((p) => p.t === 'log' && /fallback ready o1/.test(p.text))).toHaveLength(0);
    proven.port2.close();
    unproven.port2.close();
  });
});

describe('LiveCore with a refused hub session (item 5)', () => {
  it('does not arm the fallback grace while the hub refuses the session', () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const notices: string[] = [];
    const c = new LiveCore(
      {
        sendHub: () => false,
        fallback: { activate() {}, deactivate() {}, broadcastDelta() {} },
        setClockFallback() {},
        newId: () => Math.random().toString(36),
        setTimer: (fn, ms) => {
          const t = { fn, ms };
          timers.push(t);
          return t;
        },
        clearTimer: (t) => {
          const i = timers.indexOf(t as never);
          if (i >= 0) timers.splice(i, 1);
        },
        onChange() {},
        onNotice: (n) => notices.push(n.kind),
      },
      live(),
    );
    c.onStatus(true);
    c.setHubRefused(true);
    c.onStatus(false);
    for (const t of [...timers]) t.fn();
    expect(c.authority).toBe('hub');
    expect(notices).not.toContain('fallback-on');
  });
});

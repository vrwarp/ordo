import type { JsonStore } from '@ordo/cache';
import { type LiveState, parseLyrics, type ResolvedPlaylist, songFromParsed } from '@ordo/domain';
import { initialState, reduce } from '@ordo/live-state';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_KEY, CoreEngine, type CoreSnapshot } from '../src/core/engine.ts';
import type { CoreToMain, ViewModelMsg } from '../src/core/protocol.ts';

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
});

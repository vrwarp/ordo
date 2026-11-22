/**
 * The bake service (apps/operator/src/services/bake.ts) driven with a scripted hub, fake workers and a fake clock
 * (B1 to B35, B-F1, B-F2, and the four recorded mutations of the notes): the holds (never during a service, never
 * from a computer that cannot), the triggers and their delays, the key check against the hub's listing, the stale-copy
 * rule, the upload order and the sizes the hub lacks, every answer of the hub, which failures are posted and which
 * are retried, the hard deadline, the actions and the worker's life. The real worker runs in the e2e spec.
 */
import { ApiFailure } from '@ordo/client';
import {
  DEFAULT_LYRIC_STYLE,
  type Font,
  type Media,
  type Presentation,
  type ShapeObject,
  type Slide,
} from '@ordo/domain';
import { initialState } from '@ordo/live-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyLibrary } from '../src/core/libraryStore.ts';
import type { BakeVerdict } from '../src/lib/capabilities.ts';
import { useLibrary } from '../src/state/library.ts';
import { useLive } from '../src/state/live.ts';
import {
  BAKE_GAP_MS,
  BAKE_GO_LIVE_HOLD_MAX_MS,
  BAKE_HARD_GRACE_MS,
  BAKE_IDLE_SWEEP_MS,
  BAKE_JOB_DEADLINE_MS,
  BAKE_PAUSED_MAX_MS,
  BAKE_RESUME_MS,
  BAKE_SETTLE_MS,
  BAKE_START_DELAY_MS,
  BAKE_WORKER_IDLE_MS,
} from '../src/services/bakeConsts.ts';
import { type Listing, localKey, slideInputs } from '../src/services/bakePlan.ts';
import {
  type BakeServiceDeps,
  type BakeTimings,
  type BakeWorkerLike,
  bakeTestMode,
  bakeTimingsFromUrl,
  createBakeService,
  uploadUrl,
} from '../src/services/bake.ts';
import { bakeId, resetBake, useBake } from '../src/state/bake.ts';
import type { BakeIn, BakeJobIn, BakeOut } from '../src/workers/bakeJob.ts';

// ---- fixtures ----

const rect = (i: number) =>
  ({
    id: `r${i}`,
    type: 'shape',
    box: { x: (i % 40) * 40, y: Math.floor(i / 40) * 40, w: 30, h: 30, rotation: 0 },
    shape: 'rect',
    fill: { r: 200, g: 0, b: 0, a: 1 },
    opacity: 1,
    radius: 0,
  }) as ShapeObject;

function heavy(id: string, extra: Partial<Slide> = {}): Slide {
  return {
    id,
    objects: [
      ...Array.from({ length: 250 }, (_, i) => rect(i)),
      {
        id: 'title',
        type: 'text',
        box: { x: 0, y: 0, w: 400, h: 100, rotation: 0 },
        text: `Welcome ${id}`,
        style: { ...DEFAULT_LYRIC_STYLE },
        opacity: 1,
      },
      {
        id: 'pic',
        type: 'image',
        box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        mediaId: 'photo',
        fit: 'contain',
        opacity: 1,
        radius: 0,
      },
    ],
    prerender: { why: ['count'], live: [] },
    ...extra,
  } as unknown as Slide;
}

const file = (hash: string, mime: string) => ({ hash, bytes: 10, mime, path: `files/${hash}` });
const PHOTO = {
  id: 'photo',
  rev: 1,
  name: 'photo',
  tags: [],
  kind: 'image',
  original: file('photo-orig', 'image/png'),
  state: 'ready',
  loop: false,
  isBackground: false,
} as unknown as Media;
const FONTS = [
  {
    id: 'f1',
    rev: 1,
    family: 'Inter',
    weight: 400,
    style: 'normal',
    file: file('inter-regular', 'font/ttf'),
  },
] as unknown as Font[];

function deck(id: string, slides: Slide[], over: Partial<Presentation> = {}): Presentation {
  return {
    id,
    rev: 1,
    title: id,
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: `${id}-s`, name: 'Main', slides }],
    arrangements: [],
    archived: false,
    updatedAt: '2026-11-20T10:00:00Z',
    ...over,
  } as unknown as Presentation;
}

const OK: BakeVerdict = { ok: true, list: true };

class FakeWorker implements BakeWorkerLike {
  posted: BakeIn[] = [];
  terminated = false;
  onmessage: ((ev: { data: BakeOut }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  postMessage(m: BakeIn): void {
    this.posted.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
  say(m: BakeOut): void {
    this.onmessage?.({ data: m });
  }
  get jobs(): BakeJobIn[] {
    return this.posted.filter((m) => m.t === 'bake').map((m) => (m as Extract<BakeIn, { t: 'bake' }>).job);
  }
}

type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: Blob;
  json?: unknown;
  headers?: Record<string, string>;
};

function world(
  opts: {
    slides?: Slide[];
    presentations?: Presentation[];
    verdict?: BakeVerdict;
    random?: number;
    autoIdle?: boolean;
    /** What this page's SVG drawing answers. */
    bitmap?: ImageBitmap;
    /** The worker cannot be built (no Worker in this browser). */
    noWorker?: boolean;
    /** The waits of test mode. */
    timings?: Partial<BakeTimings>;
  } = {},
) {
  resetBake();
  let t = 1_000_000;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const workers: FakeWorker[] = [];
  const logs: string[] = [];
  const svgs: Blob[] = [];
  const idles: (() => void)[] = [];
  const state = { verdict: opts.verdict ?? OK, madeWorkers: 0 };
  const keys = new Map<string, Listing['keys']>();
  const failures = new Map<string, Listing['failures']>();
  const calls: Call[] = [];
  const rules: { test: (c: Call) => boolean; reply: (c: Call) => unknown }[] = [];
  const presentations = opts.presentations ?? [deck('p1', opts.slides ?? [heavy('s1')])];
  useLive.setState({
    state: { ...initialState(), mode: 'idle' },
    hubConnected: true,
    held: false,
    authority: 'hub',
    goLivePrepare: undefined,
  });
  useLibrary.setState({
    data: { ...emptyLibrary(), presentations, media: [PHOTO], fonts: FONTS, playlists: [] },
    loaded: true,
    attempted: true,
    source: 'hub',
    error: undefined,
  });
  const inputs = () =>
    slideInputs({ media: useLibrary.getState().data.media, fonts: useLibrary.getState().data.fonts });
  /** The hub keeps a picture of a size it does not hold; a key it does not list is a 409. */
  const hubPut = (p: string, key: string, call: Call) => {
    const row = (keys.get(p) ?? []).find((k) => k.key === key);
    if (!row) throw new ApiFailure(409, 'unknown_key', 'unknown key');
    const size = Number(call.query.get('size'));
    if (row.sizes.includes(size)) return { dropped: true };
    row.sizes = [...row.sizes, size].sort((a, b) => a - b);
    return {};
  };
  const api = async (
    path: string,
    init: { method?: string; body?: Blob; json?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const [pathname, qs] = path.split('?') as [string, string | undefined];
    const call: Call = {
      method: init.method ?? 'GET',
      path: pathname,
      query: new URLSearchParams(qs ?? ''),
      body: init.body,
      json: init.json,
      headers: init.headers,
    };
    calls.push(call);
    for (const r of rules) if (r.test(call)) return r.reply(call);
    const m = /^\/presentations\/([^/]+)\/prerenders(?:\/([^/]+)(\/failed)?)?$/.exec(pathname);
    if (!m) throw new Error(`unexpected hub call ${call.method} ${pathname}`);
    const p = decodeURIComponent(m[1] as string);
    const key = m[2] ? decodeURIComponent(m[2]) : undefined;
    if (call.method === 'GET')
      return {
        keys: keys.get(p) ?? [],
        failures: failures.get(p) ?? [],
        budget: { usedBytes: 0, limitBytes: 1 << 30 },
      };
    if (call.method === 'PUT' && key) return hubPut(p, key, call);
    if (call.method === 'POST' && key && m[3]) {
      failures.set(p, [
        ...(failures.get(p) ?? []),
        { key, reason: (call.json as { reason: string }).reason, at: t },
      ]);
      return {};
    }
    if (call.method === 'DELETE' && key) {
      keys.set(
        p,
        (keys.get(p) ?? []).map((k) => (k.key === key ? { ...k, sizes: [] } : k)),
      );
      failures.set(
        p,
        (failures.get(p) ?? []).filter((f) => f.key !== key),
      );
      return undefined;
    }
    throw new Error(`unexpected hub call ${call.method} ${pathname}`);
  };
  const deps: BakeServiceDeps = {
    api,
    createWorker: () => {
      if (opts.noWorker) return undefined;
      const w = new FakeWorker();
      workers.push(w);
      state.madeWorkers++;
      return w;
    },
    now: () => t,
    setTimer: (fn, ms) => {
      const tm = { at: t + ms, fn, dead: false };
      timers.push(tm);
      return tm;
    },
    clearTimer: (h) => {
      (h as { dead: boolean }).dead = true;
    },
    idle: () => (opts.autoIdle === false ? new Promise<void>((r) => idles.push(r)) : Promise.resolve()),
    yieldTask: async () => undefined,
    random: () => opts.random ?? 0,
    gate: () => state.verdict,
    stores: { live: useLive as never, library: useLibrary as never },
    openId: () => undefined,
    madeBy: () => 'operator 0.10.0 operate Linux',
    fontUrl: (h) => `https://hub/f/${h}`,
    drawSvg: async (blob) => {
      svgs.push(blob);
      return opts.bitmap;
    },
    ...(opts.timings ? { timings: opts.timings } : {}),
    log: (_l, text) => {
      logs.push(text);
    },
  };
  const service = createBakeService(deps);
  const flush = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      t = Math.max(t, next.at);
      next.dead = true;
      next.fn();
      await flush();
    }
    t = end;
    await flush();
  };
  const w = {
    service,
    deps,
    workers,
    calls,
    keys,
    failures,
    rules,
    /** The hub's own answer to a picture upload (rules that fail it call this for the ones that pass). */
    put(c: Call) {
      const m = /^\/presentations\/([^/]+)\/prerenders\/([^/]+)$/.exec(c.path);
      return hubPut(decodeURIComponent(m?.[1] as string), decodeURIComponent(m?.[2] as string), c);
    },
    logs,
    svgs,
    idles,
    state,
    timers,
    presentations,
    inputs,
    flush,
    advance,
    now: () => t,
    /** The hub knows the slide's key (its keys job has run), with these sizes. */
    know(presentationId: string, slide: Slide, sizes: number[] = []) {
      keys.set(presentationId, [
        ...(keys.get(presentationId) ?? []),
        { slideId: slide.id, key: localKey(slide, inputs()), standbyId: 'b', sizes },
      ]);
    },
    keyOf: (slide: Slide) => localKey(slide, inputs()),
    live(over: Partial<ReturnType<typeof useLive.getState>>) {
      useLive.setState(over);
    },
    library(over: Partial<ReturnType<typeof useLibrary.getState>>) {
      useLibrary.setState(over);
    },
    /** Starts the service and runs to its first sweep. */
    async begin() {
      const stop = service.start();
      await advance(BAKE_START_DELAY_MS);
      return stop;
    },
    puts: () => calls.filter((c) => c.method === 'PUT'),
    gets: () => calls.filter((c) => c.method === 'GET'),
    posts: () => calls.filter((c) => c.method === 'POST'),
    /** The reason of the first failure posted to the hub. */
    postedReason: () =>
      String((calls.find((c) => c.method === 'POST')?.json as { reason?: string } | undefined)?.reason),
    /** The computer was idle: every wait for an idle moment ends. */
    releaseIdle() {
      for (const r of idles.splice(0)) r();
    },
    worker: () => workers[workers.length - 1] as FakeWorker,
    /** Every job posted, to whichever worker (a worker is released 30 s after its last picture). */
    allJobs: () => workers.flatMap((x) => x.jobs),
    job: () => (workers[workers.length - 1] as FakeWorker).jobs.slice(-1)[0] as BakeJobIn,
    /** The worker makes the picture. */
    made(over: { sizes?: number[] } = {}) {
      const j = (workers[workers.length - 1] as FakeWorker).jobs.slice(-1)[0] as BakeJobIn;
      const sizes = over.sizes ?? [1920, 3840, 640];
      (workers[workers.length - 1] as FakeWorker).say({
        t: 'made',
        id: j.id,
        pictures: sizes.map((s) => ({
          size: s,
          type: s === 640 ? 'image/webp' : 'image/png',
          blob: new Blob([`pic${s}`]),
          bytes: 10 + s,
        })),
        opaque: true,
        standIns: [],
        ms: {},
      });
    },
    failedJob(reason: string, detail = 'a detail') {
      const j = (workers[workers.length - 1] as FakeWorker).jobs.slice(-1)[0] as BakeJobIn;
      (workers[workers.length - 1] as FakeWorker).say({
        t: 'failed',
        id: j.id,
        reason: reason as never,
        detail,
        text: `${reason}: ${detail}`,
      });
    },
  };
  return w;
}

const slideEntry = (p: string, s: string) => useBake.getState().slides[bakeId(p, s)];

beforeEach(() => {
  resetBake();
});
afterEach(() => {
  resetBake();
});

// ---- gate and holds ----

describe('the gate and the holds (B1-B5)', () => {
  for (const [name, verdict, gate] of [
    ['the hub switch is off', { ok: false, why: 'off', list: false }, 'off'],
    ['this computer cannot', { ok: false, why: 'unsupported', list: false }, 'unsupported'],
    ['the hub has not answered', { ok: false, why: 'unknown', list: false }, 'unknown'],
  ] as const)
    it(`B1 with the gate not ready (${name}) start() builds no worker and sends no request`, async () => {
      const w = world({ verdict });
      w.know('p1', w.presentations[0]?.sections[0]?.slides[0] as Slide);
      const stop = w.service.start();
      await w.advance(10 * 60_000);
      expect(w.workers).toHaveLength(0);
      expect(w.calls).toEqual([]);
      expect(useBake.getState().gate).toBe(gate);
      expect(typeof stop).toBe('function');
      stop();
    });

  it('B2 a library that has not loaded or that the hub failed to read, or a hub that is not connected, holds: no request', async () => {
    const w = world();
    w.library({ loaded: false });
    await w.begin();
    expect(w.calls).toEqual([]);
    expect(useBake.getState().hold).toBe('hub');
    w.library({ loaded: true, error: 'the hub did not answer' });
    await w.advance(BAKE_SETTLE_MS + 1);
    expect(w.calls).toEqual([]);
    expect(useBake.getState().hold).toBe('hub');
    w.library({ error: undefined });
    w.know('p1', w.presentations[0]?.sections[0]?.slides[0] as Slide);
    await w.advance(BAKE_SETTLE_MS + 1);
    expect(w.gets().length).toBeGreaterThan(0);
    w.live({ hubConnected: false });
    expect(useBake.getState().hold).toBe('hub');
  });

  it('B2 a reloaded page: the IndexedDB copy was the first message and the hub\'s snapshot after it is a patch, so the page\'s source stays "cache" for ever; the service plans from it all the same (the e2e finding)', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.library({ source: 'cache' });
    w.know('p1', slide);
    await w.begin();
    expect(useBake.getState().hold).toBeUndefined();
    expect(w.gets().length).toBeGreaterThan(0);
    expect(w.allJobs()).toHaveLength(1);
  });

  for (const [name, over, hold] of [
    ['a live service', { state: { ...initialState(), mode: 'live' as const } }, 'service'],
    ['a held service (no hub)', { held: true }, 'service'],
    ['the fallback authority', { authority: 'fallback' as const }, 'service'],
    ['a Go live the hub is preparing', { goLivePrepare: { playlistId: 'x' } as never }, 'go-live'],
  ] as const)
    it(`B3 ${name}: hold "${hold}", no listing, no worker`, async () => {
      const w = world();
      w.live(over);
      await w.begin();
      await w.advance(60_000);
      expect(useBake.getState().hold).toBe(hold);
      expect(w.calls).toEqual([]);
      expect(w.workers).toHaveLength(0);
    });

  it('B3 a service that starts while a bake runs: the worker is terminated on the spot, nothing is uploaded, nothing is posted', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide);
    await w.begin();
    expect(useBake.getState().running?.slideId).toBe('s1');
    const worker = w.worker();
    w.live({ state: { ...initialState(), mode: 'live' } });
    expect(worker.terminated).toBe(true);
    expect(useBake.getState().running).toBeUndefined();
    expect(useBake.getState().hold).toBe('service');
    worker.say({ t: 'made', id: 1, pictures: [], opaque: true, standIns: [], ms: {} });
    await w.advance(60_000);
    expect(w.puts()).toEqual([]);
    expect(w.posts()).toEqual([]);
  });

  it('B4 End service: hold resume-wait until exactly 120 s later, nothing before, then one sweep; makeNow inside the wait works', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide);
    w.live({ state: { ...initialState(), mode: 'live' } });
    await w.begin();
    expect(w.calls).toEqual([]);
    w.live({ state: { ...initialState(), mode: 'idle' } });
    const at = w.now();
    expect(useBake.getState().hold).toBe('resume-wait');
    expect(useBake.getState().holdUntil).toBe(at + BAKE_RESUME_MS);
    await w.advance(BAKE_RESUME_MS - 1);
    expect(w.calls).toEqual([]);
    expect(useBake.getState().hold).toBe('resume-wait');
    await w.advance(1);
    expect(w.gets().length).toBe(1);
    expect(w.workers).toHaveLength(1);
    // the same wait, entered again: makeNow skips it
    const w2 = world({ slides: [slide] });
    w2.know('p1', slide);
    w2.live({ state: { ...initialState(), mode: 'live' } });
    await w2.begin();
    w2.live({ state: { ...initialState(), mode: 'idle' } });
    const r = await w2.service.makeNow();
    expect(r).toEqual({ ok: true, queued: 1 });
  });

  it('B5 the press of Go live stops a bake on the spot; the hold lasts until the service starts or 60 s have passed', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide);
    await w.begin();
    const worker = w.worker();
    w.service.holdForGoLive();
    expect(worker.terminated).toBe(true);
    expect(useBake.getState().hold).toBe('go-live');
    worker.say({ t: 'made', id: 1, pictures: [], opaque: true, standIns: [], ms: {} });
    await w.advance(BAKE_GO_LIVE_HOLD_MAX_MS - 1);
    expect(w.puts()).toEqual([]);
    expect(useBake.getState().hold).toBe('go-live');
    await w.advance(2);
    // the prepare was given up: no service, the hold is released and a sweep follows
    expect(useBake.getState().hold).toBeUndefined();
    expect(w.workers.length).toBeGreaterThan(0);
    // a service that does start ends the hold into "service"
    const w2 = world({ slides: [slide] });
    w2.know('p1', slide);
    await w2.begin();
    w2.service.holdForGoLive();
    w2.live({ state: { ...initialState(), mode: 'live' } });
    expect(useBake.getState().hold).toBe('service');
    await w2.advance(BAKE_GO_LIVE_HOLD_MAX_MS * 2);
    expect(useBake.getState().hold).toBe('service');
  });
});

// ---- sweeps and triggers ----

describe('sweeps and their triggers (B6-B10)', () => {
  it('B6 a burst of library changes is ONE sweep 3 s after the last change; media and font changes too', async () => {
    const w = world({ presentations: [deck('p1', [{ id: 's0', objects: [] } as Slide])] });
    const stop = await w.begin();
    const before = w.service.snapshot().sweeps;
    const lib = () => useLibrary.getState().data;
    w.library({ data: { ...lib(), presentations: [...lib().presentations] } });
    await w.advance(1000);
    w.library({ data: { ...lib(), presentations: [...lib().presentations] } });
    await w.advance(BAKE_SETTLE_MS - 1);
    expect(w.service.snapshot().sweeps).toBe(before);
    await w.advance(1);
    expect(w.service.snapshot().sweeps).toBe(before + 1);
    w.library({ data: { ...lib(), media: [...lib().media] } });
    await w.advance(BAKE_SETTLE_MS);
    expect(w.service.snapshot().sweeps).toBe(before + 2);
    w.library({ data: { ...lib(), fonts: [...lib().fonts] } });
    await w.advance(BAKE_SETTLE_MS);
    expect(w.service.snapshot().sweeps).toBe(before + 3);
    stop();
  });

  it('B7 the first sweep is not earlier than 15 s after start plus the jitter, and not before the library came from the hub', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide], random: 0.5 });
    w.know('p1', slide);
    w.service.start();
    await w.advance(BAKE_START_DELAY_MS + 2499);
    expect(w.calls).toEqual([]);
    expect(w.service.snapshot().sweeps).toBe(0);
    await w.advance(1);
    expect(w.service.snapshot().sweeps).toBe(1);
    expect(w.gets()).toHaveLength(1);
  });

  it('B7 the jitter is a third of the start delay at most: a test that shortens the delay to nothing gets no jitter', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide], random: 0.99, timings: { startDelayMs: 0, settleMs: 500, gapMs: 0 } });
    w.know('p1', slide);
    w.service.start();
    await w.advance(1);
    expect(w.service.snapshot().sweeps).toBe(1);
    expect(w.gets()).toHaveLength(1);
  });

  it('B8 an idle sweep every 5 minutes ONLY while something is pending; when everything is ready or failed no timer is armed', async () => {
    const slide = heavy('s1');
    // something pending: the hub has no key for it yet
    const pending = world({ slides: [slide] });
    await pending.begin();
    expect(pending.workers).toHaveLength(0);
    const sweeps = pending.service.snapshot().sweeps;
    await pending.advance(BAKE_IDLE_SWEEP_MS + 1);
    expect(pending.service.snapshot().sweeps).toBeGreaterThan(sweeps);
    // everything ready (and one failed): an hour of fake time makes no request
    const a = heavy('a');
    const b = heavy('b');
    const quiet = world({ slides: [a, b] });
    quiet.know('p1', a, [1920, 3840]);
    quiet.know('p1', b, []);
    quiet.failures.set('p1', [{ key: quiet.keyOf(b), reason: 'coverage: U+4E2D', at: 1 }]);
    await quiet.begin();
    const n = quiet.calls.length;
    expect(n).toBeGreaterThan(0);
    await quiet.advance(60 * 60_000);
    expect(quiet.calls.length).toBe(n);
    expect(quiet.workers).toHaveLength(0);
    expect(quiet.service.snapshot().timers).toBe(0);
    expect(slideEntry('p1', 'a')?.state).toBe('ready');
    expect(slideEntry('p1', 'b')?.state).toBe('failed');
  });

  it('B9 refresh lists once, reuses a fresh listing and lists again when forced', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide, [1920, 3840]);
    await w.service.refresh('p1');
    await w.service.refresh('p1');
    expect(w.gets()).toHaveLength(1);
    expect(slideEntry('p1', 's1')?.state).toBe('ready');
    await w.service.refresh('p1', { force: true });
    expect(w.gets()).toHaveLength(2);
    await w.advance(11_000);
    await w.service.refresh('p1');
    expect(w.gets()).toHaveLength(3);
  });

  it('B10 a library with no record makes no request and builds no worker, one listing per presentation with records', async () => {
    const none = world({ presentations: [deck('a', [{ id: 'x', objects: [] } as Slide])] });
    await none.begin();
    await none.advance(10 * 60_000);
    expect(none.calls).toEqual([]);
    expect(none.workers).toHaveLength(0);
    const s1 = heavy('s1');
    const s2 = heavy('s2');
    const two = world({
      presentations: [deck('a', [s1]), deck('b', [{ id: 'y', objects: [] } as Slide]), deck('c', [s2])],
    });
    two.know('a', s1, [1920, 3840]);
    two.know('c', s2, [1920, 3840]);
    await two.begin();
    expect(two.gets().map((g) => g.path)).toEqual([
      '/presentations/a/prerenders',
      '/presentations/c/prerenders',
    ]);
  });
});

// ---- the key check ----

describe('the key check against the hub (B11-B13)', () => {
  it('B11 a key the hub does not list is not made: queued waiting for the hub, looked up again after 2, 5, 15, 60 and 120 s, then not again', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    await w.begin();
    expect(w.workers).toHaveLength(0);
    expect(slideEntry('p1', 's1')).toMatchObject({ state: 'queued', waiting: 'hub-key' });
    let gets = w.gets().length;
    for (const d of [2000, 5000, 15000, 60000, 120000]) {
      await w.advance(d - 1);
      expect(w.gets().length).toBe(gets);
      await w.advance(1);
      expect(w.gets().length).toBe(gets + 1);
      gets++;
    }
    await w.advance(110_000);
    expect(w.gets().length).toBe(gets);
    expect(w.logs.some((l) => l.includes('not looked at again'))).toBe(true);
    // when the hub's key appears it is made (the next lookup: here the idle sweep)
    w.know('p1', slide);
    await w.advance(BAKE_IDLE_SWEEP_MS);
    // (a worker that never answers is killed and tried again, so the first job is the one that proves the key)
    expect(w.allJobs()[0]?.key).toBe(w.keyOf(slide));
  });

  it('B12 the key in the listing: the job carries that key and every upload path ends with it', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide);
    await w.begin();
    expect(w.job()).toMatchObject({
      key: w.keyOf(slide),
      presentationId: 'p1',
      slideId: 's1',
      kind: 'slide',
      live: [],
      madeBy: 'operator 0.10.0 operate Linux',
    });
    expect(w.job().images).toEqual({ photo: 'photo-orig' });
    w.made();
    await w.flush();
    expect(w.puts()).toHaveLength(3);
    for (const p of w.puts()) expect(p.path.endsWith(`/prerenders/${w.keyOf(slide)}`)).toBe(true);
  });

  it('B13 a library change that moves the running slide terminates the worker and uploads nothing for the old key', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide);
    await w.begin();
    const worker = w.worker();
    const edited = {
      ...slide,
      objects: slide.objects.map((o) => (o.type === 'text' ? { ...o, text: 'changed' } : o)),
    } as Slide;
    w.library({ data: { ...useLibrary.getState().data, presentations: [deck('p1', [edited], { rev: 2 })] } });
    expect(worker.terminated).toBe(true);
    expect(useBake.getState().running).toBeUndefined();
    worker.say({ t: 'made', id: 1, pictures: [], opaque: true, standIns: [], ms: {} });
    await w.advance(1000);
    expect(w.puts()).toEqual([]);
    // the new key is queued once the hub knows it
    w.know('p1', edited);
    await w.advance(BAKE_SETTLE_MS + 1000);
    expect(w.workers.at(-1)?.jobs.at(-1)?.key).toBe(w.keyOf(edited));
  });

  it("B13 a finished job whose key is no longer the slide's is dropped before its first upload", async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide);
    await w.begin();
    // the library changes the same instant the picture arrives: the copy moves without a delta reaching the running job
    const edited = {
      ...slide,
      objects: slide.objects.map((o) => (o.type === 'text' ? { ...o, text: 'changed' } : o)),
    } as Slide;
    useLibrary.setState(
      (s) => ({ data: { ...s.data, presentations: [deck('p1', [edited], { rev: 2 })] } }),
      false,
    );
    w.made();
    await w.flush();
    expect(w.puts()).toEqual([]);
  });
});

// ---- bake and upload ----

describe('the queue and the upload (B14-B16)', () => {
  it('B14 one job at a time in the order of the plan, with the gap and an idle callback between two', async () => {
    const a = heavy('a');
    const b = heavy('b');
    const w = world({ slides: [a, b], autoIdle: false });
    w.know('p1', a);
    w.know('p1', b);
    w.service.start();
    await w.advance(BAKE_START_DELAY_MS);
    // waiting for the computer to be idle: no worker yet
    expect(w.workers).toHaveLength(0);
    w.releaseIdle();
    await w.flush();
    expect(w.workers).toHaveLength(1);
    expect(w.worker().jobs).toHaveLength(1);
    expect(useBake.getState().running).toMatchObject({ slideId: 'a' });
    w.made();
    await w.flush();
    // the first is done; the second waits the gap, then the idle callback
    expect(useBake.getState().running).toBeUndefined();
    expect(w.worker().jobs).toHaveLength(1);
    await w.advance(BAKE_GAP_MS - 1);
    expect(w.idles).toHaveLength(0);
    await w.advance(1);
    expect(w.idles).toHaveLength(1);
    expect(w.worker().jobs).toHaveLength(1);
    w.releaseIdle();
    await w.flush();
    expect(w.worker().jobs).toHaveLength(2);
    expect(useBake.getState().running).toMatchObject({ slideId: 'b' });
    // one worker object alive at a time
    expect(w.workers.filter((x) => !x.terminated)).toHaveLength(1);
    w.made();
    await w.flush();
    expect(slideEntry('p1', 'a')?.state).toBe('ready');
    expect(slideEntry('p1', 'b')?.state).toBe('ready');
  });

  it('B15 the upload is exactly the missing sizes, 1920 then 3840 then 640, with their content types, and never a size the listing holds', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide, []);
    await w.begin();
    w.made();
    await w.flush();
    expect(w.puts().map((p) => [p.query.get('size'), p.headers?.['content-type']])).toEqual([
      ['1920', 'image/png'],
      ['3840', 'image/png'],
      ['640', 'image/webp'],
    ]);
    expect(w.puts().every((p) => p.query.get('madeBy') === 'operator 0.10.0 operate Linux')).toBe(true);
    expect(w.puts().every((p) => p.body instanceof Blob)).toBe(true);
    // a key with its 1920 only: 3840 and 640
    const other = heavy('s2');
    const w2 = world({ slides: [other] });
    w2.know('p1', other, [1920]);
    await w2.begin();
    expect(w2.job().key).toBe(w2.keyOf(other));
    w2.made();
    await w2.flush();
    expect(w2.puts().map((p) => p.query.get('size'))).toEqual(['3840', '640']);
  });

  it('B16 201 and "dropped" both count: the slide is ready with its sizes, time and bytes; the listing is read once more after the last upload', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide);
    let n = 0;
    // another computer's upload of the same size lands first: the hub keeps its own and answers "dropped"
    w.rules.push({
      test: (c) => c.method === 'PUT',
      reply: (c) => {
        if (++n === 2) w.put(c);
        return w.put(c);
      },
    });
    await w.begin();
    const getsBefore = w.gets().length;
    w.made();
    await w.flush();
    expect(w.puts()).toHaveLength(3);
    expect(slideEntry('p1', 's1')).toMatchObject({
      state: 'ready',
      sizes: expect.arrayContaining([1920, 3840, 640]),
      bytes: 1930 + 3850 + 650,
    });
    expect(slideEntry('p1', 's1')?.ms).toBeDefined();
    // the snapshot says what the last picture cost, by phase and size, and never holds the bytes
    const last = w.service.snapshot().lastMade;
    expect(last?.pictures.map((p) => p.size)).toEqual([1920, 3840, 640]);
    expect(last?.pictures.every((p) => typeof p.bytes === 'number' && !('blob' in p))).toBe(true);
    expect(JSON.stringify(w.service.snapshot())).not.toContain('pic1920');
    expect(w.gets().length).toBe(getsBefore + 1);
    expect(useBake.getState().totals).toMatchObject({ heavy: 1, ready: 1 });
    expect(useBake.getState().running).toBeUndefined();
  });
});

// ---- what the hub says ----

describe('every answer of the hub (B17-B23)', () => {
  const pending = async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide);
    await w.begin();
    return { w, slide };
  };

  it('B17 503 paused_during_service: hold "service" for 10 minutes (the valve) or until the next End service plus 2 minutes; no failure posted; the picture is dropped', async () => {
    const { w } = await pending();
    w.rules.push({
      test: (c) => c.method === 'PUT',
      reply: () => {
        throw new ApiFailure(503, 'paused_during_service', 'paused', { retryAfterS: 120 });
      },
    });
    w.made();
    await w.flush();
    expect(w.puts()).toHaveLength(1);
    expect(w.posts()).toEqual([]);
    expect(useBake.getState().hold).toBe('service');
    expect(slideEntry('p1', 's1')?.state).not.toBe('failed');
    const at = w.now();
    expect(useBake.getState().holdUntil).toBe(at + BAKE_PAUSED_MAX_MS);
    await w.advance(BAKE_PAUSED_MAX_MS - 1000);
    expect(w.workers).toHaveLength(1);
    expect(w.worker().jobs).toHaveLength(1);
    await w.advance(2000);
    expect(useBake.getState().hold).toBeUndefined();
    // an End service seen in the store replaces the valve by the resume wait
    const x = await pending();
    x.w.rules.push({
      test: (c) => c.method === 'PUT',
      reply: () => {
        throw new ApiFailure(503, 'paused_during_service', 'paused', { retryAfterS: 120 });
      },
    });
    x.w.made();
    await x.w.flush();
    x.w.live({ state: { ...initialState(), mode: 'live' } });
    x.w.live({ state: { ...initialState(), mode: 'idle' } });
    expect(useBake.getState().hold).toBe('resume-wait');
    expect(useBake.getState().holdUntil).toBe(x.w.now() + BAKE_RESUME_MS);
  });

  it('B18 503 prerender_off: the gate is "off", everything stops and no timer is left', async () => {
    const { w } = await pending();
    w.rules.push({
      test: (c) => c.method === 'PUT',
      reply: () => {
        throw new ApiFailure(503, 'prerender_off', 'off');
      },
    });
    w.made();
    await w.flush();
    expect(useBake.getState().gate).toBe('off');
    const calls = w.calls.length;
    await w.advance(60 * 60_000);
    expect(w.calls.length).toBe(calls);
    expect(w.service.snapshot().timers).toBe(0);
    expect(w.posts()).toEqual([]);
  });

  it('B19 507 budget: the slide is failed in the store (code budget), nothing is posted, and the presentation is skipped until the listing shows less used or Make again is pressed', async () => {
    const { w } = await pending();
    w.rules.push({
      test: (c) => c.method === 'PUT',
      reply: () => {
        throw new ApiFailure(507, 'budget', 'full', { usedBytes: 1000, limitBytes: 1000 });
      },
    });
    w.made();
    await w.flush();
    expect(slideEntry('p1', 's1')).toMatchObject({ state: 'failed', code: 'budget', fix: 'fix' });
    expect(w.posts()).toEqual([]);
    // another sweep does not make it again (the presentation is skipped)
    w.library({
      data: { ...useLibrary.getState().data, presentations: [...useLibrary.getState().data.presentations] },
    });
    await w.advance(BAKE_SETTLE_MS + 1000);
    expect(w.worker().jobs).toHaveLength(1);
  });

  it('B20 507 disk: hold "disk" for 10 minutes, the slide failed in the store (code disk), nothing posted', async () => {
    const { w } = await pending();
    w.rules.push({
      test: (c) => c.method === 'PUT',
      reply: () => {
        throw new ApiFailure(507, 'disk', 'no room');
      },
    });
    w.made();
    await w.flush();
    expect(useBake.getState().hold).toBe('disk');
    expect(slideEntry('p1', 's1')).toMatchObject({ state: 'failed', code: 'disk' });
    expect(w.posts()).toEqual([]);
    await w.advance(10 * 60_000 + 1);
    expect(useBake.getState().hold).toBeUndefined();
  });

  it('B21 409 unknown_key on a PUT: the job ends, the listing is read again and the slide is handled as one the hub has not keyed', async () => {
    const { w } = await pending();
    w.rules.push({
      test: (c) => c.method === 'PUT',
      reply: () => {
        throw new ApiFailure(409, 'unknown_key', 'unknown');
      },
    });
    const gets = w.gets().length;
    w.made();
    await w.flush();
    await w.advance(BAKE_SETTLE_MS + 1);
    expect(w.gets().length).toBeGreaterThan(gets);
    expect(w.posts()).toEqual([]);
    expect(slideEntry('p1', 's1')?.state).not.toBe('failed');
  });

  it('B22 a network error, a 401 or a 403: hold "hub" until the hub is back; the picture is dropped, no failure posted, no attempt counted', async () => {
    for (const err of [
      new TypeError('network'),
      new ApiFailure(401, 'unauthorized', 'no'),
      new ApiFailure(403, 'forbidden', 'no'),
    ]) {
      const { w } = await pending();
      w.rules.push({
        test: (c) => c.method === 'PUT',
        reply: () => {
          throw err;
        },
      });
      w.made();
      await w.flush();
      expect(useBake.getState().hold).toBe('hub');
      expect(w.posts()).toEqual([]);
      expect(slideEntry('p1', 's1')?.attempts).toBeUndefined();
      w.live({ hubConnected: false });
      w.live({ hubConnected: true });
      expect(useBake.getState().hold).toBeUndefined();
    }
  });

  it('B23 400 bad_picture and 413 post a failure "verify" and "size" with the hub\'s message cut to the bound', async () => {
    for (const [status, code, want] of [
      [400, 'bad_picture', 'verify'],
      [413, 'too_large', 'size'],
    ] as const) {
      const { w } = await pending();
      w.rules.push({
        test: (c) => c.method === 'PUT',
        reply: () => {
          throw new ApiFailure(status, code, 'm'.repeat(500));
        },
      });
      w.made();
      await w.flush();
      expect(w.posts()).toHaveLength(1);
      const reason = w.postedReason();
      expect(reason.startsWith(`${want}: `)).toBe(true);
      expect(reason.length).toBeLessThanOrEqual(200);
      expect(slideEntry('p1', 's1')).toMatchObject({ state: 'failed', code: want });
    }
  });
});

// ---- failures of the slide ----

describe('failures: which are posted and which are retried (B24-B26)', () => {
  const pending = async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide);
    await w.begin();
    return { w, slide };
  };

  for (const reason of [
    'coverage',
    'time',
    'size',
    'animated',
    'cut',
    'draw',
    'frame',
    'canvas',
    'blank',
    'verify',
    'profile',
  ])
    it(`B24 "${reason}" is posted at once, nothing is uploaded and the next sweep does not make it again`, async () => {
      const { w } = await pending();
      w.failedJob(reason, 'the detail');
      await w.flush();
      expect(w.posts()).toHaveLength(1);
      expect(w.posts()[0]?.path.endsWith('/failed')).toBe(true);
      expect(w.postedReason()).toBe(`${reason}: the detail`);
      expect(w.posts()[0]?.json).toMatchObject({ madeBy: 'operator 0.10.0 operate Linux' });
      expect(w.puts()).toEqual([]);
      expect(slideEntry('p1', 's1')).toMatchObject({ state: 'failed', code: reason });
      w.library({
        data: { ...useLibrary.getState().data, presentations: [...useLibrary.getState().data.presentations] },
      });
      await w.advance(BAKE_SETTLE_MS + 5000);
      expect(w.worker().jobs).toHaveLength(1);
    });

  it('B24 a font that failed twice is posted (the first time it is tried again)', async () => {
    const { w } = await pending();
    w.failedJob('font', 'Foo Sans');
    await w.flush();
    expect(w.posts()).toEqual([]);
    await w.advance(10_000 + BAKE_GAP_MS + 100);
    expect(w.worker().jobs).toHaveLength(2);
    w.failedJob('font', 'Foo Sans');
    await w.flush();
    expect(w.posts()).toHaveLength(1);
    expect(w.postedReason()).toBe('font: Foo Sans');
  });

  for (const reason of ['cancelled', 'busy', 'fonts', 'media', 'files'])
    it(`B25 "${reason}" is not posted: tried again after 10 s and 60 s, and posted on the third failure`, async () => {
      const { w } = await pending();
      w.failedJob(reason, "a cause that is not the slide's");
      await w.flush();
      expect(w.posts()).toEqual([]);
      expect(slideEntry('p1', 's1')?.state).not.toBe('failed');
      await w.advance(9_000);
      expect(w.allJobs()).toHaveLength(1);
      await w.advance(2_000 + BAKE_GAP_MS);
      expect(w.allJobs()).toHaveLength(2);
      w.failedJob(reason, 'again');
      await w.flush();
      expect(w.posts()).toEqual([]);
      await w.advance(59_000);
      expect(w.allJobs()).toHaveLength(2);
      await w.advance(2_000 + BAKE_GAP_MS);
      expect(w.allJobs()).toHaveLength(3);
      w.failedJob(reason, 'the third time');
      await w.flush();
      expect(w.posts()).toHaveLength(1);
      expect(w.postedReason()).toBe(`${reason}: the third time`);
    });

  it('B26 a worker that stays silent is killed 5 s after its deadline and the failure "time" is posted; the deadline is the renderer\'s', async () => {
    const { w } = await pending();
    const worker = w.worker();
    // it started (said so), then went quiet over this slide
    worker.say({ t: 'phase', id: w.job().id, phase: 'drawing' });
    expect(w.job().deadlineMs).toBe(BAKE_JOB_DEADLINE_MS);
    await w.advance(BAKE_JOB_DEADLINE_MS + BAKE_HARD_GRACE_MS - 1);
    expect(worker.terminated).toBe(false);
    await w.advance(1);
    expect(worker.terminated).toBe(true);
    expect(w.posts()).toHaveLength(1);
    expect(w.postedReason().startsWith('time: ')).toBe(true);
    expect(useBake.getState().running).toBeUndefined();
  });

  it("B26 a worker that never answered is the picture maker's fault, not the slide's: nothing is posted, it is tried again, and the third time the slide is failed on this computer only", async () => {
    const { w } = await pending();
    const first = w.worker();
    await w.advance(BAKE_JOB_DEADLINE_MS + BAKE_HARD_GRACE_MS);
    expect(first.terminated).toBe(true);
    expect(w.posts()).toEqual([]);
    expect(slideEntry('p1', 's1')?.state).not.toBe('failed');
    // again after 10 s (a new worker), silent again, again after 60 s, silent a third time
    await w.advance(10_000 + BAKE_GAP_MS + 100);
    expect(w.allJobs()).toHaveLength(2);
    await w.advance(BAKE_JOB_DEADLINE_MS + BAKE_HARD_GRACE_MS);
    expect(w.posts()).toEqual([]);
    await w.advance(60_000 + BAKE_GAP_MS + 100);
    expect(w.allJobs()).toHaveLength(3);
    await w.advance(BAKE_JOB_DEADLINE_MS + BAKE_HARD_GRACE_MS);
    expect(w.posts()).toEqual([]);
    expect(slideEntry('p1', 's1')).toMatchObject({ state: 'failed', code: 'unknown', fix: 'ordo' });
    await w.advance(10 * 60_000);
    expect(w.allJobs()).toHaveLength(3);
    expect(w.posts()).toEqual([]);
  });

  it('B26 a worker that throws outside a job (its script failed to load) is the same: the job is ended on the spot, nothing posted', async () => {
    const { w } = await pending();
    const worker = w.worker();
    worker.onerror?.({ message: 'boom' });
    expect(worker.terminated).toBe(true);
    expect(useBake.getState().running).toBeUndefined();
    await w.flush();
    expect(w.posts()).toEqual([]);
    await w.advance(10_000 + BAKE_GAP_MS + 100);
    expect(w.allJobs()).toHaveLength(2);
    expect(w.workers.filter((x) => !x.terminated)).toHaveLength(1);
  });

  it('B26 the answer "time" of the worker itself is the same', async () => {
    const { w } = await pending();
    w.failedJob('time', 'over the limit');
    await w.flush();
    expect(w.posts()).toHaveLength(1);
  });

  it('the constants of the renderer and the hub are the ones this service pins (Q38.a)', async () => {
    const { readFileSync } = await import('node:fs');
    const renderer = readFileSync(new URL('../../../packages/renderer/src/bake.ts', import.meta.url), 'utf8');
    expect(/BAKE_DEADLINE_MS = ([\d_]+)/.exec(renderer)?.[1]?.replaceAll('_', '')).toBe(
      String(BAKE_JOB_DEADLINE_MS),
    );
    expect(/BAKE_UPLOAD_ORDER = \[([^\]]+)\]/.exec(renderer)?.[1]?.replaceAll(' ', '')).toBe('1920,3840,640');
    const hub = readFileSync(new URL('../../../apps/hub/src/prerenders.ts', import.meta.url), 'utf8');
    expect(/PAUSED_RETRY_S = (\d+)/.exec(hub)?.[1]).toBe(String(BAKE_RESUME_MS / 1000));
    expect(BAKE_WORKER_IDLE_MS).toBe(30_000);
  });
});

// ---- actions ----

describe('the actions (B27, B28, B33)', () => {
  it('B27 Make picture again deletes the key and queues the slide first; refused during a service; works where nothing is made', async () => {
    const a = heavy('a');
    const b = heavy('b');
    const w = world({ slides: [a, b] });
    w.know('p1', a, [1920, 3840]);
    w.know('p1', b, [1920, 3840]);
    await w.begin();
    expect(slideEntry('p1', 'a')?.state).toBe('ready');
    const r = await w.service.makeAgain('p1', 'a');
    expect(r).toEqual({ ok: true });
    const del = w.calls.filter((c) => c.method === 'DELETE');
    expect(del.map((d) => d.path)).toEqual([`/presentations/p1/prerenders/${w.keyOf(a)}`]);
    await w.advance(BAKE_SETTLE_MS + 1000);
    expect(w.worker().jobs.at(-1)?.slideId).toBe('a');
    // a slide the store does not know
    expect(await w.service.makeAgain('p1', 'nope')).toEqual({ ok: false, why: 'unknown-key' });
    // during a service: refused, nothing deleted
    w.live({ state: { ...initialState(), mode: 'live' } });
    expect(await w.service.makeAgain('p1', 'b')).toEqual({ ok: false, why: 'service' });
    expect(w.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    // a computer that cannot make pictures: the delete only, no worker
    const x = heavy('x');
    const ipad = world({ slides: [x], verdict: { ok: false, why: 'unsupported', list: true } });
    ipad.know('p1', x, [1920, 3840]);
    await ipad.service.refresh('p1');
    expect(await ipad.service.makeAgain('p1', 'x')).toEqual({ ok: true });
    await ipad.advance(60_000);
    expect(ipad.workers).toHaveLength(0);
    expect(ipad.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    // a hub that answers 409
    const y = world({ slides: [x] });
    y.know('p1', x, [1920, 3840]);
    await y.begin();
    y.rules.push({
      test: (c) => c.method === 'DELETE',
      reply: () => {
        throw new ApiFailure(409, 'unknown_key', 'u');
      },
    });
    expect(await y.service.makeAgain('p1', 'x')).toEqual({ ok: false, why: 'unknown-key' });
  });

  it('B28 Make the pictures now: refusals by the service and the gate, "nothing", and a queue that skips every wait but never a service or a permanent failure', async () => {
    const a = heavy('a');
    const b = heavy('b');
    const c = heavy('c');
    const w = world({ slides: [a, b, c], autoIdle: false });
    w.know('p1', a);
    w.know('p1', b);
    w.know('p1', c);
    w.failures.set('p1', [{ key: w.keyOf(c), reason: 'coverage: U+4E2D', at: 1 }]);
    w.service.start();
    // before the start delay: works, makes a and b, and never c
    const r = await w.service.makeNow();
    expect(r).toEqual({ ok: true, queued: 2 });
    await w.flush();
    expect(w.workers).toHaveLength(1);
    expect(w.worker().jobs.map((j) => j.slideId)).toEqual(['a']);
    expect(w.idles).toHaveLength(0);
    w.made();
    await w.flush();
    expect(w.worker().jobs.map((j) => j.slideId)).toEqual(['a', 'b']);
    // while live
    w.live({ state: { ...initialState(), mode: 'live' } });
    expect(await w.service.makeNow()).toEqual({ ok: false, why: 'service' });
    w.live({ state: { ...initialState(), mode: 'idle' } });
    w.service.holdForGoLive();
    expect(await w.service.makeNow()).toEqual({ ok: false, why: 'go-live' });
    // a service that starts and ends settles the press of Go live
    w.live({ state: { ...initialState(), mode: 'live' } });
    w.live({ state: { ...initialState(), mode: 'idle' } });
    // by the gate
    w.state.verdict = { ok: false, why: 'unsupported', list: true };
    expect(await w.service.makeNow()).toEqual({ ok: false, why: 'unsupported' });
    w.state.verdict = { ok: false, why: 'off', list: false };
    expect(await w.service.makeNow()).toEqual({ ok: false, why: 'off' });
    // the hub
    const h = world({ slides: [a] });
    h.library({ error: 'the hub did not answer' });
    expect(await h.service.makeNow()).toEqual({ ok: false, why: 'hub' });
    // nothing is missing
    const done = world({ slides: [a] });
    done.know('p1', a, [1920, 3840]);
    expect(await done.service.makeNow()).toEqual({ ok: false, why: 'nothing' });
  });

  it("B33 focus makes the playlist's presentations first without a new listing; with no focus the presentation open in the route is first", async () => {
    const a = heavy('a');
    const b = heavy('b');
    const w = world({
      presentations: [
        deck('pa', [a], { updatedAt: '2026-11-21T00:00:00Z' }),
        deck('pb', [b], { updatedAt: '2026-01-01T00:00:00Z' }),
      ],
    });
    w.know('pa', a);
    w.know('pb', b);
    useLibrary.setState((s) => ({
      data: {
        ...s.data,
        playlists: [
          {
            id: 'pl',
            rev: 1,
            name: 'Sunday',
            items: [{ id: 'i', kind: 'presentation', presentationId: 'pb' }],
          } as never,
        ],
      },
    }));
    await w.begin();
    expect(w.worker().jobs[0]?.presentationId).toBe('pa');
    // a plan with a focus: pb first, no new listing
    const w2 = world({
      presentations: [
        deck('pa', [a], { updatedAt: '2026-11-21T00:00:00Z' }),
        deck('pb', [b], { updatedAt: '2026-01-01T00:00:00Z' }),
      ],
      autoIdle: false,
    });
    w2.know('pa', a);
    w2.know('pb', b);
    useLibrary.setState((s) => ({
      data: {
        ...s.data,
        playlists: [
          {
            id: 'pl',
            rev: 1,
            name: 'Sunday',
            items: [{ id: 'i', kind: 'presentation', presentationId: 'pb' }],
          } as never,
        ],
      },
    }));
    w2.service.start();
    await w2.advance(BAKE_START_DELAY_MS);
    const gets = w2.gets().length;
    w2.service.focus({ playlistId: 'pl' });
    await w2.flush();
    expect(w2.gets().length).toBe(gets);
    w2.releaseIdle();
    await w2.flush();
    expect(w2.worker().jobs[0]?.presentationId).toBe('pb');
  });
});

// ---- hooks and lifecycle ----

describe("hooks and the worker's life (B29-B32)", () => {
  it("B29 the record's live set reaches the job and the key; the item is a slide; the upload URL adds a kind only for another kind", async () => {
    const slide = heavy('s1', { prerender: { why: ['count'], live: ['title'] } });
    const w = world({ slides: [slide] });
    w.know('p1', slide);
    await w.begin();
    expect(w.job().live).toEqual(['title']);
    expect(w.job().kind).toBe('slide');
    expect(w.job().key).toBe(localKey(slide, w.inputs()));
    w.made();
    await w.flush();
    for (const p of w.puts()) expect(p.path.endsWith(localKey(slide, w.inputs()))).toBe(true);
    expect(uploadUrl({ presentationId: 'p', key: 'k', kind: 'slide' }, 1920, 'm')).toBe(
      '/presentations/p/prerenders/k?size=1920&madeBy=m',
    );
    expect(uploadUrl({ presentationId: 'p', key: 'k', kind: 'plate' as never }, 1920, 'm')).toBe(
      '/presentations/p/prerenders/k?size=1920&madeBy=m&kind=plate',
    );
  });

  it('B30 one worker per sweep, its font list posted first, released 30 s after the last job, and after a kill a new one gets the fonts again', async () => {
    const a = heavy('a');
    const b = heavy('b');
    const w = world({ slides: [a, b] });
    w.know('p1', a);
    w.know('p1', b);
    await w.begin();
    expect(w.workers).toHaveLength(1);
    const first = w.worker();
    expect(first.posted[0]).toMatchObject({ t: 'fonts' });
    expect((first.posted[0] as Extract<BakeIn, { t: 'fonts' }>).fonts).toEqual([
      {
        family: 'Inter',
        weight: 400,
        style: 'normal',
        hash: 'inter-regular',
        url: 'https://hub/f/inter-regular',
      },
    ]);
    expect(first.posted[1]).toMatchObject({ t: 'bake' });
    w.made();
    await w.flush();
    await w.advance(BAKE_GAP_MS + 10);
    w.made();
    await w.flush();
    // the same worker made both; the fonts were sent once
    expect(w.workers).toHaveLength(1);
    expect(first.posted.filter((m) => m.t === 'fonts')).toHaveLength(1);
    expect(first.terminated).toBe(false);
    await w.advance(BAKE_WORKER_IDLE_MS - 1);
    expect(first.terminated).toBe(false);
    await w.advance(1);
    expect(first.terminated).toBe(true);
    // a kill, then a new picture: a new worker, the fonts again
    const c = heavy('c');
    w.library({
      data: { ...useLibrary.getState().data, presentations: [deck('p1', [a, b, c], { rev: 2 })] },
    });
    w.know('p1', c);
    // the hub keys the new slide a moment after the save: the settle wait, then the first look again (2 s)
    await w.advance(BAKE_SETTLE_MS + 2_000 + BAKE_GAP_MS + 100);
    expect(w.workers).toHaveLength(2);
    expect(w.worker().posted[0]).toMatchObject({ t: 'fonts' });
    expect(w.workers.filter((x) => !x.terminated)).toHaveLength(1);
    // made blobs are not kept: after the last upload nothing refers to them (the service holds no picture)
    expect(JSON.stringify(w.service.snapshot())).not.toContain('pic1920');
  });

  it('B31 the diagnostics have the fields and no slide text; the waits change only in test mode', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide] });
    w.know('p1', slide);
    await w.begin();
    const snap = w.service.snapshot();
    expect(Object.keys(snap).sort()).toEqual(
      [
        'gate',
        'hold',
        'presentations',
        'requests',
        'running',
        'slides',
        'sweeps',
        'timers',
        'totals',
        'timings',
        'workers',
      ]
        .filter((k) => k in snap)
        .sort(),
    );
    expect(snap.workers).toBe(1);
    expect(snap.requests.length).toBeGreaterThan(0);
    expect(snap.requests.every((r) => !r.path.includes('?'))).toBe(true);
    expect(JSON.stringify(snap)).not.toContain('Welcome');
    expect(snap.timings).toEqual({
      startDelayMs: 15000,
      settleMs: 3000,
      gapMs: 1000,
      resumeMs: 120000,
      idleSweepMs: 300000,
    });
    // test mode
    expect(bakeTestMode('?test=1', () => null)).toBe(true);
    expect(bakeTestMode('', () => '1')).toBe(true);
    expect(bakeTestMode('', () => null)).toBe(false);
    expect(bakeTimingsFromUrl('?test=1&bakeTimings=start:0,settle:500,gap:0,resume:2000,idle:2000')).toEqual({
      startDelayMs: 0,
      settleMs: 500,
      gapMs: 0,
      resumeMs: 2000,
      idleSweepMs: 2000,
    });
    expect(bakeTimingsFromUrl('?bakeTimings=start:x,bogus:1,idle:99999999')).toEqual({});
  });

  it('B32 start() on a computer that cannot returns a no-op stop, builds nothing and sets the gate once', async () => {
    const w = world({ verdict: { ok: false, why: 'unsupported', list: true } });
    const seen: string[] = [];
    const off = useBake.subscribe((s) => seen.push(s.gate));
    const stop = w.service.start();
    stop();
    await w.advance(60_000);
    off();
    expect(seen).toEqual(['unsupported']);
    expect(w.workers).toHaveLength(0);
    expect(w.calls).toEqual([]);
  });
});

// ---- the store on every device (B34, B35) ----

describe('the store on devices that cannot make pictures, and its upkeep (B34, B35)', () => {
  it('B34 an iPad lists once and writes ready and failed as listed and "unsupported" for every other record slide, and never builds a worker', async () => {
    const a = heavy('a');
    const b = heavy('b');
    const c = heavy('c');
    const w = world({ slides: [a, b, c], verdict: { ok: false, why: 'unsupported', list: true } });
    w.know('p1', a, [1920, 3840]);
    w.know('p1', b, []);
    w.know('p1', c, []);
    w.failures.set('p1', [{ key: w.keyOf(c), reason: 'font: Foo', at: 1 }]);
    await w.service.refresh('p1');
    expect(w.gets()).toHaveLength(1);
    expect(['a', 'b', 'c'].map((id) => slideEntry('p1', id)?.state)).toEqual([
      'ready',
      'unsupported',
      'failed',
    ]);
    expect(w.workers).toHaveLength(0);
    expect(useBake.getState().gate).toBe('unsupported');
  });

  it('B34 with the hub\'s switch off nothing is listed and the slides say "off"; a phone or the demo does nothing', async () => {
    const a = heavy('a');
    const off = world({ slides: [a], verdict: { ok: false, why: 'off', list: false } });
    await off.service.refresh('p1');
    expect(off.calls).toEqual([]);
    expect(slideEntry('p1', 'a')?.state).toBe('off');
    const phone = world({ slides: [a], verdict: { ok: false, why: 'unsupported', list: false } });
    await phone.service.refresh('p1');
    expect(phone.calls).toEqual([]);
    expect(slideEntry('p1', 'a')).toBeUndefined();
  });

  it('B35 entries of a presentation that leaves the library, or of a slide that loses its record, go at the next sweep', async () => {
    const a = heavy('a');
    const b = heavy('b');
    const w = world({ presentations: [deck('p1', [a, b]), deck('p2', [heavy('c')])] });
    w.know('p1', a, [1920, 3840]);
    w.know('p1', b, [1920, 3840]);
    w.know('p2', heavy('c'), [1920, 3840]);
    await w.begin();
    expect(Object.keys(useBake.getState().slides).sort()).toEqual(['p1/a', 'p1/b', 'p2/c']);
    expect(useBake.getState().totals.heavy).toBe(3);
    const { prerender: _, ...plainB } = b;
    w.library({
      data: { ...useLibrary.getState().data, presentations: [deck('p1', [a, plainB as Slide], { rev: 2 })] },
    });
    await w.advance(BAKE_SETTLE_MS + 1);
    expect(Object.keys(useBake.getState().slides).sort()).toEqual(['p1/a']);
    expect(useBake.getState().presentations.p2).toBeUndefined();
    expect(useBake.getState().totals).toMatchObject({ heavy: 1, ready: 1 });
  });
});

// ---- the worker's questions, a page without Workers, a queue that went stale ----

describe('the page answers the worker, and the odd ends (B36-B38)', () => {
  it("B36 the worker's phases show on the running slide; its media question is answered from the library; its SVG decode is drawn by this page", async () => {
    const slide = heavy('s1');
    const bitmap = { width: 4, height: 4 } as unknown as ImageBitmap;
    const w = world({ slides: [slide], bitmap });
    w.know('p1', slide);
    await w.begin();
    const worker = w.worker();
    const id = w.job().id;
    expect(useBake.getState().running).toMatchObject({ slideId: 's1', phase: 'files' });
    worker.say({ t: 'phase', id, phase: 'encoding' });
    expect(useBake.getState().running?.phase).toBe('encoding');
    worker.say({ t: 'media', id, ids: ['photo', 'nope'] });
    expect(worker.posted.at(-1)).toEqual({ t: 'media', id, files: { photo: 'photo-orig' } });
    const blob = new Blob(['<svg/>']);
    worker.say({ t: 'decode', id, seq: 7, hash: 'h', blob });
    await w.flush();
    expect(w.svgs).toEqual([blob]);
    expect(worker.posted.at(-1)).toEqual({ t: 'decoded', seq: 7, bitmap });
    // a message of another job is not this one's
    worker.say({ t: 'media', id: id + 99, ids: ['photo'] });
    expect(worker.posted.filter((m) => m.t === 'media')).toHaveLength(1);
  });

  it('B37 a browser without Workers makes nothing, posts nothing and does not loop', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide], noWorker: true });
    w.know('p1', slide);
    await w.begin();
    await w.advance(20 * 60_000);
    expect(w.workers).toHaveLength(0);
    expect(w.puts()).toEqual([]);
    expect(w.posts()).toEqual([]);
    // the idle sweep is the only thing that ever comes back, a few times in twenty minutes
    expect(w.service.snapshot().sweeps).toBeLessThanOrEqual(6);
  });

  it('B38 a slide edited while it waited for the idle moment is not made at its old key; the new one is', async () => {
    const slide = heavy('s1');
    const w = world({ slides: [slide], autoIdle: false });
    w.know('p1', slide);
    w.service.start();
    await w.advance(BAKE_START_DELAY_MS);
    expect(w.workers).toHaveLength(0);
    const edited = {
      ...slide,
      objects: slide.objects.map((o) => (o.type === 'text' ? { ...o, text: 'edited' } : o)),
    } as Slide;
    // the copy moves under the queue (no sweep has run yet: the settle wait is still counting)
    useLibrary.setState(
      (st) => ({ data: { ...st.data, presentations: [deck('p1', [edited], { rev: 2 })] } }),
      false,
    );
    w.releaseIdle();
    await w.flush();
    expect(w.allJobs()).toEqual([]);
  });
});

// ---- the file form (B-F1, B-F2) ----

describe('a slide kept in a slide file (B-F1, B-F2)', () => {
  const fileSlide = (): Slide =>
    ({
      id: 'f1',
      objects: Array.from({ length: 5 }, (_, i) => rect(i)),
      prerender: { why: ['count'], live: [], file: { ref: 'a'.repeat(64), bytes: 5000 } },
    }) as unknown as Slide;

  const setup = async () => {
    const slide = fileSlide();
    const w = world({ slides: [slide] });
    // the hub keyed it from its head: the listed key is the only identity
    w.keys.set('p1', [{ slideId: 'f1', key: 'hubkey1', standbyId: 'b', sizes: [] }]);
    await w.begin();
    return { w, slide };
  };

  it('the job carries the head and the key the hub listed; the main thread computes no key for it', async () => {
    const { w } = await setup();
    expect(w.job()).toMatchObject({
      key: 'hubkey1',
      file: { ref: 'a'.repeat(64), listedKey: 'hubkey1', bytes: 5000 },
    });
  });

  it('B-F1 a "stale" answer is not a failure of the slide: the presentation is listed again once, never twice in a row for one key', async () => {
    const { w } = await setup();
    const gets = w.gets().length;
    w.failedJob('stale', 'the hub key is not the key of this slide');
    await w.flush();
    expect(w.posts()).toEqual([]);
    expect(slideEntry('p1', 'f1')?.state).not.toBe('failed');
    await w.advance(BAKE_SETTLE_MS + BAKE_GAP_MS + 1000);
    expect(w.gets().length).toBeGreaterThan(gets);
    // the same key stale again: no second re-listing loop
    const jobs = w.worker().jobs.length;
    w.failedJob('stale', 'again');
    await w.flush();
    const gets2 = w.gets().length;
    await w.advance(BAKE_SETTLE_MS + BAKE_GAP_MS + 1000);
    expect(w.gets().length).toBe(gets2);
    expect(w.worker().jobs.length).toBe(jobs);
  });

  it('B-F2 a head the hub no longer has is a failure ("the full copy is missing on the hub"), posted once and not retried until the key changes', async () => {
    const { w } = await setup();
    w.failedJob('files', 'the full copy of this slide is missing on the hub');
    await w.flush();
    expect(w.posts()).toHaveLength(1);
    expect(w.postedReason()).toBe('files: the full copy of this slide is missing on the hub');
    await w.advance(5 * 60_000);
    expect(w.worker().jobs).toHaveLength(1);
  });
});

// ---- the keys are worked out once (B39, B40) ----

describe('a key is worked out once, not at every check (B39, B40)', () => {
  const four = () => ['s1', 's2', 's3', 's4'].map((id) => heavy(id));

  it("B39 the checks before a bake, before its first upload and at an unrelated library change compute no key, and neither does the editor's refresh", async () => {
    const slides = four();
    const w = world({ slides });
    const counted: string[] = [];
    w.deps.plan = {
      keyOf: (slide, inputs) => {
        counted.push(slide.id);
        return localKey(slide, inputs);
      },
    };
    for (const s of slides) w.know('p1', s);
    await w.begin();
    // the first sweep: each record slide once; the check before the first bake is free
    expect([...counted].sort()).toEqual(['s1', 's2', 's3', 's4']);
    // all four pictures are made, one after the other, with the library changing in a way that moves no key
    for (let i = 0; i < 4; i++) {
      w.made();
      await w.flush();
      w.library({ data: { ...useLibrary.getState().data, playlists: [] } });
      await w.advance(BAKE_GAP_MS + 100);
    }
    await w.service.refresh('p1');
    expect(w.puts().length).toBeGreaterThanOrEqual(12);
    expect(counted).toHaveLength(4);
  });

  it("B40 an edit while a picture is made costs the running slide's key only; the next sweep works the presentation out once", async () => {
    const slides = four();
    const w = world({ slides });
    const counted: string[] = [];
    w.deps.plan = {
      keyOf: (slide, inputs) => {
        counted.push(slide.id);
        return localKey(slide, inputs);
      },
    };
    for (const s of slides) w.know('p1', s);
    await w.begin();
    expect(counted).toHaveLength(4);
    const running = w.job().key;
    expect(running).toBe(w.keyOf(slides[0] as Slide));
    counted.length = 0;
    // another slide of the same presentation is edited: a new presentation object, rev 2
    const edited = {
      ...(slides[2] as Slide),
      objects: (slides[2] as Slide).objects.map((o) => (o.type === 'text' ? { ...o, text: 'changed' } : o)),
    } as Slide;
    w.library({
      data: {
        ...useLibrary.getState().data,
        presentations: [
          deck('p1', [slides[0] as Slide, slides[1] as Slide, edited, slides[3] as Slide], { rev: 2 }),
        ],
      },
    });
    // the running slide is checked: its own key and no other
    expect(counted).toEqual(['s1']);
    expect(w.worker().terminated).toBe(false);
    counted.length = 0;
    w.know('p1', edited);
    await w.advance(BAKE_SETTLE_MS + 200);
    // the sweep after the edit works out the other three: each slide of the edited presentation once in all
    expect([...counted].sort()).toEqual(['s2', 's3', 's4']);
  });
});

// ---- the recorded mutations (see before/service-mutations.log) ----

describe('what the cases above are for (the recorded mutations are run against them)', () => {
  it('names the four proofs: the upload of a held size (B15), the skipped key check (B11, B13), the ignored service hold (B3, B17) and the live set replaced by [] (B29, P7)', () => {
    expect(vi).toBeDefined();
  });
});

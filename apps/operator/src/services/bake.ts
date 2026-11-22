import { ApiFailure, api, fileUrl } from '@ordo/client';
import type { Font, LiveState, Media, Playlist, Presentation } from '@ordo/domain';
import { APP_VERSION } from '@ordo/protocol';
import type { BakeVerdict } from '../lib/capabilities.ts';
import { parseRoute } from '../lib/route.ts';
import {
  type BakeCode,
  type BakeFocus,
  type BakeGate,
  type BakeHold,
  bakeId,
  describeFailure,
  dropPresentation,
  type MakeAgain,
  type MakeNow,
  reasonFor,
  type SlideBake,
  setGate,
  setHold,
  setPresentation,
  setRunning,
  setSlides,
  useBake,
} from '../state/bake.ts';
import { useLibrary } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import { currentRole } from '../state/session.ts';
import type { BakeIn, BakeJobIn, BakeOut } from '../workers/bakeJob.ts';
import {
  BAKE_ATTEMPTS,
  BAKE_DISK_HOLD_MS,
  BAKE_GO_LIVE_HOLD_MAX_MS,
  BAKE_HARD_GRACE_MS,
  BAKE_HUB_HOLD_MS,
  BAKE_IDLE_SWEEP_MS,
  BAKE_JOB_DEADLINE_MS,
  BAKE_LISTING_FRESH_MS,
  BAKE_PAUSED_MAX_MS,
  BAKE_RESUME_MS,
  BAKE_SETTLE_MS,
  BAKE_STAND_INS,
  BAKE_START_DELAY_MS,
  BAKE_GAP_MS,
  BAKE_UPLOAD_ORDER,
  BAKE_WORKER_IDLE_MS,
} from './bakeConsts.ts';
import {
  type BakeItem,
  type Listing,
  type PlanCache,
  type PlanDeps,
  type PlanInput,
  cachedSlides,
  planSweepSteps,
  retryDelay,
  type SweepPlan,
  slideInputs,
  wantedItems,
} from './bakePlan.ts';
import { realGate } from './bakeGate.ts';
import { type BakeTimings, bakeTestMode, bakeTimingsFromUrl } from './bakeTest.ts';
import { log } from './log.ts';

export * from './bakeConsts.ts';
export { type BakeTimings, bakeTestMode, bakeTimingsFromUrl };

/**
 * The bake service (design/29 section 1.4, "As built in sub-wave 3 (bake-worker)"): a desktop computer with ordo open
 * makes the missing pictures of heavy slides, quietly, one at a time, never during a service, and uploads only what
 * it proved complete. It is the glue around three pieces that are tested on their own: the plan
 * (services/bakePlan.ts: what is wanted, from the library and the hub's listing), the worker
 * (workers/bakeJob.ts: one picture of one slide with the renderer's own bake) and the status store
 * (state/bake.ts: what the editor and the Go-live check read).
 *
 * THE RULES THAT DECIDE (each has cases in apps/operator/test/bakeService.test.ts):
 * - NEVER DURING A SERVICE: the holds are read from the main-thread stores (`mode`, `held`, `authority`,
 *   `goLivePrepare`) and from the press of Go live (`holdForGoLive`, the Controller's first line); a running bake's
 *   worker is TERMINATED, not asked, and nothing is uploaded or posted. The hub refuses the uploads too (503).
 * - NEVER A PICTURE FOR A KEY THE HUB DOES NOT LIST, or that is no longer the slide's: the local key is looked up in
 *   the hub's listing (equal keys prove the same slide, media and faces); before each bake and before the first
 *   upload the slide is read again from the library and its key recomputed (the listing names the keys of every
 *   kept revision, so an old key is "known").
 * - COMPLETE OR NOTHING AND NEVER A REPLACE: only the blobs of a made picture are uploaded, only the sizes the
 *   listing lacks, 1920 first; a failure of the slide is posted once, a cause that is not the slide's (the network,
 *   a service, a Go live, an edit, the hub's budget or disk) is never posted.
 * - NO POLLING: every timer has a trigger and a bound; a library with nothing pending arms none.
 *
 * Everything the service reaches is a dependency (`BakeServiceDeps`), so the node tests drive it with a scripted
 * hub, fake workers and a fake clock; the real ones are built at the end of this file (`bake`).
 */

// ---- dependencies ----

/** The worker as the service uses it (`FakeWorker` in the tests). */
export type BakeWorkerLike = {
  postMessage(m: BakeIn): void;
  terminate(): void;
  onmessage: ((ev: { data: BakeOut }) => void) | null;
  /** The worker's script failed to load or threw outside a job: the picture maker, not the slide, is at fault. */
  onerror: ((ev: unknown) => void) | null;
};

type StoreLike<T> = { getState(): T; subscribe(fn: (state: T, prev: T) => void): () => void };

export type BakeLiveSlice = {
  state: Pick<LiveState, 'mode'>;
  held: boolean;
  authority: string;
  hubConnected: boolean;
  goLivePrepare?: unknown;
};
export type BakeLibrarySlice = {
  data: { presentations: Presentation[]; playlists: Playlist[]; media: Media[]; fonts: Font[] };
  loaded: boolean;
  source: 'none' | 'cache' | 'hub';
  /** The core's last failure to read the hub's library (cleared by the next good read). */
  error?: string;
};

/**
 * Whether the library on this page is one the service may plan from: it has loaded and the hub's last read did not
 * fail. The page's `source` is NOT asked: it is the first message's only (the IndexedDB copy of a reloaded page is
 * `'cache'`, and the hub's own snapshot after it reaches the page as a patch that leaves it so, for ever), and the
 * hub's listing is the arbiter in any case (a picture is made only for a key the hub lists, and a copy that moves
 * under a bake drops it).
 */
const libraryUsable = (s: Pick<BakeLibrarySlice, 'loaded' | 'error'>): boolean => s.loaded && !s.error;

export type BakeServiceDeps = {
  api(
    path: string,
    init?: { method?: string; body?: Blob; json?: unknown; headers?: Record<string, string> },
  ): Promise<unknown>;
  createWorker(): BakeWorkerLike | undefined;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  /** Resolves when the computer has been idle for a moment (`requestIdleCallback`). */
  idle(): Promise<void>;
  /** Lets the event loop run between slices of the plan. */
  yieldTask(): Promise<void>;
  random(): number;
  /** `canBake` of the real environment, now. */
  gate(): BakeVerdict;
  stores: { live: StoreLike<BakeLiveSlice>; library: StoreLike<BakeLibrarySlice> };
  /** The presentation open in the route. */
  openId(): string | undefined;
  /** Who made the picture, as the hub records it (the role is known late, so read at each use). */
  madeBy(): string;
  /** The absolute URL a worker fetches a font file from. */
  fontUrl(hash: string): string;
  /** An SVG drawn by this page for the worker. */
  drawSvg(blob: Blob): Promise<ImageBitmap | undefined>;
  log(level: 'info' | 'warn' | 'error', text: string): void;
  /** Overrides of the waits (`?test=1`). */
  timings?: Partial<BakeTimings>;
  /** The plan's own functions, replaced in tests. */
  plan?: PlanDeps;
};

type StoreSnapshot = ReturnType<typeof useBake.getState>;
export type BakeSnapshot = {
  gate: BakeGate;
  hold?: BakeHold;
  running?: StoreSnapshot['running'];
  totals: StoreSnapshot['totals'];
  slides: StoreSnapshot['slides'];
  presentations: StoreSnapshot['presentations'];
  /** Workers alive (at most one). */
  workers: number;
  /** Timers armed (none for a library with nothing pending). */
  timers: number;
  timings: BakeTimings;
  sweeps: number;
  /** The last 20 hub calls the service made. */
  requests: { method: string; path: string; status: number }[];
  /** The last picture made: the worker's milliseconds by phase, the bytes by size, the stand-in faces; never the bytes. */
  lastMade?: {
    ms: Record<string, number>;
    pictures: { size: number; type: string; bytes: number }[];
    opaque: boolean;
    standIns: number;
  };
};

export type BakeService = {
  start(): () => void;
  refresh(presentationId: string, options?: { force?: boolean }): Promise<void>;
  makeNow: MakeNow;
  makeAgain: MakeAgain;
  focus(focus: BakeFocus): void;
  holdForGoLive(): void;
  snapshot(): BakeSnapshot;
  /** In test mode the waits may be changed later. */
  readonly timings: BakeTimings;
};

/** The URL of a picture's upload: `&kind=` only for a kind other than a slide's (H-W5: a plate adds one). */
export function uploadUrl(
  item: Pick<BakeItem, 'presentationId' | 'key' | 'kind'>,
  size: number,
  madeBy: string,
): string {
  const kind = item.kind === 'slide' ? '' : `&kind=${encodeURIComponent(item.kind)}`;
  return `/presentations/${encodeURIComponent(item.presentationId)}/prerenders/${encodeURIComponent(item.key)}?size=${size}&madeBy=${encodeURIComponent(madeBy)}${kind}`;
}

/** The reasons that are the slide's own and are posted at once: the next computer would only repeat them (D9). */
const PERMANENT = new Set([
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
]);
/** A cause that is not the slide's: tried again after a pause, posted on the third failure (D9). A `font` is tried twice. */
const TRANSIENT = new Set(['cancelled', 'busy', 'fonts', 'media', 'files', 'font']);

type Active = {
  seq: number;
  item: BakeItem;
  worker: BakeWorkerLike;
  startedAt: number;
  hard?: unknown;
  /** The worker has answered this job at least once (a worker that never did is not the slide's fault). */
  heard: boolean;
  /** Set when the job is over for a reason that posts nothing (a service, a Go live, an edit, the hub). */
  dropped: boolean;
  done: () => void;
};

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export function createBakeService(deps: BakeServiceDeps): BakeService {
  const timings: BakeTimings = {
    startDelayMs: BAKE_START_DELAY_MS,
    settleMs: BAKE_SETTLE_MS,
    gapMs: BAKE_GAP_MS,
    resumeMs: BAKE_RESUME_MS,
    idleSweepMs: BAKE_IDLE_SWEEP_MS,
    ...deps.timings,
  };
  const timersArmed = new Set<unknown>();
  const setTimer = (fn: () => void, ms: number): unknown => {
    const t: unknown = deps.setTimer(() => {
      timersArmed.delete(t);
      fn();
    }, ms);
    timersArmed.add(t);
    return t;
  };
  const clearTimer = (t: unknown): void => {
    timersArmed.delete(t);
    deps.clearTimer(t);
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimer(resolve, ms));

  let started = false;
  let stopped = false;
  let offStores: (() => void)[] = [];
  let firstSweepAt = 0;
  let wasService = false;
  let resumeAt = 0;
  let diskUntil = 0;
  let pausedUntil = 0;
  let goLiveUntil = 0;
  let hubUntil = 0;
  let sweeps = 0;
  let sweeping = false;
  let sweepAgain = false;
  let pumping = false;
  let jobSeq = 0;
  let active: Active | undefined;
  let worker: BakeWorkerLike | undefined;
  let workerIdle: unknown;
  let postedFonts: readonly Font[] | undefined;
  let queue: BakeItem[] = [];
  let planned: SweepPlan | undefined;
  let plannedFonts: readonly Font[] = [];
  let focused: BakeFocus;
  let playlists: readonly Playlist[] = [];
  let frontKey: string | undefined;
  let wake: unknown;
  const wakes = new Map<string, number>();
  const listings = new Map<string, { at: number; listing: Listing }>();
  const cache: PlanCache = new Map();
  const unknownTries = new Map<string, number>();
  const unknownDue = new Map<string, number>();
  const unknownGaveUp = new Set<string>();
  const transient = new Map<string, { tries: number; due: number }>();
  const localFailed = new Map<string, SlideBake>();
  const staleOnce = new Set<string>();
  const budgetSkip = new Map<string, number>();
  /** What the last picture of a key cost (the hub's listing has the sizes, not the time): shown on the ready row. */
  const madeFacts = new Map<string, { ms: number; bytes: number }>();
  const requests: BakeSnapshot['requests'] = [];
  let lastMade: BakeSnapshot['lastMade'];
  let libSig: { p: unknown; m: unknown; f: unknown; src: unknown } | undefined;

  const note = (method: string, path: string, status: number) => {
    requests.push({ method, path: path.split('?')[0] as string, status });
    if (requests.length > 20) requests.shift();
  };

  async function call(
    method: string,
    path: string,
    init: { body?: Blob; json?: unknown; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    try {
      const r = await deps.api(path, { method, ...init });
      note(method, path, method === 'PUT' ? 201 : method === 'DELETE' ? 204 : 200);
      return r;
    } catch (e) {
      note(method, path, e instanceof ApiFailure ? e.status : 0);
      throw e;
    }
  }

  // ---- holds ----

  const live = () => deps.stores.live.getState();
  const library = () => deps.stores.library.getState();
  const serviceLive = () => {
    const l = live();
    return l.state.mode === 'live' || l.held || l.authority === 'fallback';
  };

  /** Why nothing is made now, if anything: the first that holds, in this order. */
  function holdNow(): { hold: BakeHold; until?: number } | undefined {
    const now = deps.now();
    const l = live();
    if (!libraryUsable(library()) || !l.hubConnected) return { hold: 'hub' };
    if (hubUntil > now) return { hold: 'hub', until: hubUntil };
    if (serviceLive()) return { hold: 'service' };
    if (l.goLivePrepare) return { hold: 'go-live' };
    if (goLiveUntil > now) return { hold: 'go-live', until: goLiveUntil };
    if (resumeAt > now) return { hold: 'resume-wait', until: resumeAt };
    if (pausedUntil > now) return { hold: 'service', until: pausedUntil };
    if (diskUntil > now) return { hold: 'disk', until: diskUntil };
    if (now < firstSweepAt) return { hold: 'starting', until: firstSweepAt };
    return undefined;
  }

  let lastHold: BakeHold | undefined;
  function showHold(): void {
    const h = holdNow();
    setHold(h?.hold, h?.until);
    wakeAt('hold', h?.until);
    // a hub that came back ends its hold with no timer of its own: it is a reason to look again
    if (lastHold === 'hub' && !h && started) wakeAt('settle', deps.now() + timings.settleMs);
    lastHold = h?.hold;
  }

  // ---- the one wake-up ----

  function rearm(): void {
    if (wake !== undefined) clearTimer(wake);
    wake = undefined;
    if (stopped || wakes.size === 0) return;
    const at = Math.min(...wakes.values());
    wake = setTimer(onWake, Math.max(0, at - deps.now()));
  }

  function wakeAt(name: string, at: number | undefined): void {
    if (at === undefined) wakes.delete(name);
    else wakes.set(name, at);
    rearm();
  }

  function onWake(): void {
    wake = undefined;
    const now = deps.now();
    const fired = new Set<string>();
    for (const [name, at] of [...wakes])
      if (at <= now) {
        wakes.delete(name);
        fired.add(name);
      }
    // the idle sweep is the slow trigger of what the hub never keyed: one more reading per presentation, no new tries
    if (fired.has('idle') && planned)
      for (const s of planned.statuses)
        if (s.state === 'queued' && s.waiting === 'hub-key') listings.delete(s.presentationId);
    for (const [id, due] of [...unknownDue]) {
      if (due > now) continue;
      unknownDue.delete(id);
      listings.delete(id);
    }
    rearm();
    void sweep();
  }

  // ---- the worker ----

  function ensureWorker(): BakeWorkerLike | undefined {
    if (workerIdle !== undefined) {
      clearTimer(workerIdle);
      workerIdle = undefined;
    }
    if (worker) return worker;
    const w = deps.createWorker();
    if (!w) return undefined;
    worker = w;
    postedFonts = undefined;
    w.onmessage = (ev) => onWorkerMessage(w, ev.data);
    w.onerror = () => onWorkerError(w);
    return w;
  }

  function killWorker(): void {
    if (workerIdle !== undefined) clearTimer(workerIdle);
    workerIdle = undefined;
    const w = worker;
    worker = undefined;
    postedFonts = undefined;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
  }

  function releaseSoon(): void {
    if (workerIdle !== undefined) clearTimer(workerIdle);
    workerIdle = setTimer(() => {
      workerIdle = undefined;
      if (!active) killWorker();
    }, BAKE_WORKER_IDLE_MS);
  }

  function bakeFonts(fonts: readonly Font[]) {
    return fonts.map((f) => ({
      family: f.family,
      weight: f.weight,
      style: f.style,
      hash: f.file.hash,
      url: deps.fontUrl(f.file.hash),
    }));
  }

  /** The running job ends with nothing posted and nothing uploaded: a service, a Go live, an edit, a hub that went. */
  function dropActive(why: string): void {
    const a = active;
    if (!a) return;
    a.dropped = true;
    if (a.hard !== undefined) clearTimer(a.hard);
    active = undefined;
    killWorker();
    setRunning(undefined);
    if (planned) publish(planned, 'ready');
    deps.log('info', `picture stopped: ${why}`);
    a.done();
  }

  // ---- the plan ----

  function currentKeyOf(item: BakeItem): { key?: string; wanted: boolean } {
    const lib = library().data;
    const p = lib.presentations.find((x) => x?.id === item.presentationId);
    if (!p) return { wanted: false };
    // this slide alone, from the plan's memory: a presentation that has not changed since the sweep costs no key
    const got = wantedItems(p, {
      inputs: slideInputs({ media: lib.media, fonts: lib.fonts }),
      listing: listings.get(item.presentationId)?.listing,
      deps: deps.plan,
      slides: cachedSlides(cache, p, lib),
      only: item.slideId,
    });
    const status = got.statuses.find((s) => s.slideId === item.slideId);
    return { key: status?.key, wanted: !!status && status.state !== 'none' };
  }

  async function runPlan(): Promise<SweepPlan> {
    const lib = library().data;
    plannedFonts = lib.fonts;
    playlists = lib.playlists ?? [];
    const input: PlanInput = {
      presentations: lib.presentations,
      library: { media: lib.media, fonts: lib.fonts },
      listings: Object.fromEntries([...listings].map(([id, v]) => [id, v.listing])),
      playlists,
      focus: focused,
      openId: deps.openId(),
      cache,
    };
    const g = planSweepSteps(input, deps.plan);
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
      await deps.yieldTask();
    }
  }

  async function readListing(id: string): Promise<Listing | undefined> {
    try {
      const body = (await call('GET', `/presentations/${encodeURIComponent(id)}/prerenders`)) as
        | Listing
        | undefined;
      if (!body || !Array.isArray(body.keys)) return undefined;
      const listing: Listing = {
        keys: body.keys,
        failures: Array.isArray(body.failures) ? body.failures : [],
        ...(body.budget ? { budget: body.budget } : {}),
      };
      listings.set(id, { at: deps.now(), listing });
      setPresentation(id, {
        listedAt: deps.now(),
        ...(listing.budget
          ? { usedBytes: listing.budget.usedBytes, limitBytes: listing.budget.limitBytes }
          : {}),
      });
      const skipped = budgetSkip.get(id);
      if (skipped !== undefined && listing.budget && listing.budget.usedBytes < skipped)
        budgetSkip.delete(id);
      return listing;
    } catch (e) {
      onApiFault(e);
      return undefined;
    }
  }

  /** What the plan wants but the hub has not listed: look again after 2, 5, 15, 60 and 120 s, then wait for a trigger. */
  function armUnknown(result: SweepPlan): void {
    const unknown = new Set(
      result.statuses
        .filter((s) => s.state === 'queued' && s.waiting === 'hub-key')
        .map((s) => s.presentationId),
    );
    for (const id of [...unknownTries.keys()])
      if (!unknown.has(id)) {
        unknownTries.delete(id);
        unknownDue.delete(id);
        unknownGaveUp.delete(id);
      }
    for (const id of unknown) {
      if (unknownGaveUp.has(id) || unknownDue.has(id)) continue;
      const tries = unknownTries.get(id) ?? 0;
      const d = retryDelay('unknown', tries);
      if (d === undefined) {
        unknownGaveUp.add(id);
        deps.log(
          'info',
          'a picture waits for the hub to know its key: not looked at again until the next change',
        );
        continue;
      }
      unknownTries.set(id, tries + 1);
      unknownDue.set(id, deps.now() + d);
    }
    wakeAt('unknown', unknownDue.size ? Math.min(...unknownDue.values()) : undefined);
  }

  /** The plan's statuses with what only the service knows: the slide being made, why a queued one waits. */
  function overlay(result: SweepPlan): SlideBake[] {
    const h = holdNow();
    return result.statuses.map((s) => {
      const id = bakeId(s.presentationId, s.slideId);
      const failed = localFailed.get(id);
      if (failed && failed.key === s.key) return { ...s, ...failed, state: 'failed' as const };
      if (s.state === 'ready') {
        const m = s.key ? madeFacts.get(s.key) : undefined;
        return m ? { ...s, ms: m.ms, bytes: m.bytes } : s;
      }
      if (s.state !== 'queued') return s;
      if (active && active.item.presentationId === s.presentationId && active.item.slideId === s.slideId) {
        const { waiting: _w, ...making } = s;
        return { ...making, state: 'making' as const };
      }
      if (s.waiting) return s;
      const t = s.key ? transient.get(s.key) : undefined;
      return {
        ...s,
        waiting: h ? ('hold' as const) : ('turn' as const),
        ...(t ? { attempts: t.tries } : {}),
      };
    });
  }

  /** The device's words for a picture that is not ready or failed: this computer cannot make it, or the hub's switch is off. */
  function deviceWords(entries: SlideBake[], g: BakeGate): SlideBake[] {
    if (g === 'ready' || g === 'unknown') return entries;
    const as = g === 'off' ? ('off' as const) : ('unsupported' as const);
    return entries.map((e) => {
      if (e.state !== 'queued' && e.state !== 'making') return e;
      const { waiting: _w, ...rest } = e;
      return { ...rest, state: as };
    });
  }

  function publish(result: SweepPlan, g: BakeGate): void {
    const keys = new Set(result.statuses.map((x) => x.key));
    for (const k of [...madeFacts.keys()]) if (!keys.has(k)) madeFacts.delete(k);
    const entries = deviceWords(overlay(result), g);
    const ids = new Set(entries.map((e) => bakeId(e.presentationId, e.slideId)));
    const gone = Object.keys(useBake.getState().slides).filter((k) => !k.includes('#') && !ids.has(k));
    setSlides(entries, gone);
    const inLibrary = new Set(library().data.presentations.map((p) => p?.id));
    for (const id of Object.keys(useBake.getState().presentations))
      if (!inLibrary.has(id)) dropPresentation(id);
  }

  async function ensureListings(ids: string[], force: boolean): Promise<void> {
    for (const id of ids) {
      if (stopped || holdNow()) return;
      const have = listings.get(id);
      if (!force && have && deps.now() - have.at < BAKE_LISTING_FRESH_MS) continue;
      await readListing(id);
    }
  }

  async function refreshPlan(opts: { relist?: boolean } = {}): Promise<SweepPlan> {
    let result = await runPlan();
    if (result.needListing.length) {
      await ensureListings(result.needListing, true);
      result = await runPlan();
    } else if (opts.relist) {
      const ids = [
        ...new Set(result.statuses.filter((s) => s.state === 'queued').map((s) => s.presentationId)),
      ];
      await ensureListings(ids, true);
      result = await runPlan();
    }
    planned = result;
    publish(result, 'ready');
    armUnknown(result);
    const pending = result.statuses.some((s) => s.state === 'queued') || transient.size > 0;
    wakeAt('idle', pending ? deps.now() + timings.idleSweepMs : undefined);
    queue = buildQueue(result);
    return result;
  }

  /** What is made, in order: not a key waiting out a pause, not a presentation the hub is full for, not a failed one. */
  function buildQueue(result: SweepPlan): BakeItem[] {
    const items = result.items.filter((it) => {
      const t = transient.get(it.key);
      if (t && t.due > deps.now()) return false;
      if (budgetSkip.has(it.presentationId)) return false;
      const failed = localFailed.get(bakeId(it.presentationId, it.slideId));
      return !failed || failed.key !== it.key;
    });
    if (frontKey) {
      const i = items.findIndex((it) => it.key === frontKey);
      if (i > 0) items.unshift(...items.splice(i, 1));
    }
    return items;
  }

  // ---- the sweep ----

  async function sweep(): Promise<void> {
    if (stopped) return;
    if (sweeping) {
      sweepAgain = true;
      return;
    }
    sweeping = true;
    try {
      sweeps++;
      showHold();
      if (!deps.gate().ok || holdNow()) return;
      await refreshPlan();
      void pump(false);
    } finally {
      sweeping = false;
      if (sweepAgain) {
        sweepAgain = false;
        wakeAt('settle', deps.now());
      }
    }
  }

  // ---- the queue ----

  /**
   * Before a bake: the listing is read again if it is old (a computer that opened a moment ago may be behind), and the
   * slide is read again from the library: a copy that lags the hub must not make a picture of a slide that is gone (D13).
   */
  async function stillWanted(item: BakeItem): Promise<boolean> {
    const have = listings.get(item.presentationId);
    if (!have || deps.now() - have.at > BAKE_LISTING_FRESH_MS) await readListing(item.presentationId);
    const now = currentKeyOf(item);
    if (!now.wanted || now.key !== item.key) return false;
    const row = listings.get(item.presentationId)?.listing.keys.find((k) => k.key === item.key);
    return !!row && item.missingSizes.some((s) => !row.sizes.includes(s));
  }

  async function pump(now: boolean): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      let first = true;
      while (!stopped) {
        if (holdNow()) {
          showHold();
          if (planned) publish(planned, 'ready');
          break;
        }
        if (queue.length === 0) break;
        if (!now) {
          if (!first) await sleep(timings.gapMs);
          await deps.idle();
        }
        first = false;
        // the item is taken only now: a plan that came while the computer was not idle yet has its own order
        if (stopped || holdNow()) continue;
        const item = queue.shift();
        if (!item) break;
        if (!(await stillWanted(item))) continue;
        await runItem(item);
        if (frontKey === item.key) frontKey = undefined;
      }
    } finally {
      pumping = false;
      showHold();
    }
  }

  function runItem(item: BakeItem): Promise<void> {
    return new Promise<void>((done) => {
      const w = ensureWorker();
      if (!w) {
        done();
        return;
      }
      const seq = ++jobSeq;
      const a: Active = { seq, item, worker: w, startedAt: deps.now(), heard: false, dropped: false, done };
      active = a;
      setRunning({
        presentationId: item.presentationId,
        slideId: item.slideId,
        key: item.key,
        since: a.startedAt,
        phase: 'files',
      });
      if (planned) publish(planned, 'ready');
      if (postedFonts !== plannedFonts) {
        w.postMessage({ t: 'fonts', fonts: bakeFonts(plannedFonts) });
        postedFonts = plannedFonts;
      }
      const job: BakeJobIn = {
        kind: 'slide',
        id: seq,
        presentationId: item.presentationId,
        slideId: item.slideId,
        key: item.key,
        slide: item.slide,
        live: item.live,
        images: item.images,
        deadlineMs: BAKE_JOB_DEADLINE_MS,
        standIns: BAKE_STAND_INS,
        madeBy: deps.madeBy(),
        ...(item.file ? { file: item.file } : {}),
      };
      w.postMessage({ t: 'bake', job });
      // the hard bound: a worker that stays silent this long is killed. A worker that answered and then went quiet
      // took too long over THIS slide (posted); one that never answered is not the slide's fault (retried, not posted)
      a.hard = setTimer(() => {
        if (active !== a) return;
        a.hard = undefined;
        active = undefined;
        killWorker();
        setRunning(undefined);
        const done2 = () => {
          if (planned) publish(planned, 'ready');
          done();
        };
        if (!a.heard) void workerFault(a, 'it did not answer').finally(done2);
        else
          void onFailed(
            a,
            'time',
            'the picture took longer than the limit',
            'time: the picture took longer than the limit',
          ).finally(done2);
      }, BAKE_JOB_DEADLINE_MS + BAKE_HARD_GRACE_MS);
    });
  }

  function finish(a: Active): void {
    if (a.hard !== undefined) clearTimer(a.hard);
    a.hard = undefined;
    if (active === a) active = undefined;
    setRunning(undefined);
    if (planned) publish(planned, 'ready');
    releaseSoon();
  }

  /** The worker itself broke (its script failed, it threw outside a job): never the slide's fault, never posted. */
  function onWorkerError(w: BakeWorkerLike): void {
    const a = active;
    if (!a || a.worker !== w) {
      if (worker === w) killWorker();
      return;
    }
    if (a.hard !== undefined) clearTimer(a.hard);
    a.hard = undefined;
    active = undefined;
    killWorker();
    setRunning(undefined);
    void workerFault(a, 'it stopped').finally(() => {
      if (planned) publish(planned, 'ready');
      a.done();
    });
  }

  /**
   * A picture maker that broke or never answered: tried again after 10 s and 60 s like any cause that is not the
   * slide's; the third time the slide is marked failed on THIS computer only (fix "ordo"), never posted to the hub.
   */
  async function workerFault(a: Active, what: string): Promise<void> {
    const item = a.item;
    if (a.dropped || stopped) return;
    const tries = (transient.get(item.key)?.tries ?? 0) + 1;
    deps.log('warn', `the picture maker ${what}`);
    if (tries < BAKE_ATTEMPTS) {
      const d = retryDelay('transient', tries - 1) ?? 60_000;
      transient.set(item.key, { tries, due: deps.now() + d });
      wakeAt('transient', deps.now() + d);
      return;
    }
    transient.delete(item.key);
    markFailed(item, reasonFor('unknown', `the picture maker ${what}`), {
      code: 'unknown',
      fix: 'ordo',
      attempts: tries,
    });
  }

  function onWorkerMessage(w: BakeWorkerLike, m: BakeOut): void {
    const a = active;
    if (!a || a.worker !== w || !m || m.id !== a.seq) return;
    a.heard = true;
    switch (m.t) {
      case 'phase':
        setRunning({
          presentationId: a.item.presentationId,
          slideId: a.item.slideId,
          key: a.item.key,
          since: a.startedAt,
          phase: m.phase,
        });
        return;
      case 'decode':
        void deps.drawSvg(m.blob).then(
          (bitmap) => {
            if (active === a) w.postMessage({ t: 'decoded', seq: m.seq, bitmap });
          },
          () => {
            if (active === a) w.postMessage({ t: 'decoded', seq: m.seq });
          },
        );
        return;
      case 'media': {
        const lib = library().data;
        const inputs = slideInputs({ media: lib.media, fonts: lib.fonts });
        const files: Record<string, string> = {};
        for (const id of m.ids) {
          const h = inputs.mediaFile(id);
          if (h) files[id] = h;
        }
        w.postMessage({ t: 'media', id: m.id, files });
        return;
      }
      case 'made':
        lastMade = {
          ms: { ...m.ms },
          pictures: m.pictures.map((p) => ({ size: p.size, type: p.type, bytes: p.bytes })),
          opaque: m.opaque,
          standIns: m.standIns.length,
        };
        void onMade(a, m).finally(() => {
          finish(a);
          a.done();
        });
        return;
      case 'failed':
        void onFailed(a, m.reason, m.detail, m.text).finally(() => {
          finish(a);
          a.done();
        });
        return;
    }
  }

  // ---- what the hub answers ----

  /** A fault that is not the slide's: the network, the session, a service, the hub's switch (never posted). */
  function onApiFault(e: unknown): void {
    const now = deps.now();
    if (e instanceof ApiFailure) {
      if (e.status === 503 && e.code === 'paused_during_service') {
        const retry = Number((e.details as { retryAfterS?: unknown } | undefined)?.retryAfterS);
        pausedUntil = now + Math.max(BAKE_PAUSED_MAX_MS, Number.isFinite(retry) ? retry * 1000 : 0);
        deps.log('info', 'the hub is in a service: pictures wait');
      } else if (e.status === 503 && e.code === 'prerender_off') {
        setGate('off');
        stopForGood('the hub has pictures turned off');
        return;
      } else if (e.status === 507 && e.code === 'disk') {
        diskUntil = now + BAKE_DISK_HOLD_MS;
      } else if (e.status === 401 || e.status === 403 || e.status === 0 || e.status >= 500) {
        hubUntil = now + BAKE_HUB_HOLD_MS;
      }
    } else {
      // a network error
      hubUntil = now + BAKE_HUB_HOLD_MS;
    }
    showHold();
  }

  function stopForGood(why: string): void {
    deps.log('info', `pictures stopped: ${why}`);
    stopped = true;
    wakes.clear();
    if (wake !== undefined) clearTimer(wake);
    wake = undefined;
    queue = [];
    dropActive(why);
    killWorker();
    setHold(undefined, undefined);
  }

  async function post(item: BakeItem, reason: string): Promise<boolean> {
    try {
      await call(
        'POST',
        `/presentations/${encodeURIComponent(item.presentationId)}/prerenders/${encodeURIComponent(item.key)}/failed`,
        {
          json: { reason, madeBy: deps.madeBy() },
        },
      );
      return true;
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409) {
        listings.delete(item.presentationId);
        return true;
      }
      onApiFault(e);
      return false;
    }
  }

  function markFailed(item: BakeItem, reason: string, over: Partial<SlideBake> = {}): void {
    const d = describeFailure(reason);
    localFailed.set(bakeId(item.presentationId, item.slideId), {
      presentationId: item.presentationId,
      slideId: item.slideId,
      kind: 'slide',
      state: 'failed',
      key: item.key,
      reason,
      code: d.code,
      fix: d.fix,
      at: deps.now(),
      ...over,
    });
  }

  async function onFailed(a: Active, reason: string, detail: string, text: string): Promise<void> {
    const item = a.item;
    if (a.dropped || stopped) return;
    if (reason === 'stale') {
      // the key of the full slide is not the one the hub listed (the listing changed, or the file differs): list again once
      listings.delete(item.presentationId);
      if (!staleOnce.has(item.key)) {
        staleOnce.add(item.key);
        wakeAt('settle', deps.now() + timings.settleMs);
      }
      return;
    }
    if (reason === 'kind') {
      markFailed(item, reasonFor('kind', detail), { code: 'kind', fix: 'ordo' });
      if (planned) publish(planned, 'ready');
      return;
    }
    const fileGone = !!item.file && reason === 'files' && detail.startsWith('the full copy');
    const tries = (transient.get(item.key)?.tries ?? 0) + 1;
    const limit = reason === 'font' ? 2 : BAKE_ATTEMPTS;
    if (!fileGone && TRANSIENT.has(reason) && tries < limit) {
      const d = retryDelay('transient', tries - 1) ?? 60_000;
      transient.set(item.key, { tries, due: deps.now() + d });
      wakeAt('transient', deps.now() + d);
      deps.log('info', `picture not made yet: ${reason}`);
      if (planned) publish(planned, 'ready');
      return;
    }
    transient.delete(item.key);
    const parsed = describeFailure(text).code;
    const code: BakeCode =
      parsed === 'unknown'
        ? PERMANENT.has(reason) || TRANSIENT.has(reason)
          ? (reason as BakeCode)
          : 'unknown'
        : parsed;
    const body = reasonFor(code, text);
    deps.log('info', `picture not made: ${reason}`);
    const posted = await post(item, body);
    if (posted) markFailed(item, body, { attempts: tries });
    listings.delete(item.presentationId);
    if (planned) publish(planned, 'ready');
  }

  async function onMade(a: Active, m: Extract<BakeOut, { t: 'made' }>): Promise<void> {
    const item = a.item;
    if (a.dropped || stopped) return;
    // a picture of a key that is not the slide's now is never uploaded (D13): the copy changed while it was made
    const cur = currentKeyOf(item);
    if (!cur.wanted || cur.key !== item.key) {
      deps.log('info', 'picture dropped: the slide changed while it was made');
      wakeAt('settle', deps.now() + timings.settleMs);
      return;
    }
    const sent: number[] = [];
    let bytes = 0;
    for (const size of BAKE_UPLOAD_ORDER) {
      if (!item.missingSizes.includes(size)) continue;
      const pic = m.pictures.find((p) => p.size === size);
      if (!pic) continue;
      if (a.dropped || stopped || serviceLive() || holdNow()?.hold === 'go-live') return;
      try {
        await call('PUT', uploadUrl(item, size, deps.madeBy()), {
          body: pic.blob,
          headers: { 'content-type': pic.type },
        });
        sent.push(size);
        bytes += pic.bytes;
      } catch (e) {
        await onUploadFault(item, e);
        return;
      }
    }
    const ms = deps.now() - a.startedAt;
    deps.log('info', `picture made: ${Math.round(ms)} ms, ${(bytes / 1_000_000).toFixed(1)} MB`);
    transient.delete(item.key);
    madeFacts.set(item.key, { ms, bytes });
    const have = listings.get(item.presentationId)?.listing.keys.find((k) => k.key === item.key)?.sizes ?? [];
    const sizes = [...new Set([...have, ...sent])].sort((x, y) => x - y);
    setSlides([
      {
        presentationId: item.presentationId,
        slideId: item.slideId,
        kind: 'slide',
        state: 'ready',
        key: item.key,
        sizes,
        ms,
        bytes,
        madeBy: deps.madeBy(),
        at: deps.now(),
      },
    ]);
    // the listing is read once more after the last upload: the hub's own record is what every computer reads
    await readListing(item.presentationId);
    if (planned) {
      planned = await runPlan();
      publish(planned, 'ready');
    }
  }

  async function onUploadFault(item: BakeItem, e: unknown): Promise<void> {
    if (e instanceof ApiFailure) {
      if (e.status === 409 && e.code === 'unknown_key') {
        // the listing changed under us: read it again and handle the slide as one the hub has not keyed
        listings.delete(item.presentationId);
        wakeAt('settle', deps.now() + timings.settleMs);
        return;
      }
      if (e.status === 507 && e.code === 'budget') {
        // the hub's budget is not the slide's fault: nothing is posted, the presentation is skipped until room appears
        const used = Number((e.details as { usedBytes?: unknown } | undefined)?.usedBytes);
        budgetSkip.set(item.presentationId, Number.isFinite(used) ? used : Number.MAX_SAFE_INTEGER);
        markFailed(item, reasonFor('budget', 'the hub is full for this presentation'), {
          code: 'budget',
          fix: 'fix',
        });
        if (planned) publish(planned, 'ready');
        return;
      }
      if (e.status === 507 && e.code === 'disk') {
        markFailed(item, reasonFor('disk', 'the hub is short of disk space'), { code: 'disk', fix: 'fix' });
        onApiFault(e);
        if (planned) publish(planned, 'ready');
        return;
      }
      if (e.status === 400 || e.status === 413) {
        const text = reasonFor(e.status === 413 ? 'size' : 'verify', cut(e.message, 100));
        const posted = await post(item, text);
        if (posted) markFailed(item, text);
        if (planned) publish(planned, 'ready');
        return;
      }
    }
    onApiFault(e);
    if (planned) publish(planned, 'ready');
  }

  // ---- triggers ----

  function onLive(state?: BakeLiveSlice, prev?: BakeLiveSlice): void {
    const sl = serviceLive();
    const l = live();
    // the hub is back: whatever pause a lost request began is over
    if (state && prev && state.hubConnected && !prev.hubConnected) hubUntil = 0;
    if (sl && !wasService) {
      wasService = true;
      goLiveUntil = 0;
      dropActive('a service started');
    } else if (!sl && wasService) {
      // End service: the computers resume after the hub's own wait
      wasService = false;
      pausedUntil = 0;
      resumeAt = deps.now() + timings.resumeMs;
      wakeAt('resume', resumeAt);
    }
    if (l.goLivePrepare) dropActive('Go live was pressed');
    if (!l.hubConnected) dropActive('the hub went away');
    showHold();
  }

  function onLibrary(): void {
    const s = library();
    const d = s.data;
    const sig = { p: d.presentations, m: d.media, f: d.fonts, src: libraryUsable(s) };
    if (libSig && libSig.p === sig.p && libSig.m === sig.m && libSig.f === sig.f && libSig.src === sig.src)
      return;
    libSig = sig;
    showHold();
    if (!libraryUsable(s)) return;
    // a changed library is new facts: a key that was waiting for the hub is looked up again from the start
    unknownTries.clear();
    unknownGaveUp.clear();
    wakeAt('settle', Math.max(deps.now() + timings.settleMs, firstSweepAt));
    // the running job's slide may have changed under it: its picture would be of a slide that is gone (D13)
    const a = active;
    if (a) {
      const cur = currentKeyOf(a.item);
      if (!cur.wanted || cur.key !== a.item.key) dropActive('the slide was edited');
    }
  }

  // ---- the service ----

  const gateOf = (v: BakeVerdict): BakeGate =>
    v.ok ? 'ready' : v.why === 'off' ? 'off' : v.why === 'unsupported' ? 'unsupported' : 'unknown';

  function start(): () => void {
    const verdict = deps.gate();
    setGate(gateOf(verdict));
    if (!verdict.ok || started) return () => undefined;
    started = true;
    stopped = false;
    wasService = serviceLive();
    // the start jitter is a third of the start delay at most (5 s of 15 s): a test that shortens the delay shortens it too
    const jitterMax = Math.min(5000, timings.startDelayMs / 3);
    firstSweepAt = deps.now() + timings.startDelayMs + Math.floor(deps.random() * jitterMax);
    libSig = undefined;
    offStores = [deps.stores.live.subscribe(onLive), deps.stores.library.subscribe(onLibrary)];
    wakeAt('start', firstSweepAt);
    onLibrary();
    showHold();
    return () => {
      stopped = true;
      started = false;
      for (const off of offStores) off();
      offStores = [];
      wakes.clear();
      if (wake !== undefined) clearTimer(wake);
      wake = undefined;
      queue = [];
      dropActive('the service stopped');
      killWorker();
    };
  }

  async function refresh(presentationId: string, options: { force?: boolean } = {}): Promise<void> {
    const verdict = deps.gate();
    const g = gateOf(verdict);
    const lib = library().data;
    const p = lib.presentations.find((x) => x?.id === presentationId);
    if (!verdict.list) {
      // a phone or the demo does nothing; a hub with its switch off says "off" for the record slides, listing nothing
      if (!verdict.ok && verdict.why === 'off' && p) {
        setGate('off');
        const got = wantedItems(p, {
          inputs: slideInputs({ media: lib.media, fonts: lib.fonts }),
          listing: undefined,
          deps: deps.plan,
        });
        setSlides(
          deviceWords(
            got.statuses.filter((s) => s.state !== 'none'),
            'off',
          ),
        );
      }
      return;
    }
    setGate(g);
    const have = listings.get(presentationId);
    if (options.force || !have || deps.now() - have.at >= BAKE_LISTING_FRESH_MS)
      await readListing(presentationId);
    const again = library().data.presentations.find((x) => x?.id === presentationId);
    if (!again) return;
    const now = library().data;
    const got = wantedItems(again, {
      inputs: slideInputs({ media: now.media, fonts: now.fonts }),
      listing: listings.get(presentationId)?.listing,
      deps: deps.plan,
      slides: cachedSlides(cache, again, now),
    });
    setSlides(deviceWords(got.statuses, g));
  }

  const makeNow: MakeNow = async (scope = {}) => {
    const verdict = deps.gate();
    if (serviceLive()) return { ok: false, why: 'service' };
    if (live().goLivePrepare || goLiveUntil > deps.now()) return { ok: false, why: 'go-live' };
    if (!verdict.ok) {
      if (verdict.why === 'off') return { ok: false, why: 'off' };
      if (verdict.why === 'unsupported') return { ok: false, why: 'unsupported' };
    }
    if (!libraryUsable(library()) || !live().hubConnected) return { ok: false, why: 'hub' };
    // skips the start delay, the settle wait, the resume wait, the idle callback and the gap, never a service
    firstSweepAt = 0;
    resumeAt = 0;
    pausedUntil = 0;
    hubUntil = 0;
    if (diskUntil > deps.now()) return { ok: false, why: 'hub' };
    if (scope.playlistId || scope.presentationId) focused = scope;
    await refreshPlan({ relist: true });
    const queued = queue.length;
    if (queued === 0) return { ok: false, why: 'nothing' };
    void pump(true);
    return { ok: true, queued };
  };

  const makeAgain: MakeAgain = async (presentationId, slideId) => {
    if (serviceLive()) return { ok: false, why: 'service' };
    const key = useBake.getState().slides[bakeId(presentationId, slideId)]?.key;
    if (!key) return { ok: false, why: 'unknown-key' };
    try {
      await call(
        'DELETE',
        `/presentations/${encodeURIComponent(presentationId)}/prerenders/${encodeURIComponent(key)}`,
      );
    } catch (e) {
      if (e instanceof ApiFailure && (e.status === 409 || e.status === 404))
        return { ok: false, why: 'unknown-key' };
      if (e instanceof ApiFailure && e.status === 503 && e.code === 'paused_during_service')
        return { ok: false, why: 'service' };
      onApiFault(e);
      return { ok: false, why: 'hub' };
    }
    transient.delete(key);
    localFailed.delete(bakeId(presentationId, slideId));
    staleOnce.delete(key);
    budgetSkip.delete(presentationId);
    listings.delete(presentationId);
    frontKey = key;
    if (deps.gate().ok) wakeAt('settle', deps.now());
    else await refresh(presentationId, { force: true });
    return { ok: true };
  };

  return {
    start,
    refresh,
    makeNow,
    makeAgain,
    focus(f) {
      focused = f;
      if (!planned) return;
      void runPlan().then((r) => {
        planned = r;
        queue = buildQueue(r);
        publish(r, 'ready');
      });
    },
    holdForGoLive() {
      goLiveUntil = deps.now() + BAKE_GO_LIVE_HOLD_MAX_MS;
      dropActive('Go live was pressed');
      showHold();
    },
    snapshot() {
      const s = useBake.getState();
      return {
        gate: s.gate,
        ...(s.hold ? { hold: s.hold } : {}),
        ...(s.running ? { running: s.running } : {}),
        totals: s.totals,
        slides: { ...s.slides },
        presentations: { ...s.presentations },
        workers: worker ? 1 : 0,
        timers: timersArmed.size,
        timings: { ...timings },
        sweeps,
        requests: [...requests],
        ...(lastMade ? { lastMade } : {}),
      };
    },
    get timings() {
      return timings;
    },
  };
}

// ---- the real dependencies ----

function realDeps(): BakeServiceDeps {
  const platform =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return {
    api: (path, init) => api(path, init as never),
    createWorker: () => {
      try {
        return new Worker(new URL('../workers/bake.worker.ts', import.meta.url), {
          type: 'module',
          name: 'ordo-bake',
        }) as unknown as BakeWorkerLike;
      } catch {
        return undefined;
      }
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    idle: () =>
      new Promise<void>((resolve) => {
        const ric = (
          globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }
        ).requestIdleCallback;
        if (ric) ric(() => resolve(), { timeout: 5000 });
        else setTimeout(resolve, 50);
      }),
    yieldTask: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    random: () => Math.random(),
    gate: realGate,
    stores: { live: useLive as never, library: useLibrary as never },
    openId: () => {
      const r = parseRoute(location.hash);
      return r?.name === 'edit' ? r.id : undefined;
    },
    madeBy: () => cut(`operator ${APP_VERSION} ${currentRole() ?? 'operate'} ${platform ?? 'unknown'}`, 120),
    fontUrl: (hash) => new URL(fileUrl(hash), location.href).href,
    drawSvg: async (blob) => {
      const { svgBitmap } = await import('../../../output/src/svg.ts');
      try {
        return await svgBitmap(blob);
      } catch {
        return undefined;
      }
    },
    log: (level, text) => log(level, text),
    ...(bakeTestMode() ? { timings: bakeTimingsFromUrl() } : {}),
  };
}

/** The service of this page. */
export const bake: BakeService = createBakeService(realDeps());

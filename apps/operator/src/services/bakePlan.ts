import type { Font, Media, MediaKind, Playlist, Presentation, Slide } from '@ordo/domain';
import { drawnMediaIds, stillFile } from '@ordo/domain';
import {
  easyPlan,
  type EasyOptions,
  type PictureInputs,
  pictureSource,
  planRecord,
  prerenderKey,
} from '@ordo/domain/prerender.ts';
import {
  type BakeCode,
  type BakeFix,
  type BakeFocus,
  type BakeState,
  type BakeWaiting,
  describeFailure,
  type SlideBake,
} from '../state/bake.ts';
import {
  BAKE_ATTEMPTS,
  BAKE_READY_SIZES,
  BAKE_SLICE_MS,
  BAKE_TRANSIENT_BACKOFF_MS,
  BAKE_UNKNOWN_BACKOFF_MS,
  BAKE_UPLOAD_ORDER,
} from './bakeConsts.ts';

/**
 * The plan of the bake service (design/29 section 1.4): what this computer wants to make, as a pure function of the
 * library and the hub's listing. No timers, no store, no network; it imports the domain and types only, so the
 * Go-live check can call the same functions (C-BW2).
 *
 * The idea: the sweep is a function of WHAT IS WANTED (the record slides, their local keys, the listing), never of
 * a list of events, so nothing can be missed and Q24.a (an anchored slide with a live set) and Q24.c (a plate) add to
 * what is wanted, not to the triggers (hooks H-W1 to H-W7).
 *
 * - A record slide's key is computed LOCALLY with the domain's own `pictureSource` and `prerenderKey` over this
 *   computer's library copy; a picture is made only for a key the hub also lists (equal keys prove the same slide,
 *   media files and font faces). A slide kept in a slide file (Q54) is never keyed here (a 16 MiB slide cannot be
 *   keyed inside a 50 ms task): the hub's listed key is the item's key and the worker checks it.
 * - Eligibility is not a rule of the baker's own: it asks `easyPlan` and `planRecord` the way the two writers do,
 *   with `isMotion` from the library's media kind (Q25.c.b: only a video is a moving background) (H-W2).
 */

// ---- the hub's listing (GET /presentations/:id/prerenders) ----

export type ListingKey = {
  slideId: string;
  key: string;
  standbyId?: string;
  /** The picture sizes (widths) the hub holds for the key. */
  sizes: number[];
  madeBy?: string;
  at?: number;
};
export type ListingFailure = { key: string; reason: string; madeBy?: string; at?: number };
export type Listing = {
  /** Every kept revision's keys, the newest revision first (the hub orders them). */
  keys: ListingKey[];
  failures: ListingFailure[];
  budget?: { usedBytes: number; limitBytes: number };
};

// ---- inputs ----

/** What a key is computed from (`PictureInputs`) and what the plan asks of the media list besides. */
export type PlanInputs = PictureInputs & {
  /** The media kind of a library media, for `isMotion`; undefined for a media the library lacks. */
  kindOf(id: string): MediaKind | undefined;
};

/** The library's media files and faces as a key's inputs. Holds no reference to the arrays beyond the call. */
export function slideInputs(lib: { media: readonly Media[]; fonts: readonly Font[] }): PlanInputs {
  const files = new Map<string, string | undefined>();
  const kinds = new Map<string, MediaKind>();
  for (const m of Array.isArray(lib?.media) ? lib.media : []) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue;
    kinds.set(m.id, m.kind);
    try {
      files.set(m.id, stillFile(m)?.hash);
    } catch {
      files.set(m.id, undefined);
    }
  }
  const fonts: { family: string; file: { hash: string } }[] = [];
  for (const f of Array.isArray(lib?.fonts) ? lib.fonts : [])
    if (f && typeof f.family === 'string' && typeof f.file?.hash === 'string')
      fonts.push({ family: f.family, file: { hash: f.file.hash } });
  return {
    mediaFile: (id) => files.get(id),
    kindOf: (id) => kinds.get(id),
    fonts,
  };
}

/** The key of a slide's picture on this computer: the domain's, with the live set the record names (H-W1). */
export function localKey(slide: Slide, inputs: PictureInputs): string {
  return prerenderKey(pictureSource(slide, slide.prerender?.live ?? [], inputs));
}

/** The slides that have a record, in section and slide order. Never throws on a hostile library entry. */
export function recordSlides(p: Presentation): Slide[] {
  const out: Slide[] = [];
  const sections: unknown = p?.sections;
  if (!Array.isArray(sections)) return out;
  for (const sec of sections) {
    const slides: unknown = sec?.slides;
    if (!Array.isArray(slides)) continue;
    for (const s of slides) {
      if (!s || typeof s !== 'object' || typeof s.id !== 'string') continue;
      const pre: unknown = s.prerender;
      if (pre && typeof pre === 'object') out.push(s as Slide);
    }
  }
  return out;
}

// ---- what a listing says of a key ----

export type Classified = {
  state: BakeState;
  /** The sizes the hub holds for the key. */
  sizes: number[];
  /** The sizes this computer must make and upload, in the order of upload: never one the hub already holds. */
  missingSizes: number[];
  code?: BakeCode;
  fix?: BakeFix;
  reason?: string;
  waiting?: BakeWaiting;
  at?: number;
  madeBy?: string;
};

const NONE: number[] = [];

/**
 * What the hub's listing says of a slide whose local key is `key`. UNKNOWN IS NOT MISSING (C-BW2): with no listing,
 * or a key the hub does not list yet, the slide is `queued`, waiting for the hub's key, never `none` and never
 * `failed`. A key is ready with its 1920 and 3840 pictures (the two a screen draws): its 640 preview is not made
 * again for being absent (D8); a recorded failure holds the key unless someone made the picture since.
 */
export function classify(args: { slide: Slide; key: string; listing: Listing | undefined }): Classified {
  const { slide, key, listing } = args;
  const unknown: Classified = {
    state: 'queued',
    sizes: NONE,
    missingSizes: [...BAKE_UPLOAD_ORDER],
    waiting: 'hub-key',
  };
  if (slide?.pptx?.pending === true)
    return { state: 'queued', sizes: NONE, missingSizes: [...BAKE_UPLOAD_ORDER], waiting: 'pending' };
  if (!listing) return unknown;
  const row = listing.keys.find((k) => k.key === key);
  if (!row) return unknown;
  const sizes = [...row.sizes];
  const have = new Set(sizes);
  const common = {
    sizes,
    ...(row.madeBy ? { madeBy: row.madeBy } : {}),
    ...(row.at !== undefined ? { at: row.at } : {}),
  };
  if (BAKE_READY_SIZES.every((s) => have.has(s))) return { state: 'ready', ...common, missingSizes: [] };
  const failure = listing.failures.find((f) => f.key === key);
  if (failure) {
    const d = describeFailure(failure.reason);
    return {
      state: 'failed',
      sizes,
      missingSizes: [],
      code: d.code,
      fix: d.fix,
      reason: failure.reason,
      ...(failure.madeBy ? { madeBy: failure.madeBy } : {}),
      ...(failure.at !== undefined ? { at: failure.at } : {}),
    };
  }
  return { state: 'queued', ...common, missingSizes: BAKE_UPLOAD_ORDER.filter((s) => !have.has(s)) };
}

/** The hub's key of a slide kept in a slide file: the first (the newest revision's) key the listing names for it. */
function listedKeyFor(listing: Listing | undefined, slideId: string): string | undefined {
  return listing?.keys.find((k) => k.slideId === slideId)?.key;
}

// ---- retries ----

/**
 * How long to wait before trying again, by the kind of cause and the tries so far (0 = after the first): an unknown
 * key (the hub's keys job is behind a save) 2, 5, 15, 60 and 120 s; a transient cause (a font or a file that was not
 * there yet, a stopped bake) 10 s then 60 s, and the third failure is posted (`BAKE_ATTEMPTS`); a permanent cause
 * never. `undefined` ends the table.
 */
export function retryDelay(kind: 'unknown' | 'transient' | 'permanent', tries: number): number | undefined {
  if (!Number.isInteger(tries) || tries < 0) return undefined;
  if (kind === 'unknown') return BAKE_UNKNOWN_BACKOFF_MS[tries];
  if (kind === 'transient') return tries < BAKE_ATTEMPTS - 1 ? BAKE_TRANSIENT_BACKOFF_MS[tries] : undefined;
  return undefined;
}

// ---- order ----

/**
 * The presentations in the order to make them: the focus playlist's first in the playlist's item order (a
 * presentation named twice once), a focused presentation, the open presentation, then the rest by `updatedAt` newest
 * first and by id. Stable and deterministic; a focus naming a missing playlist changes nothing.
 */
export function orderPresentations(
  presentations: readonly Presentation[],
  opts: { focus?: BakeFocus; playlists?: readonly Playlist[]; openId?: string } = {},
): Presentation[] {
  const byId = new Map<string, Presentation>();
  for (const p of presentations) if (p && typeof p.id === 'string' && !byId.has(p.id)) byId.set(p.id, p);
  const out: Presentation[] = [];
  const seen = new Set<string>();
  const take = (id: string | undefined) => {
    if (!id || seen.has(id)) return;
    const p = byId.get(id);
    if (!p) return;
    seen.add(id);
    out.push(p);
  };
  const playlistId = opts.focus?.playlistId;
  const playlist = playlistId ? opts.playlists?.find((pl) => pl?.id === playlistId) : undefined;
  if (playlist && Array.isArray(playlist.items))
    for (const item of playlist.items) if (item?.kind === 'presentation') take(item.presentationId);
  take(opts.focus?.presentationId);
  take(opts.openId);
  const rest = [...byId.values()]
    .filter((p) => !seen.has(p.id))
    .sort((a, b) => {
      const ua = typeof a.updatedAt === 'string' ? a.updatedAt : '';
      const ub = typeof b.updatedAt === 'string' ? b.updatedAt : '';
      if (ua !== ub) return ua < ub ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  return [...out, ...rest];
}

// ---- what is wanted ----

/** What the worker makes: one record slide's picture. The union has ONE member today (H-W4: a plate adds one). */
export type BakeItem = {
  kind: 'slide';
  presentationId: string;
  slideId: string;
  /** The key the pictures are uploaded under: the local key, or for a file-form slide the hub's listed key. */
  key: string;
  /** The live set above the picture: the record's (H-W1). `[]` in this release. */
  live: string[];
  /** The sizes to upload, in order. */
  missingSizes: number[];
  /** The slide as the library holds it (for a file-form slide, its bounded stand-in). */
  slide: Slide;
  /** The file each drawn picture decodes, by media id (empty for a file-form slide: the worker asks). */
  images: Record<string, string>;
  /** A slide kept in a slide file (Q54): its head and the key the hub listed for it. */
  file?: { ref: string; bytes: number; listedKey: string };
};

/** The functions the plan calls; tests replace them (counting keys, stubbing the writers' plan, a key that throws). */
export type PlanDeps = {
  keyOf?: (slide: Slide, inputs: PictureInputs) => string;
  easy?: typeof easyPlan;
  record?: typeof planRecord;
  /** A clock in ms for the slices of `planSweepSteps`. */
  now?: () => number;
};

type Computed =
  | { eligible: false }
  | { eligible: true; form: 'inline'; key: string; live: string[]; images: Record<string, string> }
  | { eligible: true; form: 'file'; file: { ref: string; bytes: number }; live: string[] }
  | { error: string };

export type PlanCacheEntry = {
  presentation: Presentation;
  rev: unknown;
  media: readonly Media[];
  fonts: readonly Font[];
  slides: Map<string, Computed>;
};
/** Per presentation: what its record slides computed to, valid while its object, rev, media list and font list are the same. */
export type PlanCache = Map<string, PlanCacheEntry>;

/**
 * The plan's memory of one presentation: the slides' computed keys, valid while the presentation object, its rev and the
 * library's media and font lists are the same ones; a fresh (and remembered) map otherwise. A sweep, the checks around a
 * bake and the editor's refresh all go through it, so a key is worked out once and not at every check.
 */
export function cachedSlides(
  cache: PlanCache | undefined,
  p: Presentation,
  library: { media: readonly Media[]; fonts: readonly Font[] },
): Map<string, Computed> {
  let entry = cache?.get(p.id);
  if (
    !entry ||
    entry.presentation !== p ||
    entry.rev !== p.rev ||
    entry.media !== library.media ||
    entry.fonts !== library.fonts
  ) {
    entry = { presentation: p, rev: p.rev, media: library.media, fonts: library.fonts, slides: new Map() };
    cache?.set(p.id, entry);
  }
  return entry.slides;
}

export type WantCtx = {
  inputs: PlanInputs;
  listing: Listing | undefined;
  deps?: PlanDeps;
  /** The per-presentation computed slides (`cachedSlides`: the plan's memory; a fresh one otherwise). */
  slides?: Map<string, Computed>;
  /** Only this slide: the checks around a bake ask about one slide, never the presentation's every key. */
  only?: string;
};

function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function compute(p: Presentation, slide: Slide, inputs: PlanInputs, deps: PlanDeps): Computed {
  try {
    const keyOf = deps.keyOf ?? localKey;
    const easy = deps.easy ?? easyPlan;
    const record = deps.record ?? planRecord;
    // As both writers ask it: the presentation's kind and the library's media kind (Q25.c.b). A call without
    // `isMotion` would count every own background as an anchor and no slide with a background picture would ever
    // get its picture.
    const isMotion = (id: string): boolean | undefined => {
      const k = inputs.kindOf(id);
      return k === undefined ? undefined : k === 'video';
    };
    const opts: EasyOptions = { kind: p.kind, isMotion };
    if (!easy(slide, opts).eligible) return { eligible: false };
    if (!record(slide, opts).prerender) return { eligible: false };
    const live = [...(slide.prerender?.live ?? [])];
    const file = slide.prerender?.file;
    // a slide kept in a slide file is never keyed here
    if (file) return { eligible: true, form: 'file', file: { ref: file.ref, bytes: file.bytes }, live };
    const key = keyOf(slide, inputs);
    const images: Record<string, string> = {};
    for (const id of drawnMediaIds(slide)) {
      const h = inputs.mediaFile(id);
      if (h) images[id] = h;
    }
    return { eligible: true, form: 'inline', key, live, images };
  } catch (e) {
    // the name of the fault only: a message may quote the slide's text, which never goes into a log or a reason
    return { error: cut(`key: ${e instanceof Error ? e.name : 'fault'}`, 150) };
  }
}

/**
 * The statuses of a presentation's record slides and the items to make (H-W6: the only place that turns a
 * presentation into items; a Q24.c plate adds `plateItems` beside it). A generator: it yields between slides when
 * the slice (`BAKE_SLICE_MS`) is used up, so a library of thousands never takes a long task.
 */
export function* wantedSteps(
  p: Presentation,
  ctx: WantCtx,
  clock: { now: () => number; since: number } = { now: () => Date.now(), since: Date.now() },
): Generator<void, { statuses: SlideBake[]; items: BakeItem[] }> {
  const deps = ctx.deps ?? {};
  const statuses: SlideBake[] = [];
  const items: BakeItem[] = [];
  const known = ctx.slides ?? new Map<string, Computed>();
  for (const slide of recordSlides(p)) {
    if (ctx.only !== undefined && slide.id !== ctx.only) continue;
    let c = known.get(slide.id);
    if (!c) {
      c = compute(p, slide, ctx.inputs, deps);
      known.set(slide.id, c);
    }
    const base = { presentationId: p.id, slideId: slide.id, kind: 'slide' as const };
    if ('error' in c) {
      statuses.push({ ...base, state: 'failed', code: 'unknown', fix: 'ordo', reason: c.error });
    } else if (!c.eligible) {
      statuses.push({ ...base, state: 'none', reason: 'not-eligible' });
    } else {
      const key = c.form === 'file' ? listedKeyFor(ctx.listing, slide.id) : c.key;
      const r = classify({ slide, key: key ?? '', listing: key === undefined ? undefined : ctx.listing });
      statuses.push({
        ...base,
        state: r.state,
        ...(key !== undefined ? { key } : {}),
        sizes: r.sizes,
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
        ...(r.code ? { code: r.code } : {}),
        ...(r.fix ? { fix: r.fix } : {}),
        ...(r.waiting ? { waiting: r.waiting } : {}),
        ...(r.at !== undefined ? { at: r.at } : {}),
        ...(r.madeBy ? { madeBy: r.madeBy } : {}),
      });
      if (key !== undefined && r.state === 'queued' && !r.waiting && r.missingSizes.length > 0)
        items.push({
          kind: 'slide',
          presentationId: p.id,
          slideId: slide.id,
          key,
          live: c.live,
          missingSizes: r.missingSizes,
          slide,
          images: c.form === 'inline' ? c.images : {},
          ...(c.form === 'file' ? { file: { ref: c.file.ref, bytes: c.file.bytes, listedKey: key } } : {}),
        });
    }
    if (clock.now() - clock.since >= BAKE_SLICE_MS) {
      yield;
      clock.since = clock.now();
    }
  }
  return { statuses, items };
}

/** One presentation's statuses and items, planned at once (the Go-live check calls it, C-BW2). */
export function wantedItems(p: Presentation, ctx: WantCtx): { statuses: SlideBake[]; items: BakeItem[] } {
  const g = wantedSteps(p, ctx, { now: () => 0, since: 0 });
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

export type PlanInput = {
  presentations: readonly Presentation[];
  library: { media: readonly Media[]; fonts: readonly Font[] };
  /** The hub's listing by presentation id; undefined where it has not been read. */
  listings: Readonly<Record<string, Listing | undefined>>;
  playlists?: readonly Playlist[];
  focus?: BakeFocus;
  /** The presentation open in the route. */
  openId?: string;
  /** Kept by the caller between sweeps: a second sweep of the same inputs computes no key. */
  cache?: PlanCache;
};

export type SweepPlan = {
  /** One status per record slide of every presentation, in the order of the plan. */
  statuses: SlideBake[];
  /** What to make, in the order to make it. */
  items: BakeItem[];
  /** The presentations that have a record slide to look at and no listing yet. */
  needListing: string[];
};

/**
 * The plan of a whole sweep, as a generator that yields between slides (at most `BAKE_SLICE_MS` ms of work between
 * two yields); the plan is its return value.
 */
export function* planSweepSteps(input: PlanInput, deps: PlanDeps = {}): Generator<void, SweepPlan> {
  const now = deps.now ?? (() => Date.now());
  const clock = { now, since: now() };
  const inputs = slideInputs(input.library);
  const statuses: SlideBake[] = [];
  const items: BakeItem[] = [];
  const needListing: string[] = [];
  const seen = new Set<string>();
  const ordered = orderPresentations(
    (Array.isArray(input.presentations) ? input.presentations : []).filter(
      (p) => p && typeof p === 'object' && typeof p.id === 'string',
    ),
    { focus: input.focus, playlists: input.playlists, openId: input.openId },
  );
  for (const p of ordered) {
    seen.add(p.id);
    if (recordSlides(p).length === 0) {
      input.cache?.delete(p.id);
      continue;
    }
    const listing = input.listings[p.id];
    const got = yield* wantedSteps(
      p,
      { inputs, listing, deps, slides: cachedSlides(input.cache, p, input.library) },
      clock,
    );
    statuses.push(...got.statuses);
    items.push(...got.items);
    if (
      !listing &&
      got.statuses.some((s) => s.state !== 'none' && s.waiting !== 'pending' && s.state !== 'failed')
    )
      needListing.push(p.id);
  }
  if (input.cache) for (const id of [...input.cache.keys()]) if (!seen.has(id)) input.cache.delete(id);
  return { statuses, items, needListing };
}

/** The plan of a whole sweep at once. */
export function planSweep(input: PlanInput, deps: PlanDeps = {}): SweepPlan {
  const g = planSweepSteps(input, deps);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/**
 * The record slides of a presentation with no picture and no recorded failure (C-BW2), for the Go-live check. With
 * no listing it lists none: they are `unknown`, which is not the same as missing.
 */
export function missingPictures(
  p: Presentation,
  listing: Listing | undefined,
  inputs: PlanInputs,
  deps: PlanDeps = {},
): { missing: Slide[]; unknown: Slide[] } {
  const missing: Slide[] = [];
  const unknown: Slide[] = [];
  const got = wantedItems(p, { inputs, listing, deps });
  const byId = new Map(recordSlides(p).map((s) => [s.id, s] as const));
  for (const st of got.statuses) {
    const slide = byId.get(st.slideId);
    if (!slide) continue;
    if (st.state === 'queued' && st.waiting === 'hub-key') unknown.push(slide);
    else if (st.state === 'queued' && st.waiting === undefined) missing.push(slide);
  }
  return { missing, unknown };
}

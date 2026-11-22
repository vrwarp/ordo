import {
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Look,
  type Slide,
  type SlideObject,
  slideContent,
} from '@ordo/domain';
import { BAKE_MAX_OBJECTS, CLAMP, clampLook, clampSlide } from './clamp.ts';
import { digest } from './digest.ts';
import { decorPending } from './decor/files.ts';
import { geomAwaited } from './geom/stored.ts';
import { charged } from './geom/cost.ts';
import { drawnCost, withinDrawBudget } from './geombudget.ts';
import { type PictureSource, pictureTarget } from './picture.ts';
import { drawGeomShape } from './shape.ts';
import { drawObject, type ImageLookup, type UnderFrame } from './text2d.ts';
import {
  canvas2d,
  clearUnitUnmade,
  type FrameUnit,
  type GeomUnit,
  makeUnitPicture,
  markUnitUnmade,
  noteUnitWork,
  objectLeft,
  objectUnit,
  placedDigest,
  SLICE_MS,
  UNIT_CACHE_BYTES,
  UNIT_VERSION,
  type UnitRect,
  type UnitRun,
  unitCache,
  unitGeneration,
  type UnitLeft,
  slideUnitsLeft,
  unitUnmade,
} from './units.ts';
import { EFFECT_STEP_PIXELS } from './effects.ts';

/*
 * The underlay frame (design 29 section 2.3 R1, design/14 "The underlay frame"): a slide an output draws that
 * passes a count (more objects or more distinct pictures than the live clamp keeps), holds more pictures than a
 * screen prepares at once, or has effects past one frame of units, is split at one z-position into an UNDER part
 * (the bottom objects) and a DIRECT part (the top ones, within the counts). The direct part is drawn exactly as
 * every slide is, by `drawSlide2D` in one task. The under part is made once, in slices on the asset worker's
 * lanes, as one frame unit (`makeFrame`), kept in the unit cache like every unit and copied 1:1 under the direct
 * part in the same raster. Until it is ready the raster leaves it out and reports its key (`late`), and the late
 * job makes it and fades it in. The under part is a z-PREFIX, so the copy is exact for source-over drawing, and
 * the topmost objects, usually the words, are the ones on screen at once.
 *
 * This file holds the pure split and its constants; the frame unit's key and making follow below it.
 *
 * The whole-under variant (`wholeSplit`, sub-wave 3 bake-render): the pre-rendered picture of a slide (`bake.ts`) is
 * the whole slide drawn once, so its split holds EVERY drawn object under and nothing direct, whatever the counts and
 * whatever `setFrames` says. It is a `FrameSplit` like the live one, driven by the same step machine (`makeFrame`),
 * kept and keyed in the same unit cache, and `splitFrame`, `frameKey`, `makeFrame` and `underSlides` are exactly what
 * they were (bake.pins.test.ts pins them): the variant adds a second constructor beside the first, never a change
 * of the live frame's output or key.
 */

/** Objects the direct part holds at most: the live clamp's (`CLAMP.maxObjects`). */
export const FRAME_DIRECT_OBJECTS = CLAMP.maxObjects;
/** Distinct pictures the direct part holds at most: the live clamp's (`CLAMP.maxImagesPerSlide`). */
export const FRAME_DIRECT_IMAGES = CLAMP.maxImagesPerSlide;
/** Bytes of prepared pictures the direct part holds at most: one cue's bitmap budget (`CLAMP.maxCueBitmapBytes`). */
export const FRAME_DIRECT_BYTES = CLAMP.maxCueBitmapBytes;
/**
 * Distinct prepared picture draws the direct part holds at most: the output's prepared targets a cue keeps
 * (`PICTURE_LIMITS.maxPrepared`, apps/output/src/pictures.ts; held equal by a test there), so none of the
 * direct part's pictures is drawn from its source resampled.
 */
export const FRAME_DIRECT_TARGETS = 32;
/**
 * Whether rule (c) (`FRAME_DIRECT_TARGETS`) holds the direct part back of a slide that is within every other count
 * (objects, pictures, prepared bytes). Off, as M4 decided (design 29 live-frame step 6): of the 17 slides of the public
 * decks (shard0-2) that rule (c) alone would have split, 16 drew in 36 ms or less at 3840 at the base (their pictures are
 * small: 41-57 prepared draws, 0-21 MB) and the slide it was written for, Emoji_Parallel 7 (169 pictures, 15 prepared
 * draws, 118-136 ms), is not one: its time is 169 draws, not the target count. A slide past another count keeps rule (c).
 */
export const FRAME_TARGETS_WITHIN_COUNTS = false;
/** Objects a frame holds at most: the slide-file bound (design 29 A7), a hostile bound; the rest is cut and counted. */
export const FRAME_MAX_OBJECTS = BAKE_MAX_OBJECTS;
/** Frames in progress at most per thread (each holds a scratch canvas of the frame); the oldest is dropped. */
export const FRAME_WORK_MAX = 2;

let framesOn = true;

/**
 * Frames on (the default) or off (a venue troubleshooting switch: an output's `?frame=off`, wired by the asset
 * worker's init; `?effects=base` turns it off too): off, `splitFrame` splits nothing and every slide is drawn as it
 * was before the frame, cut at the live clamp.
 */
export function setFrames(on: boolean): void {
  framesOn = on;
}

/** Whether frames are on in this thread (`setFrames`). */
export function framesEnabled(): boolean {
  return framesOn;
}

/** Why the direct part stopped where it did: which rules held it back (a split taken for none is not made). */
export interface FrameWhy {
  /** More than `FRAME_DIRECT_OBJECTS` objects. */
  readonly objects: boolean;
  /** More than `FRAME_DIRECT_IMAGES` distinct pictures. */
  readonly images: boolean;
  /** More than `FRAME_DIRECT_TARGETS` distinct prepared picture draws. */
  readonly targets: boolean;
  /** More than `FRAME_DIRECT_BYTES` of prepared pictures. */
  readonly bytes: boolean;
  /** Units past `UNIT_SLIDE_AREAS` frames. */
  readonly area: boolean;
}

/** What `splitFrame` makes of a slide. */
export interface FrameSplit {
  /** The slide the split was made over (`clampSlide(.., 'bake')`). */
  readonly slide: Slide;
  /** The part drawn at once: the slide with the top objects, within the live clamp, as a clamped slide. */
  readonly direct: Slide;
  /** The part under it, bottom first: made once as the frame unit. */
  readonly under: readonly SlideObject[];
  /** Device px per logical px. */
  readonly scale: number;
  /** Where the frame is copied: the whole frame at `scale`, whole device px. */
  readonly rect: UnitRect;
  /** The frame's bitmap bytes. */
  readonly bytes: number;
  readonly why: FrameWhy;
  /**
   * Objects of the direct part the live clamp still cuts (a slide whose anchors hold more than the counts
   * above its lowest anchor: a playing video with more than 200 objects over it, design 29 E9, OQ-LF2).
   */
  readonly cut: number;
}

/** How a split is asked for. */
export interface FrameOptions {
  /** Ids of objects that stay in the direct part (design 29 `liveSet`: the live parts); the frame is below the lowest. */
  readonly anchors?: readonly string[];
  /** The slide's video plays in this object's box: it is an anchor. */
  readonly video?: { readonly objectId: string };
  /** The look the slide is drawn with: a look that does not draw it as authored is not split. */
  readonly look?: Look;
  /** Rule (c) also for a slide within every other count (default `FRAME_TARGETS_WITHIN_COUNTS`). */
  readonly targetsWithin?: boolean;
  /**
   * Rule (e), the direct part's units fit one frame of area (default true). Off for a draw a GO waits for (the asset
   * worker's live job): working it out plans every unit of the direct part, which that draw does once more with the
   * geometry files in (about 150 ms of a crowded line-art slide cold), so the slide is cut by (a) to (d) alone and
   * its late job works the full split out off the GO's path (`lateUnits`).
   */
  readonly area?: boolean;
}

/** The frame at `scale` in device px (the logical frame's, rounded up as units' is). */
export function frameSize(scale: number): { w: number; h: number } {
  return { w: Math.ceil(LOGICAL_WIDTH * scale - 1e-6), h: Math.ceil(LOGICAL_HEIGHT * scale - 1e-6) };
}

const splitMemo = new WeakMap<object, Map<string, FrameSplit | null>>();

/**
 * The split of `slide` at `scale` (device px per logical px), or undefined when the slide is drawn as it always was:
 * it fits the counts whole, the look does not draw it as authored, or frames are off (`setFrames`). Pure and
 * memoised by (slide, scale, anchors).
 *
 * The direct part is chosen from the TOP down, as many objects as satisfy every rule at once: (a) at most
 * `FRAME_DIRECT_OBJECTS` objects, (b) at most `FRAME_DIRECT_IMAGES` distinct pictures (the live clamp's rule),
 * (c) at most `FRAME_DIRECT_TARGETS` distinct prepared picture draws at `scale`, asked of a slide past another count
 * (`FRAME_TARGETS_WITHIN_COUNTS`; a picture with no target, turned or rounded without a mask, is drawn from the source
 * resampled and counts as one too), (d) the prepared targets' bytes within `FRAME_DIRECT_BYTES`, (e) the direct part's units fit one frame of area (`UNIT_SLIDE_AREAS`: none of
 * its objects is left to its legacy copy for want of it, `slideUnitsLeft` reports no 'area': r2a MUST c(2)). The
 * anchors are always direct: the frame is only objects below the lowest anchor, and a direct part that holds more
 * than the counts there is cut by the live clamp as it always was (`cut`). Rules (a) to (e) only ever add up, so the
 * direct part is the longest top-down run that satisfies them: as much as possible
 * is live at once, and the words come first. With `area: false` rule (e) is not asked (`FrameOptions.area`).
 */
export function splitFrame(slide: Slide, scale: number, opts: FrameOptions = {}): FrameSplit | undefined {
  if (!framesOn || !(Number.isFinite(scale) && scale > 0)) return undefined;
  if (opts.look && clampLook(opts.look).layers.slide.mode !== 'authored') return undefined;
  const anchors = [...(opts.anchors ?? []), ...(opts.video ? [opts.video.objectId] : [])];
  const bake = clampSlide(slide, 'bake');
  const area = opts.area !== false;
  const within = opts.targetsWithin ?? FRAME_TARGETS_WITHIN_COUNTS;
  const at = `${scale}|${anchors.join(',')}|${area ? 'a' : ''}${within ? 'w' : ''}`;
  let m = splitMemo.get(bake);
  if (!m) splitMemo.set(bake, (m = new Map()));
  const hit = m.get(at);
  if (hit !== undefined) return hit ?? undefined;
  const out = split(bake, scale, anchors, area, within);
  if (m.size >= 8) m.clear();
  m.set(at, out ?? null);
  return out;
}

function split(
  bake: Slide,
  scale: number,
  anchors: readonly string[],
  area: boolean,
  within: boolean,
): FrameSplit | undefined {
  const content = slideContent(bake);
  const objects = content.objects;
  const n = objects.length;
  if (n === 0) return undefined;
  const frame = frameSize(scale);
  const images = new Set<string>();
  const targets = new Map<string, number>();
  let bytes = 0;
  // The slide's own picture (a reference picture or an imported page) is one prepared draw of the whole frame.
  if (content.pictureMediaId) {
    targets.set(`${content.pictureMediaId}|frame`, 1);
    bytes += frame.w * frame.h * 4;
  }
  const why = { objects: false, images: false, targets: false, bytes: false, area: false };
  // Rule (c) is asked of a slide past another count only (`FRAME_TARGETS_WITHIN_COUNTS`): one within them all is drawn
  // as it always was, its pictures past the prepared targets from their sources.
  let ruleC = within;
  if (!ruleC) {
    const every = new Set<string>();
    const draws = new Set<string>();
    let all = content.pictureMediaId ? frame.w * frame.h * 4 : 0;
    for (const o of objects) {
      if (o.type !== 'image') continue;
      every.add(o.mediaId);
      const t = pictureTarget(o, scale);
      const key = t ? `${o.mediaId}|${t.key}` : `${o.mediaId}|source`;
      if (!draws.has(key)) {
        draws.add(key);
        all += t ? t.w * t.h * 4 : 0;
      }
    }
    ruleC = n > FRAME_DIRECT_OBJECTS || every.size > FRAME_DIRECT_IMAGES || all > FRAME_DIRECT_BYTES;
  }
  let start = n;
  for (let i = n - 1; i >= 0; i--) {
    const o = objects[i]!;
    // What adding `o` would do to each rule.
    let broke = false;
    if (n - i > FRAME_DIRECT_OBJECTS) {
      why.objects = true;
      broke = true;
    }
    let image = false;
    let key = '';
    let targetBytes = 0;
    if (o.type === 'image') {
      image = !images.has(o.mediaId);
      if (image && images.size >= FRAME_DIRECT_IMAGES) {
        why.images = true;
        broke = true;
      }
      const t = pictureTarget(o, scale);
      key = t ? `${o.mediaId}|${t.key}` : `${o.mediaId}|source`;
      if (!targets.has(key)) {
        targetBytes = t ? t.w * t.h * 4 : 0;
        if (ruleC && targets.size >= FRAME_DIRECT_TARGETS) {
          why.targets = true;
          broke = true;
        }
        if (bytes + targetBytes > FRAME_DIRECT_BYTES) {
          why.bytes = true;
          broke = true;
        }
      }
    }
    if (broke) break;
    start = i;
    if (image) images.add((o as { mediaId: string }).mediaId);
    if (key && !targets.has(key)) {
      targets.set(key, targetBytes);
      bytes += targetBytes;
    }
  }
  // (e) The direct part's units fit one frame of area (r2a MUST c(2)): no object of it is left to its legacy copy
  // for want of area (`slideUnitsLeft`). Units only ever add up, so the longest run that fits is found by
  // halving; a step down from there covers a slide whose areas do not quite add up.
  if (area && start < n) {
    const over = (at: number) =>
      slideUnitsLeft(at === 0 ? objects : objects.slice(at), scale).includes('area');
    if (over(start)) {
      let lo = start;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (over(mid)) lo = mid + 1;
        else hi = mid;
      }
      while (lo < n - 1 && over(lo)) lo++;
      start = lo;
      why.area = true;
    }
  }
  // The anchors stay direct: nothing below the lowest one is, but everything from it up is.
  if (anchors.length) {
    const ids = new Set(anchors);
    const low = objects.findIndex((o) => ids.has(o.id));
    if (low >= 0 && low < start) start = low;
  }
  // Nothing needs the frame: the slide is drawn as it always was.
  if (start <= 0) return undefined;
  // The top object stays direct whatever it costs alone (a frame of one object less would hold it).
  if (start >= n) start = n - 1;
  const under = objects.slice(0, start);
  const directObjects = objects.slice(start);
  const direct = clampSlide({ ...bake, objects: directObjects });
  const cut = directObjects.length - direct.objects.length;
  const rect: UnitRect = { x: 0, y: 0, w: frame.w, h: frame.h };
  return {
    slide: bake,
    direct,
    under,
    scale,
    rect,
    bytes: frame.w * frame.h * 4,
    why,
    cut,
  };
}

// ── The frame unit: key, resumable making ───────────────────────────────────────────────────────────────

/**
 * Time a frame may take at most, ms of its turns summed over every call that works on it (design 29 D12, set by
 * the bench of a 1,000- and a 20,000-object frame: `packages/renderer/bench/frame.ts`, never below ten seconds).
 * A frame past it is not made: the slide keeps its direct part, and the overrun is counted (`frameStats`).
 */
export const FRAME_BUDGET_MS = 10_000;

/** Whether `o` waits for a geometry, mask or decoration file not read yet: it draws nothing until then. */
function awaited(o: SlideObject): boolean {
  if (o.type === 'shape') return geomAwaited(o.geom) || (o.decor !== undefined && decorPending(o.decor));
  if (o.type === 'image') return geomAwaited(o.mask);
  return false;
}

const keyMemo = new WeakMap<FrameSplit, Map<string, string>>();

/**
 * The key of the frame of `split` under font epoch `epoch`: a digest of `UNIT_VERSION`, what each under object
 * draws (`placedDigest`: every drawn field and its position, a picture as its file, `setUnitMedia`), which of
 * them still wait for a file (a file that arrives gives a new key), the font epoch and the scale. Not the objects'
 * ids, origins or locks. The epoch is a count the caller bumps whenever a face finishes loading: a frame of
 * fallback glyphs is never copied for a slide whose face has arrived since.
 */
export function frameKey(split: FrameSplit, epoch = 0): string {
  const gen = unitGeneration();
  const at = `${epoch}|${gen}`;
  let m = keyMemo.get(split);
  if (!m) keyMemo.set(split, (m = new Map()));
  const hit = m.get(at);
  if (hit !== undefined) return hit;
  const parts: string[] = [];
  let waiting = '';
  split.under.forEach((o, i) => {
    parts.push(placedDigest(o));
    if (awaited(o)) waiting += `${i},`;
  });
  const key = `f${UNIT_VERSION}:${digest(`${UNIT_VERSION}|frame|${split.scale}|${epoch}|${waiting}|${parts.join(',')}`)}@${split.scale}`;
  if (m.size >= 8) m.clear();
  m.set(at, key);
  return key;
}

/** One picture a frame draws: the bitmaps the draw asks for and the hold on them. */
export interface FramePicture {
  /** What `drawObject` asks for its picture (and its prepared target). */
  readonly lookup: ImageLookup;
  /** Let go of the bitmaps once the draw call is done. */
  release(): void;
  /**
   * Set when the picture's file was not there (not cached yet, the hub did not serve it): the object is drawn
   * without it this time and the frame is marked incomplete until the file arrives (`FramePictures.arrived`).
   */
  readonly missing?: string;
}

/**
 * Where a frame's pictures come from (the output's implementation: `apps/output/src/prepare/frame.ts`). One
 * picture at a time: decoded and prepared at the object's size, held for its one draw call, released.
 */
export interface FramePictures {
  /** Decode and prepare what `o` draws at `scale`; throws when the job is cancelled. */
  acquire(o: Extract<SlideObject, { type: 'image' }>, scale: number): Promise<FramePicture>;
  /** Whether any of these missing files (`FramePicture.missing`) is there now. */
  arrived?(missing: readonly string[]): Promise<boolean>;
}

/** What a frame is made with. */
export interface FrameMakeOptions {
  readonly pictures?: FramePictures;
  /** The font epoch the key follows (`frameKey`). */
  readonly epoch?: number;
  /** The turn time a frame may take before it is dropped (default `FRAME_BUDGET_MS`): the bench measures past it. */
  readonly budgetMs?: number;
  /**
   * Told when one object's draw threw. The live frame passes none: it leaves the object out and goes on (a frame
   * that must not lose a slide). The bake passes one, because a picture must not be made with an object missing.
   */
  readonly onError?: (o: SlideObject, err: unknown) => void;
}

type FrameStep =
  | { readonly kind: 'plain'; readonly object: SlideObject }
  | { readonly kind: 'picture'; readonly object: Extract<SlideObject, { type: 'image' }> }
  | { readonly kind: 'unit'; readonly object: SlideObject; readonly unit: GeomUnit };

const stepMemo = new WeakMap<FrameSplit, { gen: number; steps: readonly FrameStep[] }>();

/**
 * What each under object is drawn by, in z-order (the frame draws each as if alone on its slide, so a budget the
 * whole slide shares never takes an effect from one): a picture through the picture provider, a shape or a
 * decoration past the budget by itself through its own unit (`objectUnit`: made in steps into a canvas that is
 * copied into the frame and let go), everything else with one draw call (an object past the budget that no unit
 * draws, a table or a chart, as its legacy copy, as it always was).
 */
function stepsOf(split: FrameSplit): readonly FrameStep[] {
  const gen = unitGeneration();
  const hit = stepMemo.get(split);
  if (hit && hit.gen === gen) return hit.steps;
  const steps: FrameStep[] = [];
  for (const o of split.under) steps.push(stepOf(o, split.scale));
  stepMemo.set(split, { gen, steps });
  return steps;
}

/** The step of one under object (see `stepsOf`). */
function stepOf(o: SlideObject, scale: number): FrameStep {
  if (o.type === 'image') return { kind: 'picture', object: o };
  const unit = objectUnit(o, scale);
  if (unit && unit.of !== 'prepared') return { kind: 'unit', object: o, unit };
  return { kind: 'plain', object: withinDrawBudget([o])[0] ?? o };
}

/** A plan in progress: the steps worked out so far and the next under object. */
const plans = new WeakMap<FrameSplit, { gen: number; steps: FrameStep[]; at: number }>();

/**
 * The steps of `split` worked out in turns of at most `SLICE_MS` / 2 and one object (about 7 us an object: a frame of
 * 20,000 objects was one turn of 130-170 ms), kept across a stopped call (a hurried or cancelled one plans on from
 * where it stopped) and memoised as `stepsOf`.
 */
async function planSteps(split: FrameSplit, run: UnitRun, now: () => number): Promise<readonly FrameStep[]> {
  const gen = unitGeneration();
  const hit = stepMemo.get(split);
  if (hit && hit.gen === gen) return hit.steps;
  let p = plans.get(split);
  if (!p || p.gen !== gen) plans.set(split, (p = { gen, steps: [], at: 0 }));
  const plan = p;
  const under = split.under;
  while (plan.at < under.length) {
    run.check();
    await run.slice(() => {
      const t0 = now();
      do {
        plan.steps.push(stepOf(under[plan.at]!, split.scale));
        plan.at++;
      } while (plan.at < under.length && now() - t0 < SLICE_MS / 2);
    });
  }
  plans.delete(split);
  stepMemo.set(split, { gen, steps: plan.steps });
  return plan.steps;
}

/** A frame being made: its scratch canvas of the frame, the next step, and the time spent. */
interface FrameWork {
  canvas: OffscreenCanvas;
  c: OffscreenCanvasRenderingContext2D;
  index: number;
  /** Turn time summed over every call (`FRAME_BUDGET_MS`). */
  ms: number;
  turns: number;
  steps: number;
  longestTurn: number;
  longestStep: number;
  /** Pictures that were not there (`FramePicture.missing`). */
  missing: Set<string>;
}

const works = new Map<string, FrameWork>();
/** Frames made without a picture that was not there yet, by key, and which: made again once it has arrived. */
const incomplete = new Map<string, string[]>();
const stats = { made: 0, over: 0, resumed: 0, longestTurn: 0, longestStep: 0 };

/**
 * Frames made, frames dropped past `FRAME_BUDGET_MS`, calls that resumed a stopped frame, and the longest turn and
 * the longest single step (ms) of any frame made or dropped, on this thread. The two longest are what M2 and M5
 * read (a turn is at most `SLICE_MS` / 2 plus one step; a step over 50 ms at 3840 is D11's).
 */
export function frameStats(): {
  made: number;
  over: number;
  resumed: number;
  longestTurn: number;
  longestStep: number;
} {
  return { ...stats };
}

/** Bytes of the scratch canvases of the frames in progress (at most `FRAME_WORK_MAX` of them). */
export function frameWorkBytes(): number {
  let b = 0;
  for (const w of works.values()) b += w.canvas.width * w.canvas.height * 4;
  return b;
}

/** The keys of the frames in progress, oldest first. */
export function frameWorkKeys(): string[] {
  return [...works.keys()];
}

/** Frames in progress. */
export function framesInProgress(): number {
  return works.size;
}

/** The progress of the frame under `key` (steps done), undefined when none is in progress. */
export function frameProgress(key: string): { done: number; ms: number } | undefined {
  const w = works.get(key);
  return w ? { done: w.index, ms: w.ms } : undefined;
}

/** Let go of the frame in progress under `key` (its slide left, its job ended, its key was replaced). */
export function dropFrameWork(key: string): void {
  works.delete(key);
}

/** Forget every frame in progress and every incomplete mark (tests, a cold measurement). */
export function clearFrameWork(): void {
  works.clear();
  incomplete.clear();
  stats.made = 0;
  stats.over = 0;
  stats.resumed = 0;
  stats.longestTurn = 0;
  stats.longestStep = 0;
}

/** Whether the frame under `key` was made without a picture that was not there. */
export function frameIncomplete(key: string): boolean {
  return incomplete.has(key);
}

/**
 * Copy `src` (a unit's canvas, `rect` of the frame) into `c` in bands of `EFFECT_STEP_PIXELS`, each a step of its
 * own: source-over, 1:1, the very pixels drawing the unit there gives.
 */
function copyBands(
  c: OffscreenCanvasRenderingContext2D,
  src: CanvasImageSource,
  rect: UnitRect,
): ((n: number) => void)[] {
  const rows = Math.max(1, Math.floor(EFFECT_STEP_PIXELS / Math.max(1, rect.w)));
  const out: ((n: number) => void)[] = [];
  for (let y0 = 0; y0 < rect.h; y0 += rows) {
    const n = Math.min(rows, rect.h - y0);
    out.push(() => {
      c.drawImage(src, 0, y0, rect.w, n, rect.x, rect.y + y0, rect.w, n);
      c.getImageData(rect.x, rect.y + y0, 1, 1);
    });
  }
  return out;
}

/** Draw `o` on the scratch with one call, a throw (hostile content) leaving it out. */
function drawStep(
  c: OffscreenCanvasRenderingContext2D,
  o: SlideObject,
  scale: number,
  images?: ImageLookup,
  onError?: (o: SlideObject, err: unknown) => void,
): void {
  try {
    drawObject(c as never, o, scale, images);
  } catch (err) {
    console.warn('[ordo frame] an object could not be drawn', err);
    onError?.(o, err);
  }
}

/**
 * The frame of `split` as a unit (`FrameUnit`) for `prepareSlideUnits`: ready when its key is in the unit cache and
 * complete, made in steps by `makeFrame`.
 */
export function frameUnit(split: FrameSplit, opts: FrameMakeOptions = {}): FrameUnit {
  const key = frameKey(split, opts.epoch ?? 0);
  return {
    key,
    bytes: split.bytes,
    async ready() {
      if (!unitCache.has('unit', key)) return false;
      const missing = incomplete.get(key);
      if (!missing) return true;
      // A picture that was not there when it was made: made again once any of them has arrived.
      if (!(await opts.pictures?.arrived?.(missing))) return true;
      incomplete.delete(key);
      unitCache.delete('unit', key);
      return false;
    },
    make: (run) => makeFrame(split, key, run, opts),
  };
}

/**
 * Make the frame of `split` under `key` in steps on `run`, one object a step (design 29 R1 "making"): a scratch
 * canvas of the frame, each under object drawn at the frame's own transform in z-order, a plain object with one
 * draw call, a picture through `pictures` (decoded and prepared one at a time, released after its draw call), an
 * object past the budget by itself through its own unit (`makeUnitPicture`, copied in in bands, then let go).
 * Turns of at most `SLICE_MS` / 2 on the clock of `run`, as `makeUnit` runs them; each ends with a one-pixel
 * read, so the canvas draws now and the step is the step's own time. The frame is kept in `unitCache`.
 *
 * RESUMABLE: its work (the scratch canvas and the next step) is kept by key, at most `FRAME_WORK_MAX` of them (the
 * oldest dropped), so a stopped, hurried or cancelled call (`run.check` throws between turns) leaves it and the next
 * call for the same key goes on at the step it stopped. Resolves with the longest turn (ms), undefined when no frame
 * could be made (no canvas, the cache refused it, past `FRAME_BUDGET_MS`): remembered as unmade, the slide keeps its
 * direct part.
 */
export async function makeFrame(
  split: FrameSplit,
  key: string,
  run: UnitRun,
  opts: FrameMakeOptions = {},
): Promise<number | undefined> {
  if (unitCache.has('unit', key)) return 0;
  const now = run.now ?? (() => performance.now());
  const steps = await planSteps(split, run, now);
  let w = works.get(key);
  if (w) {
    // Newest last: a third frame drops the oldest.
    works.delete(key);
    works.set(key, w);
    stats.resumed++;
  } else {
    const made = canvas2d(split.rect.w, split.rect.h);
    if (!made) return markUnitUnmade(key);
    w = {
      canvas: made.canvas,
      c: made.c,
      index: 0,
      ms: 0,
      turns: 0,
      steps: 0,
      longestTurn: 0,
      longestStep: 0,
      missing: new Set(),
    };
    works.set(key, w);
    while (works.size > FRAME_WORK_MAX) works.delete(works.keys().next().value!);
  }
  const work = w;
  const scale = split.scale;
  const turn = (t0: number) => {
    const t = now() - t0;
    work.ms += t;
    work.turns++;
    work.longestTurn = Math.max(work.longestTurn, t);
  };
  // Cancelled or hurried between turns (`run.check` throws): `work` stays in `works`, the next call resumes it.
  while (work.index < steps.length) {
    run.check();
    if (work.ms > (opts.budgetMs ?? FRAME_BUDGET_MS)) {
      works.delete(key);
      stats.over++;
      stats.longestTurn = Math.max(stats.longestTurn, work.longestTurn);
      stats.longestStep = Math.max(stats.longestStep, work.longestStep);
      return markUnitUnmade(key);
    }
    const st = steps[work.index]!;
    if (st.kind === 'picture') {
      // Its bitmap decoded and prepared off the turns (or in their own), one at a time.
      const pic = opts.pictures ? await opts.pictures.acquire(st.object, scale) : undefined;
      try {
        const t0 = now();
        await run.slice(() => {
          if (pic) drawStep(work.c, st.object, scale, pic.lookup, opts.onError);
          work.c.getImageData(0, 0, 1, 1);
        });
        work.longestStep = Math.max(work.longestStep, now() - t0);
        turn(t0);
        work.steps++;
        work.index++;
        if (pic?.missing) work.missing.add(pic.missing);
      } finally {
        pic?.release();
      }
    } else if (st.kind === 'unit') {
      const t1 = now();
      const made = await makeUnitPicture(st.unit, run);
      work.ms += now() - t1;
      if (!made) {
        // Not drawable here: its legacy copy, never left out.
        await run.slice(() => {
          drawStep(work.c, withinDrawBudget([st.object])[0] ?? st.object, scale, undefined, opts.onError);
          work.c.getImageData(0, 0, 1, 1);
        });
      } else {
        const copy = copyBands(work.c, made.picture as CanvasImageSource, st.unit.rect);
        for (const band of copy) {
          run.check();
          const t0 = now();
          await run.slice(() => band(0));
          work.longestStep = Math.max(work.longestStep, now() - t0);
          turn(t0);
        }
        if (st.unit.kind === 'layers' && st.object.type === 'shape')
          await run.slice(() => {
            drawGeomShape(work.c as never, st.object as never, scale, 'body');
            work.c.getImageData(0, 0, 1, 1);
          });
      }
      work.steps++;
      work.index++;
    } else {
      const t0 = now();
      await run.slice(() => {
        do {
          const t1 = now();
          drawStep(
            work.c,
            (steps[work.index] as { object: SlideObject }).object,
            scale,
            undefined,
            opts.onError,
          );
          work.index++;
          work.steps++;
          work.longestStep = Math.max(work.longestStep, now() - t1);
        } while (
          work.index < steps.length &&
          steps[work.index]!.kind === 'plain' &&
          now() - t0 < SLICE_MS / 2
        );
        work.c.getImageData(0, 0, 1, 1);
      });
      turn(t0);
    }
  }
  run.check();
  // Done: the scratch is the frame (the whole frame at its scale: nothing to copy), its bitmap taken from it.
  const bitmap = work.canvas.transferToImageBitmap();
  works.delete(key);
  const close = () => {
    const b = bitmap as { close?: () => void };
    if (typeof b.close === 'function') b.close();
  };
  const kept = unitCache.set('unit', key, {
    source: bitmap,
    w: split.rect.w,
    h: split.rect.h,
    bytes: split.bytes,
    close,
  });
  if (!kept) {
    close();
    return markUnitUnmade(key);
  }
  clearUnitUnmade(key);
  if (work.missing.size) incomplete.set(key, [...work.missing]);
  else incomplete.delete(key);
  stats.made++;
  stats.longestTurn = Math.max(stats.longestTurn, work.longestTurn);
  stats.longestStep = Math.max(stats.longestStep, work.longestStep);
  noteUnitWork(1, work.steps, work.turns);
  return work.longestTurn;
}

/** The frame's bitmap if it is in the cache. */
export function frameImage(key: string): CanvasImageSource | undefined {
  return unitCache.get('unit', key)?.source;
}

/** Whether the frame under `key` could not be made on this thread when last tried. */
export function frameUnmade(key: string): boolean {
  return unitUnmade(key);
}

/** The most bytes one frame may be (half of the unit cache: the cache refuses a bigger unit). */
export const FRAME_MAX_BYTES = UNIT_CACHE_BYTES / 2;

/** A picture source type re-exported for the provider's implementation. */
export type { PictureSource };

/**
 * The frame of `split` as the draw takes it (`SlideDrawOptions.under`): its key, its rect, its picture when it is in
 * the unit cache, and whether it could not be made here (`late` is not told then: the slide keeps its direct part).
 */
export function underFrame(split: FrameSplit, epoch = 0): UnderFrame {
  const key = frameKey(split, epoch);
  return {
    key,
    rect: split.rect,
    image: () => frameImage(key),
    unmade: () => frameUnmade(key),
  };
}

/**
 * The objects of the frame that get no unit and why (`UnitLeft`), for the census: an under object is drawn alone, so
 * none is ever left for want of area (r2a MUST c(2)); a table or a chart past its budget keeps its legacy copy
 * (`kind`), one sub-path past the per-call bound is `alone`.
 */
export function frameUnitsLeft(split: FrameSplit): UnitLeft[] {
  const out: UnitLeft[] = [];
  for (const o of split.under) {
    if (o.type === 'image') continue;
    const w = objectLeft(o, split.scale);
    if (w) out.push(w);
  }
  return out;
}

/**
 * What making the frame costs, in the units of `slideUnitsCost` (health reads the direct part only: the frame is
 * paid once at arm, in the lanes' turns, never in a raster): the drawing units of the under objects each drawn
 * alone, and the one frame the raster copies.
 */
export function frameCost(split: FrameSplit): { making: number; copy: number } {
  let making = 0;
  for (const st of stepsOf(split)) {
    const o = st.kind === 'unit' ? st.unit.drawn : st.object;
    making += charged(drawnCost(o));
  }
  return { making, copy: 1 };
}

const underMemo = new WeakMap<FrameSplit, readonly Slide[]>();

/**
 * The frame's objects cut into slides of the live counts (at most `FRAME_DIRECT_OBJECTS` objects and
 * `FRAME_DIRECT_IMAGES` distinct pictures each, in z-order), for the slide prepare steps (`PrepareJob.slides`): the
 * geometry and decoration files, the drawers and the table layouts of the frame's objects are made ready like those
 * of any slide, each step reading a slide within the counts it was built for.
 */
export function underSlides(split: FrameSplit): readonly Slide[] {
  const hit = underMemo.get(split);
  if (hit) return hit;
  const out: Slide[] = [];
  let chunk: SlideObject[] = [];
  let media = new Set<string>();
  const flush = () => {
    if (chunk.length) out.push(clampSlide({ id: `${split.slide.id}-under-${out.length}`, objects: chunk }));
    chunk = [];
    media = new Set();
  };
  for (const o of split.under) {
    const image = o.type === 'image' && !media.has(o.mediaId);
    if (chunk.length >= FRAME_DIRECT_OBJECTS || (image && media.size >= FRAME_DIRECT_IMAGES)) flush();
    chunk.push(o);
    if (o.type === 'image') media.add(o.mediaId);
  }
  flush();
  underMemo.set(split, out);
  return out;
}

/** The pictures the frame under `key` was made without because their files were not there (a hash or `media:id`). */
export function frameMissing(key: string): readonly string[] {
  return incomplete.get(key) ?? [];
}

// ── The whole-under variant (the bake's) ────────────────────────────────────────────────────────────────

/** How `wholeSplit` is asked for. */
export interface WholeOptions {
  /**
   * Ids of objects left out of the picture (the live set drawn above it: design 29 `liveSet`, the hook of Q24.a).
   * Default: the RAW slide's `prerender.live` (the clamped slide has no record: `clampSlide` builds it field by
   * field), else none. This release always passes `[]`.
   */
  readonly live?: readonly string[];
}

const wholeMemo = new WeakMap<object, Map<string, FrameSplit>>();

/** The ids of the raw slide's live set (`Slide.prerender.live`), strings only. */
function recordedLive(slide: Slide): string[] {
  const live = (slide as { prerender?: { live?: unknown } }).prerender?.live;
  return Array.isArray(live) ? live.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * The whole-under split of `slide` at `scale` (device px per logical px): every drawn object of the slide under
 * (`slideContent` of its bake clamp, bottom first, without the live set), nothing direct, the whole frame as its
 * rect. Unlike `splitFrame` it never returns nothing: a slide within the counts, an empty slide and a slide when
 * frames are off (`setFrames`) all have one, because the picture is the whole slide made once. At most
 * `FRAME_MAX_OBJECTS` objects (the bake clamp's: a raw slide past it is cut there and counted, `bakeCuts`; the
 * bake refuses it before it gets here). Pure and memoised by (slide, scale, live), at most 8 a slide as
 * `splitFrame`'s.
 */
export function wholeSplit(slide: Slide, scale: number, opts: WholeOptions = {}): FrameSplit {
  if (!(Number.isFinite(scale) && scale > 0))
    throw new RangeError('wholeSplit: scale must be a positive number');
  const bake = clampSlide(slide, 'bake');
  const live = opts.live ?? recordedLive(slide);
  const at = `${scale}|${JSON.stringify(live)}`;
  let m = wholeMemo.get(bake);
  if (!m) wholeMemo.set(bake, (m = new Map()));
  const hit = m.get(at);
  if (hit) return hit;
  const left = new Set(live);
  const under = slideContent(bake).objects.filter((o) => !left.has(o.id));
  const frame = frameSize(scale);
  const out: FrameSplit = {
    slide: bake,
    direct: clampSlide({ ...bake, objects: [] }),
    under,
    scale,
    rect: { x: 0, y: 0, w: frame.w, h: frame.h },
    bytes: frame.w * frame.h * 4,
    why: { objects: false, images: false, targets: false, bytes: false, area: false },
    cut: 0,
  };
  if (m.size >= 8) m.clear();
  m.set(at, out);
  return out;
}

/**
 * The indexes (into `split.under`) of the objects that wait for a geometry, mask or decoration file that is not read
 * yet: they draw nothing until it is, so a picture made now would lack them. The bake refuses to start while any
 * is (`files`); the frame's own key already carries them (`frameKey`), so one that arrives gives a new key.
 */
export function awaitedFiles(split: FrameSplit): readonly number[] {
  const out: number[] = [];
  split.under.forEach((o, i) => {
    if (awaited(o)) out.push(i);
  });
  return out;
}

/**
 * Forget everything the frame under `key` left: its work in progress, its incomplete mark, its unmade mark and its
 * unit-cache entry (the cache closes the bitmap). A bake calls it after every bake, made or not: a picture is a
 * one-off, and a stale frame under the same key would give back the same pixels without drawing (`makeFrame` returns
 * at once for a key that is in the cache).
 */
export function forgetFrame(key: string): void {
  works.delete(key);
  incomplete.delete(key);
  clearUnitUnmade(key);
  unitCache.delete('unit', key);
}

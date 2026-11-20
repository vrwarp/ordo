import {
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Look,
  type Slide,
  type SlideObject,
  slideContent,
} from '@ordo/domain';
import { BAKE_MAX_OBJECTS, CLAMP, clampLook, clampSlide } from './clamp.ts';
import { pictureTarget } from './picture.ts';
import { UNIT_SLIDE_AREAS, type UnitRect, unitOf } from './units.ts';

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
 * (c) at most `FRAME_DIRECT_TARGETS` distinct prepared picture draws at `scale` (a picture with no target, turned
 * or rounded without a mask, is drawn from the source resampled and counts as one too), (d) the prepared targets'
 * bytes within `FRAME_DIRECT_BYTES`, (e) the sum of its objects' stand-alone unit areas (`unitOf`: a conservative
 * bound) within `UNIT_SLIDE_AREAS` frames, so the direct part never leaves an effect to its legacy copy for want of
 * area (r2a MUST c(2)). The anchors are always direct: the frame is only objects below the lowest anchor, and a
 * direct part that holds more than the counts there is cut by the live clamp as it always was (`cut`). Rules (a)
 * to (e) only ever add up, so the direct part is the longest top-down run that satisfies them: as much as possible
 * is live at once, and the words come first.
 */
export function splitFrame(slide: Slide, scale: number, opts: FrameOptions = {}): FrameSplit | undefined {
  if (!framesOn || !(Number.isFinite(scale) && scale > 0)) return undefined;
  if (opts.look && clampLook(opts.look).layers.slide.mode !== 'authored') return undefined;
  const anchors = [...(opts.anchors ?? []), ...(opts.video ? [opts.video.objectId] : [])];
  const bake = clampSlide(slide, 'bake');
  const at = `${scale}|${anchors.join(',')}`;
  let m = splitMemo.get(bake);
  if (!m) splitMemo.set(bake, (m = new Map()));
  const hit = m.get(at);
  if (hit !== undefined) return hit ?? undefined;
  const out = split(bake, scale, anchors);
  if (m.size >= 8) m.clear();
  m.set(at, out ?? null);
  return out;
}

/** The area of `o`'s unit as if it were alone on its slide, in frames (0: it has none, or no area of its own). */
function unitArea(o: SlideObject, scale: number): number {
  const u = unitOf(o, scale, 'both');
  if (!u || u.bytes <= 0) return 0;
  const f = frameSize(scale);
  return (u.rect.w * u.rect.h) / (f.w * f.h);
}

function split(bake: Slide, scale: number, anchors: readonly string[]): FrameSplit | undefined {
  const content = slideContent(bake);
  const objects = content.objects;
  const n = objects.length;
  if (n === 0) return undefined;
  const frame = frameSize(scale);
  const images = new Set<string>();
  const targets = new Map<string, number>();
  let bytes = 0;
  let area = 0;
  // The slide's own picture (a reference picture or an imported page) is one prepared draw of the whole frame.
  if (content.pictureMediaId) {
    targets.set(`${content.pictureMediaId}|frame`, 1);
    bytes += frame.w * frame.h * 4;
  }
  const why = { objects: false, images: false, targets: false, bytes: false, area: false };
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
        if (targets.size >= FRAME_DIRECT_TARGETS) {
          why.targets = true;
          broke = true;
        }
        if (bytes + targetBytes > FRAME_DIRECT_BYTES) {
          why.bytes = true;
          broke = true;
        }
      }
    }
    const a = unitArea(o, scale);
    if (a > 0 && area + a > UNIT_SLIDE_AREAS + 1e-9) {
      why.area = true;
      broke = true;
    }
    if (broke) break;
    start = i;
    if (image) images.add((o as { mediaId: string }).mediaId);
    if (key && !targets.has(key)) {
      targets.set(key, targetBytes);
      bytes += targetBytes;
    }
    area += a;
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

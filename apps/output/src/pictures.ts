import {
  type BitmapCache,
  CLAMP,
  type PictureTarget,
  type SlidePicture,
  bitmapBytes,
  downscaleFor,
  pictureKey,
} from '@ordo/renderer';

/**
 * The pictures one cue draws, prepared for the asset worker's synchronous draw (design/27 §7.1, design/25
 * clamps). Pure apart from the decoder it is given, so it is unit tested with mocked bitmaps.
 *
 * - **One decode per file.** The uses are grouped by file: a file whose targets are not all cached is
 *   decoded once, every missing target is prepared from that decode (`preparePicture` of `@ordo/renderer`,
 *   as the fidelity harness prepares them), and the decode is closed. A slide that shows one photo 200 times
 *   at 200 sizes decodes it once, not 200 times. The decoder is told what the decode is for (`DecodeWant`),
 *   so it may decode only the visible crop at about its displayed size (crop-aware decode, design/27 §7.5).
 * - **Pinned while the cue holds them.** Every bitmap handed to the draw is pinned in the shared cache until
 *   `release()` (after the draw), so neither a later insert nor a prune arriving meanwhile closes it: drawing
 *   a closed bitmap throws and loses the whole slide. Pins are counted and each preload unpins only its own:
 *   the raster lanes run jobs side by side (lanes.ts).
 * - **Bounded.** At most `maxImages` files and `maxBytes` of bitmaps per cue (each distinct bitmap counted
 *   once), and at most `maxPrepared` prepared targets, below the cache's count. A target is checked against
 *   the budget before it is prepared (`w × h × 4`); one that would not fit, one past the count, and one the
 *   decoder cannot prepare are drawn from the source instead: the file reduced so that it still covers the
 *   output (`downscaleFor`), cached under the file's hash. Targets are cut to the canvas
 *   (`pictureTarget`), so a prepared bitmap is never larger than the output.
 * - **In steps.** Preparing a target is synchronous work on the worker's thread; it runs in the job's turns
 *   (`PreloadSteps.slice`), in bands where the decoder offers them (`prepareSteps`), and a cancelled job
 *   stops between them, closing its decode and unpinning what it pinned.
 * - What still does not fit is skipped (drawn without the picture) and counted.
 */

/** What the cache holds: an `ImageBitmap`, or a test's stand-in. */
export type Bitmap = { width: number; height: number; close(): void };

/**
 * What a decode is for: the targets that will be prepared from it, and whether the file is also drawn as
 * its source covering an output of `cover` (the whole picture is then needed at that scale).
 */
export type DecodeWant = { targets?: readonly PictureTarget[]; cover?: { w: number; h: number } };

/** The decoder: reads and decodes files, prepares targets and reduces sources. */
export interface PictureDecoder<B extends Bitmap> {
  /**
   * The file `hash` decoded at its own size, or (given what it is for) only the part `want` needs at the
   * scale it needs; throws when it cannot be read or decoded.
   */
  decode(hash: string, want?: DecodeWant): Promise<B>;
  /** The part of `src` that `t` shows, resampled into a new bitmap of `t.w` x `t.h`; undefined: no canvas. */
  prepare(src: B, t: PictureTarget): B | undefined;
  /** `prepare` in steps (bands); each `next()` is synchronous work, the last one returns the bitmap. */
  prepareSteps?(src: B, t: PictureTarget): Iterator<void, B | undefined, void>;
  /** `src` reduced to `w` x `h` (a new bitmap; `src` stays open). */
  reduce(src: B, w: number, h: number): Promise<B>;
  /** Whether a decode holds only part of its picture (it cannot be drawn as the source). */
  partial?(src: B): boolean;
}

export type PictureLimits = {
  /** Files per cue (`CLAMP.maxImagesPerSlide`). */
  maxImages: number;
  /** Bytes of bitmaps per cue (`CLAMP.maxCueBitmapBytes`). */
  maxBytes: number;
  /** Prepared targets per cue: below the cache's count, so one cue never fills it with pinned entries. */
  maxPrepared: number;
};

export const PICTURE_LIMITS: PictureLimits = {
  maxImages: CLAMP.maxImagesPerSlide,
  maxBytes: CLAMP.maxCueBitmapBytes,
  maxPrepared: 32,
};

/** How a job runs synchronous work (its turns in the raster lanes) and learns that it was cancelled. */
export type PreloadSteps = {
  slice<T>(fn: () => T): Promise<T>;
  check(): void;
};

/** Synchronous work at once, never cancelled (tests, the fidelity harness). */
export const INLINE_STEPS: PreloadSteps = { slice: async (fn) => fn(), check: () => undefined };

export type Preloaded<B extends Bitmap> = {
  /** The bitmap for a use: its prepared target, else the file's source; undefined: drawn without. */
  lookup: (id: string, target?: PictureTarget) => B | undefined;
  /** Uses left out by the budget. */
  skipped: number;
  /** Files that could not be read or decoded, with why. */
  failed: { hash: string; error: unknown }[];
  /** Decodes this preload made (each one a read and decode of a file). */
  decodes: number;
  /** Unpin the cue's bitmaps once the draw is done; the cache then trims back to its limits. */
  release: () => void;
};

/** Prepare one target in the job's turns, in bands when the decoder offers them. */
async function prepareIn<B extends Bitmap>(
  steps: PreloadSteps,
  decoder: PictureDecoder<B>,
  src: B,
  t: PictureTarget,
): Promise<B | undefined> {
  if (!decoder.prepareSteps) return steps.slice(() => decoder.prepare(src, t));
  const g = decoder.prepareSteps(src, t);
  let done = false;
  try {
    for (;;) {
      const r = await steps.slice(() => g.next());
      if (r.done) {
        done = true;
        return r.value;
      }
    }
  } finally {
    if (!done) g.return?.(undefined);
  }
}

/**
 * Prepare what a cue draws. `map`: media id → file hash; `uses`: what the draw asks for (`slidePictures`),
 * undefined for jobs that draw every image as its source (props). An image of `map` that no use names (a
 * next slide's, a logo) is decoded as the source. `output`: the canvas size in device pixels. `steps`: the
 * job's turns (lanes.ts); a `Cancelled` thrown there unpins and closes what this preload holds and is
 * thrown on.
 */
export async function preloadPictures<B extends Bitmap>(
  cache: BitmapCache<B>,
  decoder: PictureDecoder<B>,
  map: Readonly<Record<string, string>>,
  uses: readonly SlidePicture[] | undefined,
  output: { w: number; h: number },
  limits: PictureLimits = PICTURE_LIMITS,
  steps: PreloadSteps = INLINE_STEPS,
): Promise<Preloaded<B>> {
  // What the draw asks for, by media id: prepared targets by key, and whether the source is drawn.
  const wanted = new Map<string, { targets: Map<string, PictureTarget>; source: boolean }>();
  for (const u of uses ?? []) {
    let w = wanted.get(u.mediaId);
    if (!w) wanted.set(u.mediaId, (w = { targets: new Map(), source: false }));
    if (u.target) w.targets.set(u.target.key, u.target);
    else w.source = true;
  }
  // Bitmaps by `pictureKey(mediaId, target)` or media id, each distinct bitmap's bytes counted once.
  const out = new Map<string, B>();
  const counted = new Set<B>();
  const pins: string[] = [];
  let bytes = 0;
  let skipped = 0;
  let decodes = 0;
  let prepared = 0;
  let files = 0;
  const failed: { hash: string; error: unknown }[] = [];
  const fits = (b: number) => bytes + b <= limits.maxBytes;
  const take = (cacheKey: string, outKey: string, bmp: B): boolean => {
    const b = counted.has(bmp) ? 0 : bitmapBytes(bmp);
    if (!fits(b)) return false;
    cache.pin(cacheKey);
    pins.push(cacheKey);
    out.set(outKey, bmp);
    if (b) {
      counted.add(bmp);
      bytes += b;
    }
    return true;
  };
  const release = () => {
    for (const k of pins.splice(0)) cache.unpin(k);
  };

  try {
    for (const [mediaId, hash] of Object.entries(map)) {
      if (files >= limits.maxImages) {
        skipped++;
        continue;
      }
      steps.check();
      const w = wanted.get(mediaId) ?? { targets: new Map<string, PictureTarget>(), source: true };
      let any = false;
      let needSource = w.source;
      // Cached targets are taken; the others are prepared within the count and the budget, reserved here.
      const missing: PictureTarget[] = [];
      let reserved = 0;
      for (const t of w.targets.values()) {
        const key = pictureKey(hash, t);
        const hit = cache.get(key);
        if (hit) {
          if (take(key, pictureKey(mediaId, t), hit)) any = true;
          else needSource = true;
          continue;
        }
        // Past the count, or not within the budget at its size: drawn from the source.
        if (prepared + missing.length >= limits.maxPrepared || !fits(reserved + t.w * t.h * 4)) {
          needSource = true;
          continue;
        }
        missing.push(t);
        reserved += t.w * t.h * 4;
      }
      let full: B | undefined;
      /** What `full` was decoded for: a scaled or cropped decode may not serve as the source. */
      let fullCovers = false;
      let broken = false;
      const decoded = async (want: DecodeWant): Promise<B | undefined> => {
        if (!full && !broken) {
          try {
            full = await decoder.decode(hash, want);
            fullCovers = !!want.cover && !decoder.partial?.(full);
            decodes++;
            steps.check();
          } catch (error) {
            if (isCancel(error)) throw error;
            broken = true;
            failed.push({ hash, error });
          }
        }
        return full;
      };
      try {
        if (missing.length) {
          const cover = needSource && !cache.has(hash) ? output : undefined;
          const src = await decoded({ targets: missing, ...(cover ? { cover } : {}) });
          if (src)
            for (const t of missing) {
              const key = pictureKey(hash, t);
              // Another job may have prepared it meanwhile: its bitmap is taken, this one not made.
              const ready = cache.get(key) ?? (await prepareIn(steps, decoder, src, t));
              if (!ready) {
                needSource = true; // no canvas to prepare it on
                continue;
              }
              prepared++;
              const held = cache.set(key, ready);
              if (take(key, pictureKey(mediaId, t), held)) any = true;
              else needSource = true;
            }
        }
        if (needSource && !broken) {
          let bmp = cache.get(hash);
          if (!bmp) {
            // A decode made for targets only (scaled for them, or a crop) is not the source: decoded again.
            if (full && !fullCovers) {
              full.close();
              full = undefined;
            }
            const src = await decoded({ cover: output });
            if (src) {
              const down = downscaleFor(src.width, src.height, output.w, output.h);
              if (down) {
                bmp = await decoder.reduce(src, down.width, down.height);
                steps.check();
              } else {
                bmp = src;
                full = undefined; // kept as the source: not closed below
              }
              bmp = cache.set(hash, bmp);
            }
          }
          if (bmp) {
            if (take(hash, mediaId, bmp)) any = true;
            else skipped++;
          }
        }
      } finally {
        // The full decode is not kept: what the cue draws is prepared or reduced from it.
        (full as B | undefined)?.close();
      }
      if (any) files++;
    }
  } catch (err) {
    release();
    throw err;
  }

  return {
    lookup: (id, target) => (target && out.get(pictureKey(id, target))) || out.get(id),
    skipped,
    failed,
    decodes,
    release,
  };
}

/** Whether an error is a lane's cancellation (lanes.ts `Cancelled`), which is never a decode failure. */
function isCancel(err: unknown): boolean {
  return err instanceof Error && err.name === 'Cancelled';
}

/**
 * One file as its source (a full-frame image cue): cached under its hash, reduced to cover the output, and
 * pinned until `release` (the draw runs in a later turn of the job, lanes.ts).
 */
export async function sourcePicture<B extends Bitmap>(
  cache: BitmapCache<B>,
  decoder: PictureDecoder<B>,
  hash: string,
  output: { w: number; h: number },
  steps: PreloadSteps = INLINE_STEPS,
): Promise<{ bitmap: B; release: () => void }> {
  const pinned = (bitmap: B) => {
    cache.pin(hash);
    let done = false;
    return {
      bitmap,
      release: () => {
        if (done) return;
        done = true;
        cache.unpin(hash);
      },
    };
  };
  const hit = cache.get(hash);
  if (hit) return pinned(hit);
  const src = await decoder.decode(hash, { cover: output });
  let bmp = src;
  try {
    steps.check();
    const down = downscaleFor(src.width, src.height, output.w, output.h);
    if (down) {
      bmp = await decoder.reduce(src, down.width, down.height);
      try {
        steps.check();
      } catch (err) {
        bmp.close();
        throw err;
      }
    }
  } catch (err) {
    src.close();
    throw err;
  } finally {
    if (bmp !== src) src.close();
  }
  return pinned(cache.set(hash, bmp));
}

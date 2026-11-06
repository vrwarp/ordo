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
 *   at 200 sizes decodes it once, not 200 times.
 * - **Pinned while the cue holds them.** Every bitmap handed to the draw is pinned in the shared cache until
 *   `release()` (after the draw), so neither a later insert of the same preload nor a prune arriving
 *   meanwhile closes it: drawing a closed bitmap throws and loses the whole slide.
 * - **Bounded.** At most `maxImages` files and `maxBytes` of bitmaps per cue (each distinct bitmap counted
 *   once), and at most `maxPrepared` prepared targets, below the cache's count. A target is checked against
 *   the budget before it is prepared (`w × h × 4`); one that would not fit, one past the count, and one the
 *   decoder cannot prepare are drawn from the source instead: the file reduced so that it still covers the
 *   output (`downscaleFor`), cached under the file's hash. Targets are cut to the canvas
 *   (`pictureTarget`), so a prepared bitmap is never larger than the output.
 * - What still does not fit is skipped (drawn without the picture) and counted.
 */

/** What the cache holds: an `ImageBitmap`, or a test's stand-in. */
export type Bitmap = { width: number; height: number; close(): void };

/** The decoder: reads and decodes files, prepares targets and reduces sources. */
export interface PictureDecoder<B extends Bitmap> {
  /** The file `hash` decoded at its own size; throws when it cannot be read or decoded. */
  decode(hash: string): Promise<B>;
  /** The part of `src` that `t` shows, resampled into a new bitmap of `t.w` x `t.h`; undefined: no canvas. */
  prepare(src: B, t: PictureTarget): B | undefined;
  /** `src` reduced to `w` x `h` (a new bitmap; `src` stays open). */
  reduce(src: B, w: number, h: number): Promise<B>;
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

export type Preloaded<B extends Bitmap> = {
  /** The bitmap for a use: its prepared target, else the file's source; undefined: drawn without. */
  lookup: (id: string, target?: PictureTarget) => B | undefined;
  /** Uses left out by the budget. */
  skipped: number;
  /** Files that could not be read or decoded, with why. */
  failed: { hash: string; error: unknown }[];
  /** Decodes this preload made (each one a full read and decode of a file). */
  decodes: number;
  /** Unpin the cue's bitmaps once the draw is done; the cache then trims back to its limits. */
  release: () => void;
};

/**
 * Prepare what a cue draws. `map`: media id → file hash; `uses`: what the draw asks for (`slidePictures`),
 * undefined for jobs that draw every image as its source (props). An image of `map` that no use names (a
 * next slide's, a logo) is decoded as the source. `output`: the canvas size in device pixels.
 */
export async function preloadPictures<B extends Bitmap>(
  cache: BitmapCache<B>,
  decoder: PictureDecoder<B>,
  map: Readonly<Record<string, string>>,
  uses: readonly SlidePicture[] | undefined,
  output: { w: number; h: number },
  limits: PictureLimits = PICTURE_LIMITS,
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
    out.set(outKey, bmp);
    if (b) {
      counted.add(bmp);
      bytes += b;
    }
    return true;
  };

  for (const [mediaId, hash] of Object.entries(map)) {
    if (files >= limits.maxImages) {
      skipped++;
      continue;
    }
    const w = wanted.get(mediaId) ?? { targets: new Map<string, PictureTarget>(), source: true };
    let full: B | undefined;
    let broken = false;
    const decoded = async (): Promise<B | undefined> => {
      if (!full && !broken) {
        try {
          full = await decoder.decode(hash);
          decodes++;
        } catch (error) {
          broken = true;
          failed.push({ hash, error });
        }
      }
      return full;
    };
    let any = false;
    let needSource = w.source;
    try {
      for (const t of w.targets.values()) {
        const key = pictureKey(hash, t);
        const hit = cache.get(key);
        if (hit) {
          if (take(key, pictureKey(mediaId, t), hit)) any = true;
          else needSource = true;
          continue;
        }
        // Past the count, or not within the budget at its size: drawn from the source.
        if (prepared >= limits.maxPrepared || !fits(t.w * t.h * 4)) {
          needSource = true;
          continue;
        }
        const src = await decoded();
        if (!src) break;
        const ready = decoder.prepare(src, t);
        if (!ready) {
          needSource = true; // no canvas to prepare it on
          continue;
        }
        prepared++;
        cache.set(key, ready);
        if (take(key, pictureKey(mediaId, t), ready)) any = true;
        else needSource = true;
      }
      if (needSource && !broken) {
        let bmp = cache.get(hash);
        if (!bmp) {
          const src = await decoded();
          if (src) {
            const down = downscaleFor(src.width, src.height, output.w, output.h);
            if (down) bmp = await decoder.reduce(src, down.width, down.height);
            else {
              bmp = src;
              full = undefined; // kept as the source: not closed below
            }
            cache.set(hash, bmp);
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

  return {
    lookup: (id, target) => (target && out.get(pictureKey(id, target))) || out.get(id),
    skipped,
    failed,
    decodes,
    release: () => cache.unpinAll(),
  };
}

/** One file as its source (a full-frame image cue): cached under its hash, reduced to cover the output. */
export async function sourcePicture<B extends Bitmap>(
  cache: BitmapCache<B>,
  decoder: PictureDecoder<B>,
  hash: string,
  output: { w: number; h: number },
): Promise<B> {
  const hit = cache.get(hash);
  if (hit) return hit;
  const src = await decoder.decode(hash);
  const down = downscaleFor(src.width, src.height, output.w, output.h);
  let bmp = src;
  if (down) {
    try {
      bmp = await decoder.reduce(src, down.width, down.height);
    } finally {
      src.close();
    }
  }
  cache.set(hash, bmp);
  return bmp;
}

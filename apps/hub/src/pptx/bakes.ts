/**
 * Baked pictures of a native import (design/27 §4 "Pictures", §15 M6 "Recolour and tile bakes"): each
 * recoloured picture (duotone, clrChange, grayscl, biLevel, lum, PowerPoint's recolour presets) and each tiled
 * picture fill the converter lists (`EmitResult.media` entries with a `bake`, `@ordo/pptx-scene` `bake.ts`)
 * becomes a new prepared picture, an ordinary ready media item, so those pictures are drawn natively by every
 * build, older ones included.
 *
 * - **Key.** A bake is named by `bakeKey(part, bake)` behind `BAKE_KEY_PREFIX` (a key no part name is): the
 *   job keeps it in the same maps and resume pairs as part names (`PptxNativeProgress.media`).
 * - **Size.** A recoloured picture is made at the size the source would be prepared at for its display need
 *   (`targetSize`); a tiled fill at its box's display need (the box at 3840 px wide), its height by the box's
 *   aspect. Both within `BAKE_LIMITS` (8,192 px a side, 16 MP), so the pool task's input and output stay
 *   within 64 MB each.
 * - **Steps.** The source's header is checked as any picture's (`checkSource`); ffmpeg decodes it to RGBA at
 *   the size the bake reads (its demuxer forced, the decode bounded by the header's size, as preparation
 *   runs it); the pool task `pptx-bake` applies the bake and encodes a PNG (`bakeTask.ts`, 60 s, the pool's
 *   heap); an opaque bake of a JPEG source is stored as a JPEG. Decoded megapixels count against the
 *   import's picture budget.
 * - **Dedup.** The derived picture's identity is SHA-256 of the source's hash and the recipe: stored as the
 *   item's `source` hash, so a re-import finds the baked item without decoding anything; the content hash
 *   deduplicates as for every prepared picture.
 * - **Failure** (a source the header check refuses, a decode or pool error, the budget): the bake is listed in
 *   `failed` with ordo's own reason; the job then shows the source picture as it is, without the effect.
 */
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Media } from '@ordo/domain';
import { newId } from '@ordo/domain';
import { BAKE_LIMITS, bakeKey, type PictureBake, tileSourceSize } from '@ordo/pptx-scene/bake.ts';
import { errorMessage } from '../errors.ts';
import { type PictureInputFormat, pictureFile } from '../media/ffmpeg.ts';
import type { CpuPool } from '../pool.ts';
import { hashFile } from '../store.ts';
import { findMedia } from './mediaParts.ts';
import {
  addReadyPicture,
  checkSource,
  PICTURE_LIMITS,
  type PictureBudget,
  PictureError,
  type PreparedPicture,
  readPictureHeader,
  targetSize,
} from './pictures.ts';
import type { PptxDeps } from './shared.ts';

/** What a bake's key starts with: a NUL, which no part name of the deck's maps holds. */
export const BAKE_KEY_PREFIX = '\u0000bake:';

/** The key of a bake in the job's part maps and resume pairs. */
export function bakeMapKey(part: string, bake: PictureBake): string {
  return BAKE_KEY_PREFIX + bakeKey(part, bake);
}

/** One bake of an import: its key, the source part's spilled file, the recipe and its display need in px. */
export type BakeItem = { key: string; part: string; file: string; bake: PictureBake; need: number };

export type StoreBakesOptions = {
  dir: string;
  timeoutMs: number;
  signal: AbortSignal;
  budget: PictureBudget;
  /** Resume pairs [key, media id] (the job's `done.media`); each new pair is appended before `save`. */
  done: [string, string][];
  save(): void;
  name(part: string): string;
  tags: string[];
  log(msg: string): void;
};

export type StoreBakesResult = {
  /** Key → media id of every bake stored, found or resumed. */
  media: Map<string, string>;
  /** Keys that could not be baked, with ordo's own reason. */
  failed: [string, string][];
  baked: number;
  reused: number;
};

/** A need within the prepared limits (`pictures.ts` `clampNeed`). */
function needPx(px: number): number {
  if (!Number.isFinite(px)) return PICTURE_LIMITS.side;
  return Math.min(PICTURE_LIMITS.side, Math.max(PICTURE_LIMITS.minNeed, Math.ceil(px)));
}

/** A size within `BAKE_LIMITS`, its aspect kept. */
function bounded(w: number, h: number): { width: number; height: number } {
  const k = Math.min(1, BAKE_LIMITS.side / Math.max(w, h), Math.sqrt(BAKE_LIMITS.pixels / (w * h)));
  return { width: Math.max(1, Math.floor(w * k)), height: Math.max(1, Math.floor(h * k)) };
}

/** The output size of a bake for a source of `w` x `h` px and a display need of `need` px. */
export function bakeSize(
  bake: PictureBake,
  w: number,
  h: number,
  need: number,
): { width: number; height: number } {
  if (bake.tile) {
    const W = needPx(need);
    return bounded(W, Math.max(1, Math.round(W * bake.tile.aspect)));
  }
  const t = targetSize(w, h, need);
  return bounded(t.width, t.height);
}

/** The identity of a derived picture: SHA-256 of its source's hash and its recipe (a `source` hash). */
export function bakeHash(sourceHash: string, bake: PictureBake): string {
  return createHash('sha256')
    .update(`ordo-bake\n${sourceHash}\n${JSON.stringify(bake)}`)
    .digest('hex');
}

const DECODABLE: ReadonlySet<string> = new Set(['png', 'jpeg', 'gif', 'webp', 'bmp', 'tiff']);

/** One bake: found already, or decoded, baked on the pool and stored. */
async function bakeOne(
  deps: PptxDeps,
  pool: Pick<CpuPool, 'run'>,
  item: BakeItem,
  opts: StoreBakesOptions,
): Promise<{ media: Media; reused: boolean }> {
  const h = await readPictureHeader(item.file);
  checkSource(h);
  if (!DECODABLE.has(h.format) || (h.format === 'webp' && h.animated))
    throw new PictureError('a picture of this kind is not baked');
  const { hash } = await hashFile(item.file);
  const derived = bakeHash(hash, item.bake);
  const out = bakeSize(item.bake, h.width, h.height, item.need);
  const found = findMedia(
    deps,
    derived,
    'source',
    (m) => m.kind === 'image' && m.state === 'ready' && m.width === out.width && m.height === out.height,
  )[0];
  if (found) return { media: found, reused: true };
  const read = item.bake.tile ? tileSourceSize(item.bake.tile, out) : out;
  opts.budget.spend((h.width * h.height) / 1e6);
  if (opts.signal.aborted) throw new Error('cancelled');
  const raw = join(opts.dir, `${newId()}.rgba`);
  const png = join(opts.dir, `${newId()}.png`);
  const scratch = [raw];
  try {
    await pictureFile(item.file, raw, {
      input: h.format as PictureInputFormat,
      width: read.width,
      height: read.height,
      output: 'rgba',
      alpha: true,
      decoded: { width: h.width, height: h.height },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const data = new Uint8Array(await readFile(raw));
    await rm(raw, { force: true });
    if (data.length !== read.width * read.height * 4)
      throw new PictureError('the decoded picture is not the size asked for');
    const baked = await pool.run(
      'pptx-bake',
      {
        source: { width: read.width, height: read.height, channels: 4, data },
        bake: item.bake,
        ...(item.bake.tile ? { out } : {}),
        format: h.format,
      },
      { signal: opts.signal, transfer: [data.buffer as ArrayBuffer] },
    );
    await writeFile(png, baked.png);
    let picture: PreparedPicture = {
      path: png,
      ext: 'png',
      mime: 'image/png',
      width: baked.width,
      height: baked.height,
      hasAlpha: baked.alpha,
      sourceHash: derived,
      notes: [],
    };
    if (!baked.alpha && h.format === 'jpeg') {
      // A photo stays a JPEG: the PNG of a recoloured photo is several times its size.
      const jpg = join(opts.dir, `${newId()}.jpg`);
      scratch.push(png);
      await pictureFile(png, jpg, {
        input: 'png',
        width: baked.width,
        height: baked.height,
        output: 'jpg',
        alpha: false,
        decoded: { width: baked.width, height: baked.height },
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
      picture = { ...picture, path: jpg, ext: 'jpg', mime: 'image/jpeg' };
    }
    const media = await addReadyPicture(deps, picture, { name: opts.name(item.part), tags: opts.tags });
    return { media, reused: false };
  } finally {
    for (const f of scratch) await rm(f, { force: true });
  }
}

/**
 * Store an import's baked pictures, each once, with resume pairs (as `storePictures` stores its pictures).
 * Never throws for one bake: it is listed in `failed` and the job shows the source picture instead.
 */
export async function storeBakes(
  deps: PptxDeps,
  pool: Pick<CpuPool, 'run'>,
  items: readonly BakeItem[],
  opts: StoreBakesOptions,
): Promise<StoreBakesResult> {
  const res: StoreBakesResult = { media: new Map(), failed: [], baked: 0, reused: 0 };
  for (const [key, id] of opts.done) {
    if (!key.startsWith(BAKE_KEY_PREFIX)) continue;
    const m = deps.lib.media.get(id);
    if (m && m.kind === 'image' && m.state !== 'failed') res.media.set(key, id);
  }
  try {
    for (const item of items) {
      if (opts.signal.aborted) throw new Error('cancelled');
      if (res.media.has(item.key)) continue;
      try {
        const got = await bakeOne(deps, pool, item, opts);
        res.media.set(item.key, got.media.id);
        opts.done.push([item.key, got.media.id]);
        if (got.reused) res.reused++;
        else res.baked++;
      } catch (e) {
        if (opts.signal.aborted) throw e;
        const own = e instanceof PictureError ? e.message.slice(0, 300) : 'it could not be baked';
        const detail = e instanceof PictureError ? e.detail : errorMessage(e);
        if (detail) deps.log.warn({ part: item.part, err: detail.slice(0, 2_000) }, 'pptx picture not baked');
        res.failed.push([item.key, own]);
        opts.log(`[warn] ${item.part}: ${own}; it is drawn without its effects or tiles`);
      }
    }
  } finally {
    opts.save();
  }
  return res;
}

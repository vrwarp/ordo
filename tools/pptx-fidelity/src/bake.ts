/**
 * Baked pictures in the native column (design/27 §4 "Pictures", M6): what the hub's pool task `pptx-bake`
 * makes of a recoloured picture or a tiled fill, made here so the harness draws the slides as the hub stores
 * them. The source is decoded by ffmpeg (its demuxer forced by the sniffed format, files only, as the hub
 * runs it) to RGBA at the size the bake needs, `@ordo/pptx-scene` `applyBake` does the pixels, and the result
 * is written as a PNG.
 */
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { applyBake, BAKE_LIMITS, type PictureBake, tileSourceSize } from '@ordo/pptx-scene/bake.ts';
import { rasterPng } from './png.ts';

const run = promisify(execFile);

const DEMUXER: Readonly<Record<string, string>> = {
  png: 'png_pipe',
  jpeg: 'jpeg_pipe',
  gif: 'gif',
  webp: 'webp_pipe',
  bmp: 'bmp_pipe',
};

/** A size within the bake limits, scaled down with its aspect kept. */
export function bounded(
  w: number,
  h: number,
  widest: number = BAKE_LIMITS.side,
): { width: number; height: number } {
  const k = Math.min(1, widest / Math.max(w, h), Math.sqrt(BAKE_LIMITS.pixels / (w * h)));
  return { width: Math.max(1, Math.floor(w * k)), height: Math.max(1, Math.floor(h * k)) };
}

/** `src` (of sniffed `type`) decoded to RGBA at exactly `width` x `height`. */
async function decode(src: string, type: string, width: number, height: number, scratch: string) {
  const demuxer = DEMUXER[type];
  if (!demuxer) throw new Error(`no decoder for ${type}`);
  const out = `${scratch}.rgba`;
  try {
    await run(
      'ffmpeg',
      [
        ...['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe'],
        ...['-f', demuxer, '-i', src, '-frames:v', '1'],
        ...[
          '-vf',
          `scale=${width}:${height}:flags=lanczos,format=rgba`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgba',
          out,
        ],
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    const data = new Uint8Array(await readFile(out));
    if (data.length !== width * height * 4) throw new Error('ffmpeg gave the wrong number of pixels');
    return { width, height, data };
  } finally {
    await rm(out, { force: true });
  }
}

/**
 * The baked picture of `src` (`size` its pixel size): recoloured at its own size (within the limits), or a
 * tiled fill over `box` px (the widest box the slides draw it in, at 3840 px density). Writes `dest`.
 */
export async function bakePicture(
  src: string,
  type: string,
  size: { w: number; h: number },
  bake: PictureBake,
  box: { w: number; h: number } | undefined,
  dest: string,
): Promise<void> {
  if (bake.tile) {
    const w = Math.max(16, Math.round((box?.w ?? 960) * 2));
    const out = bounded(w, Math.max(1, Math.round(w * bake.tile.aspect)));
    const at = tileSourceSize(bake.tile, out);
    const raster = await decode(src, type, at.width, at.height, dest);
    await writeFile(dest, rasterPng(applyBake(raster, bake, out, type)));
    return;
  }
  const at = bounded(size.w, size.h, 4096);
  const raster = await decode(src, type, at.width, at.height, dest);
  await writeFile(dest, rasterPng(applyBake(raster, bake, undefined, type)));
}

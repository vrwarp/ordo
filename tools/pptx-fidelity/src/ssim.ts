import { readFile } from 'node:fs/promises';
import { run } from '../../../apps/hub/src/media/tools.ts';

/** The width pictures are scored at: a slide at 960x540. */
export const SSIM_WIDTH = 960;

/** A PNG's size from its header. */
export async function pngSize(file: string): Promise<{ w: number; h: number } | undefined> {
  const b = await readFile(file);
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** A region of a page, in the second picture's px. */
export type SsimRegion = { x: number; y: number; w: number; h: number };

/** A whole number of px within 0..max (NaN is 0). */
const px = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(Number.isFinite(v) ? v : 0)));

/**
 * SSIM of two pictures in greyscale at 960x540 (ffmpeg). The reference `a` is first cut to the other's
 * proportions: LibreOffice rounds a slide up to a whole pixel (1921x1080, 1440x811), a blank last column
 * or row.
 *
 * With `region`, only that part of both pages is scored, at the scale a whole page is scored at (the page's
 * width to 960): the score the slide's SSIM gives that region, which is how the preset golden scores one shape's
 * box. The region is in `b`'s px and is cut from both pictures at the same place (`a` drawn at the same scale,
 * as LibreOffice's 1921x1080 page is with ordo's 1920x1080).
 */
export async function ssim(a: string, b: string, region?: SsimRegion): Promise<number> {
  const size = await pngSize(b);
  let filters: string;
  if (region && size) {
    const x = px(region.x, size.w - 1);
    const y = px(region.y, size.h - 1);
    const w = Math.max(1, px(region.w, size.w - x));
    const h = Math.max(1, px(region.h, size.h - y));
    const s = SSIM_WIDTH / size.w;
    const sw = Math.max(8, Math.round(w * s));
    const sh = Math.max(8, Math.round(h * s));
    const cut = `crop=${w}:${h}:${x}:${y},scale=${sw}:${sh}:flags=area,format=gray`;
    filters = `[0:v]${cut}[a];[1:v]${cut}[b];[a][b]ssim`;
  } else {
    const ratio = size ? `${size.w}/${size.h}` : '';
    const crop = size ? `crop='min(iw,trunc(ih*${ratio}+0.5))':'min(ih,trunc(iw/(${ratio})+0.5))':0:0,` : '';
    filters = `[0:v]${crop}scale=960:540:flags=area,format=gray[a];[1:v]scale=960:540:flags=area,format=gray[b];[a][b]ssim`;
  }
  const args = ['-hide_banner', '-nostats', '-i', a, '-i', b, '-lavfi', filters, '-f', 'null', '-'];
  const r = await run('ffmpeg', args, { timeoutMs: 60_000 });
  const m = /All:([0-9.]+)/.exec(r.stderr);
  return m ? Number(m[1]) : 0;
}

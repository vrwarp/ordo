import { LOOK_MAIN, type Slide } from '@ordo/domain';
// Registers the decoration drawer with the shape dispatch.
import { withDirectDecor } from './index.ts';
import { showcaseSlide } from './test-util.ts';
import { clearEffectCache } from '../effects.ts';
import { rasterSlide } from '../raster.ts';
import { clearSpriteCache } from '../spritecache.ts';

/*
 * Browser side of decor.browser.test.ts (design/27 M9, decor-render; plan §4 exit): the 60-shape showcase
 * (`decor.test-util.ts`), without shadows and with 12, drawn as separate shapes and as one decoration (shape
 * by shape, `withDirectDecor`)
 * through `rasterSlide`, as the asset worker draws a slide, at 1920 and 3840 px wide, compared channel by
 * channel in premultiplied levels (getImageData unpremultiplies, so a pixel of alpha 1 carries any colour);
 * the decoration through its sprite against the same decoration drawn shape by shape, and the sprite's cached
 * copy against its first draw.
 */

/**
 * A comparison: the largest difference and the pixels past the tolerance, over the interior (pixels whose 3 x 3
 * neighbourhood is flat in both pictures) and over the edges (the rest), with the edges' mean difference.
 */
export type DiffResult = {
  name: string;
  max: number;
  over: number;
  pixels: number;
  interiorMax: number;
  edgeMax: number;
  edgeMean: number;
  edgeOver: number;
  edges: number;
};

function draw(
  slide: Slide,
  w: number,
  h: number,
  opts: { direct?: boolean; dx?: number; cold?: boolean; scale?: number } = {},
) {
  if (opts.cold !== false) {
    clearEffectCache();
    clearSpriteCache();
  }
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (opts.dx) ctx.translate(opts.dx, opts.dx);
  const run = () => rasterSlide(ctx as never, slide, LOOK_MAIN, opts.scale ?? w / 1920, () => undefined);
  if (opts.direct) withDirectDecor(run);
  else run();
  return ctx.getImageData(0, 0, w, h).data;
}

/** A pixel's channels in premultiplied levels. */
function pm(buf: Uint8ClampedArray, i: number, k: number): number {
  return k === 3 ? buf[i * 4 + 3]! : (buf[i * 4 + k]! * buf[i * 4 + 3]!) / 255;
}

/** Whether a pixel's 3 x 3 neighbourhood is flat (within 2 levels of it in every channel). */
function flat(buf: Uint8ClampedArray, i: number, w: number, h: number): boolean {
  const x = i % w;
  const y = (i - x) / w;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx;
      const Y = y + dy;
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const j = Y * w + X;
      for (let k = 0; k < 4; k++) if (Math.abs(pm(buf, i, k) - pm(buf, j, k)) > 2) return false;
    }
  return true;
}

/**
 * Two RGBA buffers of `w` x `h` compared in premultiplied levels (see `DiffResult`); `shift`: `b` is `a` moved
 * by that many pixels right and down.
 */
function diff(
  name: string,
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  w: number,
  tol = 2,
  shift = 0,
): DiffResult {
  const n = a.length / 4;
  const h = n / w;
  const out: DiffResult = {
    name,
    max: 0,
    over: 0,
    pixels: n,
    interiorMax: 0,
    edgeMax: 0,
    edgeMean: 0,
    edgeOver: 0,
    edges: 0,
  };
  let edgeSum = 0;
  for (let i = 0; i < n; i++) {
    const x = i % w;
    const y = (i - x) / w;
    if (x + shift >= w || y + shift >= h) continue;
    const j = (y + shift) * w + x + shift;
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(pm(a, i, k) - pm(b, j, k)));
    const r = Math.round(d);
    if (r > out.max) out.max = r;
    if (r > tol) out.over++;
    if (r === 0) continue;
    if (flat(a, i, w, h) && flat(b, j, w, h)) out.interiorMax = Math.max(out.interiorMax, r);
    else {
      out.edges++;
      edgeSum += r;
      out.edgeMax = Math.max(out.edgeMax, r);
      if (r > tol) out.edgeOver++;
    }
  }
  out.edgeMean = out.edges ? Math.round((edgeSum / out.edges) * 100) / 100 : 0;
  return out;
}

function run(): DiffResult[] {
  const out: DiffResult[] = [];
  for (const [w, h] of [
    [1920, 1080],
    [3840, 2160],
  ] as const) {
    // Shape by shape: the drawer against the shapes drawn one by one, without shadows and with 12.
    const plain = draw(showcaseSlide('shapes', 0), w, h);
    const plainDecor = draw(showcaseSlide('decor', 0), w, h, { direct: true });
    out.push(diff(`60 shapes vs one decoration at ${w}`, plain, plainDecor, w));
    const shapes = draw(showcaseSlide('shapes'), w, h);
    const direct = draw(showcaseSlide('decor'), w, h, { direct: true });
    out.push(diff(`60 shapes with 12 shadows vs one decoration at ${w}`, shapes, direct, w));
    // Through its sprite (12 shadowed shapes: past 4): a gradient is dithered by its device position, so the
    // sprite, drawn at another place of another canvas, differs from the direct drawing by a level or two.
    // Drawn once (directly), then again: the sprite is made and drawn.
    const slide = showcaseSlide('decor');
    draw(slide, w, h);
    const sprite = draw(slide, w, h, { cold: false });
    out.push(diff(`decoration sprite vs direct at ${w}`, sprite, direct, w));
    // The cached sprite copied again equals its first draw: a 1:1 copy.
    const again = draw(slide, w, h, { cold: false });
    out.push(diff(`decoration sprite cached copy at ${w}`, sprite, again, w, 0));
  }
  return out;
}

(globalThis as unknown as { __decor: () => DiffResult[] }).__decor = run;

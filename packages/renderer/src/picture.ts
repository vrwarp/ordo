import { type Box, type ImageCrop, LOGICAL_HEIGHT, LOGICAL_WIDTH, type ShapeGeom } from '@ordo/domain';

import { CLAMP, clampBox, clampCrop, clampMask, num } from './clamp.ts';
import type { Ctx2D } from './ctx.ts';

/**
 * Pictures prepared at their displayed device size (design/27 §7.1 "Decode target").
 *
 * Drawing a picture at any size other than its bitmap's makes Chromium's rasterizer resample it on every
 * draw, and a picture that kept an embedded colour profile is converted to sRGB on every draw as well: a
 * full-slide photo costs 4-5 ms at 1920 and 17-23 ms at 3840 that way (46 ms with a profile), against
 * 0.7 and 2.7 ms for a 1:1 copy. So the decoders (the output's asset worker, the fidelity harness) resample
 * the visible part of each picture once into an sRGB bitmap covering the box's device rectangle in whole
 * pixels, upscaling included, and the drawers copy it 1:1 there. Only the part of the box on the canvas
 * (the logical 1920x1080 frame at the drawing scale) is prepared, so a prepared bitmap is never larger
 * than the output, however far a picture overflows the slide.
 *
 * The bitmap is the device size even where that enlarges the source (a small tile stretched over the
 * slide), not min(native, device): enlarging on every draw is what costs the 4-5 ms per full-slide picture
 * above. The decoders bound the bytes per cue instead and draw the source when a prepared bitmap would not
 * fit (`apps/output` pictures.ts).
 *
 * Inside the bitmap the picture keeps its exact sub-pixel position and size, so it lands where the source
 * path puts it. Rounding the box to whole pixels (as LibreOffice's `DrawTransformedBitmapEx` does, after
 * quantising positions to 1/100 mm) was measured too: moving pictures by up to half a pixel lowered 141 of
 * the 924 slides of worship shard 0 against LibreOffice, by up to 0.024 SSIM, against 24 slides by at
 * most 0.005 with the exact position.
 *
 * A rotated picture and one with round corners, a mask or a flip keep being drawn from the source through
 * the transform and the clip path (`drawImageFit`).
 */

export type PictureFit = 'contain' | 'cover' | 'stretch';

/**
 * How a picture is cut and mirrored in its box (design/27 §3.1 `ImageObject.mask`, `flipH`, `flipV`):
 * mirrored about the box's centre before the box's rotation, mask included.
 */
export type PictureShape = { mask?: ShapeGeom; flipH?: boolean; flipV?: boolean };

/** What a picture's pixels depend on besides its source: an `ImageObject`, or a frame-filling picture. */
export type PictureDraw = { box: Box; fit: PictureFit; crop?: ImageCrop; radius?: number } & PictureShape;

/** OOXML roundRect's default `adj`: the corner radius in 1/100,000 of the shorter side. */
export const ROUND_RECT_ADJ = 16_667;

/**
 * The outline a picture is cut to in its `w` x `h` box (logical px), as every drawer cuts it (the 2D
 * drawers, the editor and the video plane, `scene.ts`): an 'ellipse' mask is the box's ellipse; a
 * 'roundRect' mask is a rect with corners of its 'adj' share (0..50,000) of the shorter side; another
 * preset is the box itself until M6 draws presets; without a preset the box with `radius` corners.
 */
export function pictureCut(
  o: { radius?: number; mask?: ShapeGeom },
  w: number,
  h: number,
): { kind: 'rect' | 'ellipse'; radius: number } {
  const mask = clampMask(o.mask);
  if (mask?.preset === 'ellipse') return { kind: 'ellipse', radius: 0 };
  if (mask?.preset === 'roundRect') {
    let adj = ROUND_RECT_ADJ;
    for (const [name, v] of mask.adj ?? []) if (name === 'adj') adj = num(v, 0, 50_000, ROUND_RECT_ADJ);
    const side = Math.min(Math.abs(w), Math.abs(h));
    return { kind: 'rect', radius: Number.isFinite(side) ? (side * adj) / 100_000 : 0 };
  }
  if (mask?.preset !== undefined) return { kind: 'rect', radius: 0 };
  return { kind: 'rect', radius: num(o.radius, 0, CLAMP.maxRadius, 0) };
}

/** Whether a picture is cut or mirrored beyond its box and `radius` (it is then drawn from its source). */
export function isShapedPicture(o: PictureShape): boolean {
  return o.flipH === true || o.flipV === true || clampMask(o.mask)?.preset !== undefined;
}

/**
 * The device pixels a picture is prepared for and copied to: the box's device rectangle widened to whole
 * pixels and cut to the canvas (`x`, `y` and the size `w` x `h`), the box relative to them (an overflowing
 * box starts left of or above them), and the fit and crop the pixels are made with.
 */
export type PictureTarget = {
  x: number;
  y: number;
  w: number;
  h: number;
  fit: PictureFit;
  /** The clamped crop (`clampCrop`); undefined when it cuts nothing. */
  crop?: ImageCrop;
  /** The box in the bitmap's pixels: its exact device position less (x, y), and its device size. */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  /**
   * Identifies the prepared pixels for one source: size, offset of the box in them, fit and crop, not the
   * whole-pixel position (the same box moved by whole pixels, inside the canvas, shares them). Decoders key
   * their caches by the file and this.
   */
  key: string;
};

/** The largest picture prepared (16 MP, design/27 §7.1); a larger box is drawn from the source as before. */
export const MAX_PREPARED_PIXELS = 16_000_000;

/** The fit `drawImageFit` applies for a value: 'stretch', 'contain', else 'cover'. */
export function pictureFit(fit: unknown): PictureFit {
  return fit === 'stretch' || fit === 'contain' ? fit : 'cover';
}

/**
 * The device pixels a picture is prepared for at `scale` (device px per logical px): undefined for a rotated
 * box, round corners, a mask or a flip (a clip path and a mirror), an empty box, one entirely off the canvas
 * or one over `MAX_PREPARED_PIXELS`. Those are drawn from the source as before. Edges within 1e-6 px of a pixel boundary
 * are taken as on it, so float noise never widens a box by a pixel.
 */
export function pictureTarget(o: PictureDraw, scale: number): PictureTarget | undefined {
  if (!(Number.isFinite(scale) && scale > 0)) return undefined;
  const box = clampBox(o.box);
  if (box.rotation) return undefined;
  if (num(o.radius, 0, CLAMP.maxRadius, 0) > 0 || isShapedPicture(o)) return undefined;
  const snap = (v: number) => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v);
  const x0 = snap(box.x * scale);
  const y0 = snap(box.y * scale);
  const x1 = snap((box.x + box.w) * scale);
  const y1 = snap((box.y + box.h) * scale);
  // The canvas: the logical frame at this scale, in whole pixels.
  const cw = Math.ceil(snap(LOGICAL_WIDTH * scale));
  const ch = Math.ceil(snap(LOGICAL_HEIGHT * scale));
  const x = Math.max(0, Math.floor(x0));
  const y = Math.max(0, Math.floor(y0));
  const w = Math.min(cw, Math.ceil(x1)) - x;
  const h = Math.min(ch, Math.ceil(y1)) - y;
  if (!(w >= 1 && h >= 1 && x1 > x0 && y1 > y0) || w * h > MAX_PREPARED_PIXELS) return undefined;
  const bx = x0 - x;
  const by = y0 - y;
  const bw = x1 - x0;
  const bh = y1 - y0;
  const fit = pictureFit(o.fit);
  const crop = clampCrop(o.crop);
  const key = `${w}x${h} ${bx} ${by} ${bw} ${bh} ${fit}${crop ? ` ${crop.l} ${crop.t} ${crop.r} ${crop.b}` : ''}`;
  const t = { x, y, w, h, fit, bx, by, bw, bh, key };
  return crop ? { ...t, crop } : t;
}

/** Bitmaps `preparePicture` made: the key of the target each was made for, and its source's size. */
const prepared = new WeakMap<object, { key: string; w: number; h: number }>();

/** The target key a bitmap was prepared for (`preparePicture`), else undefined: a source. */
export function preparedKey(img: CanvasImageSource): string | undefined {
  return typeof img === 'object' && img !== null ? prepared.get(img)?.key : undefined;
}

/** A picture's own pixel size (an image's, a bitmap's or a video's), 0 when it has none. */
function ownSize(img: CanvasImageSource): [number, number] {
  return [
    (img as { width?: number }).width || (img as HTMLVideoElement).videoWidth || 0,
    (img as { height?: number }).height || (img as HTMLVideoElement).videoHeight || 0,
  ];
}

/**
 * The size a picture is fitted with, as `paintPicture` fits it from its source: for a bitmap
 * `preparePicture` made, which holds only what one box shows at that box's device size, the size of the
 * source it was made from; for any other picture its own. What the video plane fits a clip of unknown size
 * with (the poster's size, design/27 §7.2), whichever of the two the image lookup hands back. Raw numbers:
 * 0 (or whatever the image says) when it has none; callers clamp.
 */
export function sourceSize(img: CanvasImageSource): [number, number] {
  const p = typeof img === 'object' && img !== null ? prepared.get(img) : undefined;
  return p ? [p.w, p.h] : ownSize(img);
}

/**
 * Where a decoded bitmap's pixels lie in the picture it was decoded from (design/27 §7.5 crop-aware decode):
 * the bitmap holds the rectangle (`x`, `y`, `w`, `h`) of an `iw` x `ih` picture, all in the picture's own
 * pixels, resampled to the bitmap's size. A decoder that decodes only the visible crop of a large photo at
 * about its displayed size (a JPEG at 1/8 to 4/8 of its size, `apps/output` decode.ts) hands this on, and the
 * picture is laid out as if the whole picture had been decoded: crop shares, fit and the source's size refer
 * to the picture, not the bitmap.
 */
export type PictureFrom = { iw: number; ih: number; x: number; y: number; w: number; h: number };

/**
 * Device pixels a preparation draws per step (`preparePictureSteps`): 2 MiB-pixels, so a 1080p target is one
 * step and a 4K one four. Measured in headless Chromium 153 (software canvas, a loaded 4-core container): a
 * 24 MP photo prepared for a full 4K frame took 70-150 ms as one task, and 14-50 ms per quarter.
 */
export const PREPARE_STEP_PIXELS = 1 << 21;

/**
 * Resample the part of `src` that `t` shows into a new sRGB bitmap of exactly `t.w` x `t.h` (colour profile
 * applied once), laid out and clipped as `drawImageFit` lays the source out in the box: transparent where
 * the fit or a negative crop share leaves the box uncovered, edge pixels the box covers in part blended as
 * the source path blends them. Undefined when no 2D context can be had; the caller then draws the source.
 * `from`: `src` holds only part of the picture, or holds it at another size (`PictureFrom`).
 *
 * Smoothing is 'medium' (bilinear, mipmapped when reducing), the closest Chromium has to LibreOffice's bitmap
 * scaling (bilinear when enlarging, area-averaging when reducing): over the sermon decks and worship shard 0
 * it scored higher than 'high' on 58 slides and lower on 3 (by at most 0.0007), and above 'low' in the mean.
 * The canvas is CPU-backed (`willReadFrequently`) like the asset worker's surface, so drawing the bitmap
 * there never reads a texture back.
 */
export function preparePicture(
  src: CanvasImageSource,
  t: PictureTarget,
  from?: PictureFrom,
): ImageBitmap | undefined {
  const steps = preparePictureSteps(src, t, from, Number.POSITIVE_INFINITY);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * `preparePicture` in steps: each `next()` draws one band of at most `stepPixels` device pixels (whole rows)
 * and the last one also takes the bitmap, so the asset worker's raster lanes can let a props job run between
 * two bands of a large picture (design/27 §7.5). The bands are clipped at whole rows, so the bitmap is the
 * one `preparePicture` makes, byte for byte (`asset.lanes.browser.test.ts`). Abandoning the generator drops
 * the canvas.
 */
export function* preparePictureSteps(
  src: CanvasImageSource,
  t: PictureTarget,
  from?: PictureFrom,
  stepPixels = PREPARE_STEP_PIXELS,
): Generator<void, ImageBitmap | undefined, void> {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  const canvas = new OffscreenCanvas(t.w, t.h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!ctx) return undefined;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  const rows = Math.max(1, Math.floor(stepPixels / t.w));
  if (rows >= t.h) {
    ctx.beginPath();
    ctx.rect(t.bx, t.by, t.bw, t.bh);
    ctx.clip();
    paintTarget(ctx, src, t, from);
  } else {
    for (let y = 0; y < t.h; y += rows) {
      if (y > 0) yield;
      ctx.save();
      ctx.beginPath();
      ctx.rect(t.bx, t.by, t.bw, t.bh);
      ctx.clip();
      ctx.beginPath();
      ctx.rect(0, y, t.w, Math.min(rows, t.h - y));
      ctx.clip();
      paintTarget(ctx, src, t, from);
      ctx.restore();
    }
  }
  const bmp = canvas.transferToImageBitmap();
  const [w, h] = from ? [from.iw, from.ih] : ownSize(src);
  prepared.set(bmp, { key: t.key, w, h });
  return bmp;
}

function paintTarget(ctx: Ctx2D, src: CanvasImageSource, t: PictureTarget, from?: PictureFrom): void {
  if (from) paintPictureFrom(ctx, src, from, t.bx, t.by, t.bw, t.bh, t.fit, t.crop);
  else paintPicture(ctx, src, t.bx, t.by, t.bw, t.bh, t.fit, t.crop);
}

/**
 * How `paintPicture` lays a picture of `iw` x `ih` out in the device rectangle (bx, by, bw, bh): the cropped
 * rect in picture pixels (`sx`, `sy`, `sw`, `sh`; it reaches past the picture where a share is negative),
 * where it lands (`dx`, `dy`, `dw`, `dh`), device pixels per picture pixel (`kx`, `ky`) and the part of the
 * picture drawn (`x0`..`x1`, `y0`..`y1`). Undefined when the crop leaves nothing.
 */
export type PictureLayout = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  kx: number;
  ky: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export function pictureLayout(
  iw: number,
  ih: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  fit: PictureFit,
  c: ImageCrop | undefined,
): PictureLayout | undefined {
  let sx = 0;
  let sy = 0;
  let sw = iw;
  let sh = ih;
  if (c) {
    sx = c.l * iw;
    sy = c.t * ih;
    sw = (1 - c.l - c.r) * iw;
    sh = (1 - c.t - c.b) * ih;
    if (!(sw > 0 && sh > 0)) return undefined;
  }
  let dw = bw;
  let dh = bh;
  if (fit !== 'stretch') {
    const s = fit === 'contain' ? Math.min(bw / sw, bh / sh) : Math.max(bw / sw, bh / sh);
    dw = sw * s;
    dh = sh * s;
  }
  const dx = bx + (bw - dw) / 2;
  const dy = by + (bh - dh) / 2;
  const x0 = Math.max(sx, 0);
  const y0 = Math.max(sy, 0);
  const x1 = Math.min(sx + sw, iw);
  const y1 = Math.min(sy + sh, ih);
  if (!(x1 > x0 && y1 > y0)) return undefined;
  return { sx, sy, sw, sh, dx, dy, dw, dh, kx: dw / sw, ky: dh / sh, x0, y0, x1, y1 };
}

/**
 * The part of an `iw` x `ih` picture that target `t` shows (in the picture's pixels: what lies inside the
 * box and on the canvas), and the device pixels per picture pixel it is shown at (`scale`, the larger of the
 * two axes). Undefined when nothing of it is visible.
 */
export function pictureRegion(
  t: PictureTarget,
  iw: number,
  ih: number,
): { x: number; y: number; w: number; h: number; scale: number } | undefined {
  if (!(iw > 0 && ih > 0)) return undefined;
  const l = pictureLayout(iw, ih, t.bx, t.by, t.bw, t.bh, t.fit, t.crop);
  if (!l || !(l.kx > 0 && l.ky > 0) || !Number.isFinite(l.kx) || !Number.isFinite(l.ky)) return undefined;
  // The device window: the box (the clip) on the target's canvas.
  const X0 = Math.max(t.bx, 0);
  const Y0 = Math.max(t.by, 0);
  const X1 = Math.min(t.bx + t.bw, t.w);
  const Y1 = Math.min(t.by + t.bh, t.h);
  const x0 = Math.max(l.x0, l.sx + (X0 - l.dx) / l.kx);
  const y0 = Math.max(l.y0, l.sy + (Y0 - l.dy) / l.ky);
  const x1 = Math.min(l.x1, l.sx + (X1 - l.dx) / l.kx);
  const y1 = Math.min(l.y1, l.sy + (Y1 - l.dy) / l.ky);
  if (!(x1 > x0 && y1 > y0)) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, scale: Math.max(l.kx, l.ky) };
}

/**
 * What a decoder needs to decode for `targets` of one `iw` x `ih` picture: the union of their regions
 * (`pictureRegion`, in the picture's pixels, not padded) and the largest scale any of them shows it at.
 * Undefined when none shows anything.
 */
export function decodePlan(
  targets: readonly PictureTarget[],
  iw: number,
  ih: number,
): { x: number; y: number; w: number; h: number; scale: number } | undefined {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  let scale = 0;
  for (const t of targets) {
    const r = pictureRegion(t, iw, ih);
    if (!r) continue;
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
    scale = Math.max(scale, r.scale);
  }
  if (!(x1 > x0 && y1 > y0 && scale > 0)) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, scale };
}

/**
 * Draw `img` fitted into the device rectangle (bx, by, bw, bh) as `fit` and the clamped `crop` say,
 * without clipping: `cover` overflows the rectangle. `crop` first cuts a share of the picture from each
 * side (a negative share extends it with transparency); only the part of the cropped rect that lies on the
 * picture is drawn, with the 9-argument `drawImage`, and a crop that leaves nothing draws nothing.
 */
export function paintPicture(
  ctx: Ctx2D,
  img: CanvasImageSource,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  fit: PictureFit,
  c: ImageCrop | undefined,
): void {
  const iw = (img as { width: number }).width || (img as HTMLVideoElement).videoWidth || 1;
  const ih = (img as { height: number }).height || (img as HTMLVideoElement).videoHeight || 1;
  const l = pictureLayout(iw, ih, bx, by, bw, bh, fit, c);
  if (!l) return;
  if (!c) {
    ctx.drawImage(img, l.dx, l.dy, l.dw, l.dh);
    return;
  }
  // The part of the cropped rect that lies on the picture, and where it lands; the rest stays clear.
  ctx.drawImage(
    img,
    l.x0,
    l.y0,
    l.x1 - l.x0,
    l.y1 - l.y0,
    l.dx + (l.x0 - l.sx) * l.kx,
    l.dy + (l.y0 - l.sy) * l.ky,
    (l.x1 - l.x0) * l.kx,
    (l.y1 - l.y0) * l.ky,
  );
}

/**
 * `paintPicture` of the picture `from` describes, drawn from `img`, which holds only its rectangle `from`
 * (at the bitmap's own size): the picture is laid out as `paintPicture` lays the whole picture out, and the
 * part of it the bitmap holds is drawn there. A decoder that cropped the picture keeps a margin around what
 * is visible, so the edges of what it drew stay outside the box.
 */
export function paintPictureFrom(
  ctx: Ctx2D,
  img: CanvasImageSource,
  from: PictureFrom,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  fit: PictureFit,
  c: ImageCrop | undefined,
): void {
  const l = pictureLayout(from.iw, from.ih, bx, by, bw, bh, fit, c);
  if (!l || !(from.w > 0 && from.h > 0)) return;
  const x0 = Math.max(l.x0, from.x);
  const y0 = Math.max(l.y0, from.y);
  const x1 = Math.min(l.x1, from.x + from.w);
  const y1 = Math.min(l.y1, from.y + from.h);
  if (!(x1 > x0 && y1 > y0)) return;
  const [iw, ih] = ownSize(img);
  const ux = iw / from.w;
  const uy = ih / from.h;
  ctx.drawImage(
    img,
    (x0 - from.x) * ux,
    (y0 - from.y) * uy,
    (x1 - x0) * ux,
    (y1 - y0) * uy,
    l.dx + (x0 - l.sx) * l.kx,
    l.dy + (y0 - l.sy) * l.ky,
    (x1 - x0) * l.kx,
    (y1 - y0) * l.ky,
  );
}

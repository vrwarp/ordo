import { type Box, type ImageCrop, LOGICAL_HEIGHT, LOGICAL_WIDTH, type ShapeGeom } from '@ordo/domain';

import { CLAMP, clampBox, clampCrop, clampGeom, num } from './clamp.ts';
import type { Ctx2D } from './ctx.ts';
import { digest } from './digest.ts';
import { GEOM_CLIP_RULE, geomFillPath2D } from './geom/draw.ts';
import { storedGeometry } from './geom/stored.ts';

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
 * A rotated picture and one with round corners keep being drawn from the source through the transform and
 * the clip path (`drawImageFit`).
 *
 * A picture's mask and flips (design/27 §3.1 `ImageObject.mask`, `flipH`, `flipV`) are part of what is
 * prepared: the bitmap holds the picture mirrored about the box's centre and cut to the mask's filled paths
 * (their union, `geomFillPath2D`) by an anti-aliased fill, not a clip (a 2D clip on an OffscreenCanvas is not
 * anti-aliased in Chromium), so a masked picture is copied 1:1 like any other, rotated ones included (their
 * bitmap covers the turned box's bounds; a slide of four large turned photos in masks drew in 297 ms at 4K
 * from the source, each through a frame-sized sprite). The mask is evaluated at the logical box (a resized
 * picture keeps its corners) and scaled to the device box.
 */

export type PictureFit = 'contain' | 'cover' | 'stretch';

/** How a picture is cut and mirrored (`ImageObject.mask`, `flipH`, `flipV`, design/27 §3.1). */
export type PictureShape = { mask?: ShapeGeom; flipH?: boolean; flipV?: boolean };

/** What a picture's pixels depend on besides its source: an `ImageObject`, or a frame-filling picture. */
export type PictureDraw = { box: Box; fit: PictureFit; crop?: ImageCrop; radius?: number } & PictureShape;

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
  /** The clamped mask and flips (absent when there are none), with the logical box size the mask is built at. */
  shape?: PictureShape & { w: number; h: number };
  /**
   * A masked picture's rotation in degrees about the box's centre (bx, by, bw, bh stay the unturned box): the
   * bitmap covers the turned box's bounds and holds the picture turned and cut to its mask.
   */
  rotation?: number;
};

/** Clamped masks and their key digests, by the stored mask object (a slide's pictures are asked for often). */
const masks = new WeakMap<object, { mask: ShapeGeom | undefined; key: string }>();

function maskOf(v: unknown): { mask: ShapeGeom | undefined; key: string } {
  if (!v || typeof v !== 'object') return { mask: undefined, key: '' };
  let hit = masks.get(v);
  if (!hit) {
    const mask = clampGeom(v);
    hit = { mask, key: mask ? digest(JSON.stringify(mask)) : '' };
    masks.set(v, hit);
    if (mask) masks.set(mask, hit);
  }
  return hit;
}

/** The clamped mask and flips of a picture, or undefined when it has none. */
export function pictureShape(o: PictureShape): PictureShape | undefined {
  const mask = maskOf(o.mask).mask;
  const flipH = o.flipH === true;
  const flipV = o.flipV === true;
  if (!mask && !flipH && !flipV) return undefined;
  const out: PictureShape = {};
  if (mask) out.mask = mask;
  if (flipH) out.flipH = true;
  if (flipV) out.flipV = true;
  return out;
}

/** The key part of a picture's mask and flips. */
function shapeKey(s: PictureShape): string {
  return ` ${s.flipH ? 'h' : ''}${s.flipV ? 'v' : ''}${s.mask ? `m${maskOf(s.mask).key}` : ''}`;
}

/** The largest picture prepared (16 MP, design/27 §7.1); a larger box is drawn from the source as before. */
export const MAX_PREPARED_PIXELS = 16_000_000;

/** The fit `drawImageFit` applies for a value: 'stretch', 'contain', else 'cover'. */
export function pictureFit(fit: unknown): PictureFit {
  return fit === 'stretch' || fit === 'contain' ? fit : 'cover';
}

/**
 * The device pixels a picture is prepared for at `scale` (device px per logical px): undefined for a rotated
 * box, round corners (a clip path), an empty box, one entirely off the canvas or one over
 * `MAX_PREPARED_PIXELS`. Those are drawn from the source as before. A masked picture is prepared with round
 * corners (the mask replaces them) and rotated (the bitmap covers the turned box's bounds). Edges within
 * 1e-6 px of a pixel boundary are taken as on it, so float noise never widens a box by a pixel.
 */
export function pictureTarget(o: PictureDraw, scale: number): PictureTarget | undefined {
  if (!(Number.isFinite(scale) && scale > 0)) return undefined;
  const box = clampBox(o.box);
  const shape = pictureShape(o);
  // A rotated picture is prepared only with a mask, which cuts it (anti-aliased) wherever the box turns.
  if (box.rotation && !shape?.mask) return undefined;
  if (!shape?.mask && num(o.radius, 0, CLAMP.maxRadius, 0) > 0) return undefined;
  const snap = (v: number) => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v);
  const x0 = snap(box.x * scale);
  const y0 = snap(box.y * scale);
  const x1 = snap((box.x + box.w) * scale);
  const y1 = snap((box.y + box.h) * scale);
  // The device rect the picture covers: the box's, or the bounds of the turned box.
  let ax0 = x0;
  let ay0 = y0;
  let ax1 = x1;
  let ay1 = y1;
  if (box.rotation) {
    const th = (box.rotation * Math.PI) / 180;
    const hw = ((x1 - x0) * Math.abs(Math.cos(th)) + (y1 - y0) * Math.abs(Math.sin(th))) / 2;
    const hh = ((x1 - x0) * Math.abs(Math.sin(th)) + (y1 - y0) * Math.abs(Math.cos(th))) / 2;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    ax0 = cx - hw;
    ay0 = cy - hh;
    ax1 = cx + hw;
    ay1 = cy + hh;
  }
  // The canvas: the logical frame at this scale, in whole pixels.
  const cw = Math.ceil(snap(LOGICAL_WIDTH * scale));
  const ch = Math.ceil(snap(LOGICAL_HEIGHT * scale));
  const x = Math.max(0, Math.floor(ax0));
  const y = Math.max(0, Math.floor(ay0));
  const w = Math.min(cw, Math.ceil(ax1)) - x;
  const h = Math.min(ch, Math.ceil(ay1)) - y;
  if (!(w >= 1 && h >= 1 && x1 > x0 && y1 > y0) || w * h > MAX_PREPARED_PIXELS) return undefined;
  const bx = x0 - x;
  const by = y0 - y;
  const bw = x1 - x0;
  const bh = y1 - y0;
  const fit = pictureFit(o.fit);
  const crop = clampCrop(o.crop);
  const turn = box.rotation ? ` r${box.rotation}` : '';
  const key = `${w}x${h} ${bx} ${by} ${bw} ${bh} ${fit}${crop ? ` ${crop.l} ${crop.t} ${crop.r} ${crop.b}` : ''}${turn}${shape ? shapeKey(shape) : ''}`;
  const t: PictureTarget = { x, y, w, h, fit, bx, by, bw, bh, key };
  if (crop) t.crop = crop;
  if (shape) t.shape = { ...shape, w: box.w, h: box.h };
  if (box.rotation) t.rotation = box.rotation;
  return t;
}

/**
 * Maps a picture's box (0..w, 0..h, the logical box) onto device px (bx, by, bw, bh) of `ctx`, mirrored about
 * the box's centre as `shape` says.
 */
function placeShape(
  ctx: Ctx2D,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  shape: PictureShape & { w: number; h: number },
): void {
  ctx.translate(bx + bw / 2, by + bh / 2);
  ctx.scale(shape.flipH ? -1 : 1, shape.flipV ? -1 : 1);
  ctx.translate(-bw / 2, -bh / 2);
  if (shape.w > 0 && shape.h > 0) ctx.scale(bw / shape.w, bh / shape.h);
}

/**
 * Paints a picture as `paintPicture` does, mirrored and cut to its mask as `shape` says (box: device px
 * bx, by, bw, bh; the mask built at the logical box `shape.w` x `shape.h`). The cut is a 'destination-in'
 * fill of the mask, so `ctx` must hold nothing else under the picture (a sprite or a prepared bitmap).
 */
export function paintShapedPicture(
  ctx: Ctx2D,
  img: CanvasImageSource,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  fit: PictureFit,
  c: ImageCrop | undefined,
  shape: PictureShape & { w: number; h: number },
): void {
  ctx.save();
  placeShape(ctx, bx, by, bw, bh, shape);
  const lw = shape.w > 0 ? shape.w : bw;
  const lh = shape.h > 0 ? shape.h : bh;
  paintPicture(ctx, img, 0, 0, lw, lh, fit, c);
  const built = shape.mask ? storedGeometry(shape.mask, lw, lh) : undefined;
  if (built) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = '#000';
    ctx.fill(geomFillPath2D(built), GEOM_CLIP_RULE);
  }
  ctx.restore();
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
 * Resample the part of `src` that `t` shows into a new sRGB bitmap of exactly `t.w` x `t.h` (colour profile
 * applied once), laid out and clipped as `drawImageFit` lays the source out in the box: transparent where
 * the fit or a negative crop share leaves the box uncovered, edge pixels the box covers in part blended as
 * the source path blends them. Undefined when no 2D context can be had; the caller then draws the source.
 *
 * Smoothing is 'medium' (bilinear, mipmapped when reducing), the closest Chromium has to LibreOffice's bitmap
 * scaling (bilinear when enlarging, area-averaging when reducing): over the sermon decks and worship shard 0
 * it scored higher than 'high' on 58 slides and lower on 3 (by at most 0.0007), and above 'low' in the mean.
 * The canvas is CPU-backed (`willReadFrequently`) like the asset worker's surface, so drawing the bitmap
 * there never reads a texture back.
 */
export function preparePicture(src: CanvasImageSource, t: PictureTarget): ImageBitmap | undefined {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  const canvas = new OffscreenCanvas(t.w, t.h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!ctx) return undefined;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  if (t.shape?.mask) {
    if (t.rotation) {
      const cx = t.bx + t.bw / 2;
      const cy = t.by + t.bh / 2;
      ctx.translate(cx, cy);
      ctx.rotate((t.rotation * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }
    paintShapedPicture(ctx, src, t.bx, t.by, t.bw, t.bh, t.fit, t.crop, t.shape);
  } else {
    ctx.beginPath();
    ctx.rect(t.bx, t.by, t.bw, t.bh);
    ctx.clip();
    if (t.shape) paintShapedPicture(ctx, src, t.bx, t.by, t.bw, t.bh, t.fit, t.crop, t.shape);
    else paintPicture(ctx, src, t.bx, t.by, t.bw, t.bh, t.fit, t.crop);
  }
  const bmp = canvas.transferToImageBitmap();
  const [w, h] = ownSize(src);
  prepared.set(bmp, { key: t.key, w, h });
  return bmp;
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
  // The cropped rect in picture pixels; it reaches past the picture where a share is negative.
  let sx = 0;
  let sy = 0;
  let sw = iw;
  let sh = ih;
  if (c) {
    sx = c.l * iw;
    sy = c.t * ih;
    sw = (1 - c.l - c.r) * iw;
    sh = (1 - c.t - c.b) * ih;
    if (!(sw > 0 && sh > 0)) return;
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
  if (!c) {
    ctx.drawImage(img, dx, dy, dw, dh);
    return;
  }
  // The part of the cropped rect that lies on the picture, and where it lands; the rest stays clear.
  const x0 = Math.max(sx, 0);
  const y0 = Math.max(sy, 0);
  const x1 = Math.min(sx + sw, iw);
  const y1 = Math.min(sy + sh, ih);
  if (!(x1 > x0 && y1 > y0)) return;
  const kx = dw / sw;
  const ky = dh / sh;
  ctx.drawImage(
    img,
    x0,
    y0,
    x1 - x0,
    y1 - y0,
    dx + (x0 - sx) * kx,
    dy + (y0 - sy) * ky,
    (x1 - x0) * kx,
    (y1 - y0) * ky,
  );
}

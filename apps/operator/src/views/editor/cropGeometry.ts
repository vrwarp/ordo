import type { ImageCrop, ImageObject } from '@ordo/domain';
import { MIN_CROP_KEEP, normalizeCrop } from './ops/pictures.ts';

/*
 * The geometry of cropping a picture whose box stays (M4 item D; `CropControl.tsx`). Pure, in the picture's
 * own unrotated box: x from 0 (its left edge) to `w`, y from 0 to `h`, logical px.
 *
 * - The panel's fields name the sides as seen on the slide: a picture mirrored left to right shows its
 *   source's right share on the left (`visualCrop`, `withVisualSide`).
 * - The canvas handles move and scale the whole picture behind the fixed box (`pictureFrame`, `dragFrame`,
 *   `cropForFrame`): the crop is the box's place on the picture, so a picture kept at its aspect is never
 *   distorted, whatever its `fit`.
 */

/** A side as the volunteer sees it on the slide. */
export type Side = 'left' | 'top' | 'right' | 'bottom';

/** The crop share of each side as seen on the slide (a flip swaps the source's sides). */
export type VisualCrop = Record<Side, number>;

/** A rect in the picture's unrotated box (logical px). */
export type Rect = { x: number; y: number; w: number; h: number };

/** The eight crop handles: the corners and the sides' midpoints. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const ZERO: ImageCrop = { l: 0, t: 0, r: 0, b: 0 };

/** The source side each visible side shows. */
function sourceKey(o: Pick<ImageObject, 'flipH' | 'flipV'>, side: Side): keyof ImageCrop {
  if (side === 'left') return o.flipH ? 'r' : 'l';
  if (side === 'right') return o.flipH ? 'l' : 'r';
  if (side === 'top') return o.flipV ? 'b' : 't';
  return o.flipV ? 't' : 'b';
}

const OPPOSITE: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

/** The crop shares of `o` by the side seen on the slide. */
export function visualCrop(o: Pick<ImageObject, 'crop' | 'flipH' | 'flipV'>): VisualCrop {
  const c = o.crop ?? ZERO;
  return {
    left: c[sourceKey(o, 'left')],
    top: c[sourceKey(o, 'top')],
    right: c[sourceKey(o, 'right')],
    bottom: c[sourceKey(o, 'bottom')],
  };
}

/** The largest share a side can take while the opposite side keeps its own (`MIN_CROP_KEEP` left visible). */
export function sideMax(o: Pick<ImageObject, 'crop' | 'flipH' | 'flipV'>, side: Side): number {
  return Math.min(1, 1 - MIN_CROP_KEEP - visualCrop(o)[OPPOSITE[side]]);
}

/**
 * `o`'s crop with the side seen on the slide set to `share` (-1..1), kept below the opposite side's
 * (`sideMax`); undefined when nothing is cut or padded any more.
 */
export function withVisualSide(
  o: Pick<ImageObject, 'crop' | 'flipH' | 'flipV'>,
  side: Side,
  share: number,
): ImageCrop | undefined {
  if (!Number.isFinite(share)) return o.crop;
  const v = Math.max(-1, Math.min(sideMax(o, side), share));
  return normalizeCrop({ ...(o.crop ?? ZERO), [sourceKey(o, side)]: v });
}

/**
 * Where the whole picture lies, unmirrored, when `o` is drawn in its box as `drawImageFit` draws it: the
 * crop's rect fitted (`fit`; stretched when the picture's size is unknown), widened by the cut and padded
 * shares. `size` is the picture's pixel size.
 */
export function pictureFrame(
  o: Pick<ImageObject, 'box' | 'crop' | 'fit'>,
  size: { width: number; height: number } | undefined,
): Rect {
  const bw = Math.abs(o.box.w);
  const bh = Math.abs(o.box.h);
  const c = o.crop ?? ZERO;
  const cw = Math.max(MIN_CROP_KEEP, 1 - c.l - c.r);
  const ch = Math.max(MIN_CROP_KEEP, 1 - c.t - c.b);
  let dw = bw;
  let dh = bh;
  const sw = (size?.width ?? 0) * cw;
  const sh = (size?.height ?? 0) * ch;
  if (o.fit !== 'stretch' && sw > 0 && sh > 0) {
    const s = o.fit === 'contain' ? Math.min(bw / sw, bh / sh) : Math.max(bw / sw, bh / sh);
    dw = sw * s;
    dh = sh * s;
  }
  const w = dw / cw;
  const h = dh / ch;
  return { x: (bw - dw) / 2 - c.l * w, y: (bh - dh) / 2 - c.t * h, w, h };
}

/** A frame mirrored about the box's centre as `o`'s flips mirror the picture (its own inverse). */
export function mirrorFrame(o: Pick<ImageObject, 'box' | 'flipH' | 'flipV'>, f: Rect): Rect {
  const bw = Math.abs(o.box.w);
  const bh = Math.abs(o.box.h);
  return {
    x: o.flipH ? bw - f.x - f.w : f.x,
    y: o.flipV ? bh - f.y - f.h : f.y,
    w: f.w,
    h: f.h,
  };
}

/**
 * The crop that shows the box's place on the whole picture lying at `f` (unmirrored): exactly what the
 * frame shows for a stretched picture, and for any fit while the frame keeps the picture's aspect
 * (`crop` undefined: the whole picture fills the box). Undefined when it would leave the bounds (a share
 * past -1..1, or less than `MIN_CROP_KEEP` kept): the handles then keep the last crop.
 */
export function cropForFrame(
  o: Pick<ImageObject, 'box'>,
  f: Rect,
): { crop: ImageCrop | undefined } | undefined {
  const bw = Math.abs(o.box.w);
  const bh = Math.abs(o.box.h);
  if (!(f.w > 0 && f.h > 0 && bw > 0 && bh > 0)) return undefined;
  const c = { l: -f.x / f.w, t: -f.y / f.h, r: (f.x + f.w - bw) / f.w, b: (f.y + f.h - bh) / f.h };
  const shares = [c.l, c.t, c.r, c.b];
  if (!shares.every((v) => Number.isFinite(v) && v >= -1 && v <= 1)) return undefined;
  if (1 - c.l - c.r < MIN_CROP_KEEP || 1 - c.t - c.b < MIN_CROP_KEEP) return undefined;
  return { crop: normalizeCrop(c) };
}

/** The smallest a frame's side gets while a handle scales it (logical px). */
const MIN_FRAME = 8;

/**
 * The frame after dragging `handle` of `f` (as drawn on the slide, mirrored or not) to `p`: scaled at the
 * frame's own aspect about the opposite corner (corner handles) or the opposite side's midpoint (side
 * handles), so the picture is never distorted.
 */
export function dragFrame(f: Rect, handle: Handle, p: { x: number; y: number }): Rect {
  const k = f.w / f.h;
  const right = f.x + f.w;
  const bottom = f.y + f.h;
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  const fromW = (w: number) => Math.max(MIN_FRAME, Math.max(MIN_FRAME * k, w));
  switch (handle) {
    case 'e': {
      const w = fromW(p.x - f.x);
      return { x: f.x, y: cy - w / k / 2, w, h: w / k };
    }
    case 'w': {
      const w = fromW(right - p.x);
      return { x: right - w, y: cy - w / k / 2, w, h: w / k };
    }
    case 's': {
      const w = fromW((p.y - f.y) * k);
      return { x: cx - w / 2, y: f.y, w, h: w / k };
    }
    case 'n': {
      const w = fromW((bottom - p.y) * k);
      return { x: cx - w / 2, y: bottom - w / k, w, h: w / k };
    }
    default: {
      // A corner: the opposite corner stays; the larger of the two pulls wins.
      const east = handle === 'ne' || handle === 'se';
      const south = handle === 'se' || handle === 'sw';
      const ax = east ? f.x : right;
      const ay = south ? f.y : bottom;
      const w = fromW(Math.max(east ? p.x - ax : ax - p.x, (south ? p.y - ay : ay - p.y) * k));
      const h = w / k;
      return { x: east ? ax : ax - w, y: south ? ay : ay - h, w, h };
    }
  }
}

/** Where a handle sits on a frame. */
export function handlePoint(f: Rect, handle: Handle): { x: number; y: number } {
  const x = handle.includes('w') ? f.x : handle.includes('e') ? f.x + f.w : f.x + f.w / 2;
  const y = handle.includes('n') ? f.y : handle.includes('s') ? f.y + f.h : f.y + f.h / 2;
  return { x, y };
}

/**
 * Whether `o` shows its picture distorted: stretched over its box with a cropped part whose aspect is not
 * the box's (more than 1 % apart). A picture whose size is unknown never counts.
 */
export function isDistorted(
  o: Pick<ImageObject, 'box' | 'crop' | 'fit'>,
  size: { width?: number; height?: number } | undefined,
): boolean {
  if (o.fit !== 'stretch' || !size?.width || !size.height) return false;
  const c = o.crop ?? ZERO;
  const sw = size.width * (1 - c.l - c.r);
  const sh = size.height * (1 - c.t - c.b);
  const bw = Math.abs(o.box.w);
  const bh = Math.abs(o.box.h);
  if (!(sw > 0 && sh > 0 && bw > 0 && bh > 0)) return false;
  return Math.abs(sw / sh / (bw / bh) - 1) > 0.01;
}

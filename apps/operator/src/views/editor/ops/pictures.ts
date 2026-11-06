import type { ImageCrop, ImageObject, Media } from '@ordo/domain';

/*
 * Picture ops (M4 item D; design/27 §11 item 6 "Pictures", §3.1 ImageObject). Pure functions over one
 * ImageObject, applied through the actions in `../actions.ts`; each returns `o` itself when it changes
 * nothing. A locked object (art) takes none of them: the actions skip it, and the ops return it unchanged.
 *
 * The fields: `crop` (M1, the share cut from each side of the source), `flipH` and `flipV` (mirrored about
 * the box's centre before the rotation, crop and mask included) and `mask` (a `ShapeGeom`: the editor offers
 * an ellipse and a rounded rect), drawn alike by the outputs, the thumbnails, the editor's image node
 * (`drawImageFit`) and the video plane (`scene.ts`). Crop shares always name the source's sides, so a flip
 * keeps the crop and the same part of the picture shows, mirrored; the Object panel shows them as the sides
 * seen on the slide (`../cropGeometry.ts`).
 */

/** A picture's mask, the presets the editor offers ('Mask: none, ellipse, rounded'): design/27's `ShapeGeom`. */
export type PictureMask = {
  preset: 'ellipse' | 'roundRect';
  /** Adjustments as [name, value] pairs, POI's: roundRect's 'adj' is the corner radius (default 16667). */
  adj?: [string, number][];
};

/** A flip change: a key that is present sets it (false removes it). */
export type PictureFlip = { flipH?: boolean; flipV?: boolean };

/** A picture and its pixel size; an unknown size (no `width`/`height`) is treated as the box's aspect. */
export type PictureSize = Pick<Media, 'id' | 'width' | 'height'>;

/** The smallest share of the source a crop keeps on each axis (1 %): `l + r` and `t + b` stay below 1. */
export const MIN_CROP_KEEP = 0.01;

/** roundRect's adjust range and default (1/100,000 of the box's shorter side; OOXML, design/27 §3.1). */
export const ROUND_ADJ_MAX = 50_000;
export const ROUND_ADJ_DEFAULT = 16_667;

/** Shares are stored to six decimals: a millionth of the picture, far below a pixel, and short JSON. */
function share(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

function finite(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** One axis of a crop kept below the whole source: the excess comes off the shares that cut. */
function keepAxis(a: number, b: number): [number, number] {
  const over = a + b - (1 - MIN_CROP_KEEP);
  if (over <= 0) return [a, b];
  const pa = Math.max(a, 0);
  const pb = Math.max(b, 0);
  const sum = pa + pb;
  return [a - (over * pa) / sum, b - (over * pb) / sum];
}

/**
 * A crop as the ops store it: every share finite, within -1..1 and to six decimals, each axis keeping at
 * least `MIN_CROP_KEEP` of the source (an excess is taken off the cutting shares in proportion).
 * Undefined when it cuts and pads nothing.
 */
export function normalizeCrop(c: ImageCrop | undefined): ImageCrop | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const clip = (v: unknown) => Math.min(1, Math.max(-1, finite(v)));
  const [l, r] = keepAxis(clip(c.l), clip(c.r));
  const [t, b] = keepAxis(clip(c.t), clip(c.b));
  const out = { l: share(l), t: share(t), r: share(r), b: share(b) };
  return out.l || out.t || out.r || out.b ? out : undefined;
}

/** Whether two crops show the same part of the picture (within a millionth; none = all zero). */
export function sameCrop(a: ImageCrop | undefined, b: ImageCrop | undefined): boolean {
  const z = { l: 0, t: 0, r: 0, b: 0 };
  const x = a ?? z;
  const y = b ?? z;
  return (['l', 't', 'r', 'b'] as const).every((k) => Math.abs(finite(x[k]) - finite(y[k])) <= 1e-6);
}

/** `o` with `crop` set (or removed), or `o` itself when it shows the same. */
function withCrop(o: ImageObject, crop: ImageCrop | undefined): ImageObject {
  if (sameCrop(o.crop, crop) && (crop === undefined) === (o.crop === undefined)) return o;
  const { crop: _old, ...rest } = o;
  return crop ? { ...rest, crop } : rest;
}

/**
 * Crop the picture while its box stays (the numeric fields and the canvas crop handles): `crop` is the share
 * cut from each side, -1..1, a negative share padding that side transparent; `l + r` and `t + b` stay below
 * 1 (`normalizeCrop`). `undefined` removes the crop (the whole picture), as does a crop of zeros.
 */
export function setCrop(o: ImageObject, crop: ImageCrop | undefined): ImageObject {
  if (o.locked) return o;
  const next = normalizeCrop(crop);
  if (!next && !o.crop) return o;
  if (next && o.crop && sameCrop(o.crop, next)) return o;
  return withCrop(o, next);
}

/** A mask as the ops store it: the two presets, roundRect's corner as 'adj' within 0..50,000 (or none). */
function normalizeMask(m: PictureMask): ImageObject['mask'] | undefined {
  if (m.preset === 'ellipse') return { preset: 'ellipse' };
  if (m.preset !== 'roundRect') return undefined;
  const adj = m.adj?.find(([name]) => name === 'adj')?.[1];
  if (adj === undefined || !Number.isFinite(adj)) return { preset: 'roundRect' };
  return { preset: 'roundRect', adj: [['adj', Math.round(Math.min(ROUND_ADJ_MAX, Math.max(0, adj)))]] };
}

/**
 * The `radius` an importer writes beside a mask for an older build (design/27 §3.2): half the shorter side
 * for an ellipse, the corner for a rounded rect; undefined for any other mask.
 */
export function legacyRadius(o: Pick<ImageObject, 'box' | 'mask'>): number | undefined {
  const side = Math.min(Math.abs(o.box.w), Math.abs(o.box.h));
  if (o.mask?.preset === 'ellipse') return side / 2;
  const corner = roundCorner(o);
  return corner === undefined ? undefined : (side * corner) / 100_000;
}

/**
 * Mask the picture with an ellipse or a rounded rectangle, or remove the mask (`undefined`). A legacy
 * `radius` stays what an older build draws: setting a mask keeps it as it is (the drawers ignore it under a
 * mask). Removing one keeps it too, unless it is only the stand-in an importer wrote for that mask
 * (`legacyRadius`, within half a pixel): then the picture becomes a plain rect, as 'None' says. A preset
 * the editor does not offer changes nothing.
 */
export function setMask(o: ImageObject, mask: PictureMask | undefined): ImageObject {
  if (o.locked) return o;
  if (!mask) {
    if (!o.mask) return o;
    const { mask: _old, ...rest } = o;
    const stand = legacyRadius(o);
    return stand !== undefined && o.radius > 0 && Math.abs(o.radius - stand) <= 0.5
      ? { ...rest, radius: 0 }
      : rest;
  }
  const next = normalizeMask(mask);
  if (!next) return o;
  if (JSON.stringify(o.mask) === JSON.stringify(next)) return o;
  return { ...o, mask: next };
}

/** The corner of a roundRect mask, 0..50,000 (its default when it has no 'adj'); undefined for no such mask. */
export function roundCorner(o: Pick<ImageObject, 'mask'>): number | undefined {
  if (o.mask?.preset !== 'roundRect') return undefined;
  const adj = o.mask.adj?.find(([name]) => name === 'adj')?.[1];
  return adj === undefined || !Number.isFinite(adj)
    ? ROUND_ADJ_DEFAULT
    : Math.min(ROUND_ADJ_MAX, Math.max(0, adj));
}

/**
 * Flip the picture horizontally or vertically inside its box (the box, crop and mask stay). A key that is
 * present sets that flip (false removes it); one that is absent leaves it.
 */
export function setFlip(o: ImageObject, flip: PictureFlip): ImageObject {
  if (o.locked) return o;
  let out = o;
  for (const k of ['flipH', 'flipV'] as const) {
    const want = flip[k];
    if (want === undefined || (o[k] === true) === want) continue;
    if (out === o) out = { ...o };
    if (want) out[k] = true;
    else delete out[k];
  }
  return out;
}

/**
 * The crop that shows a picture of `size` undistorted in `o`'s box: the largest part of it with the box's
 * aspect (a cover crop), centred on the centre of `o`'s current crop (the picture's centre without one),
 * moved inside the picture where it would reach past it. Undefined when the whole picture already has the
 * box's aspect, or when the picture's size or the box's is unknown (the picture is then taken as the box's
 * aspect).
 */
export function coverCrop(
  o: Pick<ImageObject, 'box' | 'crop'>,
  size: Pick<Media, 'width' | 'height'>,
): ImageCrop | undefined {
  const bw = Math.abs(finite(o.box.w));
  const bh = Math.abs(finite(o.box.h));
  const pw = finite(size.width);
  const ph = finite(size.height);
  if (!(bw > 0 && bh > 0 && pw > 0 && ph > 0)) return undefined;
  const box = bw / bh;
  const pic = pw / ph;
  if (Math.abs(pic / box - 1) < 1e-9) return undefined;
  const c = o.crop;
  const cx = c ? (1 + finite(c.l) - finite(c.r)) / 2 : 0.5;
  const cy = c ? (1 + finite(c.t) - finite(c.b)) / 2 : 0.5;
  const place = (centre: number, keep: number) => Math.min(1 - keep, Math.max(0, centre - keep / 2));
  if (pic > box) {
    // Wider than the box: the full height, a share of the width.
    const keep = box / pic;
    const l = place(cx, keep);
    return normalizeCrop({ l, t: 0, r: 1 - keep - l, b: 0 });
  }
  const keep = pic / box;
  const t = place(cy, keep);
  return normalizeCrop({ l: 0, t, r: 0, b: 1 - keep - t });
}

/**
 * 'Replace' keeps the look, not the crop numbers (design/27 §11 item 6): the new picture is cover-cropped to
 * the box's aspect and centred on the old crop's centre (clamped to the picture), so a picture of another
 * aspect is never distorted. Box, mask, flip, opacity, radius, stroke and shadow are kept. A picture with
 * `fit: 'contain' | 'cover'` keeps its fit and drops the crop. A video's poster (`play`) keeps its clip.
 * The Object panel's 'Replace' and `replaceBackground` (item E) use it.
 */
export function replacePicture(o: ImageObject, next: PictureSize): ImageObject {
  if (o.locked || !next.id) return o;
  const crop = o.fit === 'contain' || o.fit === 'cover' ? undefined : coverCrop(o, next);
  if (next.id === o.mediaId) return withCrop(o, crop);
  const { crop: _old, ...rest } = o;
  return crop ? { ...rest, mediaId: next.id, crop } : { ...rest, mediaId: next.id };
}

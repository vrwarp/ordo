import type { Box, ImageCrop, Shadow, ShapeGeom } from '@ordo/domain';

import type { Ctx2D } from './ctx.ts';
import { digest } from './digest.ts';
import { drawEffected } from './effects.ts';
import { geomPending } from './geom/stored.ts';
import {
  type PictureFit,
  type PictureShape,
  type PictureSource,
  type PictureTarget,
  paintPicture,
  pictureSilhouette,
} from './picture.ts';
import { placeBox } from './shape.ts';

/*
 * A picture's shadow and soft edge (design/27 §3.1 `ImageObject.shadow`, `softEdge`; design/20 "ProPresenter"):
 * drawn through the shapes' effects path (`effects.ts` `drawEffected`), so a picture and a shape with the same
 * fields look the same: the shadow is the picture's alpha blurred by σ = blur/√6 (LibreOffice's stack blur, by
 * a Canvas shadow: no `ctx.filter`, so WebKit blurs it too), in its colour and offset; the soft edge multiplies
 * the picture by its silhouette (its mask, else its box; round corners are a 'roundRect' mask here,
 * `roundCornerMask`, the geometry a shape with that radius draws) eroded by `softEdge` and blurred by it.
 * Both are made at a reduced resolution, cached in the sprite cache (`spritecache.ts`, kind 'effect') by what
 * is drawn and the device transform, and counted in the slide's effect budget (`geombudget.ts`, `geom/cost.ts`
 * `effectArea`).
 *
 * A prepared picture (`picture.ts` `pictureTarget`, the outputs' asset worker) already holds its soft edge (the
 * `SOFT_EDGE_STEP` post step) and its cut: its shadow is a layer drawn under the prepared bitmap, which is
 * copied 1:1 over it (into the composite sprite, or onto the canvas for a picture past the composite size). A
 * picture drawn from its source (the thumbnails, the editor, a picture past 16 MP) is drawn into the effect
 * sprite itself, cut to its silhouette by an anti-aliased fill (`EffectSource.isolated`), its round corners
 * kept, and feathered there.
 */

/** Ids of the pictures drawn with effects (each decoded bitmap or source object), for the cache keys. */
const sources = new WeakMap<object, number>();
let nextSource = 1;

function sourceId(img: PictureSource): number {
  if (typeof img !== 'object' || img === null) return 0;
  let id = sources.get(img);
  if (id === undefined) {
    id = nextSource++;
    sources.set(img, id);
  }
  return id;
}

/** A 2D affine's six numbers. */
type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };

/** `x` · `y` (apply `y` first). */
function times(x: Affine, y: Affine): Affine {
  return {
    a: x.a * y.a + x.c * y.b,
    b: x.b * y.a + x.d * y.b,
    c: x.a * y.c + x.c * y.d,
    d: x.b * y.c + x.d * y.d,
    e: x.a * y.e + x.c * y.f + x.e,
    f: x.b * y.e + x.d * y.f + x.f,
  };
}

function inverse(m: Affine): Affine | undefined {
  const det = m.a * m.d - m.b * m.c;
  if (!(Math.abs(det) > 1e-12) || !Number.isFinite(det)) return undefined;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/** `m` with a near-identity linear part and near-whole offsets made exact (a 1:1 copy stays one). */
function snapped(m: Affine): Affine {
  const near = (v: number, to: number) => Math.abs(v - to) < 1e-9;
  if (!(near(m.a, 1) && near(m.d, 1) && near(m.b, 0) && near(m.c, 0))) return m;
  const whole = (v: number) => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v);
  return { a: 1, b: 0, c: 0, d: 1, e: whole(m.e), f: whole(m.f) };
}

/**
 * Draws a picture with its effects (`hasPictureEffects`) through `drawEffected`, at `opacity`; false when it
 * could not (no OffscreenCanvas or getTransform, a sprite past `EFFECT_MAX_PIXELS`, a degenerate transform):
 * the caller then draws the picture without them. `shape` is clamped (`pictureShape`; round corners as its
 * mask, `roundCornerMask`), `box` and `crop` too; `prepared` is the target `img` was prepared for
 * (`preparePicture`: it holds the soft edge, cut, mirrored and turned), else `img` is the source.
 */
export function drawPictureEffected(
  ctx: Ctx2D,
  img: PictureSource,
  box: Box,
  scale: number,
  fit: PictureFit,
  opacity: number,
  crop: ImageCrop | undefined,
  shape: PictureShape,
  prepared?: PictureTarget,
): boolean {
  if (typeof OffscreenCanvas === 'undefined' || typeof ctx.getTransform !== 'function') return false;
  const w = box.w;
  const h = box.h;
  if (!(w > 0 && h > 0)) return true;
  const mask = shape.mask;
  const shadow: Shadow | undefined = shape.shadow && shape.shadow.color.a > 0 ? shape.shadow : undefined;
  // A prepared bitmap holds the soft edge already.
  const softEdge = prepared ? 0 : (shape.softEdge ?? 0);
  if (!shadow && !(softEdge > 0)) return false;
  // The caller's transform: a prepared bitmap is copied at the target's origin under it, as the plain copy
  // is (`drawImageFit`); the asset worker's tight sprites draw under a translation to the sprite's origin.
  const t0 = ctx.getTransform();
  const outer: Affine = { a: t0.a, b: t0.b, c: t0.c, d: t0.d, e: t0.e, f: t0.f };
  ctx.save();
  // Box space under the flips, as a shape's (`drawGeomShape`): the picture and its silhouette are drawn
  // unmirrored and the transform mirrors them.
  placeBox(ctx, box, scale, shape.flipH === true, shape.flipV === true);
  const t = ctx.getTransform();
  const m: Affine = { a: t.a, b: t.b, c: t.c, d: t.d, e: t.e, f: t.f };
  const inv = inverse(m);
  if (!inv) {
    ctx.restore();
    return false;
  }
  const device = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  let silhouette: Path2D | undefined;
  let made = false;
  const fill = () => {
    if (!made) {
      silhouette = pictureSilhouette(w, h, mask);
      made = true;
    }
    return silhouette;
  };
  const draw = prepared
    ? (c: Ctx2D) => {
        // The bitmap lies at the target's whole px under the caller's transform (`outer`): `c`'s transform
        // maps box space, so the caller's space maps to `c` through it after the inverse of `ctx`'s
        // (box space to the device) and the caller's own (its space to the device).
        const k = c.getTransform();
        const d = snapped(times(times({ a: k.a, b: k.b, c: k.c, d: k.d, e: k.e, f: k.f }, inv), outer));
        c.setTransform(d.a, d.b, d.c, d.d, d.e, d.f);
        c.drawImage(img as CanvasImageSource, prepared.x, prepared.y);
      }
    : (c: Ctx2D) => {
        // Laid out in the box (a 'cover' picture overflows it), then cut to the silhouette by an anti-aliased
        // fill: `c` holds nothing else (`isolated`).
        paintPicture(c, img, 0, 0, w, h, fit, crop);
        const p = fill();
        if (!p) return;
        c.globalCompositeOperation = 'destination-in';
        c.fillStyle = '#000';
        c.fill(p, 'nonzero');
        c.globalCompositeOperation = 'source-over';
      };
  const key = effectKey(img, w, h, fit, crop, shape, prepared, softEdge);
  const drawn = drawEffected(
    ctx,
    {
      transform: t,
      scale: device,
      bounds: { x0: 0, y0: 0, x1: w, y1: h },
      draw,
      get fill() {
        return fill();
      },
      lineWidth: 0,
      // A prepared bitmap is copied as it is (onto the caller's canvas past the composite size); a source is cut.
      isolated: !prepared,
      ...(shadow ? { shadow } : {}),
      ...(softEdge > 0 ? { softEdge } : {}),
      ...(key !== undefined ? { key } : {}),
    },
    opacity,
  );
  ctx.restore();
  return drawn;
}

/**
 * The effect cache key of a picture drawn with effects: what is drawn (the picture's own object, the box size,
 * fit, crop, mask, flips, shadow and soft edge) but not where (`drawEffected` adds the device transform).
 * Undefined, not cached, while the mask waits for its geometry file.
 */
function effectKey(
  img: PictureSource,
  w: number,
  h: number,
  fit: PictureFit,
  crop: ImageCrop | undefined,
  shape: PictureShape,
  prepared: PictureTarget | undefined,
  softEdge: number,
): string | undefined {
  if (shape.mask && geomPending(shape.mask as ShapeGeom)) return undefined;
  try {
    const what = JSON.stringify([
      w,
      h,
      fit,
      crop ?? null,
      shape.mask ?? null,
      shape.flipH === true,
      shape.flipV === true,
      shape.shadow ?? null,
      softEdge,
      prepared ? prepared.key : null,
    ]);
    return `pic${sourceId(img)}|${digest(what)}`;
  } catch {
    return undefined;
  }
}

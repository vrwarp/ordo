import {
  type ImageObject,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Look,
  type Slide,
  type SlideObject,
  type TextObject,
} from '@ordo/domain';
import { CLAMP, clampBox, clampLook, clampSlide, clampStyle, clampText, num } from './clamp.ts';
import { drawableContent } from './content.ts';
import { withinDrawBudget } from './geombudget.ts';
import { pictureTarget, sourceSize } from './picture.ts';
import { rasterSlide } from './raster.ts';
import {
  PLANE_FLOATS,
  type PlaneSource,
  type Rect,
  encodePlane,
  objectBounds,
  rotatedBounds,
  splitScene,
} from './scene.ts';
import { type Ctx2D, type ImageLookup, layoutText } from './text2d.ts';

/**
 * The asset worker's half of a scene stack (design/27 §7.2, SCENE.md item E): a slide job that carries
 * `video` is drawn as a base bitmap, an optional over bitmap and the video plane, instead of one bitmap.
 * Pure drawing on the caller's surface, so the output's asset worker and the headless checks run the same
 * code.
 */

/** The two slides a scene draws, and its plane. */
export type SceneSlides = {
  /** Drawn into base: the page picture, the objects below the video, its poster (unless hidden while
   * stopped) and the upper objects that touch neither the video nor anything in over. */
  base: Slide;
  /** Drawn into over: the upper objects that overlap the video (or an over object); null when none. */
  over: Slide | null;
  /** PLANE_FLOATS floats (scene.ts), PLANE_HAS_OVER set when `over` is not null. */
  plane: Float32Array;
};

/**
 * Whether a text object uses rich text fields (M2, design/27 §3.1) that can draw past what `layoutText`
 * lays out: runs (larger runs, other fonts), paragraph styles (spacing, indents), the office line model,
 * insets in place of the padding, or no wrapping. Shrinking (autofit, fitScale) only draws less.
 */
function richText(o: TextObject): boolean {
  const x = o as { runs?: unknown; paras?: unknown };
  const st = o.style as { lineModel?: unknown; insets?: unknown; wrap?: unknown } | undefined;
  return (
    (Array.isArray(x.runs) && x.runs.length > 0) ||
    (Array.isArray(x.paras) && x.paras.length > 0) ||
    st?.lineModel === 'office' ||
    st?.insets != null ||
    st?.wrap === false
  );
}

/**
 * Where a text object can draw (logical px): its laid-out block, as `drawText` lays it out at `scale`,
 * united with its box, widened by one em for glyphs that reach past their line box (accents, descenders,
 * italics), turned with the box about its centre, plus the reach of its effects. Text that overflows its
 * box is therefore covered, which `objectBounds` alone is not. Text that uses rich text fields (`richText`,
 * M2) is not measured here until this measure uses the M2 layout: it counts as covering the whole frame,
 * so it lands in over whenever it is above the video, which is never wrong, only one more bitmap.
 */
export function textBounds(ctx: Ctx2D, o: TextObject, scale: number): Rect {
  const box = clampBox(o.box);
  const own = objectBounds({ ...o, box });
  if (richText(o)) return wholeFrame();
  const text = clampText(o.text);
  if (!text.trim()) return own;
  const s = num(scale, 0.01, 8, 1);
  ctx.save();
  const layout = layoutText(ctx, text, clampStyle(o.style), box, s, false);
  ctx.restore();
  const em = layout.fontSize;
  const x0 = Math.min(box.x, layout.block.x / s - em);
  const y0 = Math.min(box.y, layout.block.y / s - em);
  const x1 = Math.max(box.x + box.w, (layout.block.x + layout.block.w) / s + em);
  const y1 = Math.max(box.y + box.h, (layout.block.y + layout.block.h) / s + em);
  // The effects' reach is what objectBounds adds to the turned box.
  const margin = Math.max(0, rotatedBounds(box).x - own.x);
  const turned = turnedBounds(x0, y0, x1, y1, box.x + box.w / 2, box.y + box.h / 2, box.rotation);
  return {
    x: turned.x - margin,
    y: turned.y - margin,
    w: turned.w + 2 * margin,
    h: turned.h + 2 * margin,
  };
}

/** Everything an object can reach after the render clamps (boxes lie within ±2× the logical canvas). */
function wholeFrame(): Rect {
  const w = CLAMP.boxFactor * LOGICAL_WIDTH;
  const h = CLAMP.boxFactor * LOGICAL_HEIGHT;
  return { x: -w, y: -h, w: 2 * w, h: 2 * h };
}

/** Axis-aligned bounds of the rect [x0, x1] x [y0, y1] turned `deg` clockwise about (cx, cy). */
function turnedBounds(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  deg: number,
): Rect {
  if (!deg) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const th = (deg * Math.PI) / 180;
  const c = Math.cos(th);
  const sn = Math.sin(th);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const x of [x0, x1])
    for (const y of [y0, y1]) {
      const px = cx + (x - cx) * c - (y - cy) * sn;
      const py = cy + (x - cx) * sn + (y - cy) * c;
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * The size a drawer fits a picture with (`drawImageFit`): a prepared bitmap's source size, else its own
 * (`sourceSize`); 0 x 0 when there is none.
 */
function pictureSize(img: CanvasImageSource | undefined): [number, number] {
  if (!img) return [0, 0];
  const [iw, ih] = sourceSize(img);
  const w = num(iw, 0, 1e6, 0);
  const h = num(ih, 0, 1e6, 0);
  return w > 0 && h > 0 ? [w, h] : [0, 0];
}

/**
 * Plan the scene of a slide whose ImageObject `objectId` plays its clip in place, drawn at `scale` (device
 * px per logical px) with `look`. `ctx` measures text (nothing is drawn). The plane fits the video with the
 * clip's own size (`clip`, the delivery's Media.width x height): the poster may be any picture the operator
 * chose, of another aspect. Only when the clip's size is unknown is the poster's size used, and without
 * either the clip is stretched to the box. The poster is asked for exactly as `drawSlide2D` asks for it
 * (`images(object.mediaId, pictureTarget(object, scale))`), so a decoder that prepares only the targets
 * `slidePictures` lists (the asset worker) hands back the poster's prepared bitmap, whose source's size
 * `sourceSize` knows. Base and over are subsets of what the slide draws (`slideContent` of its clamped copy:
 * its picture, a reference or a page, and its objects), so every picture they draw asks for one of those
 * targets too.
 *
 * A play object drawn below full opacity leaves its poster out of base, as 'Hide while not playing' does:
 * the video is mixed over base at that opacity, so a poster in base would show through the moving picture
 * (SCENE.md). Its slot's paused frame still shows while it is stopped.
 *
 * The split is over what the slide draws (`slideContent`, design/27 §5): base keeps the slide's picture
 * under everything. Undefined when the slide is not a scene and stays one bitmap: the look does not draw the
 * slide as authored (lyric-only, hidden), the object is not an image the slide draws (gone, or an imported
 * object under the slide's PowerPoint picture), or nothing of the video can show (an empty box, a crop that
 * leaves nothing).
 */
export function sceneSlides(
  ctx: Ctx2D,
  slide: Slide,
  look: Look | undefined,
  scale: number,
  images: ImageLookup,
  objectId: string,
  clip: { w?: number; h?: number } = {},
): SceneSlides | undefined {
  if (look && clampLook(look).layers.slide.mode !== 'authored') return undefined;
  const s = clampSlide(slide);
  // The slide's drawing budget decides once for the whole slide, as `drawSlide2D` does for the editor and
  // thumbnails; each part then draws what it decided (geombudget.ts: a part of a slide within the budget
  // changes nothing more).
  const drawn = withinDrawBudget(drawableContent(s).objects);
  const index = drawn.findIndex((o) => o.type === 'image' && o.id === objectId);
  const play = drawn[index] as ImageObject | undefined;
  if (!play) return undefined;
  const translucent = num(play.opacity, 0, 1, 1) < 1;
  const split = splitScene(drawn, index, {
    showWhenStopped: translucent ? false : play.play?.showWhenStopped,
    bounds: (o: SlideObject) => (o.type === 'text' ? textBounds(ctx, o, scale) : objectBounds(o)),
  });
  const plane = new Float32Array(PLANE_FLOATS);
  const cw = num(clip.w, 0, 1e6, 0);
  const ch = num(clip.h, 0, 1e6, 0);
  const at = num(scale, 0.01, 8, 1);
  const [w, h] = cw > 0 && ch > 0 ? [cw, ch] : pictureSize(images(play.mediaId, pictureTarget(play, at)));
  if (!encodePlane(play as PlaneSource, at, w, h, plane, split.over.length > 0)) return undefined;
  return {
    base: { ...s, objects: split.base },
    over: split.over.length ? { id: s.id, objects: split.over } : null,
    plane,
  };
}

/**
 * Draw a scene: base on `ctx` (a cleared full-frame surface), `take()` it, then over on the same surface
 * and `take()` that. `take` returns the drawn picture and leaves the surface transparent, as
 * OffscreenCanvas.transferToImageBitmap does. Undefined, with nothing drawn, when the slide is not a scene
 * (`sceneSlides`): the caller draws it as one bitmap.
 */
export function rasterScene<B>(
  ctx: Ctx2D,
  take: () => B,
  slide: Slide,
  look: Look,
  scale: number,
  images: ImageLookup,
  objectId: string,
  opts: { nextSlide?: Slide; isSong?: boolean; clip?: { w?: number; h?: number } } = {},
): { base: B; over: B | null; plane: Float32Array } | undefined {
  const scene = sceneSlides(ctx, slide, look, scale, images, objectId, opts.clip);
  if (!scene) return undefined;
  rasterSlide(ctx, scene.base, look, scale, images, opts);
  const base = take();
  let over: B | null = null;
  if (scene.over) {
    rasterSlide(ctx, scene.over, look, scale, images, opts);
    over = take();
  }
  return { base, over, plane: scene.plane };
}

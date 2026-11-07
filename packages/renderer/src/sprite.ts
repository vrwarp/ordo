import {
  type Box,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Look,
  type Rgba,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextStyle,
  readableText,
} from '@ordo/domain';
import { CLAMP, clampBox, clampLook, clampSlide, clampStyle, clampText, num } from './clamp.ts';
import { drawableContent } from './content.ts';
import type { Ctx2D } from './ctx.ts';
import { sourceSize } from './picture.ts';
import type { PropsModel } from './props.ts';
import { lowerThirdStyle } from './raster.ts';
import { rotatedBounds } from './scene.ts';
import { hasStrongRtl } from './text/bidi.ts';
import { currentFontEnv } from './text/fonts.ts';
import { measurerFor } from './text/measure.ts';
import { paintPlan } from './text/paint.ts';
import {
  BAND_MIN_FONT_SCALE,
  type RichLayoutOptions,
  bandObject,
  clampTextObject,
  isRichStyle,
  isRichText,
  layoutRich,
} from './text/rich.ts';
import { bandSource, layoutText, lyricTextFor } from './text2d.ts';

/**
 * Tight sprites (design/27 §7.3, M7): a layer's raster is the bounding box of what it draws, at its offset
 * in the frame, instead of a full-frame bitmap, where that saves work. A lyric band, a lower third, props
 * text or a scene's over covers a fraction of the frame; drawing, transferring and uploading only that
 * fraction removes most of the clear, the transfer and the upload, and the compositors draw it at its
 * offset (WebGPU: a sub-rect copy and a scissor; Canvas 2D: drawImage at the offset).
 *
 * The box comes from the content, before anything is drawn (`*Reach`, logical px): every object's reach as
 * its drawer lays it out (legacy text by `layoutText`, rich text by the engine's own layout and paint plan,
 * memoised, so the draw that follows does not lay out again), widened by its effects (shadow, outline, glow)
 * and OVERHANG_EM of its glyph size for glyphs that reach past their line box (accents over capitals,
 * descenders, italics), turned with its box. Anything this cannot bound
 * (an object with fields it does not know, a slide's PowerPoint picture, an opaque logo) reaches the whole
 * frame, and the layer stays full-frame. `drawSprite` draws into a surface of the box (with a margin) and
 * checks that nothing touches the surface's edges where they are not the frame's: if anything does, the
 * reach was short, and the layer is drawn again full-frame, so a sprite never cuts what it draws.
 */

/** A device px rect in the frame, whole pixels. */
export type SpriteRect = { x: number; y: number; w: number; h: number };

/** Logical px rect; `null` reaches the whole frame (the layer stays full-frame). */
export type Reach = { x: number; y: number; w: number; h: number } | null;

/** Device px kept clear around a reach: the ring `drawSprite` checks lies outside everything reached. */
export const SPRITE_MARGIN = 2;
/** A sprite is used only when it covers at most this share of the frame; else the raster is full-frame. */
export const SPRITE_MAX_SHARE = 0.8;
/**
 * How far glyphs can reach past their laid-out line boxes, in ems of their size: an accent over a capital
 * (0.95 em above the baseline against the 0.8 em the layout gives the ascent), a descender with a line
 * height under 1, an italic's overhang. The ink touches the glyphs' own box, so anything that reaches
 * further still crosses the sprite's edge ring and `drawSprite` draws the layer again full-frame: a tighter
 * margin can cost a redraw, never a cut glyph.
 */
export const OVERHANG_EM = 0.3;

const EMPTY = { x: 0, y: 0, w: 0, h: 0 };
const FRAME: Box = { x: 0, y: 0, w: LOGICAL_WIDTH, h: LOGICAL_HEIGHT, rotation: 0 };

/** Fields of the objects whose reach is known; an object with any other field reaches the whole frame. */
const KNOWN: Record<SlideObject['type'], ReadonlySet<string>> = {
  text: new Set(['id', 'type', 'box', 'text', 'style', 'opacity', 'runs', 'paras', 'origin', 'locked']),
  image: new Set([
    'id',
    'type',
    'box',
    'mediaId',
    'play',
    'fit',
    'opacity',
    'radius',
    'crop',
    'flipH',
    'flipV',
    'mask',
    'origin',
    'locked',
  ]),
  shape: new Set(['id', 'type', 'box', 'shape', 'fill', 'stroke', 'opacity', 'radius', 'origin', 'locked']),
};

function union(a: Reach, b: Reach): Reach {
  if (a === null || b === null) return null;
  if (!(b.w > 0 && b.h > 0)) return a;
  if (!(a.w > 0 && a.h > 0)) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Axis-aligned bounds of [x0, x1] x [y0, y1] turned `deg` clockwise about (cx, cy), grown by `m`. */
function turned(x0: number, y0: number, x1: number, y1: number, box: Box, m: number): Reach {
  const deg = num(box.rotation, -36_000, 36_000, 0);
  if (!deg) return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const th = (deg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const x of [x0, x1])
    for (const y of [y0, y1]) {
      const px = cx + (x - cx) * c - (y - cy) * s;
      const py = cy + (x - cx) * s + (y - cy) * c;
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
  return { x: minX - m, y: minY - m, w: maxX - minX + 2 * m, h: maxY - minY + 2 * m };
}

type Effects = {
  shadow?: { dx?: number; dy?: number; blur?: number } | null;
  outline?: { width?: number } | null;
  glow?: { radius?: number } | null;
};

/** How far a style's or run's shadow, outline and glow reach past the glyphs (logical px). */
function effectReach(e: Effects | undefined | null): number {
  if (!e) return 0;
  let m = 0;
  const f = (v: unknown) => num(v, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0);
  if (e.shadow)
    m = Math.max(
      m,
      Math.max(Math.abs(f(e.shadow.dx)), Math.abs(f(e.shadow.dy))) + 2 * Math.abs(f(e.shadow.blur)),
    );
  if (e.outline) m = Math.max(m, Math.abs(f(e.outline.width)));
  if (e.glow) m = Math.max(m, 2 * Math.abs(f(e.glow.radius)));
  return m;
}

/**
 * Legacy text as `drawText` draws it (`layoutText` with the same `fit`): its laid-out block (the lines, and
 * the fill box when the style has one: `drawText` paints nothing else of the box), OVERHANG_EM of the font
 * size for glyph overhang, the style's effects, turned with the box.
 */
export function legacyTextReach(
  ctx: Ctx2D,
  text: string,
  style: TextStyle,
  box: Box,
  scale: number,
  fit: boolean,
): Reach {
  const b = clampBox(box);
  const st = clampStyle(style);
  const t = clampText(text);
  if (!t.trim()) return EMPTY;
  const s = num(scale, 0.01, 8, 1);
  ctx.save();
  const l = layoutText(ctx, t, st, b, s, fit);
  ctx.restore();
  if (!(l.block.w > 0 && l.block.h > 0)) return EMPTY;
  const x0 = l.block.x / s;
  const y0 = l.block.y / s;
  const x1 = (l.block.x + l.block.w) / s;
  const y1 = (l.block.y + l.block.h) / s;
  return turned(x0, y0, x1, y1, b, OVERHANG_EM * l.fontSize + effectReach(st as unknown as Effects));
}

/**
 * Rich text as `drawRichText` draws it: the engine's layout of the clamped object (memoised, so the draw
 * reuses it) and its paint plan: the fill box, highlights, decorations and every laid line with its bullet
 * (the box itself is not painted), grown by OVERHANG_EM of the largest glyph (plus the largest baseline
 * shift) and the largest effect of any run, turned with the box.
 */
export function richTextReach(ctx: Ctx2D, o: TextObject, opts?: RichLayoutOptions): Reach {
  const c = clampTextObject(o);
  const l = layoutRich(measurerFor(ctx), c, currentFontEnv(), opts);
  const plan = paintPlan(c, l);
  const b = c.box;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const add = (x: number, y: number, w: number, h: number) => {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h))) return;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  };
  // The largest glyph size (runs scale the box size; autofit only shrinks) and the largest baseline shift.
  const size = num(c.style.fontSizePx, 0, 1e4, 0);
  let scaleMax = 1;
  let shift = 0;
  for (const r of c.runs ?? []) {
    scaleMax = Math.max(scaleMax, num(r.sizeScale, 0, 50, 1));
    shift = Math.max(shift, Math.abs(num(r.baseline, -1, 1, 0)));
  }
  let em = size * scaleMax;
  for (const line of l.lines) {
    add(line.x, line.top, line.w, line.height);
    if (line.bullet) {
      const size = num(line.bullet.sizePx, 0, 1e4, 0);
      em = Math.max(em, size);
      add(line.bullet.x - size, line.top, 3 * size, line.height);
    }
  }
  if (plan.box) add(plan.box.x, plan.box.y, plan.box.w, plan.box.h);
  for (const r of plan.highlights) add(r.x, r.y, r.w, r.h);
  for (const r of plan.decorations) add(r.x, r.y, r.w, r.h);
  let fx = 0;
  for (const g of plan.glyphs) fx = Math.max(fx, effectReach(g));
  for (const g of plan.bullets) fx = Math.max(fx, effectReach(g));
  for (const d of plan.decorations) fx = Math.max(fx, effectReach(d));
  if (plan.glow) fx = Math.max(fx, 2 * num(plan.glow.radius, 0, CLAMP.maxEffectPx, 0));
  if (!(x1 >= x0 && y1 >= y0)) return EMPTY;
  return turned(x0, y0, x1, y1, b, em * (OVERHANG_EM + shift) + fx);
}

/** Where one object `drawObject` draws can reach (logical px), or null when it is not known. */
export function objectReach(ctx: Ctx2D, o: SlideObject, scale: number): Reach {
  const known = KNOWN[o.type];
  if (!known) return null;
  for (const k of Object.keys(o)) if (!known.has(k)) return null;
  if (o.type === 'text') {
    if (isRichText(o)) return richTextReach(ctx, o);
    return legacyTextReach(ctx, o.text, o.style, o.box, scale, false);
  }
  // A picture is cut to its box (a prepared one is copied at the box rounded out to whole pixels); a shape is
  // its box plus its stroke.
  const r = rotatedBounds(clampBox(o.box));
  const m = o.type === 'shape' && o.stroke ? num(o.stroke.width, 0, CLAMP.maxEffectPx, 1) : 0;
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

/** A look band (`drawBandText`): the rich engine's layout or `drawText`'s, shrunk to fit as the draw does. */
export function bandReach(
  ctx: Ctx2D,
  text: string,
  style: TextStyle,
  band: Box,
  scale: number,
  src?: TextObject,
): Reach {
  const clamped = clampStyle(style);
  const t = clampText(text);
  if ((src && isRichText(src)) || isRichStyle(clamped) || hasStrongRtl(t))
    return richTextReach(ctx, bandObject(src ? readableText(src) : t, clamped, clampBox(band), src), {
      minFontScale: BAND_MIN_FONT_SCALE,
    });
  return legacyTextReach(ctx, t, style, band, scale, true);
}

/** Where `drawSlide2D` with these options can draw (logical px). */
export function slideReach(
  ctx: Ctx2D,
  rawSlide: Slide,
  opts: { scale: number; look?: Look; nextSlide?: Slide; isSong?: boolean },
): Reach {
  const slide = clampSlide(rawSlide);
  const look = opts.look ? clampLook(opts.look) : undefined;
  const scale = num(opts.scale, 0.01, 8, 1);
  const rule = look?.layers.slide ?? { mode: 'authored' as const };
  if (rule.mode === 'hidden') return EMPTY;
  if (rule.mode === 'authored') {
    const drawn = drawableContent(slide);
    // The slide's PowerPoint or page picture covers the frame.
    if (drawn.pictureMediaId) return null;
    let r: Reach = EMPTY;
    for (const o of drawn.objects) {
      r = union(r, objectReach(ctx, o, scale));
      if (r === null) return null;
    }
    return r;
  }
  let r: Reach = EMPTY;
  const isSong = opts.isSong ?? true;
  const text = lyricTextFor(slide, look, isSong);
  if (text) r = union(r, bandReach(ctx, text, rule.style, rule.band, scale, bandSource(slide, text)));
  const next = opts.nextSlide ? clampSlide(opts.nextSlide) : undefined;
  if (rule.nextSlide && next) {
    const nt = lyricTextFor(next, look, isSong);
    if (nt)
      r = union(
        r,
        bandReach(ctx, nt, rule.nextSlide.style, rule.nextSlide.band, scale, bandSource(next, nt)),
      );
  }
  return r;
}

/** The lower-third layer (`rasterLowerThird`). */
export function lowerThirdReach(ctx: Ctx2D, text: string, look: Look, scale: number): Reach {
  const { style, band } = lowerThirdStyle(look);
  return bandReach(ctx, text, style, band, scale);
}

/** The props layer (`rasterProps`): a logo covers the frame; text props are drawn fitted to their boxes. */
export function propsReach(ctx: Ctx2D, model: PropsModel, scale: number): Reach {
  if (model.logo) return null;
  let r: Reach = EMPTY;
  for (const it of model.items) r = union(r, legacyTextReach(ctx, it.text, it.style, it.box, scale, true));
  return r;
}

/** An image layer (`rasterImage`): contain leaves the letterbox empty; cover and stretch fill the frame. */
export function imageReach(img: CanvasImageSource, fit: 'contain' | 'cover' | 'stretch'): Reach {
  if (fit !== 'contain') return null;
  const [iw, ih] = sourceSize(img);
  if (!(iw > 0 && ih > 0)) return null;
  const k = Math.min(FRAME.w / iw, FRAME.h / ih);
  const w = iw * k;
  const h = ih * k;
  return { x: (FRAME.w - w) / 2, y: (FRAME.h - h) / 2, w, h };
}

/**
 * Whether what is drawn over the whole frame is opaque: a fill or a cover-fitted opaque picture over the
 * logical frame covers the output only when the output is no taller than 16:9 at its width.
 */
export function coversFrame(scale: number, width: number, height: number): boolean {
  return LOGICAL_WIDTH * scale >= width - 1e-6 && LOGICAL_HEIGHT * scale >= height - 1e-6;
}

/** Whether a clear colour fills opaquely (the props logo's backdrop). */
export function opaqueColor(c: Rgba | undefined): boolean {
  return !!c && num(c.a, 0, 1, 1) >= 1;
}

/**
 * The device rect of a reach on a `width` x `height` frame at `scale`: rounded out to whole pixels, grown by
 * SPRITE_MARGIN, cut to the frame. Null (full-frame) when the reach is unknown or the rect would cover more
 * than SPRITE_MAX_SHARE of the frame; a 1x1 rect when nothing is drawn on the frame.
 */
export function spriteRect(reach: Reach, scale: number, width: number, height: number): SpriteRect | null {
  if (reach === null) return null;
  if (!(reach.w > 0 && reach.h > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  const s = num(scale, 0.01, 8, 1);
  const x0 = Math.max(0, Math.floor(reach.x * s) - SPRITE_MARGIN);
  const y0 = Math.max(0, Math.floor(reach.y * s) - SPRITE_MARGIN);
  const x1 = Math.min(width, Math.ceil((reach.x + reach.w) * s) + SPRITE_MARGIN);
  const y1 = Math.min(height, Math.ceil((reach.y + reach.h) * s) + SPRITE_MARGIN);
  if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1)))
    return null;
  if (!(x1 > x0 && y1 > y0)) return { x: 0, y: 0, w: 1, h: 1 };
  if ((x1 - x0) * (y1 - y0) > SPRITE_MAX_SHARE * width * height) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Whether anything drawn touches the edge ring of a sprite surface where that edge is not the frame's edge
 * (alpha above 0 in its outermost row or column): the reach was short and the sprite would cut the drawing.
 * A surface that cannot be read counts as touched (the layer is then drawn full-frame).
 */
export function spriteEdgeTouched(ctx: Ctx2D, r: SpriteRect, width: number, height: number): boolean {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  try {
    const any = (x: number, y: number, w: number, h: number) => {
      const d = ctx.getImageData(x, y, w, h).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) return true;
      return false;
    };
    return (
      (r.y > 0 && any(0, 0, r.w, 1)) ||
      (r.y + r.h < height && any(0, r.h - 1, r.w, 1)) ||
      (r.x > 0 && any(0, 0, 1, r.h)) ||
      (r.x + r.w < width && any(r.w - 1, 0, 1, r.h))
    );
  } catch {
    return true;
  } finally {
    ctx.restore();
  }
}

/** A drawn layer: its bitmap and offset; `missed` when a sprite was drawn again full-frame. */
export type DrawnSprite<B> = { bitmap: B; x: number; y: number; tight: boolean; missed: boolean };

/**
 * Draw a layer as a tight sprite when `rect` is given (`spriteRect`), else full-frame. `surface(w, h)`
 * returns a cleared, untransformed context of that size; `take()` the drawn picture (leaving the surface
 * transparent, as transferToImageBitmap does); `draw` draws in frame device px. A sprite whose drawing
 * touches its edge ring (`spriteEdgeTouched`) is drawn again full-frame.
 */
export function drawSprite<B>(
  surface: (w: number, h: number) => Ctx2D,
  take: () => B,
  width: number,
  height: number,
  rect: SpriteRect | null,
  draw: (ctx: Ctx2D) => void,
): DrawnSprite<B> {
  if (rect) {
    const c = surface(rect.w, rect.h);
    c.translate(-rect.x, -rect.y);
    draw(c);
    if (!spriteEdgeTouched(c, rect, width, height))
      return { bitmap: take(), x: rect.x, y: rect.y, tight: true, missed: false };
  }
  const c = surface(width, height);
  draw(c);
  return { bitmap: take(), x: 0, y: 0, tight: false, missed: rect !== null };
}

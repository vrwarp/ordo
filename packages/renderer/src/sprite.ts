import {
  type Box,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Look,
  type Rgba,
  type ShapeObject,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextStyle,
  readableText,
} from '@ordo/domain';
import { CLAMP, clampBox, clampLook, clampSlide, clampStyle, clampText, isRichStyle, num } from './clamp.ts';
import { drawableContent } from './content.ts';
import type { Ctx2D } from './ctx.ts';
import { BLUR_MAX_REDUCTION, STACK_BLUR_SIGMA } from './effects.ts';
import { drawnBounds, placedBounds } from './geom/bounds.ts';
import { hasShapeExtras, outlineOf } from './geom/outline.ts';
import { geomAwaited } from './geom/stored.ts';
import { withinDrawBudget } from './geombudget.ts';
import { pictureLooksRegistered, sourceSize } from './picture.ts';
import type { PropsModel } from './props.ts';
import { lowerThirdStyle } from './raster.ts';
import { rotatedBounds } from './scene.ts';
import { clampShapeObject, look3dRegistered, shapeDrawerReach, shapeGeometry } from './shape.ts';
import { hasStrongRtl } from './text/bidi.ts';
import { currentFontEnv } from './text/fonts.ts';
import { measurerFor } from './text/measure.ts';
import {
  DIRECT_TARGET,
  faceTargetFor,
  glyphPainterFor,
  PLAIN_PAINTER,
  type PaintPlan,
  paintPlan,
} from './text/paint.ts';
import {
  BAND_MIN_FONT_SCALE,
  type RichLayoutOptions,
  bandObject,
  clampTextObject,
  isRichText,
  layoutRich,
} from './text/rich.ts';
import type { Measurer, RichLayout } from './text/types.ts';
import {
  bandSource,
  baselineOffset,
  layoutText,
  lyricTextFor,
  registeredSlideObjectsDrawer,
} from './text2d.ts';

/**
 * Tight sprites (design/27 §7.3, M7): a layer's raster is the bounding box of what it draws, at its offset
 * in the frame, instead of a full-frame bitmap, where that saves work. A lyric band, a lower third, props
 * text or a scene's over covers a fraction of the frame; drawing, transferring and uploading only that
 * fraction removes most of the clear, the transfer and the upload, and the compositors draw it at its
 * offset (WebGPU: a sub-rect copy and a scissor; Canvas 2D: drawImage at the offset).
 *
 * The box comes from the content, before anything is drawn (`*Reach`, logical px): every object's reach as
 * its drawer lays it out (legacy text by `layoutText`, rich text by the engine's own layout and paint plan,
 * memoised, so the draw that follows does not lay out again), widened by its effects (shadow, outline, glow),
 * turned with its box; a PowerPoint shape (M6) its geometry, outline and effect layers as `drawGeomShape` and
 * `drawEffected` make them. Text reaches its laid-out lines grown by OVERHANG_EM, united with the ink its glyphs
 * measure (`TextMetrics.actualBoundingBox*`: legacy lines carry theirs in the layout, rich segments are
 * measured once per paint plan), which is what bounds glyph parts that are shapes of their own beyond the
 * line box (tone marks stacked over a circumflex on a capital, Thai marks above a vowel, with tight line
 * spacing). M9's fields are known (`KNOWN`): a table, chart or decoration reaches where its registered drawer
 * says (`shapeDrawerReach`; the table's `tableReach`), else as its legacy shape; text with a warp, vertical
 * writing, a centred block or a 3-D look, and a picture with a 3-D look or vector fonts, reach as their plain
 * text and box while no hook draws them. Anything this cannot bound (an object with fields it does not know,
 * text a registered glyph painter or face target draws, a picture or shape whose registered 3-D look may
 * reach past it, a drawer registered without a reach, a slide's PowerPoint picture, an opaque logo) reaches
 * the whole frame, and the layer stays full-frame. `drawSprite` draws into
 * a surface of the box (with a margin) and checks that nothing touches the surface's edges where they are
 * not the frame's: if anything does, the reach was short, and the layer is drawn again full-frame. The edge
 * ring sees only drawing that crosses it, never a shape that lies wholly beyond it, so the reach itself must
 * hold every part of every glyph: the ring is the safety net for a reach that is short by a little.
 */

/** A device px rect in the frame, whole pixels. */
export type SpriteRect = { x: number; y: number; w: number; h: number };

/** Logical px rect; `null` reaches the whole frame (the layer stays full-frame). */
export type Reach = { x: number; y: number; w: number; h: number } | null;

/** Device px kept clear around a reach: the ring `drawSprite` checks lies outside everything reached. */
export const SPRITE_MARGIN = 2;
/**
 * A sprite's origin is a whole multiple of this many device px (its left and top edges move out to one):
 * Chromium dithers gradients (a PowerPoint shape's or gradient text's, M6) by device position, so a sprite
 * at any other offset would differ from the full-frame draw by a level on many pixels of a gradient.
 */
export const SPRITE_ALIGN = 8;
/** A sprite is used only when it covers at most this share of the frame; else the raster is full-frame. */
export const SPRITE_MAX_SHARE = 0.8;
/**
 * How far glyphs are taken to reach past their laid-out line boxes, in ems of their size, before their ink
 * is known: an accent over a capital (0.95 em above the baseline against the 0.8 em the layout gives the
 * ascent), a descender with a line height under 1, an italic's overhang. It is not a bound: a glyph part
 * that is a shape of its own can lie wholly beyond it ('Ễ' in Inter Bold reaches 1.11 em above its
 * baseline, 0.46 em above its line box at a line height of 0.7, and its tilde lies wholly above the 0.3 em),
 * and the edge ring cannot see a shape that never crosses it. The measured ink (the legacy lines' `ink`,
 * `planInk`) is what bounds the glyphs; this margin covers contexts that report no ink box and keeps the
 * reach of ordinary text what it was.
 */
export const OVERHANG_EM = 0.3;
/** Logical px the measured ink is grown by: its rounding to whole px at the measured size, antialiasing. */
const INK_SLACK = 1;

const EMPTY = { x: 0, y: 0, w: 0, h: 0 };
const FRAME: Box = { x: 0, y: 0, w: LOGICAL_WIDTH, h: LOGICAL_HEIGHT, rotation: 0 };

/** Fields of the objects whose reach is known; an object with any other field reaches the whole frame. */
const KNOWN: Record<SlideObject['type'], ReadonlySet<string>> = {
  text: new Set([
    'id',
    'type',
    'box',
    'text',
    'style',
    'opacity',
    'runs',
    'paras',
    'origin',
    'locked',
    // M9 (`RICH_OBJECT_KEYS`): drawn by the rich engine; while a warp or upright painter or the 3-D face
    // target applies, the object reaches the whole frame (`textHooked`).
    'warp',
    'writing',
    'centerBlock',
    'look3d',
  ]),
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
    'shadow',
    'softEdge',
    'origin',
    'locked',
    // M9: a picture's 3-D look reaches past its box only through a registered target extension or post step
    // (`pictureLooksRegistered`); a vector picture's families change nothing of where it is drawn.
    'look3d',
    'vectorFonts',
  ]),
  shape: new Set([
    'id',
    'type',
    'box',
    'shape',
    'fill',
    'stroke',
    'opacity',
    'radius',
    // M6 (design/27 §3.1), drawn through the geometry engine: `geomShapeReach`.
    'geom',
    'gradient',
    'dash',
    'lineJoin',
    'lineCap',
    'ends',
    'flipH',
    'flipV',
    'shadow',
    'glow',
    'softEdge',
    'origin',
    'locked',
    // M9: a table, chart or decoration reaches where its registered drawer says (`shapeDrawerReach`), its
    // geometry or legacy shape until one is registered; a 3-D look with a registered resolver, the frame.
    'table',
    'chart',
    'decor',
    'look3d',
  ]),
};

function union(a: Reach, b: Reach): Reach {
  if (a === null || b === null) return null;
  if (!(b.w > 0 && b.h > 0)) return a;
  if (!(a.w > 0 && a.h > 0)) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Axis-aligned bounds of [x0, x1] x [y0, y1] (logical px, slide space) turned by `box.rotation` clockwise
 * about the box's centre, grown by `m`.
 */
export function turned(x0: number, y0: number, x1: number, y1: number, box: Box, m: number): Reach {
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
 * the fill box when the style has one: `drawText` paints nothing else of the box) grown by OVERHANG_EM of the
 * font size, united with every line's ink (`TextLayout` lines' `ink`, at the baseline `drawText` draws the
 * line on), then the style's effects, turned with the box.
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
  const o = OVERHANG_EM * l.fontSize;
  let x0 = l.block.x / s - o;
  let y0 = l.block.y / s - o;
  let x1 = (l.block.x + l.block.w) / s + o;
  let y1 = (l.block.y + l.block.h) / s + o;
  const base = baselineOffset(l, s);
  for (const line of l.lines) {
    const k = line.ink;
    if (!k) continue;
    const y = line.y + base;
    x0 = Math.min(x0, (line.x - k.left) / s - INK_SLACK);
    x1 = Math.max(x1, (line.x + k.right) / s + INK_SLACK);
    y0 = Math.min(y0, (y - k.ascent) / s - INK_SLACK);
    y1 = Math.max(y1, (y + k.descent) / s + INK_SLACK);
  }
  if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1)))
    return null;
  return turned(x0, y0, x1, y1, b, effectReach(st as unknown as Effects));
}

/**
 * Rich text as `drawRichText` draws it: the engine's layout of the clamped object (memoised, so the draw
 * reuses it) and its paint plan: the fill box, highlights, decorations and every laid line with its bullet
 * (the box itself is not painted), grown by OVERHANG_EM of the largest glyph (plus the largest baseline
 * shift), united with the ink of every glyph run and bullet (`planInk`), then the largest effect of any run,
 * turned with the box.
 */
export function richTextReach(ctx: Ctx2D, o: TextObject, opts?: RichLayoutOptions): Reach {
  const c = clampTextObject(o);
  if (textHooked(c)) return null;
  const m = measurerFor(ctx);
  const l = layoutRich(m, c, currentFontEnv(), opts);
  const k = richLayoutBounds(m, c, l);
  if (!k) return EMPTY;
  return turned(k.x0, k.y0, k.x1, k.y1, c.box, k.fx);
}

/**
 * Whether a text object is painted by a registered hook (M9 plan decision 6): a warp or upright glyph
 * painter, or the 3-D face sprite target. They lay out and draw glyphs their own way, so the plain paint
 * plan does not bound them: such an object reaches the whole frame.
 */
export function textHooked(o: TextObject): boolean {
  return glyphPainterFor(o) !== PLAIN_PAINTER || faceTargetFor(o) !== DIRECT_TARGET;
}

/** Unturned bounds (logical px, the layout's own space) and the largest effect reach. */
export type RichBounds = { x0: number; y0: number; x1: number; y1: number; fx: number };

/**
 * Where a rich layout `l` of the clamped text object `c` draws with the plain painter, unturned, in the
 * layout's own space (`richTextReach`'s bounds before the box's rotation), and its largest effect; null when
 * it draws nothing. Table cells (`table/reach.ts`) place it at their corners.
 */
export function richLayoutBounds(m: Measurer, c: TextObject, l: RichLayout): RichBounds | null {
  const plan = paintPlan(c, l);
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
  if (plan.lineMask) {
    for (const r of plan.lineMask.straps) add(r.x, r.y, r.w, r.h);
  }
  let fx = 0;
  for (const g of plan.glyphs) fx = Math.max(fx, effectReach(g));
  for (const g of plan.bullets) fx = Math.max(fx, effectReach(g));
  for (const d of plan.decorations) fx = Math.max(fx, effectReach(d));
  if (plan.glow) fx = Math.max(fx, 2 * num(plan.glow.radius, 0, CLAMP.maxEffectPx, 0));
  if (!(x1 >= x0 && y1 >= y0)) return null;
  const over = em * (OVERHANG_EM + shift);
  x0 -= over;
  y0 -= over;
  x1 += over;
  y1 += over;
  const ink = planInk(m, plan);
  if (ink) {
    x0 = Math.min(x0, ink.x0);
    y0 = Math.min(y0, ink.y0);
    x1 = Math.max(x1, ink.x1);
    y1 = Math.max(y1, ink.y1);
  }
  return { x0, y0, x1, y1, fx };
}

type InkBox = { x0: number; y0: number; x1: number; y1: number };
const planInks = new WeakMap<PaintPlan, InkBox | null>();

/**
 * Where the glyphs of a paint plan reach (logical px, rotation 0): each glyph run and bullet measured in the
 * state `paintRich` draws it in (font, direction, language, letter spacing; left-aligned at its x, on its
 * baseline y), grown by INK_SLACK. Memoised per plan (plans are per layout, layouts per object and font
 * generation), so a layer's reach measures its runs once. Null when the measurer reports no ink.
 */
function planInk(m: Measurer, plan: PaintPlan): InkBox | null {
  const hit = planInks.get(plan);
  if (hit !== undefined) return hit;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  if (m.ink)
    for (const list of [plan.glyphs, plan.bullets])
      for (const g of list) {
        const k = m.ink(g.font, g.dir, g.lang, g.spacing, g.text);
        if (!k) continue;
        const a = g.x - k.left;
        const b = g.x + k.right;
        const t = g.y - k.ascent;
        const d = g.y + k.descent;
        if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(t) && Number.isFinite(d))) continue;
        x0 = Math.min(x0, a);
        x1 = Math.max(x1, b);
        y0 = Math.min(y0, t);
        y1 = Math.max(y1, d);
      }
  const out =
    x1 >= x0 && y1 >= y0
      ? { x0: x0 - INK_SLACK, y0: y0 - INK_SLACK, x1: x1 + INK_SLACK, y1: y1 + INK_SLACK }
      : null;
  planInks.set(plan, out);
  return out;
}

/** Where one object `drawObject` draws can reach (logical px), or null when it is not known. */
export function objectReach(ctx: Ctx2D, o: SlideObject, scale: number): Reach {
  const known = KNOWN[o.type];
  if (!known) return null;
  for (const k of Object.keys(o)) if (!known.has(k)) return null;
  if (o.type === 'text') {
    if (isRichText(o) || isRichStyle(o.style)) return richTextReach(ctx, o);
    return legacyTextReach(ctx, o.text, o.style, o.box, scale, false);
  }
  if (o.type === 'shape') {
    // `drawShapeObject`'s order: a registered table, chart or decoration drawer, then the geometry (with a
    // 3-D look when its resolver is registered), then the legacy shape.
    const drawn = shapeDrawerReach(ctx, o);
    if (drawn !== undefined) return drawn;
    if (o.look3d !== undefined && look3dRegistered()) return null;
    if (hasShapeExtras(o)) return geomShapeReach(o, scale);
  }
  if (o.type === 'image') {
    if (o.look3d !== undefined && pictureLooksRegistered()) return null;
    const r = rotatedBounds(clampBox(o.box));
    let x0 = r.x;
    let y0 = r.y;
    let x1 = r.x + r.w;
    let y1 = r.y + r.h;
    // A shadow is the picture's alpha blurred and offset as a shape's (`picture-effects.ts`, `drawEffected`:
    // 3σ past it, σ = blur/√6); a soft edge only fades the picture inside its box.
    if (o.shadow && num(o.shadow.color?.a, 0, 1, 0) > 0) {
      const dx = num(o.shadow.dx, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0);
      const dy = num(o.shadow.dy, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0);
      const blur = num(o.shadow.blur, 0, CLAMP.maxEffectPx, 0);
      const pad = 3 * blur * STACK_BLUR_SIGMA + BLUR_SLACK_PX / num(scale, 0.01, 8, 1) + INK_SLACK;
      x0 = Math.min(x0, r.x + dx - pad);
      y0 = Math.min(y0, r.y + dy - pad);
      x1 = Math.max(x1, r.x + r.w + dx + pad);
      y1 = Math.max(y1, r.y + r.h + dy + pad);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  // A shape is its box plus its stroke.
  const r = rotatedBounds(clampBox(o.box));
  const m = o.type === 'shape' && o.stroke ? num(o.stroke.width, 0, CLAMP.maxEffectPx, 1) : 0;
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

/**
 * Device px a blurred effect layer reaches past what its blur covers (`drawEffected`): the 2 px its region
 * adds, and the enlarged reduced layer's last pixel (up to BLUR_MAX_REDUCTION device px).
 */
const BLUR_SLACK_PX = 2 + BLUR_MAX_REDUCTION;

/**
 * A shape drawn through the geometry engine (`drawGeomShape`, M6): what it draws in box space (its geometry's
 * points, past its box included, grown by its outline's joins, caps and arrowheads: `drawnBounds`, the
 * bounds its effect layers are made over) placed on the slide with its flips and rotation, united with its
 * shadow (offset, blurred 3σ past it) and glow (grown by half its radius, blurred 3σ past that) as
 * `drawEffected` sizes their layers, grown by INK_SLACK for anti-aliasing. A soft edge only fades the shape
 * inside its outline. A shape whose geometry file is not read yet draws nothing (`geomAwaited`).
 */
export function geomShapeReach(raw: ShapeObject, scale: number): Reach {
  const o = clampShapeObject(raw);
  if (geomAwaited(o.geom)) return EMPTY;
  const s = num(scale, 0.01, 8, 1);
  const built = shapeGeometry(o);
  const outline = o.stroke ? outlineOf(o, num(o.stroke.width, 0, CLAMP.maxEffectPx, 1)) : undefined;
  const b = placedBounds(drawnBounds(built, outline), {
    box: o.box,
    flipH: o.flipH === true,
    flipV: o.flipV === true,
  });
  let { x0, y0, x1, y1 } = b;
  const slack = BLUR_SLACK_PX / s;
  const sh = o.shadow && num(o.shadow.color?.a, 0, 1, 0) > 0 ? o.shadow : undefined;
  if (sh) {
    const dx = num(sh.dx, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0);
    const dy = num(sh.dy, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0);
    const r = 3 * num(sh.blur, 0, CLAMP.maxEffectPx, 0) * STACK_BLUR_SIGMA + slack;
    x0 = Math.min(x0, b.x0 + dx - r);
    y0 = Math.min(y0, b.y0 + dy - r);
    x1 = Math.max(x1, b.x1 + dx + r);
    y1 = Math.max(y1, b.y1 + dy + r);
  }
  const radius =
    o.glow && num(o.glow.color?.a, 0, 1, 0) > 0 ? num(o.glow.radius, 0, CLAMP.maxEffectPx, 0) : 0;
  if (radius > 0) {
    const r = (radius / 2) * (1 + 3 * STACK_BLUR_SIGMA) + slack;
    x0 = Math.min(x0, b.x0 - r);
    y0 = Math.min(y0, b.y0 - r);
    x1 = Math.max(x1, b.x1 + r);
    y1 = Math.max(y1, b.y1 + r);
  }
  if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1)))
    return null;
  return { x: x0 - INK_SLACK, y: y0 - INK_SLACK, w: x1 - x0 + 2 * INK_SLACK, h: y1 - y0 + 2 * INK_SLACK };
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
  if ((src && (isRichText(src) || isRichStyle(src.style))) || isRichStyle(clamped) || hasStrongRtl(t))
    return richTextReach(ctx, bandObject(src ? readableText(src) : t, clamped, clampBox(band), src), {
      minFontScale: BAND_MIN_FONT_SCALE,
    });
  return legacyTextReach(ctx, t, style, band, scale, true);
}

/** Where `drawSlide2D` with these options can draw (logical px). */
export function slideReach(
  ctx: Ctx2D,
  rawSlide: Slide,
  opts: {
    scale: number;
    look?: Look;
    nextSlide?: Slide;
    isSong?: boolean;
    presentationKind?: 'song' | 'slides' | 'loop';
  },
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
    // As `drawSlide2D` draws them: past the slide's drawing budget, as their legacy shapes or without effects;
    // an object past it whose geometry unit is ready (units.ts) as the unit draws it, its original's bounds.
    const units = registeredSlideObjectsDrawer();
    for (const o of withinDrawBudget(drawn.objects)) {
      r = union(r, units?.reach?.(o, scale) ?? objectReach(ctx, o, scale));
      if (r === null) return null;
    }
    return r;
  }
  let r: Reach = EMPTY;
  const kind = opts.presentationKind ?? opts.isSong ?? true;
  const text = lyricTextFor(slide, look, kind);
  if (text) r = union(r, bandReach(ctx, text, rule.style, rule.band, scale, bandSource(slide, text)));
  const next = opts.nextSlide ? clampSlide(opts.nextSlide) : undefined;
  if (rule.nextSlide && next && kind !== 'loop') {
    const nt = lyricTextFor(next, look, kind);
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
 * SPRITE_MARGIN, its origin moved out to a multiple of SPRITE_ALIGN, cut to the frame. Null (full-frame) when
 * the reach is unknown or the rect would cover more than SPRITE_MAX_SHARE of the frame; a 1x1 rect when
 * nothing is drawn on the frame.
 */
export function spriteRect(reach: Reach, scale: number, width: number, height: number): SpriteRect | null {
  if (reach === null) return null;
  if (!(reach.w > 0 && reach.h > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  const s = num(scale, 0.01, 8, 1);
  const align = (v: number) => Math.floor(v / SPRITE_ALIGN) * SPRITE_ALIGN;
  const x0 = Math.max(0, align(Math.floor(reach.x * s) - SPRITE_MARGIN));
  const y0 = Math.max(0, align(Math.floor(reach.y * s) - SPRITE_MARGIN));
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

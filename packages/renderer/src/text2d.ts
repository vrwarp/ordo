import {
  adaptStageRegions,
  type Box,
  formatStageNotesPlain,
  type ImageCrop,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Look,
  type PropBox,
  type Rgba,
  type Slide,
  type SlideObject,
  stageNotesEnabled,
  type TextObject,
  type TextStyle,
  readableText,
  strapText,
  rgbaCss,
  textScripts,
} from '@ordo/domain';

import {
  CLAMP,
  clampBox,
  clampCrop,
  clampLook,
  clampSlide,
  clampStyle,
  clampText,
  isRichStyle,
  num,
} from './clamp.ts';
import { drawableContent } from './content.ts';
import { type Ctx2D, roundRect, setLetterSpacing, withRotation } from './ctx.ts';
import {
  type PictureShape,
  type PictureSource,
  type PictureTarget,
  paintPicture,
  paintShapedPicture,
  pictureFit,
  hasPictureEffects,
  pictureShape,
  pictureTarget,
  preparedKey,
  roundCornerMask,
} from './picture.ts';
import { EFFECT_MAX_PIXELS } from './effects.ts';
import { drawPictureEffected } from './picture-effects.ts';
import { GEOM_CLIP_RULE, geomFillPath2D } from './geom/draw.ts';
import { geomAwaited, storedGeometry } from './geom/stored.ts';
import { withinDrawBudget } from './geombudget.ts';
import { drawShapeObject, placeBox } from './shape.ts';
import { spriteCache } from './spritecache.ts';
import { firstStrong, hasStrongRtl } from './text/bidi.ts';
import { LEGACY_FONT_ENV, currentFontEnv } from './text/fonts.ts';
import { metricsInk } from './text/measure.ts';
import { BAND_MIN_FONT_SCALE, bandObject, drawRichText, isRichText } from './text/rich.ts';
import type { Ink } from './text/types.ts';

export type { Ctx2D } from './ctx.ts';
/**
 * Decoded pictures by media id. The drawers pass the `pictureTarget` each picture is drawn at (undefined
 * for one drawn from its source: rotated, round corners, oversized). Given a target, a lookup returns the
 * source or a bitmap `preparePicture` made for a target with the same key; a lookup may ignore targets. A
 * source may be a vector picture (`PictureSource`, M9), which a registered source step draws.
 */
export type ImageLookup = (mediaId: string, target?: PictureTarget) => PictureSource | undefined;

/**
 * The CSS font of legacy text. With a font resolver installed (design/27 §10: the asset worker, the thumbnail
 * worker, the editor page) the family resolves through it like rich text does, with `script`'s fallback
 * face; with none it is exactly the string drawers used before the resolver.
 */
export function fontString(style: TextStyle, scale: number, sizeOverride?: number, script = ''): string {
  const size = (sizeOverride ?? style.fontSizePx) * scale;
  const env = currentFontEnv();
  if (env === LEGACY_FONT_ENV)
    return `${style.fontStyle === 'italic' ? 'italic ' : ''}${style.fontWeight} ${size}px "${style.fontFamily}", "Inter", "Segoe UI", Arial, sans-serif`;
  return env.font({
    family: style.fontFamily,
    fallbacks: style.fallbackFonts ?? [],
    weight: style.fontWeight,
    italic: style.fontStyle === 'italic',
    smallCaps: false,
    sizePx: size,
    script,
  });
}

/** The script whose fallback face legacy text asks the resolver for: the first of `textScripts`, else ''. */
function legacyScript(text: string): string {
  if (currentFontEnv() === LEGACY_FONT_ENV) return '';
  for (const s of textScripts(text)) return s;
  return '';
}

/** Greedy word wrap. Paragraphs are separated by \n. Long words are broken by characters. */
export function wrapLines(ctx: Pick<Ctx2D, 'measureText'>, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) wrapParagraph(ctx, para, maxWidth, out);
  return out;
}

/** The lines of one paragraph, appended to `out`. */
function wrapParagraph(ctx: Pick<Ctx2D, 'measureText'>, para: string, maxWidth: number, out: string[]): void {
  const words = para.split(/\s+/).filter(Boolean);
  if (!words.length) {
    out.push('');
    return;
  }
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      if (!line && ctx.measureText(w).width > maxWidth) {
        // break an over-long word
        let chunk = '';
        for (const ch of w) {
          if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
            out.push(chunk);
            chunk = ch;
          } else chunk += ch;
        }
        line = chunk;
      } else line = candidate;
    } else {
      out.push(line);
      line = w;
    }
  }
  out.push(line);
}

/**
 * The direction `drawText` sets for each paragraph (design/27 §6 "Bands, stage and readable text"): the
 * direction of its first strong character, only for a paragraph that has a strong right-to-left character;
 * null for the others, which keep the context's direction. Null when no paragraph has one, so left-to-right
 * text is laid out and drawn exactly as before.
 */
export function paragraphDirections(text: string): ('ltr' | 'rtl' | null)[] | null {
  if (!hasStrongRtl(text)) return null;
  return text.split('\n').map((p) => (hasStrongRtl(p) ? (firstStrong(p) ?? 'rtl') : null));
}

/** `wrapLines` with each paragraph measured in its direction, and the direction of every line. */
function wrapDirected(
  ctx: Ctx2D,
  text: string,
  maxWidth: number,
  dirs: readonly ('ltr' | 'rtl' | null)[],
): { lines: string[]; dirs: ('ltr' | 'rtl' | null)[] } {
  const dir0 = ctx.direction;
  const lines: string[] = [];
  const out: ('ltr' | 'rtl' | null)[] = [];
  text.split('\n').forEach((para, i) => {
    const d = dirs[i] ?? null;
    ctx.direction = d ?? dir0;
    const n = lines.length;
    wrapParagraph(ctx, para, maxWidth, lines);
    for (let k = n; k < lines.length; k++) out.push(d);
  });
  ctx.direction = dir0;
  return { lines, dirs: out };
}

export type TextLayout = {
  /**
   * `dir` is set on lines of paragraphs with a strong right-to-left character (`paragraphDirections`).
   * `ink` (device px, from the line's own `measureText`, `metricsInk`) is where its glyphs reach from
   * (x, the baseline `drawText` draws it on, `y + baselineOffset`): every glyph part, a tone mark stacked
   * over a capital that lies wholly above the line box included. Absent on blank lines and where the
   * context reports no ink box.
   */
  lines: { text: string; x: number; y: number; width: number; dir?: 'ltr' | 'rtl'; ink?: Ink }[];
  fontSize: number;
  lineHeightPx: number;
  block: { x: number; y: number; w: number; h: number };
  /**
   * The CSS font and letter spacing (device px) the lines were measured in. `drawText` sets both from the
   * layout, so a layout from the memo draws in its own font whatever state the context is in.
   */
  font: string;
  letterSpacing: number;
};

/**
 * Lay out text in a box (device pixels = logical * scale). With `fit`, shrinks the font down to
 * `minScale` of its size until the block fits the box height. Memoised per context while a font resolver
 * is installed (`legacyLayoutMemo`); the layout returned is shared and must not be changed.
 */
export function layoutText(
  ctx: Ctx2D,
  text: string,
  style: TextStyle,
  box: Box,
  scale: number,
  fit = false,
  minScale = 0.5,
): TextLayout {
  return legacyLayoutMemo(ctx, text, style, box, scale, fit, minScale, layoutTextNow);
}

function layoutTextNow(
  ctx: Ctx2D,
  text: string,
  style: TextStyle,
  box: Box,
  scale: number,
  fit = false,
  minScale = 0.5,
): TextLayout {
  // Last line of the render-plan clamps (design/25): bounded text, font size and box whatever the caller.
  text = clampText(text);
  if (style.transform === 'uppercase') text = text.toUpperCase();
  style = clampStyle(style);
  box = clampBox(box);
  scale = num(scale, 0.01, 8, 1);
  minScale = num(minScale, 0.05, 1, 0.5);
  const pad = style.padding * scale;
  const bx = box.x * scale;
  const by = box.y * scale;
  const bw = box.w * scale;
  const bh = box.h * scale;
  const innerW = Math.max(1, bw - 2 * pad);
  const innerH = Math.max(1, bh - 2 * pad);
  let size = style.fontSizePx;
  let lines: string[] = [];
  let lineDirs: ('ltr' | 'rtl' | null)[] | null = null;
  let lh = 0;
  let font = '';
  const spacing = style.letterSpacing * scale;
  const dirs = paragraphDirections(text);
  const script = legacyScript(text);
  for (;;) {
    font = fontString(style, scale, size, script);
    ctx.font = font;
    setLetterSpacing(ctx, spacing);
    if (dirs) ({ lines, dirs: lineDirs } = wrapDirected(ctx, text, innerW, dirs));
    else lines = wrapLines(ctx, text, innerW);
    lh = size * scale * style.lineHeight;
    if (!fit || lines.length * lh <= innerH || size <= Math.max(CLAMP.minFontPx, style.fontSizePx * minScale))
      break;
    size = Math.max(CLAMP.minFontPx, style.fontSizePx * minScale, size * 0.92);
  }
  const blockH = lines.length * lh;
  let y0 = by + pad;
  if (style.valign === 'middle') y0 = by + pad + (innerH - blockH) / 2;
  else if (style.valign === 'bottom') y0 = by + pad + innerH - blockH;
  // Lines that overflow far past the clamp region (±2× the canvas) are never visible: cull them, so an
  // overlong text costs measuring, not drawing thousands of off-screen lines.
  const lo = -CLAMP.boxFactor * LOGICAL_HEIGHT * scale;
  const hi = CLAMP.boxFactor * LOGICAL_HEIGHT * scale;
  const laid: TextLayout['lines'] = [];
  const dir0 = lineDirs ? ctx.direction : undefined;
  // Each line's ink comes from the same measure as its width, on the alphabetic baseline `drawText` draws
  // on (put back after), relative to the line's left edge whatever the context's alignment.
  const baseline0 = ctx.textBaseline;
  if (baseline0 !== 'alphabetic') ctx.textBaseline = 'alphabetic';
  for (let i = 0; i < lines.length; i++) {
    const y = y0 + i * lh;
    if (y < lo || y > hi) continue;
    const t = lines[i]!;
    const dir = lineDirs?.[i];
    if (lineDirs) ctx.direction = dir ?? dir0!;
    const metrics = ctx.measureText(t);
    const width = metrics.width;
    let x = bx + pad;
    if (style.align === 'center') x = bx + pad + (innerW - width) / 2;
    else if (style.align === 'right') x = bx + pad + innerW - width;
    const line: TextLayout['lines'][number] = dir ? { text: t, x, y, width, dir } : { text: t, x, y, width };
    const ink = /\S/.test(t) ? metricsInk(metrics, ctx.textAlign, ctx.direction) : undefined;
    if (ink) line.ink = ink;
    laid.push(line);
  }
  if (baseline0 !== 'alphabetic') ctx.textBaseline = baseline0;
  if (lineDirs) ctx.direction = dir0!;
  const maxW = laid.reduce((m, l) => Math.max(m, l.width), 0);
  let blockX = bx + pad;
  if (style.align === 'center') blockX = bx + pad + (innerW - maxW) / 2;
  else if (style.align === 'right') blockX = bx + pad + innerW - maxW;
  const top = Math.max(lo, y0 - pad);
  const bottom = Math.min(hi, y0 + blockH + pad);
  return {
    lines: laid,
    fontSize: size,
    lineHeightPx: lh,
    block: { x: blockX - pad, y: top, w: maxW + 2 * pad, h: Math.max(0, bottom - top) },
    font,
    letterSpacing: spacing,
  };
}

/**
 * Where `drawText` puts a line's baseline below the line's `y` (device px): the line box centred on the
 * font size, an ascent of 0.8 em.
 */
export function baselineOffset(layout: TextLayout, scale: number): number {
  const ascent = layout.fontSize * scale * 0.8;
  return (layout.lineHeightPx - layout.fontSize * scale) / 2 + ascent;
}

/** Draw one text block: fill, shadow, outline, then the glyphs. */
export function drawText(
  ctx: Ctx2D,
  text: string,
  style: TextStyle,
  box: Box,
  scale: number,
  opts: { opacity?: number; fit?: boolean } = {},
): TextLayout {
  style = clampStyle(style);
  box = clampBox(box);
  text = clampText(text);
  ctx.save();
  ctx.globalAlpha = num(opts.opacity, 0, 1, 1);
  const layout = layoutText(ctx, text, style, box, scale, opts.fit ?? false);
  // The layout may come from the memo (measured on another surface, or before a resize reset the state):
  // draw in the font it was measured in, not whatever the context holds.
  ctx.font = layout.font;
  setLetterSpacing(ctx, layout.letterSpacing);
  // Lines of right-to-left paragraphs are drawn in their direction, left-aligned at their x like every line.
  const directed = layout.lines.some((l) => l.dir);
  const dir0 = directed ? ctx.direction : undefined;
  const lineDir = directed
    ? (l: TextLayout['lines'][number]) => {
        ctx.direction = l.dir ?? dir0!;
      }
    : undefined;
  withRotation(ctx, box, scale, () => {
    ctx.textBaseline = 'alphabetic';
    if (directed) ctx.textAlign = 'left';
    const offsetY = baselineOffset(layout, scale);
    if (style.fill && text.trim()) {
      ctx.fillStyle = rgbaCss(style.fill.color);
      roundRect(
        ctx,
        layout.block.x,
        layout.block.y,
        layout.block.w,
        layout.block.h,
        style.fill.radius * scale,
      );
      ctx.fill();
    }
    if (style.shadow) {
      ctx.save();
      ctx.shadowColor = rgbaCss(style.shadow.color);
      ctx.shadowBlur = style.shadow.blur * scale;
      ctx.shadowOffsetX = style.shadow.dx * scale;
      ctx.shadowOffsetY = style.shadow.dy * scale;
      ctx.fillStyle = rgbaCss(style.outline?.color ?? style.color);
      for (const l of layout.lines) {
        lineDir?.(l);
        ctx.fillText(l.text, l.x, l.y + offsetY);
      }
      ctx.restore();
    }
    if (style.outline && style.outline.width > 0) {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = style.outline.width * 2 * scale;
      ctx.strokeStyle = rgbaCss(style.outline.color);
      for (const l of layout.lines) {
        lineDir?.(l);
        ctx.strokeText(l.text, l.x, l.y + offsetY);
      }
    }
    ctx.fillStyle = rgbaCss(style.color);
    for (const l of layout.lines) {
      lineDir?.(l);
      ctx.fillText(l.text, l.x, l.y + offsetY);
    }
  });
  ctx.restore();
  return layout;
}

/**
 * Draw a picture in `box` as `fit` says, clipped to the box (with `radius` corners) and rotated with it.
 *
 * `crop` (`ImageObject.crop`) first cuts a share of the picture from each side; `fit` then places what is
 * left. A negative share extends the picture past that side with transparency, so the picture itself
 * lands smaller in the box. Only the part of the cropped rect that lies on the picture is drawn, with the
 * 9-argument `drawImage`; a crop that leaves nothing draws nothing. Without a crop the picture is drawn
 * exactly as before crops existed.
 *
 * `shape` (an `ImageObject`'s `flipH`, `flipV` and `mask`, design/27 §3.1) mirrors the picture about the
 * box's centre before the rotation, mask included, and cuts it to the mask's filled paths instead of the box
 * and `radius` (`radius` applies only without a mask): drawn into a sprite of its device bounds and cut there
 * by an anti-aliased 'destination-in' fill (`paintShapedPicture`), then copied at the opacity; without
 * OffscreenCanvas, or past EFFECT_MAX_PIXELS, through a clip of the mask. The editor's image node passes the
 * same fields, so the editor, the thumbnails and the outputs cut and mirror a picture alike. Without a mask
 * or flips the picture is drawn exactly as before.
 *
 * `shape`'s effects (`ImageObject.shadow`, `softEdge`) go through the shapes' effects path
 * (`picture-effects.ts` `drawPictureEffected`, `effects.ts`): the shadow is the picture's alpha blurred as a
 * shape's is, under it; the soft edge feathers the picture's silhouette (its mask, else the box with its round
 * corners). Where that path cannot draw (Node, a sprite past EFFECT_MAX_PIXELS) the picture is drawn without
 * them, as a shape is.
 *
 * `target` is the `pictureTarget` the caller asked its image lookup for. When `img` is a bitmap
 * `preparePicture` made for that target (same key: size, sub-pixel offset, fit, crop and soft edge), it
 * already holds what the box shows at device size: it is copied 1:1 at the target's whole-pixel origin, with
 * no resampling and no clip (design/27 §7.1), over its shadow if it has one. Any other image is drawn as the
 * source, as above. A prepared bitmap of a masked, flipped or soft-edged picture already holds it cut,
 * mirrored and feathered (`pictureTarget`).
 */
export function drawImageFit(
  ctx: Ctx2D,
  img: PictureSource,
  box: Box,
  scale: number,
  fit: 'contain' | 'cover' | 'stretch',
  opacity = 1,
  radius = 0,
  crop?: ImageCrop,
  target?: PictureTarget,
  shape?: PictureShape,
): void {
  opacity = num(opacity, 0, 1, 1);
  const prepared = !!target && preparedKey(img) === target.key;
  const shaped = shape ? pictureShape(shape) : undefined;
  if (shaped && hasPictureEffects(shaped)) {
    const b = clampBox(box);
    const s = num(scale, 0.01, 8, 1);
    const c = clampCrop(crop);
    // Round corners with effects are cut as the outputs prepare them (`roundCornerMask`).
    const round = roundCornerMask(radius, b.w, b.h, shaped);
    const cut = round ? { ...shaped, mask: round } : shaped;
    if (drawPictureEffected(ctx, img, b, s, pictureFit(fit), opacity, c, cut, prepared ? target : undefined))
      return;
  }
  if (prepared && target) {
    ctx.save();
    ctx.globalAlpha = opacity;
    // A prepared bitmap (`preparePicture`): a canvas image, copied 1:1.
    ctx.drawImage(img as CanvasImageSource, target.x, target.y);
    ctx.restore();
    return;
  }
  if (shaped && (shaped.mask || shaped.flipH || shaped.flipV)) {
    drawShapedPicture(
      ctx,
      img,
      clampBox(box),
      num(scale, 0.01, 8, 1),
      pictureFit(fit),
      opacity,
      radius,
      crop,
      shaped,
    );
    return;
  }
  box = clampBox(box);
  radius = num(radius, 0, CLAMP.maxRadius, 0);
  const c = clampCrop(crop);
  const bx = box.x * scale;
  const by = box.y * scale;
  const bw = box.w * scale;
  const bh = box.h * scale;
  ctx.save();
  ctx.globalAlpha = opacity;
  withRotation(ctx, box, scale, () => {
    roundRect(ctx, bx, by, bw, bh, radius * scale);
    ctx.clip();
    paintPicture(ctx, img, bx, by, bw, bh, pictureFit(fit), c);
  });
  ctx.restore();
}

/** A masked or flipped picture from its source (`drawImageFit` with a `shape`), without its effects. */
function drawShapedPicture(
  ctx: Ctx2D,
  img: PictureSource,
  box: Box,
  scale: number,
  fit: 'contain' | 'cover' | 'stretch',
  opacity: number,
  radius: number,
  crop: ImageCrop | undefined,
  shape: PictureShape,
): void {
  const c = clampCrop(crop);
  const sized = { mask: shape.mask, flipH: shape.flipH, flipV: shape.flipV, w: box.w, h: box.h };
  ctx.save();
  placeBox(ctx, box, scale);
  if (shape.mask && typeof OffscreenCanvas !== 'undefined' && typeof ctx.getTransform === 'function') {
    const m = ctx.getTransform();
    const xs = [m.e, m.a * box.w + m.e, m.c * box.h + m.e, m.a * box.w + m.c * box.h + m.e];
    const ys = [m.f, m.b * box.w + m.f, m.d * box.h + m.f, m.b * box.w + m.d * box.h + m.f];
    const canvas = ctx.canvas as { width?: number; height?: number } | undefined;
    const cw = canvas?.width ?? 0;
    const ch = canvas?.height ?? 0;
    const X = Math.max(0, Math.floor(Math.min(...xs)));
    const Y = Math.max(0, Math.floor(Math.min(...ys)));
    const W = Math.min(cw || Number.POSITIVE_INFINITY, Math.ceil(Math.max(...xs))) - X;
    const H = Math.min(ch || Number.POSITIVE_INFINITY, Math.ceil(Math.max(...ys))) - Y;
    if (!(W >= 1 && H >= 1)) {
      ctx.restore();
      return;
    }
    if (W * H <= EFFECT_MAX_PIXELS && [m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite)) {
      const sprite = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
      if (sprite) {
        sprite.imageSmoothingQuality = 'medium';
        sprite.setTransform(m.a, m.b, m.c, m.d, m.e - X, m.f - Y);
        paintShapedPicture(sprite, img, 0, 0, box.w, box.h, fit, c, sized);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = opacity;
        ctx.drawImage(sprite.canvas, X, Y);
        ctx.restore();
        return;
      }
    }
  }
  // A clip (not anti-aliased on an OffscreenCanvas): the mask's union, else the box with its corners.
  ctx.globalAlpha = opacity;
  const built = shape.mask ? storedGeometry(shape.mask, box.w, box.h) : undefined;
  if (built) {
    // The mask is mirrored with the picture: clip in the mirrored box, then mirror back (a flip about the
    // centre undoes itself), since paintShapedPicture mirrors the picture again.
    ctx.translate(box.w / 2, box.h / 2);
    ctx.scale(shape.flipH ? -1 : 1, shape.flipV ? -1 : 1);
    ctx.translate(-box.w / 2, -box.h / 2);
    ctx.clip(geomFillPath2D(built), GEOM_CLIP_RULE);
    ctx.translate(box.w / 2, box.h / 2);
    ctx.scale(shape.flipH ? -1 : 1, shape.flipV ? -1 : 1);
    ctx.translate(-box.w / 2, -box.h / 2);
  } else {
    roundRect(ctx, 0, 0, box.w, box.h, num(radius, 0, CLAMP.maxRadius, 0));
    ctx.clip();
  }
  paintShapedPicture(ctx, img, 0, 0, box.w, box.h, fit, c, { ...sized, mask: undefined });
  ctx.restore();
}

export function drawShape(ctx: Ctx2D, o: Extract<SlideObject, { type: 'shape' }>, scale: number): void {
  // M9 draw dispatch (shape.ts): table, chart, decoration, geometry; else the legacy shape below.
  if (drawShapeObject(ctx, o, scale)) return;
  const box = clampBox(o.box);
  ctx.save();
  ctx.globalAlpha = num(o.opacity, 0, 1, 1);
  withRotation(ctx, box, scale, () => {
    const x = box.x * scale;
    const y = box.y * scale;
    const w = box.w * scale;
    const h = box.h * scale;
    ctx.beginPath();
    if (o.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (o.shape === 'line') {
      ctx.moveTo(x, y + h / 2);
      ctx.lineTo(x + w, y + h / 2);
    } else roundRect(ctx, x, y, w, h, o.radius * scale);
    if (o.fill && o.shape !== 'line') {
      ctx.fillStyle = rgbaCss(o.fill);
      ctx.fill();
    }
    if (o.stroke) {
      ctx.lineWidth = num(o.stroke.width, 0, CLAMP.maxEffectPx, 1) * scale;
      ctx.strokeStyle = rgbaCss(o.stroke.color);
      ctx.stroke();
    }
  });
  ctx.restore();
}

/**
 * Draw a text object: through the rich text engine (design/27 §6) when it has runs, paragraph styles or any
 * rich style field, else through `drawText` exactly as before those fields existed.
 */
export function drawTextObject(ctx: Ctx2D, o: TextObject, scale: number): void {
  if (isRichText(o) || isRichStyle(o.style)) drawRichText(ctx, o, scale);
  else drawText(ctx, o.text, o.style, o.box, scale, { opacity: o.opacity });
}

export function drawObject(ctx: Ctx2D, o: SlideObject, scale: number, images?: ImageLookup): void {
  if (o.type === 'text') drawTextObject(ctx, o, scale);
  else if (o.type === 'shape') drawShape(ctx, o, scale);
  else {
    // A mask only in a geometry file not read yet: the picture waits for it, as for its own decode.
    if (geomAwaited(o.mask)) return;
    const target = pictureTarget(o, scale);
    const img = images?.(o.mediaId, target);
    if (img) drawImageFit(ctx, img, o.box, scale, o.fit, o.opacity, o.radius, o.crop, target, o);
  }
}

/**
 * The underlay frame a slide is drawn over (`frame.ts`, design 29 R1): what lies under the slide's own objects, made
 * once as a unit and copied 1:1 under them. A handle, so this file imports nothing of units.ts (which imports it):
 * `frame.ts`'s `underFrame` makes one over the unit cache.
 */
export interface UnderFrame {
  /** The frame's unit key (what `SlideDrawOptions.late` reports while it is not ready). */
  readonly key: string;
  /** Where it is copied, in device px: the frame's rect. */
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** The frame's picture when it is ready. */
  image(): CanvasImageSource | undefined;
  /** Whether it could not be made here: nothing is waited for then (the slide keeps its direct part). */
  unmade?(): boolean;
}

export type SlideDrawOptions = {
  /** device px per logical px (canvas width / 1920) */
  scale: number;
  look?: Look;
  images?: ImageLookup;
  nextSlide?: Slide;
  /** Whether the slide belongs to a song (lyric-only looks treat non-song slides per `nonSong`). */
  isSong?: boolean;
  /** Explicit presentation kind so loop slides suppress lower-third extraction in previews too. */
  presentationKind?: 'song' | 'slides' | 'loop';
  /**
   * An output raster's report of a part left out because its unit is not ready (C2b, units.ts): with it, a
   * decoration past `DECOR_SPRITE` whose effect unit is not made yet is not drawn directly (a task of up to
   * about 115 ms at 3840) but left out and reported by its unit's key, to fade in once made. Without it (the
   * harness, thumbnails, the editor: callers that wait) it is drawn directly as before. Geometry and effect
   * units not ready keep their cheap legacy copies either way.
   */
  late?: (key: string) => void;
  /**
   * The slide's underlay frame (`frame.ts`): `slide` is then its direct part. Copied 1:1 under the objects, after
   * the slide's own picture, when it is ready; not ready, it is left out and reported through `late` by its key
   * (never drawn directly in this raster: it is seconds of work), so the late job makes it and it fades in. A
   * context that cannot copy 1:1 (not a whole-pixel translation) is not given the frame. Without `under` the slide
   * is drawn as it always was.
   */
  under?: UnderFrame;
};

/**
 * Draw a look band (the lyric-only and next-slide bands, the lower third): `drawText` shrunk to fit, as
 * always, unless the source object is rich, the text has a strong right-to-left character or the look's
 * style has a rich field. Then the source's readable text (`readableText`, numbers and bullets written as
 * text) goes through the rich engine in the look's style, with the source paragraphs' directions
 * (design/27 §6 "Bands, stage and readable text").
 */
export function drawBandText(
  ctx: Ctx2D,
  text: string,
  style: TextStyle,
  band: Box,
  scale: number,
  src?: TextObject,
): void {
  const clamped = clampStyle(style);
  text = clampText(text);
  if ((src && (isRichText(src) || isRichStyle(src.style))) || isRichStyle(clamped) || hasStrongRtl(text))
    drawRichText(
      ctx,
      bandObject(src ? readableText(src) : text, clamped, clampBox(band), src),
      scale,
      undefined,
      {
        minFontScale: BAND_MIN_FONT_SCALE,
      },
    );
  else drawText(ctx, text, style, band, scale, { fit: true });
}

/** The text object a lyric-only band shows `text` of: the one `firstText` reads, when it holds that text. */
export function bandSource(slide: Slide, text: string): TextObject | undefined {
  let o: SlideObject | undefined;
  if (slide.lyricObjectId) {
    o = slide.objects.find((x) => x.id === slide.lyricObjectId);
    if (o?.type !== 'text' || !o.text) o = undefined;
  }
  o ??= slide.objects.find((x) => x.type === 'text');
  if (o?.type !== 'text') return undefined;
  return o.text === text || readableText(o) === text ? o : undefined;
}

/** The text a lyric-only look shows for a slide, or null when the look shows nothing for it. */
export function lyricTextFor(
  slide: Slide,
  look: Look | undefined,
  kindOrIsSong: boolean | 'song' | 'slides' | 'loop',
): string | null {
  const rule = look?.layers.slide;
  if (rule?.mode !== 'lyricOnly') return null;
  if (kindOrIsSong === 'loop') {
    return look?.kind === 'stage' ? 'Service Starting Soon' : null;
  }
  const isSong = kindOrIsSong === true || kindOrIsSong === 'song';
  if (slide.bottomThirdText !== undefined) {
    return slide.bottomThirdText.trim() ? slide.bottomThirdText.trim() : null;
  }
  if (!isSong && rule.nonSong === 'none') return null;
  if (!isSong && slide.scripture) {
    const r = slide.scripture.ref;
    const refStr = `${r.book} ${r.chapter}:${r.verseFrom}${r.verseTo ? `-${r.verseTo}` : ''}`;
    return `${refStr}\n${slide.scripture.text}`;
  }
  // M9: a table's or a chart's text is never a strap (`strapText`).
  const t = strapText(slide);
  return t.trim() ? t : null;
}

/**
 * A slide's whole-slide picture (`slideContent`: its PowerPoint reference picture, or an imported page
 * picture): the whole frame, contain-fitted.
 */
const SLIDE_PICTURE = { box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, fit: 'contain' } as const;

/** A picture `drawSlide2D` draws: its media id and the target it asks the image lookup for. */
export type SlidePicture = { mediaId: string; target?: PictureTarget };

/**
 * The pictures `drawSlide2D` draws for these options, in drawing order, each with the `pictureTarget` it
 * passes to the image lookup: what a decoder prepares before the (synchronous) draw. They follow
 * `slideContent` as the draw does (design/27 §5): the slide's picture (a reference picture or an imported
 * page) under the image objects it draws (only the operator's own on a reference picture). Nothing in the
 * lyric-only and hidden modes, which draw text bands only.
 */
export function slidePictures(
  rawSlide: Slide,
  opts: Pick<SlideDrawOptions, 'scale' | 'look'>,
): SlidePicture[] {
  const look = opts.look ? clampLook(opts.look) : undefined;
  if ((look?.layers.slide.mode ?? 'authored') !== 'authored') return [];
  const drawn = drawableContent(rawSlide);
  const scale = num(opts.scale, 0.01, 8, 1);
  const out: SlidePicture[] = [];
  if (drawn.pictureMediaId)
    out.push({ mediaId: drawn.pictureMediaId, target: pictureTarget(SLIDE_PICTURE, scale) });
  for (const b of withinDrawBudget(drawn.objects)) {
    // What the slide objects' drawer draws in its place (effect units: a masked picture's prepared bitmap).
    const o = slideObjectsDrawer?.drawnFor?.(b, scale) ?? b;
    if (o.type === 'image') out.push({ mediaId: o.mediaId, target: pictureTarget(o, scale) });
  }
  return out;
}

/**
 * What draws an authored slide's objects in `drawSlide2D`'s place (M9 geometry units, `units.ts`, which registers
 * it): `draw` draws the slide's clamped objects (`slideContent`'s, before the drawing budget) or returns false
 * to leave them to `drawSlide2D`; `reach` says where an object as the budget draws it (a legacy copy) reaches
 * when `draw` draws it otherwise (logical px), undefined to leave it to `objectReach` (`sprite.ts`).
 */
export interface SlideObjectsDrawer {
  draw(
    ctx: Ctx2D,
    raw: Slide,
    objects: readonly SlideObject[],
    scale: number,
    images?: ImageLookup,
    late?: (key: string) => void,
  ): boolean;
  reach?(o: SlideObject, scale: number): { x: number; y: number; w: number; h: number } | undefined;
  /**
   * The object whose picture `draw` asks the image lookup for in place of `o` (as the budget draws it), if
   * another: a masked picture past the budget drawn from its prepared bitmap (its mask cut in, effect units).
   */
  drawnFor?(o: SlideObject, scale: number): SlideObject | undefined;
}

let slideObjectsDrawer: SlideObjectsDrawer | undefined;

/** Register the slide objects' drawer (one at a time); returns its unregistration. */
export function registerSlideObjectsDrawer(d: SlideObjectsDrawer): () => void {
  slideObjectsDrawer = d;
  return () => {
    if (slideObjectsDrawer === d) slideObjectsDrawer = undefined;
  };
}

/** The registered slide objects' drawer, if any (`sprite.ts` asks it for reaches). */
export function registeredSlideObjectsDrawer(): SlideObjectsDrawer | undefined {
  return slideObjectsDrawer;
}

/** Bytes of a full frame at `scale` device px per logical px (the sprite cache's budget follows it). */
export function frameBytes(scale: number): number {
  return Math.round(LOGICAL_WIDTH * scale) * Math.round(LOGICAL_HEIGHT * scale) * 4;
}

/** Whether `ctx`'s transform is a translation by whole device px (a 1:1 copy is exact under it). */
function copiesExactly(ctx: Ctx2D): boolean {
  // A context that cannot say (a test's stand-in) is taken as untransformed, as the units' drawer takes it.
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : undefined;
  if (!m) return true;
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && Number.isInteger(m.e) && Number.isInteger(m.f);
}

/** Copy the ready frame 1:1 at its rect, or report it left out (nothing else is drawn for it). */
function drawUnder(ctx: Ctx2D, under: UnderFrame, late?: (key: string) => void): void {
  const img = under.image();
  if (!img) {
    if (!under.unmade?.()) late?.(under.key);
    return;
  }
  if (!copiesExactly(ctx)) return;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(img, under.rect.x, under.rect.y);
  ctx.restore();
}

/**
 * Draw the Slide layer of a slide as a look renders it, on a transparent canvas. Backgrounds are not
 * drawn here (they are their own layer). A look that draws slides as authored draws what `slideContent`
 * says (design/27 §5): the slide's picture contain-fitted (its PowerPoint reference picture, or an imported
 * page), then its objects (only the operator's own on a reference picture). Lyric-only looks read the
 * slide's text, whichever way it is drawn.
 */
export function drawSlide2D(ctx: Ctx2D, rawSlide: Slide, opts: SlideDrawOptions): void {
  const slide = clampSlide(rawSlide);
  const look = opts.look ? clampLook(opts.look) : undefined;
  const next = opts.nextSlide ? clampSlide(opts.nextSlide) : undefined;
  const scale = num(opts.scale, 0.01, 8, 1);
  const rule = look?.layers.slide ?? { mode: 'authored' as const };
  if (rule.mode === 'hidden') return;
  if (rule.mode === 'authored') {
    const drawn = drawableContent(slide);
    if (drawn.pictureMediaId) {
      const target = pictureTarget(SLIDE_PICTURE, scale);
      const img = opts.images?.(drawn.pictureMediaId, target);
      if (img) drawImageFit(ctx, img, SLIDE_PICTURE.box, scale, 'contain', 1, 0, undefined, target);
    }
    // One raster of the sprite cache (spritecache.ts): the slide's own sprites never evict each other, and the
    // cache holds a few frames at this scale.
    spriteCache.raster(() => {
      // The underlay frame (frame.ts) lies under every object: copied here, or left out and reported.
      if (opts.under) drawUnder(ctx, opts.under, opts.late);
      // Units (units.ts): an object past the budget whose unit is ready is copied from it 1:1 in z-order.
      if (slideObjectsDrawer?.draw(ctx, rawSlide, drawn.objects, scale, opts.images, opts.late)) return;
      // Past the slide's drawing budget, later stored geometries draw as their legacy shapes and later effects
      // are left out (geombudget.ts).
      for (const o of withinDrawBudget(drawn.objects)) drawObject(ctx, o, scale, opts.images);
    }, frameBytes(scale));
    return;
  }
  const kind = opts.presentationKind ?? opts.isSong ?? true;
  const preview = stagePreview(rawSlide, slide, next, look, kind);
  if (preview) {
    drawStagePreview2D(ctx, preview, scale);
    return;
  }
  const text = lyricTextFor(slide, look, kind);
  if (text) drawBandText(ctx, text, rule.style, rule.band, scale, bandSource(slide, text));
  if (rule.nextSlide && next && kind !== 'loop') {
    const nt = lyricTextFor(next, look, kind);
    if (nt) drawBandText(ctx, nt, rule.nextSlide.style, rule.nextSlide.band, scale, bandSource(next, nt));
  }
}

function paintCardBox(ctx: Ctx2D, box: Box, fill: TextStyle['fill'], scale: number): void {
  if (!fill) return;
  ctx.save();
  ctx.fillStyle = rgbaCss(fill.color);
  ctx.beginPath();
  roundRect(ctx, box.x * scale, box.y * scale, box.w * scale, box.h * scale, fill.radius * scale);
  ctx.fill();
  ctx.restore();
}

/** A card of the stage preview: its box and fill, and the band text drawn in it (without the fill). */
export type StageCard = {
  box: Box;
  fill: TextStyle['fill'];
  style: TextStyle;
  text: string;
  src: TextObject | undefined;
};

/** What the stage preview draws: the current and next cards, then the notes box (clipped to it). */
export type StagePreview = {
  cards: StageCard[];
  notes: { box: Box; fill: TextStyle['fill']; style: PropBox; text: string } | null;
};

/**
 * The speaker notes a look's stage preview shows for a slide (PR #28): its `Slide.notes`, plain (`**x**` as
 * x, bullets as '•'), at most 4,000 characters read, when the look's stage notes are on; '' otherwise. An
 * output's slides carry none (the planner's `clampSlide` keeps no notes); look previews and thumbnails do.
 */
export function stageNotesText(rawSlide: Pick<Slide, 'notes'>, look: Look | undefined): string {
  if (!look || !stageNotesEnabled(look) || typeof rawSlide.notes !== 'string') return '';
  return formatStageNotesPlain(rawSlide.notes.slice(0, 4000));
}

/**
 * Whether a lyric-only look draws a slide as the stage preview (PR #28's adaptive stage regions,
 * `adaptStageRegions`), and what it draws: a look whose stage notes are on (`stageNotesEnabled`), for a slide
 * with notes, or with the split or prompter preset. Null when the look draws the plain bands. `drawSlide2D`
 * draws it, and `sprite.ts` `slideReach` and `plan.ts` `slideVisible` read the same regions, so a slide
 * raster is never cut short of a moved card or of the notes box. `look` and `slide` are clamped; the notes
 * are read from `rawSlide` (`clampSlide` keeps none).
 */
export function stagePreview(
  rawSlide: Pick<Slide, 'notes'>,
  slide: Slide,
  next: Slide | undefined,
  look: Look | undefined,
  kind: boolean | 'song' | 'slides' | 'loop',
): StagePreview | null {
  const rule = look?.layers.slide;
  if (!look || rule?.mode !== 'lyricOnly' || !stageNotesEnabled(look)) return null;
  const notesText = stageNotesText(rawSlide, look);
  const preset = look.layers.props.stagePreset;
  if (!(notesText.length > 0 || preset === 'split' || preset === 'prompter')) return null;
  const isSong = kind === true || kind === 'song';
  const customNotes = look.layers.props.style.notes;
  const defaultNotesBox: PropBox = customNotes ?? {
    fontFamily: rule.style.fontFamily,
    fontWeight: 400,
    fontStyle: 'normal',
    fontSizePx: 32,
    color: { r: 235, g: 235, b: 235, a: 1 },
    align: 'left',
    valign: 'top',
    lineHeight: 1.2,
    letterSpacing: 0,
    padding: 8,
    transform: 'none',
    fill: { color: { r: 255, g: 255, b: 255, a: 0.1 }, radius: 10 },
    box: { x: 60, y: 972, w: 1800, h: 92, rotation: 0 },
  };
  const text = lyricTextFor(slide, look, kind);
  const nt = rule.nextSlide && next && kind !== 'loop' ? lyricTextFor(next, look, kind) : null;
  const adapted = adaptStageRegions({
    preset: look.layers.props.stagePreset,
    notesScale: look.layers.props.notesScale,
    isSong,
    hasNotes: notesText.length > 0,
    notesEnabled: true,
    hasCustomNotesStyle: Boolean(customNotes),
    current: rule.nonSong === 'none' && !isSong ? null : { box: rule.band, style: rule.style },
    next: rule.nextSlide ? { box: rule.nextSlide.band, style: rule.nextSlide.style } : null,
    notes: defaultNotesBox,
  });
  const cards: StageCard[] = [];
  if (adapted.current && text)
    cards.push({
      box: adapted.current.box,
      fill: adapted.current.style.fill,
      style: { ...adapted.current.style, fill: undefined },
      text,
      src: bandSource(slide, text),
    });
  if (adapted.next && nt)
    cards.push({
      box: adapted.next.box,
      fill: adapted.next.style.fill,
      style: { ...adapted.next.style, fill: undefined },
      text: nt,
      src: next ? bandSource(next, nt) : undefined,
    });
  const notes =
    adapted.notes && notesText
      ? { box: adapted.notes.box, fill: adapted.notes.fill, style: adapted.notes, text: notesText }
      : null;
  return { cards, notes };
}

function drawStagePreview2D(ctx: Ctx2D, preview: StagePreview, scale: number): void {
  for (const c of preview.cards) {
    paintCardBox(ctx, c.box, c.fill, scale);
    drawBandText(ctx, c.text, c.style, c.box, scale, c.src);
  }
  const n = preview.notes;
  if (n) {
    const nb = n.box;
    paintCardBox(ctx, nb, n.fill, scale);
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, nb.x * scale, nb.y * scale, nb.w * scale, nb.h * scale, (n.fill?.radius ?? 0) * scale);
    ctx.clip();
    drawText(ctx, n.text, { ...n.style, fill: undefined, valign: 'top' }, nb, scale, { fit: false });
    ctx.restore();
  }
}

export function fillColor(ctx: Ctx2D, c: Rgba, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = rgbaCss(c);
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Legacy layouts kept per context (a band laid out for its sprite's reach, then drawn: design/27 §7.3). */
const LEGACY_LAYOUTS = 32;
const legacyLayouts = new WeakMap<Ctx2D, Map<string, TextLayout>>();

/**
 * `layoutText` through a small memo per context, keyed by every input and the font generation: the asset
 * worker lays a legacy text out to find its sprite's reach (sprite.ts) and `drawText` then draws that very
 * layout instead of measuring it again. Only while a font resolver is installed (its generation changes
 * whenever a face loads); without one a late font would leave a stale layout, so nothing is kept.
 */
function legacyLayoutMemo(
  ctx: Ctx2D,
  text: string,
  style: TextStyle,
  box: Box,
  scale: number,
  fit: boolean,
  minScale: number,
  lay: typeof layoutTextNow,
): TextLayout {
  const env = currentFontEnv();
  if (env === LEGACY_FONT_ENV) return lay(ctx, text, style, box, scale, fit, minScale);
  const key = `${env.generation}|${scale}|${fit ? 1 : 0}|${minScale}|${JSON.stringify(box)}|${JSON.stringify(style)}|${text}`;
  let m = legacyLayouts.get(ctx);
  if (!m) legacyLayouts.set(ctx, (m = new Map()));
  const hit = m.get(key);
  if (hit) {
    m.delete(key);
    m.set(key, hit);
    return hit;
  }
  const out = lay(ctx, text, style, box, scale, fit, minScale);
  m.set(key, out);
  if (m.size > LEGACY_LAYOUTS) m.delete(m.keys().next().value!);
  return out;
}

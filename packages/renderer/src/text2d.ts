import {
  type Box,
  type ImageCrop,
  LOGICAL_HEIGHT,
  type Look,
  type Rgba,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextStyle,
  firstText,
  readableText,
  rgbaCss,
  textScripts,
} from '@ordo/domain';

import { CLAMP, clampBox, clampCrop, clampLook, clampSlide, clampStyle, clampText, num } from './clamp.ts';
import { type Ctx2D, roundRect, setLetterSpacing, withRotation } from './ctx.ts';
import { type PictureTarget, paintPicture, pictureFit, pictureTarget, preparedKey } from './picture.ts';
import { firstStrong, hasStrongRtl } from './text/bidi.ts';
import { LEGACY_FONT_ENV, currentFontEnv } from './text/fonts.ts';
import { BAND_MIN_FONT_SCALE, bandObject, drawRichText, isRichStyle, isRichText } from './text/rich.ts';

export type { Ctx2D } from './ctx.ts';
/**
 * Decoded pictures by media id. The drawers pass the `pictureTarget` each picture is drawn at (undefined
 * for one drawn from its source: rotated, round corners, oversized). Given a target, a lookup returns the
 * source or a bitmap `preparePicture` made for a target with the same key; a lookup may ignore targets.
 */
export type ImageLookup = (mediaId: string, target?: PictureTarget) => CanvasImageSource | undefined;

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
  /** `dir` is set on lines of paragraphs with a strong right-to-left character (`paragraphDirections`). */
  lines: { text: string; x: number; y: number; width: number; dir?: 'ltr' | 'rtl' }[];
  fontSize: number;
  lineHeightPx: number;
  block: { x: number; y: number; w: number; h: number };
};

/**
 * Lay out text in a box (device pixels = logical * scale). With `fit`, shrinks the font down to
 * `minScale` of its size until the block fits the box height.
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
  const dirs = paragraphDirections(text);
  const script = legacyScript(text);
  for (;;) {
    ctx.font = fontString(style, scale, size, script);
    setLetterSpacing(ctx, style.letterSpacing * scale);
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
  for (let i = 0; i < lines.length; i++) {
    const y = y0 + i * lh;
    if (y < lo || y > hi) continue;
    const t = lines[i]!;
    const dir = lineDirs?.[i];
    if (lineDirs) ctx.direction = dir ?? dir0!;
    const width = ctx.measureText(t).width;
    let x = bx + pad;
    if (style.align === 'center') x = bx + pad + (innerW - width) / 2;
    else if (style.align === 'right') x = bx + pad + innerW - width;
    laid.push(dir ? { text: t, x, y, width, dir } : { text: t, x, y, width });
  }
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
  };
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
    const ascent = layout.fontSize * scale * 0.8;
    const offsetY = (layout.lineHeightPx - layout.fontSize * scale) / 2 + ascent;
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
 * `target` is the `pictureTarget` the caller asked its image lookup for. When `img` is a bitmap
 * `preparePicture` made for that target (same key: size, sub-pixel offset, fit and crop), it already holds
 * what the box shows at
 * device size: it is copied 1:1 at the target's whole-pixel origin, with no resampling and no clip
 * (design/27 §7.1). Any other image is drawn as the source, as above.
 */
export function drawImageFit(
  ctx: Ctx2D,
  img: CanvasImageSource,
  box: Box,
  scale: number,
  fit: 'contain' | 'cover' | 'stretch',
  opacity = 1,
  radius = 0,
  crop?: ImageCrop,
  target?: PictureTarget,
): void {
  opacity = num(opacity, 0, 1, 1);
  if (target && preparedKey(img) === target.key) {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.drawImage(img, target.x, target.y);
    ctx.restore();
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

export function drawShape(ctx: Ctx2D, o: Extract<SlideObject, { type: 'shape' }>, scale: number): void {
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
  if (isRichText(o)) drawRichText(ctx, o, scale);
  else drawText(ctx, o.text, o.style, o.box, scale, { opacity: o.opacity });
}

export function drawObject(ctx: Ctx2D, o: SlideObject, scale: number, images?: ImageLookup): void {
  if (o.type === 'text') drawTextObject(ctx, o, scale);
  else if (o.type === 'shape') drawShape(ctx, o, scale);
  else {
    const target = pictureTarget(o, scale);
    const img = images?.(o.mediaId, target);
    if (img) drawImageFit(ctx, img, o.box, scale, o.fit, o.opacity, o.radius, o.crop, target);
  }
}

export type SlideDrawOptions = {
  /** device px per logical px (canvas width / 1920) */
  scale: number;
  look?: Look;
  images?: ImageLookup;
  nextSlide?: Slide;
  /** Whether the slide belongs to a song (lyric-only looks treat non-song slides per `nonSong`). */
  isSong?: boolean;
  /** Draw the slide's imported page image (an image slide) even if hidden under objects. */
  skipImported?: boolean;
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
  if ((src && isRichText(src)) || isRichStyle(clamped) || hasStrongRtl(text))
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
export function lyricTextFor(slide: Slide, look: Look | undefined, isSong: boolean): string | null {
  const rule = look?.layers.slide;
  if (!rule || rule.mode !== 'lyricOnly') return null;
  if (!isSong && rule.nonSong === 'none') return null;
  const t = firstText(slide);
  return t.trim() ? t : null;
}

/** An imported slide's page picture: the whole frame, contain-fitted. */
const IMPORTED_PAGE = { box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, fit: 'contain' } as const;

/** A picture `drawSlide2D` draws: its media id and the target it asks the image lookup for. */
export type SlidePicture = { mediaId: string; target?: PictureTarget };

/**
 * The pictures `drawSlide2D` draws for these options, in drawing order, each with the `pictureTarget` it
 * passes to the image lookup: what a decoder prepares before the (synchronous) draw. Nothing in the
 * lyric-only and hidden modes, which draw text bands only.
 */
export function slidePictures(
  rawSlide: Slide,
  opts: Pick<SlideDrawOptions, 'scale' | 'look' | 'skipImported'>,
): SlidePicture[] {
  const look = opts.look ? clampLook(opts.look) : undefined;
  if ((look?.layers.slide.mode ?? 'authored') !== 'authored') return [];
  const slide = clampSlide(rawSlide);
  const scale = num(opts.scale, 0.01, 8, 1);
  const out: SlidePicture[] = [];
  if (slide.imported && !opts.skipImported)
    out.push({ mediaId: slide.imported.imageMediaId, target: pictureTarget(IMPORTED_PAGE, scale) });
  for (const o of slide.objects)
    if (o.type === 'image') out.push({ mediaId: o.mediaId, target: pictureTarget(o, scale) });
  return out;
}

/**
 * Draw the Slide layer of a slide as a look renders it, on a transparent canvas. Backgrounds are not
 * drawn here (they are their own layer).
 */
export function drawSlide2D(ctx: Ctx2D, rawSlide: Slide, opts: SlideDrawOptions): void {
  const slide = clampSlide(rawSlide);
  const look = opts.look ? clampLook(opts.look) : undefined;
  const next = opts.nextSlide ? clampSlide(opts.nextSlide) : undefined;
  const scale = num(opts.scale, 0.01, 8, 1);
  const rule = look?.layers.slide ?? { mode: 'authored' as const };
  if (rule.mode === 'hidden') return;
  if (rule.mode === 'authored') {
    if (slide.imported && !opts.skipImported) {
      const target = pictureTarget(IMPORTED_PAGE, scale);
      const img = opts.images?.(slide.imported.imageMediaId, target);
      if (img) drawImageFit(ctx, img, IMPORTED_PAGE.box, scale, 'contain', 1, 0, undefined, target);
    }
    for (const o of slide.objects) drawObject(ctx, o, scale, opts.images);
    return;
  }
  const text = lyricTextFor(slide, look, opts.isSong ?? true);
  if (text) drawBandText(ctx, text, rule.style, rule.band, scale, bandSource(slide, text));
  if (rule.nextSlide && next) {
    const nt = lyricTextFor(next, look, opts.isSong ?? true);
    if (nt) drawBandText(ctx, nt, rule.nextSlide.style, rule.nextSlide.band, scale, bandSource(next, nt));
  }
}

export function fillColor(ctx: Ctx2D, c: Rgba, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = rgbaCss(c);
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

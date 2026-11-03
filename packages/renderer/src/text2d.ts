import {
  type Box,
  type Look,
  type Rgba,
  type Slide,
  type SlideObject,
  type TextStyle,
  firstText,
  rgbaCss,
} from '@ordo/domain';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type ImageLookup = (mediaId: string) => CanvasImageSource | undefined;

export function fontString(style: TextStyle, scale: number, sizeOverride?: number): string {
  const size = (sizeOverride ?? style.fontSizePx) * scale;
  return `${style.fontStyle === 'italic' ? 'italic ' : ''}${style.fontWeight} ${size}px "${style.fontFamily}", "Inter", "Segoe UI", Arial, sans-serif`;
}

/** Greedy word wrap. Paragraphs are separated by \n. Long words are broken by characters. */
export function wrapLines(ctx: Pick<Ctx2D, 'measureText'>, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
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
  return out;
}

export type TextLayout = {
  lines: { text: string; x: number; y: number; width: number }[];
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
  const pad = style.padding * scale;
  const bx = box.x * scale;
  const by = box.y * scale;
  const bw = box.w * scale;
  const bh = box.h * scale;
  const innerW = Math.max(1, bw - 2 * pad);
  const innerH = Math.max(1, bh - 2 * pad);
  let size = style.fontSizePx;
  let lines: string[] = [];
  let lh = 0;
  for (;;) {
    ctx.font = fontString(style, scale, size);
    setLetterSpacing(ctx, style.letterSpacing * scale);
    lines = wrapLines(ctx, text, innerW);
    lh = size * scale * style.lineHeight;
    if (!fit || lines.length * lh <= innerH || size <= style.fontSizePx * minScale) break;
    size = Math.max(style.fontSizePx * minScale, size * 0.92);
  }
  const blockH = lines.length * lh;
  let y0 = by + pad;
  if (style.valign === 'middle') y0 = by + pad + (innerH - blockH) / 2;
  else if (style.valign === 'bottom') y0 = by + pad + innerH - blockH;
  const laid = lines.map((t, i) => {
    const width = ctx.measureText(t).width;
    let x = bx + pad;
    if (style.align === 'center') x = bx + pad + (innerW - width) / 2;
    else if (style.align === 'right') x = bx + pad + innerW - width;
    return { text: t, x, y: y0 + i * lh, width };
  });
  const maxW = laid.reduce((m, l) => Math.max(m, l.width), 0);
  let blockX = bx + pad;
  if (style.align === 'center') blockX = bx + pad + (innerW - maxW) / 2;
  else if (style.align === 'right') blockX = bx + pad + innerW - maxW;
  return {
    lines: laid,
    fontSize: size,
    lineHeightPx: lh,
    block: { x: blockX - pad, y: y0 - pad, w: maxW + 2 * pad, h: blockH + 2 * pad },
  };
}

function setLetterSpacing(ctx: Ctx2D, px: number): void {
  const c = ctx as Ctx2D & { letterSpacing?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${px}px`;
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (r > 0 && 'roundRect' in ctx) (ctx as CanvasRenderingContext2D).roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function withRotation(ctx: Ctx2D, box: Box, scale: number, draw: () => void): void {
  if (!box.rotation) {
    draw();
    return;
  }
  const cx = (box.x + box.w / 2) * scale;
  const cy = (box.y + box.h / 2) * scale;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((box.rotation * Math.PI) / 180);
  ctx.translate(-cx, -cy);
  draw();
  ctx.restore();
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
  ctx.save();
  ctx.globalAlpha = opts.opacity ?? 1;
  const layout = layoutText(ctx, text, style, box, scale, opts.fit ?? false);
  withRotation(ctx, box, scale, () => {
    ctx.textBaseline = 'alphabetic';
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
      for (const l of layout.lines) ctx.fillText(l.text, l.x, l.y + offsetY);
      ctx.restore();
    }
    if (style.outline && style.outline.width > 0) {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = style.outline.width * 2 * scale;
      ctx.strokeStyle = rgbaCss(style.outline.color);
      for (const l of layout.lines) ctx.strokeText(l.text, l.x, l.y + offsetY);
    }
    ctx.fillStyle = rgbaCss(style.color);
    for (const l of layout.lines) ctx.fillText(l.text, l.x, l.y + offsetY);
  });
  ctx.restore();
  return layout;
}

export function drawImageFit(
  ctx: Ctx2D,
  img: CanvasImageSource,
  box: Box,
  scale: number,
  fit: 'contain' | 'cover' | 'stretch',
  opacity = 1,
  radius = 0,
): void {
  const iw = (img as { width: number }).width || (img as HTMLVideoElement).videoWidth || 1;
  const ih = (img as { height: number }).height || (img as HTMLVideoElement).videoHeight || 1;
  const bx = box.x * scale;
  const by = box.y * scale;
  const bw = box.w * scale;
  const bh = box.h * scale;
  let dw = bw;
  let dh = bh;
  if (fit !== 'stretch') {
    const s = fit === 'contain' ? Math.min(bw / iw, bh / ih) : Math.max(bw / iw, bh / ih);
    dw = iw * s;
    dh = ih * s;
  }
  ctx.save();
  ctx.globalAlpha = opacity;
  withRotation(ctx, box, scale, () => {
    roundRect(ctx, bx, by, bw, bh, radius * scale);
    ctx.clip();
    ctx.drawImage(img, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
  });
  ctx.restore();
}

export function drawShape(ctx: Ctx2D, o: Extract<SlideObject, { type: 'shape' }>, scale: number): void {
  const { box } = o;
  ctx.save();
  ctx.globalAlpha = o.opacity;
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
      ctx.lineWidth = o.stroke.width * scale;
      ctx.strokeStyle = rgbaCss(o.stroke.color);
      ctx.stroke();
    }
  });
  ctx.restore();
}

export function drawObject(ctx: Ctx2D, o: SlideObject, scale: number, images?: ImageLookup): void {
  if (o.type === 'text') drawText(ctx, o.text, o.style, o.box, scale, { opacity: o.opacity });
  else if (o.type === 'shape') drawShape(ctx, o, scale);
  else {
    const img = images?.(o.mediaId);
    if (img) drawImageFit(ctx, img, o.box, scale, o.fit, o.opacity, o.radius);
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

/** The text a lyric-only look shows for a slide, or null when the look shows nothing for it. */
export function lyricTextFor(slide: Slide, look: Look | undefined, isSong: boolean): string | null {
  const rule = look?.layers.slide;
  if (!rule || rule.mode !== 'lyricOnly') return null;
  if (!isSong && rule.nonSong === 'none') return null;
  const t = firstText(slide);
  return t.trim() ? t : null;
}

/**
 * Draw the Slide layer of a slide as a look renders it, on a transparent canvas. Backgrounds are not
 * drawn here (they are their own layer).
 */
export function drawSlide2D(ctx: Ctx2D, slide: Slide, opts: SlideDrawOptions): void {
  const rule = opts.look?.layers.slide ?? { mode: 'authored' as const };
  if (rule.mode === 'hidden') return;
  if (rule.mode === 'authored') {
    if (slide.imported && !opts.skipImported) {
      const img = opts.images?.(slide.imported.imageMediaId);
      if (img) drawImageFit(ctx, img, { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, opts.scale, 'contain');
    }
    for (const o of slide.objects) drawObject(ctx, o, opts.scale, opts.images);
    return;
  }
  const text = lyricTextFor(slide, opts.look, opts.isSong ?? true);
  if (text) drawText(ctx, text, rule.style, rule.band, opts.scale, { fit: true });
  if (rule.nextSlide && opts.nextSlide) {
    const nt = lyricTextFor(opts.nextSlide, opts.look, opts.isSong ?? true);
    if (nt) drawText(ctx, nt, rule.nextSlide.style, rule.nextSlide.band, opts.scale, { fit: true });
  }
}

export function fillColor(ctx: Ctx2D, c: Rgba, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = rgbaCss(c);
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

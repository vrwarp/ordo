import {
  type Box,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  LOOK_LOWER_THIRD,
  type Look,
  type Rgba,
  type Slide,
  type TextStyle,
} from '@ordo/domain';
import { clampLook, clampSlide } from './clamp.ts';
import type { AssetJob } from './messages.ts';
import type { PropsModel } from './props.ts';
import { type Ctx2D, type ImageLookup, drawImageFit, drawSlide2D, drawText, fillColor } from './text2d.ts';

/**
 * Full-frame rasterization used by the output's asset worker and by thumbnails. Every function draws
 * onto a transparent canvas of the output's device size; `scale` is device px per logical px.
 */

export const FULL_FRAME: Box = { x: 0, y: 0, w: LOGICAL_WIDTH, h: LOGICAL_HEIGHT, rotation: 0 };

/** Style and band of the lower-third layer: the look's lyric-only style, else the default lobby band. */
export function lowerThirdStyle(look: Look): { style: TextStyle; band: Box } {
  const rule = look.layers.slide;
  if (rule.mode === 'lyricOnly') return { style: rule.style, band: rule.band };
  const d = LOOK_LOWER_THIRD.layers.slide;
  if (d.mode === 'lyricOnly') return { style: d.style, band: d.band };
  throw new Error('default lower-third look is not lyric-only');
}

export function rasterSlide(
  ctx: Ctx2D,
  slide: Slide,
  look: Look,
  scale: number,
  images: ImageLookup,
  opts: { nextSlide?: Slide; isSong?: boolean } = {},
): void {
  drawSlide2D(ctx, slide, { scale, look, images, nextSlide: opts.nextSlide, isSong: opts.isSong ?? true });
}

export function rasterLowerThird(ctx: Ctx2D, text: string, look: Look, scale: number): void {
  const { style, band } = lowerThirdStyle(look);
  drawText(ctx, text, style, band, scale, { fit: true });
}

export function rasterImage(
  ctx: Ctx2D,
  img: CanvasImageSource,
  fit: 'contain' | 'cover' | 'stretch',
  scale: number,
): void {
  drawImageFit(ctx, img, FULL_FRAME, scale, fit);
}

/**
 * The props layer. The logo covers the frame with the clear colour and the logo image centred in its box
 * (the Logo action replaces what is on screen); text props draw on top.
 */
export function rasterProps(
  ctx: Ctx2D,
  model: PropsModel,
  scale: number,
  images: ImageLookup,
  clearColor: Rgba,
): void {
  if (model.logo) {
    fillColor(ctx, clearColor, LOGICAL_WIDTH * scale, LOGICAL_HEIGHT * scale);
    const img = images(model.logo.mediaId);
    if (img) drawImageFit(ctx, img, model.logo.box, scale, 'contain');
  }
  for (const it of model.items) drawText(ctx, it.text, it.style, it.box, scale, { fit: true });
}

export type ThumbnailOptions = {
  /** Whether the slide belongs to a song (lyric-only looks apply their non-song rule otherwise). */
  isSong?: boolean;
  /** Background image or video frame to draw under the slide (cover). */
  background?: CanvasImageSource;
  /** Fill under everything: true (default) uses the look's clear colour, false leaves it transparent. */
  clear?: boolean | Rgba;
  /** Reuse a canvas (it is resized to width x height). */
  canvas?: OffscreenCanvas;
};

/**
 * Draw a slide as an output with `look` would show it, into any 2D context of size width x height.
 * Text uses the same rasterizer as the outputs, so thumbnails match.
 */
export function drawSlideThumbnail(
  ctx: Ctx2D,
  slide: Slide,
  look: Look | undefined,
  images: ImageLookup | Map<string, CanvasImageSource>,
  width: number,
  height: number,
  nextSlide?: Slide,
  opts: ThumbnailOptions = {},
): void {
  const lookup: ImageLookup = typeof images === 'function' ? images : (id) => images.get(id);
  const scale = Math.min(width / LOGICAL_WIDTH, height / LOGICAL_HEIGHT);
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  const clear = opts.clear ?? true;
  if (clear)
    fillColor(ctx, clear === true ? (look?.clearColor ?? { r: 0, g: 0, b: 0, a: 1 }) : clear, width, height);
  // Centre a 16:9 frame in non-16:9 canvases.
  ctx.translate((width - LOGICAL_WIDTH * scale) / 2, (height - LOGICAL_HEIGHT * scale) / 2);
  if (opts.background && (look?.layers.background.visible ?? true))
    drawImageFit(ctx, opts.background, FULL_FRAME, scale, 'cover');
  drawSlide2D(ctx, slide, { scale, look, images: lookup, nextSlide, isSong: opts.isSong ?? true });
  ctx.restore();
}

/**
 * Render a slide thumbnail on an OffscreenCanvas (works in workers) and return it as an ImageBitmap.
 * `images` maps media ids to decoded images (ImageBitmap etc.).
 */
export function renderSlideThumbnail(
  slide: Slide,
  look: Look | undefined,
  images: ImageLookup | Map<string, CanvasImageSource>,
  width: number,
  height: number,
  nextSlide?: Slide,
  opts: ThumbnailOptions = {},
): ImageBitmap {
  const canvas = opts.canvas ?? new OffscreenCanvas(width, height);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  drawSlideThumbnail(ctx, slide, look, images, width, height, nextSlide, opts);
  return canvas.transferToImageBitmap();
}

/** Families every output can draw without a loaded font file (the rasterizer's fallback chain). */
export const FALLBACK_FAMILIES: ReadonlySet<string> = new Set([
  'inter',
  'segoe ui',
  'arial',
  'helvetica',
  'sans-serif',
  'serif',
  'monospace',
  'system-ui',
]);

/** Every font family a raster job draws text with (clamped, deduplicated, lower-cased). */
export function jobFontFamilies(job: AssetJob): string[] {
  const out = new Set<string>();
  const add = (s: { fontFamily?: unknown } | undefined) => {
    if (s && typeof s.fontFamily === 'string' && s.fontFamily.trim())
      out.add(s.fontFamily.trim().toLowerCase().slice(0, 200));
  };
  const look = clampLook(job.kind === 'image' ? undefined : job.look);
  const rule = look.layers.slide;
  if (job.kind === 'slide') {
    if (rule.mode === 'authored')
      for (const o of clampSlide(job.slide).objects) if (o.type === 'text' && o.text.trim()) add(o.style);
    if (rule.mode === 'lyricOnly') {
      add(rule.style);
      if (rule.nextSlide && job.nextSlide) add(rule.nextSlide.style);
    }
  } else if (job.kind === 'lowerThird') add(lowerThirdStyle(look).style);
  else if (job.kind === 'props') for (const it of job.model.items ?? []) add(it.style);
  return [...out];
}

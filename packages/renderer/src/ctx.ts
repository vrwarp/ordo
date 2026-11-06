import type { Box } from '@ordo/domain';

/** The 2D contexts every drawer uses: the outputs' and thumbnails' OffscreenCanvas, the editor's canvas. */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Set `ctx.letterSpacing` where the browser has it (older engines ignore letter spacing). */
export function setLetterSpacing(ctx: Ctx2D, px: number): void {
  const c = ctx as Ctx2D & { letterSpacing?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${px}px`;
}

/** Set `ctx.lang` where the browser has it (shaping and line breaking by language). */
export function setLang(ctx: Ctx2D, lang: string): void {
  const c = ctx as Ctx2D & { lang?: string };
  if ('lang' in c) c.lang = lang || 'inherit';
}

export function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (r > 0 && 'roundRect' in ctx) (ctx as CanvasRenderingContext2D).roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** Run `draw` rotated by the box's rotation about its centre (device px = logical × scale). */
export function withRotation(ctx: Ctx2D, box: Box, scale: number, draw: () => void): void {
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

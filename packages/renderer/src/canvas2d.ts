import type { Compositor, FrameInputs } from './compositor.ts';
import { type LayerStack, SRC_BITMAP, SRC_EMPTY, SRC_VIDEO, type Stack, fitRect } from './stacks.ts';

/**
 * Canvas 2D fallback compositor, used when WebGPU is unavailable (headless tests, odd machines). It
 * draws the same bitmaps and video frames with the same crossfade maths: the pair is mixed in a scratch
 * canvas with additive blending of premultiplied colour (exact mix), then composited over.
 */
export class Canvas2DCompositor implements Compositor {
  readonly kind = '2d' as const;
  private ctx: OffscreenCanvasRenderingContext2D;
  private scratch: OffscreenCanvas;
  private sctx: OffscreenCanvasRenderingContext2D;
  private rect = new Float32Array(4);
  private clearStyle = '';
  private clearKey = -1;
  private pixelStyle = '';
  private pixelKey = -1;

  constructor(
    readonly canvas: OffscreenCanvas,
    readonly width: number,
    readonly height: number,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.scratch = new OffscreenCanvas(width, height);
    const s = this.scratch.getContext('2d');
    if (!s) throw new Error('2D scratch context unavailable');
    this.sctx = s;
  }

  draw(f: FrameInputs): void {
    /* @hot */
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const ck = ((f.clear[0]! * 255) << 16) | ((f.clear[1]! * 255) << 8) | (f.clear[2]! * 255);
    if (ck !== this.clearKey) {
      // Only on a look change.
      this.clearKey = ck;
      this.clearStyle = rgbString(f.clear[0]! * 255, f.clear[1]! * 255, f.clear[2]! * 255);
    }
    ctx.fillStyle = this.clearStyle;
    ctx.fillRect(0, 0, this.width, this.height);
    for (let i = 0; i < f.layers.length; i++) this.drawLayer(f.layers[i]!, f);
    if (f.testPixel[0]! >= 0) {
      const pk = (f.testPixel[0]! << 16) | (f.testPixel[1]! << 8) | f.testPixel[2]!;
      if (pk !== this.pixelKey) {
        this.pixelKey = pk;
        this.pixelStyle = rgbString(f.testPixel[0]!, f.testPixel[1]!, f.testPixel[2]!);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.pixelStyle;
      ctx.fillRect(0, 0, 1, 1);
    }
  }

  private drawLayer(ls: LayerStack<ImageBitmap>, f: FrameInputs): void {
    /* @hot */
    const live = ls.liveStack;
    const out = ls.armedStack;
    const liveOn = this.hasSource(live, f);
    const outOn = ls.fading && this.hasSource(out, f);
    if (!liveOn && !outOn) return;
    const w = ls.weight(f.now);
    const ctx = this.ctx;
    if (liveOn && outOn) {
      const s = this.sctx;
      s.globalCompositeOperation = 'source-over';
      s.clearRect(0, 0, this.width, this.height);
      s.globalAlpha = 1 - w;
      this.drawSource(s, out, f);
      s.globalCompositeOperation = 'lighter';
      s.globalAlpha = w;
      this.drawSource(s, live, f);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.scratch, 0, 0);
      return;
    }
    ctx.globalAlpha = liveOn ? w : 1 - w;
    this.drawSource(ctx, liveOn ? live : out, f);
    ctx.globalAlpha = 1;
  }

  private hasSource(s: Stack<ImageBitmap>, f: FrameInputs): boolean {
    /* @hot */
    if (s.kind === SRC_EMPTY) return false;
    if (s.kind === SRC_BITMAP) return s.bitmap !== null;
    return s.videoSlot >= 0 && f.video.frames[s.videoSlot] != null;
  }

  private drawSource(ctx: OffscreenCanvasRenderingContext2D, s: Stack<ImageBitmap>, f: FrameInputs): void {
    /* @hot */
    if (s.kind === SRC_BITMAP) {
      if (s.bitmap) ctx.drawImage(s.bitmap, 0, 0, this.width, this.height);
      return;
    }
    if (s.kind === SRC_VIDEO) {
      const fr = f.video.frames[s.videoSlot];
      if (!fr) return;
      fitRect(fr.displayWidth, fr.displayHeight, this.width, this.height, s.fit, this.rect);
      ctx.drawImage(fr, this.rect[0]!, this.rect[1]!, this.rect[2]!, this.rect[3]!);
    }
  }

  destroy(): void {
    /* nothing to release; bitmaps belong to the stacks */
  }
}

function rgbString(r: number, g: number, b: number): string {
  return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
}

import {
  type Compositor,
  type FrameInputs,
  opaqueFrom,
  opaqueLive,
  sceneVideoPresent,
} from './compositor.ts';
import {
  MASK_ELLIPSE,
  MASK_ROUND,
  PLANE_FLOATS,
  PLANE_MASK,
  PLANE_OPACITY,
  PLANE_RADII,
  PLANE_UV,
  planeForward,
} from './scene.ts';
import {
  type LayerStack,
  SRC_BITMAP,
  SRC_EMPTY,
  SRC_SCENE,
  SRC_VIDEO,
  type Stack,
  type StackContent,
  fitRect,
} from './stacks.ts';

/**
 * Most rounded-rect mask paths kept. A layer holds at most three contents (live, armed, queued), so this
 * covers every scene the five layers can hold plus the one being offered.
 */
const MASK_CACHE = 16;

/**
 * How far (device px) a turned video is first drawn past each edge of its visible rect. Chromium never
 * anti-aliases a VideoFrame's edges, so a turned plane's edges are cut by an anti-aliased fill instead, and
 * the pixels that fill half covers need video under them: this enlarged first draw puts the edge texels
 * there, under the exact draw.
 */
const BLEED = 1.5;

/** A rounded-rect mask in a plane's frame units (corner radii rx, ry), as a fill path. */
type RoundMask = { rx: number; ry: number; path: Path2D };

/**
 * Canvas 2D fallback compositor, used when WebGPU is unavailable (headless tests, odd machines, software
 * adapters). It draws the same bitmaps and video frames with the same crossfade maths: the pair is mixed
 * in a scratch canvas with additive blending of premultiplied colour (exact mix), then composited over.
 * A tight sprite (design/27 §7.3) is drawn at its offset, and a crossfade of two sprites mixes only the
 * rect they cover. A full-frame opaque bitmap at full weight is drawn with 'copy' (no blending) and
 * nothing under it is drawn, the clear included (`opaqueFrom`).
 *
 * A scene stack (SRC_SCENE, design/27 §7.2, scene.ts) draws its base, then, while its slot holds a frame
 * of the stack's generation, the video through its plane, then its over. The video is drawn with
 * `setTransform` to the plane's forward affine (the frame's unit square to device px, rotation and flips
 * included) and the 9-argument `drawImage` of its visible part: the plane's UV rect cut to the picture, so
 * a crop's padding stays empty and the image's own edges are the frame's. An upright plane with a rect
 * mask needs nothing more; its edges snap to whole pixels, as Chromium draws every upright image.
 *
 * Chromium anti-aliases neither a 2D clip on an OffscreenCanvas nor a VideoFrame's edges (both measured),
 * so masks and turned edges are cut with fills, which are anti-aliased: the video is drawn into the mask
 * canvas within its pixel bounds, kept where the visible rect (turned planes) and the mask path (ellipse,
 * rounded rect) cover it ('destination-in'), and that rect is copied to the target. Mask paths and the
 * extra canvases are made when the scene is offered (`prepare`), never per frame.
 *
 * A scene is several draws, so it is composed at full alpha before it is weighted: in the scene canvas
 * during a crossfade (then mixed like any source), or in the scratch canvas when it fades alone.
 */
export class Canvas2DCompositor implements Compositor {
  readonly kind = '2d' as const;
  private ctx: OffscreenCanvasRenderingContext2D;
  private scratch: OffscreenCanvas;
  private sctx: OffscreenCanvasRenderingContext2D;
  private rect = new Float32Array(4);
  /** The rect a crossfade mixes: x0, y0, x1, y1 (device px). */
  private mix = new Float64Array(4);
  private clearStyle = '';
  private clearKey = -1;
  private pixelStyle = '';
  private pixelKey = -1;
  /** Composes one scene at full alpha for a crossfade; made with the first scene offered. */
  private sceneCanvas: OffscreenCanvas | null = null;
  private scenectx: OffscreenCanvasRenderingContext2D | null = null;
  /** Holds a masked video while its mask is applied; made with the first masked scene offered. */
  private maskCanvas: OffscreenCanvas | null = null;
  private maskctx: OffscreenCanvasRenderingContext2D | null = null;
  /** The unit ellipse (frame units), made with the first elliptical mask. */
  private ellipse: Path2D | null = null;
  private rounds: RoundMask[] = [];
  /** The forward affine of the plane being drawn (setTransform arguments). */
  private fwd = new Float64Array(6);
  /** The layers of the last frame: which masks are still held when the cache is full. */
  private held: LayerStack<ImageBitmap>[] | null = null;

  readonly canvas: OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  constructor(canvas: OffscreenCanvas, width: number, height: number) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.scratch = new OffscreenCanvas(width, height);
    const s = this.scratch.getContext('2d');
    if (!s) throw new Error('2D scratch context unavailable');
    this.sctx = s;
  }

  /**
   * The offer handler (design/27 §7.2): the engine calls it with every content offered to a layer, before
   * the layer takes it, and with the stacks it holds when the compositor is created. A scene's mask path
   * and the canvases it is drawn through are made here, so drawing it allocates nothing.
   */
  prepare(_layer: number, c: StackContent<ImageBitmap>): void {
    const p = c.plane;
    if (c.kind !== SRC_SCENE || !p || p.length !== PLANE_FLOATS) return;
    this.sceneTarget();
    const kind = p[PLANE_MASK]!;
    // The inverse of an upright affine is upright.
    if (kind === MASK_ELLIPSE || kind === MASK_ROUND || !upright(p[0]!, p[1]!, p[2]!, p[3]!))
      this.maskTarget();
    if (kind === MASK_ELLIPSE) this.ellipseMask();
    else if (kind === MASK_ROUND) {
      const rx = p[PLANE_RADII]!;
      const ry = p[PLANE_RADII + 1]!;
      if (!this.findRound(rx, ry)) this.makeRound(rx, ry);
    }
  }

  draw(f: FrameInputs): void {
    /* @hot */
    this.held = f.layers;
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const ck = ((f.clear[0]! * 255) << 16) | ((f.clear[1]! * 255) << 8) | (f.clear[2]! * 255);
    if (ck !== this.clearKey) {
      // Only on a look change.
      this.clearKey = ck;
      this.clearStyle = rgbString(f.clear[0]! * 255, f.clear[1]! * 255, f.clear[2]! * 255);
    }
    const n = f.layers.length;
    const first = opaqueFrom(f.layers, n, this.width, this.height);
    if (n > 0 && opaqueLive(f.layers[first]!, this.width, this.height)) {
      // Opaque and covering the frame: it replaces the clear and every layer under it.
      ctx.globalCompositeOperation = 'copy';
      const b = f.layers[first]!.liveStack.bitmap!;
      ctx.drawImage(b, 0, 0, b.width, b.height);
      ctx.globalCompositeOperation = 'source-over';
      for (let i = first + 1; i < n; i++) this.drawLayer(f.layers[i]!, f);
    } else {
      ctx.fillStyle = this.clearStyle;
      ctx.fillRect(0, 0, this.width, this.height);
      for (let i = 0; i < n; i++) this.drawLayer(f.layers[i]!, f);
    }
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
      // Mixed in the scratch, within the rect the two sources cover (two sprites: their union).
      const m = this.mix;
      m[0] = this.width;
      m[1] = this.height;
      m[2] = 0;
      m[3] = 0;
      this.coverOf(out);
      this.coverOf(live);
      const x0 = Math.max(0, Math.floor(m[0]!));
      const y0 = Math.max(0, Math.floor(m[1]!));
      const x1 = Math.min(this.width, Math.ceil(m[2]!));
      const y1 = Math.min(this.height, Math.ceil(m[3]!));
      if (!(x1 > x0 && y1 > y0)) return;
      const s = this.sctx;
      s.globalCompositeOperation = 'source-over';
      s.clearRect(x0, y0, x1 - x0, y1 - y0);
      this.mixSource(s, out, f, 1 - w);
      s.globalCompositeOperation = 'lighter';
      this.mixSource(s, live, f, w);
      ctx.globalAlpha = 1;
      if (x0 === 0 && y0 === 0 && x1 === this.width && y1 === this.height) ctx.drawImage(this.scratch, 0, 0);
      else ctx.drawImage(this.scratch, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      return;
    }
    const one = liveOn ? live : out;
    const a = liveOn ? w : 1 - w;
    if (a < 1 && this.layered(one, f)) {
      // A scene fading alone: composed at full alpha first, so its parts do not show through each other.
      const s = this.sctx;
      s.globalCompositeOperation = 'source-over';
      s.globalAlpha = 1;
      s.clearRect(0, 0, this.width, this.height);
      this.drawSource(s, one, f);
      ctx.globalAlpha = a;
      ctx.drawImage(this.scratch, 0, 0);
    } else {
      ctx.globalAlpha = a;
      this.drawSource(ctx, one, f);
    }
    ctx.globalAlpha = 1;
  }

  /** Grow the crossfade's rect by what a stack covers: a bitmap its sprite rect, anything else the frame. */
  private coverOf(s: Stack<ImageBitmap>): void {
    /* @hot */
    const m = this.mix;
    let x0 = 0;
    let y0 = 0;
    let x1 = this.width;
    let y1 = this.height;
    if (s.kind === SRC_BITMAP) {
      const b = s.bitmap;
      if (!b) return;
      x0 = s.x;
      y0 = s.y;
      x1 = s.x + b.width;
      y1 = s.y + b.height;
    }
    if (x0 < m[0]!) m[0] = x0;
    if (y0 < m[1]!) m[1] = y0;
    if (x1 > m[2]!) m[2] = x1;
    if (y1 > m[3]!) m[3] = y1;
  }

  /** Draw a stack into the crossfade's scratch at `alpha`, with the scratch's current blend mode. */
  private mixSource(
    s: OffscreenCanvasRenderingContext2D,
    st: Stack<ImageBitmap>,
    f: FrameInputs,
    alpha: number,
  ): void {
    /* @hot */
    if (this.layered(st, f)) {
      const sc = this.scenectx ?? this.sceneTarget();
      sc.globalCompositeOperation = 'source-over';
      sc.globalAlpha = 1;
      sc.clearRect(0, 0, this.width, this.height);
      this.drawSource(sc, st, f);
      s.globalAlpha = alpha;
      s.drawImage(this.sceneCanvas!, 0, 0);
      return;
    }
    s.globalAlpha = alpha;
    this.drawSource(s, st, f);
  }

  private hasSource(s: Stack<ImageBitmap>, f: FrameInputs): boolean {
    /* @hot */
    if (s.kind === SRC_EMPTY) return false;
    if (s.kind === SRC_BITMAP) return s.bitmap !== null;
    if (s.kind === SRC_SCENE) return s.bitmap !== null || s.over !== null || sceneVideoPresent(s, f.video);
    return s.videoSlot >= 0 && f.video.frames[s.videoSlot] != null;
  }

  /** Whether a stack is more than one draw (a scene with two of base, video and over). */
  private layered(s: Stack<ImageBitmap>, f: FrameInputs): boolean {
    /* @hot */
    if (s.kind !== SRC_SCENE) return false;
    let n = 0;
    if (s.bitmap) n++;
    if (s.over) n++;
    if (n < 2 && sceneVideoPresent(s, f.video) && s.plane[PLANE_OPACITY]! > 0) n++;
    return n > 1;
  }

  private drawSource(ctx: OffscreenCanvasRenderingContext2D, s: Stack<ImageBitmap>, f: FrameInputs): void {
    /* @hot */
    // Bitmaps are drawn 1:1 at their offset (a full-frame bitmap at 0, 0; a tight sprite where it was drawn).
    if (s.kind === SRC_BITMAP) {
      const b = s.bitmap;
      if (b) ctx.drawImage(b, s.x, s.y, b.width, b.height);
      return;
    }
    if (s.kind === SRC_SCENE) {
      const b = s.bitmap;
      if (b) ctx.drawImage(b, s.x, s.y, b.width, b.height);
      if (sceneVideoPresent(s, f.video)) this.drawPlane(ctx, s.plane, f.video.frames[s.videoSlot]!);
      const o = s.over;
      if (o) ctx.drawImage(o, s.overX, s.overY, o.width, o.height);
      return;
    }
    if (s.kind === SRC_VIDEO) {
      const fr = f.video.frames[s.videoSlot];
      if (!fr) return;
      fitRect(fr.displayWidth, fr.displayHeight, this.width, this.height, s.fit, this.rect);
      ctx.drawImage(fr, this.rect[0]!, this.rect[1]!, this.rect[2]!, this.rect[3]!);
    }
  }

  /**
   * The video of a scene through its plane, at the context's alpha times the plane's opacity, in the
   * context's blend mode. In frame units (the forward affine is the transform) the frame's [0, 1] square
   * maps to UV [u0, u1] x [v0, v1], so the visible part is the UV rect cut to 0..1, drawn from that part of
   * the frame's pixels at the same share of the unit square. Outside it (a crop's padding) nothing is drawn.
   */
  private drawPlane(ctx: OffscreenCanvasRenderingContext2D, plane: Float32Array, fr: VideoFrame): void {
    /* @hot */
    const opacity = plane[PLANE_OPACITY]!;
    if (!(opacity > 0)) return;
    const tw = fr.displayWidth;
    const th = fr.displayHeight;
    if (!(tw > 0 && th > 0)) return;
    const u0 = plane[PLANE_UV]!;
    const v0 = plane[PLANE_UV + 1]!;
    const su = plane[PLANE_UV + 2]! - u0;
    const sv = plane[PLANE_UV + 3]! - v0;
    if (!(su > 0 && sv > 0)) return;
    const ua = Math.max(u0, 0);
    const ub = Math.min(u0 + su, 1);
    const va = Math.max(v0, 0);
    const vb = Math.min(v0 + sv, 1);
    if (!(ub > ua && vb > va)) return;
    if (!planeForward(plane, this.fwd)) return;
    // The visible rect in frame units.
    const x0 = (ua - u0) / su;
    const y0 = (va - v0) / sv;
    const dw = (ub - ua) / su;
    const dh = (vb - va) / sv;
    const kind = plane[PLANE_MASK]!;
    let mask: Path2D | null = null;
    if (kind === MASK_ELLIPSE) mask = this.ellipse ?? this.ellipseMask();
    else if (kind === MASK_ROUND) {
      const rx = plane[PLANE_RADII]!;
      const ry = plane[PLANE_RADII + 1]!;
      // Made by prepare(); made here only for a scene offered without it.
      mask = this.findRound(rx, ry) ?? this.makeRound(rx, ry);
    }
    const m = this.fwd;
    const a = m[0]!;
    const b = m[1]!;
    const c = m[2]!;
    const d = m[3]!;
    const up = upright(a, b, c, d);
    const sx = ua * tw;
    const sy = va * th;
    const sw = (ub - ua) * tw;
    const sh = (vb - va) * th;
    if (!mask && up) {
      ctx.save();
      ctx.setTransform(a, b, c, d, m[4]!, m[5]!);
      ctx.globalAlpha *= opacity;
      ctx.drawImage(fr, sx, sy, sw, sh, x0, y0, dw, dh);
      ctx.restore();
      return;
    }
    // The visible rect's device bounds in whole pixels, with a margin for the anti-aliased edge.
    const ax = a * dw;
    const ay = b * dw;
    const bx = c * dh;
    const by = d * dh;
    const ox = a * x0 + c * y0 + m[4]!;
    const oy = b * x0 + d * y0 + m[5]!;
    const left = Math.max(0, Math.floor(ox + Math.min(ax, 0) + Math.min(bx, 0)) - 2);
    const top = Math.max(0, Math.floor(oy + Math.min(ay, 0) + Math.min(by, 0)) - 2);
    const right = Math.min(this.width, Math.ceil(ox + Math.max(ax, 0) + Math.max(bx, 0)) + 2);
    const bottom = Math.min(this.height, Math.ceil(oy + Math.max(ay, 0) + Math.max(by, 0)) + 2);
    if (!(right > left && bottom > top)) return;
    const w = right - left;
    const h = bottom - top;
    const mc = this.maskctx ?? this.maskTarget();
    mc.save();
    mc.beginPath();
    mc.rect(left, top, w, h);
    mc.clip(); // whole pixels: exact without anti-aliasing; bounds 'destination-in' below
    mc.clearRect(left, top, w, h);
    mc.setTransform(a, b, c, d, m[4]!, m[5]!);
    if (!up) {
      const ex = BLEED / Math.hypot(a, b);
      const ey = BLEED / Math.hypot(c, d);
      mc.drawImage(fr, sx, sy, sw, sh, x0 - ex, y0 - ey, dw + 2 * ex, dh + 2 * ey);
    }
    mc.drawImage(fr, sx, sy, sw, sh, x0, y0, dw, dh);
    mc.globalCompositeOperation = 'destination-in';
    if (!up) mc.fillRect(x0, y0, dw, dh);
    if (mask) mc.fill(mask);
    mc.restore();
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * opacity;
    ctx.drawImage(this.maskCanvas!, left, top, w, h, left, top, w, h);
    ctx.globalAlpha = alpha;
  }

  private findRound(rx: number, ry: number): Path2D | null {
    /* @hot */
    const r = this.rounds;
    for (let i = 0; i < r.length; i++) if (r[i]!.rx === rx && r[i]!.ry === ry) return r[i]!.path;
    return null;
  }

  /**
   * A rounded-rect mask path in frame units, kept until the cache is full and no stack uses it. Its straight
   * sides are pushed a frame's size outward (a cross with rounded inner corners): inside the frame it is the
   * rounded rect, and only its corners cut the video. The frame's edges are the visible rect's, so they are
   * cut once, not twice (two anti-aliased cuts on one edge would multiply their coverage).
   */
  private makeRound(rx: number, ry: number): Path2D {
    const p = new Path2D();
    const q = Math.PI / 2;
    p.moveTo(rx, 0);
    p.lineTo(rx, -1);
    p.lineTo(1 - rx, -1);
    p.lineTo(1 - rx, 0);
    p.ellipse(1 - rx, ry, rx, ry, 0, -q, 0);
    p.lineTo(2, ry);
    p.lineTo(2, 1 - ry);
    p.lineTo(1, 1 - ry);
    p.ellipse(1 - rx, 1 - ry, rx, ry, 0, 0, q);
    p.lineTo(1 - rx, 2);
    p.lineTo(rx, 2);
    p.lineTo(rx, 1);
    p.ellipse(rx, 1 - ry, rx, ry, 0, q, 2 * q);
    p.lineTo(-1, 1 - ry);
    p.lineTo(-1, ry);
    p.lineTo(0, ry);
    p.ellipse(rx, ry, rx, ry, 0, 2 * q, 3 * q);
    p.closePath();
    if (this.rounds.length >= MASK_CACHE) {
      let drop = 0;
      for (let i = 0; i < this.rounds.length; i++)
        if (!this.roundHeld(this.rounds[i]!)) {
          drop = i;
          break;
        }
      this.rounds.splice(drop, 1);
    }
    this.rounds.push({ rx, ry, path: p });
    return p;
  }

  private roundHeld(m: RoundMask): boolean {
    for (const ls of this.held ?? []) {
      const stacks = ls.hasQueued ? [ls.stacks[0], ls.stacks[1], ls.queued] : ls.stacks;
      for (const s of stacks)
        if (
          s.kind === SRC_SCENE &&
          s.plane[PLANE_MASK] === MASK_ROUND &&
          s.plane[PLANE_RADII] === m.rx &&
          s.plane[PLANE_RADII + 1] === m.ry
        )
          return true;
    }
    return false;
  }

  private ellipseMask(): Path2D {
    if (!this.ellipse) {
      this.ellipse = new Path2D();
      this.ellipse.ellipse(0.5, 0.5, 0.5, 0.5, 0, 0, 2 * Math.PI);
    }
    return this.ellipse;
  }

  /** The canvas a scene is composed in during a crossfade (frame-sized, made once). */
  private sceneTarget(): OffscreenCanvasRenderingContext2D {
    if (!this.scenectx) {
      this.sceneCanvas = new OffscreenCanvas(this.width, this.height);
      const c = this.sceneCanvas.getContext('2d');
      if (!c) throw new Error('2D scene context unavailable');
      this.scenectx = c;
    }
    return this.scenectx;
  }

  /** The canvas a masked video is drawn in before its mask is applied (frame-sized, made once). */
  private maskTarget(): OffscreenCanvasRenderingContext2D {
    if (!this.maskctx) {
      this.maskCanvas = new OffscreenCanvas(this.width, this.height);
      const c = this.maskCanvas.getContext('2d');
      if (!c) throw new Error('2D mask context unavailable');
      this.maskctx = c;
    }
    return this.maskctx;
  }

  destroy(): void {
    /* nothing to release; bitmaps belong to the stacks */
  }
}

/** Whether the 2x2 part of an affine keeps rects upright (no turn, or a quarter turn; flips allowed). */
function upright(a: number, b: number, c: number, d: number): boolean {
  /* @hot */
  const aa = Math.abs(a);
  const ab = Math.abs(b);
  const ac = Math.abs(c);
  const ad = Math.abs(d);
  return (ab * 1e6 < aa && ac * 1e6 < ad) || (aa * 1e6 < ab && ad * 1e6 < ac);
}

function rgbString(r: number, g: number, b: number): string {
  return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
}

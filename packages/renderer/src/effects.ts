import { type Glow, type Shadow, rgbaCss } from '@ordo/domain';

import type { Ctx2D } from './ctx.ts';
import type { Bounds } from './geom/bounds.ts';

export type { Bounds } from './geom/bounds.ts';

/*
 * Shape effects (design/27 §7.5 "effect sprite cache", §15 M6): an outer shadow, a glow and a soft edge, drawn
 * as LibreOffice draws them (drawinglayer ShadowPrimitive2D, GlowPrimitive2D and SoftEdgePrimitive2D with
 * `ProcessAndBlurAlphaMask`, whose blur is a stack blur: a triangular kernel of radius r, whose standard
 * deviation is r/√6):
 * - shadow: the shape's alpha blurred by the shadow's `blur` (σ = blur/√6), in its colour, offset by dx, dy;
 * - glow: the shape's silhouette grown by radius/2, blurred by radius/2, in the glow's colour and alpha;
 * - soft edge: the shape's alpha times its silhouette shrunk by `softEdge` and blurred by it.
 * They stack as in LibreOffice: shadow under glow under the shape, each at the object's opacity.
 *
 * Each blurred layer is the silhouette drawn into a canvas, blurred by a Canvas shadow of a copy drawn outside
 * the canvas (only the shadow lands; every engine anti-aliases and blurs it, unlike `ctx.filter`, which Safari
 * lacks). A blur is smooth, so its layer is made at a reduced resolution (as LibreOffice computes its blurs
 * within 250,000 px and 1,000 px a side): 1/k of the device size with k = σ/2 (σ in device px, k between 1
 * and BLUR_MAX_REDUCTION, more for a layer past BLUR_MAX_PIXELS), enlarged with smoothing onto the canvas,
 * over which the shape is drawn as vectors. A soft-edged shape is drawn into a sprite of its device bounds
 * and its alpha multiplied by the eroded silhouette, blurred and reduced the same way (a mask past
 * BLUR_MAX_PIXELS too). Making a full-slide shadow at 4K blurs a few hundred thousand pixels instead of eight
 * million.
 *
 * The reduced layers are cached by the caller's key and the device transform (`EFFECT_CACHE_BYTES`, LRU; a
 * layer is at most 4 MB): a master decoration with a shadow is drawn on every slide of a deck, and a slide is
 * drawn again for every look and refresh. A shape and its layers are composed into one full-resolution
 * sprite (cached, copied 1:1) up to EFFECT_COMPOSITE_BYTES, and past it until it thrashes the cache
 * (`drawEffected`). With no OffscreenCanvas (Node) or a sprite past
 * EFFECT_MAX_PIXELS nothing is drawn here: the caller draws the shape without its effects.
 *
 * The layers are made over what the shape draws (`EffectSource.bounds`, `geom/bounds.ts` `drawnBounds`: its
 * geometry's points, past its box included, grown by its outline's reach), grown by each effect's reach and
 * cut to the canvas and that reach (`region`): the area the slide's effect budget sizes them by
 * (`geom/cost.ts` `effectArea`), the same in the converter.
 */

/** Device pixels of one effect sprite at most (the 16 MP of a prepared picture). */
export const EFFECT_MAX_PIXELS = 16_000_000;
/** Bytes of cached effect sprites (design/27 §7.5: ≤ 64 MiB). */
export const EFFECT_CACHE_BYTES = 64 * 1024 * 1024;
/** σ of a stack blur of radius r, over r (a triangular kernel's √(r²/6)). */
export const STACK_BLUR_SIGMA = 1 / Math.sqrt(6);
/** The largest resolution reduction of a blurred layer (its σ is kept at 2 px or more). */
export const BLUR_MAX_REDUCTION = 8;
/** Pixels of one reduced blur layer at most (LibreOffice: 250,000). */
export const BLUR_MAX_PIXELS = 1_000_000;

/** What the effect sprites draw of a shape, in box space under `transform`. */
export interface EffectSource {
  /** Box space → device px (the caller's transform, its scale, the box's rotation and flips). */
  readonly transform: DOMMatrix;
  /** Device px per logical px, for blur sizes (Canvas shadows are not transformed). */
  readonly scale: number;
  /** What the shape covers in box space, strokes and markers included. */
  readonly bounds: Bounds;
  /** Draws the shape at full alpha (fills, strokes, markers) under the context's transform. */
  readonly draw: (c: Ctx2D) => void;
  /** The union of the filled paths (non-zero rule), for the glow's and the soft edge's silhouette. */
  readonly fill?: Path2D;
  /** The stroked paths and the line width (box units), for the silhouette of the outline. */
  readonly strokes?: readonly Path2D[];
  readonly lineWidth: number;
  /** The outline's joins and caps (Canvas's; default miter and butt), for its silhouette. */
  readonly join?: CanvasLineJoin;
  readonly cap?: CanvasLineCap;
  readonly shadow?: Shadow;
  readonly glow?: Glow;
  /** Logical px. */
  readonly softEdge?: number;
  /** Cache key of everything drawn but the transform; undefined: not cached. */
  readonly key?: string;
}

/** A sprite and where it goes: device px x, y, size w x h (it may be smaller: it is enlarged to that). */
type Sprite = { canvas: OffscreenCanvas; x: number; y: number; w: number; h: number; bytes: number };

const cache = new Map<string, Sprite>();
let cacheBytes = 0;
/**
 * Keys of large composites made once, and of those made again after the cache let them go (the slide holds
 * more of them than the cache: they would be rebuilt on every raster), which are drawn layered from then on.
 */
const composed = new Set<string>();
const thrashed = new Set<string>();
/** Keys remembered in `composed` and `thrashed` at most (both are cleared past it). */
const KEYS_MAX = 4_096;

/** Forget every cached effect sprite (tests, and memory pressure). */
export function clearEffectCache(): void {
  cache.clear();
  cacheBytes = 0;
  composed.clear();
  thrashed.clear();
}

/** Bytes the effect cache holds. */
export function effectCacheBytes(): number {
  return cacheBytes;
}

function cached(key: string | undefined): Sprite | undefined {
  if (key === undefined) return undefined;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function remember(key: string | undefined, s: Sprite): void {
  if (key === undefined || s.bytes > EFFECT_CACHE_BYTES / 2) return;
  const old = cache.get(key);
  if (old) {
    cache.delete(key);
    cacheBytes -= old.bytes;
  }
  while (cacheBytes + s.bytes > EFFECT_CACHE_BYTES && cache.size) {
    const [k, v] = cache.entries().next().value as [string, Sprite];
    cache.delete(k);
    cacheBytes -= v.bytes;
  }
  cache.set(key, s);
  cacheBytes += s.bytes;
}

function sprite(w: number, h: number): OffscreenCanvasRenderingContext2D | undefined {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  const c = new OffscreenCanvas(w, h);
  return c.getContext('2d', { willReadFrequently: true }) ?? undefined;
}

/** A 2D affine (a DOMMatrix's six numbers). */
type Affine = Pick<DOMMatrix, 'a' | 'b' | 'c' | 'd' | 'e' | 'f'>;

/** The device bounds of a box-space rectangle under `m`. */
function deviceBounds(m: Affine, b: Bounds): Bounds {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x0, b.y1],
    [b.x1, b.y1],
  ] as const) {
    xs.push(m.a * x + m.c * y + m.e);
    ys.push(m.b * x + m.d * y + m.f);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Draws `img` blurred by a Canvas shadow only (the image itself lands outside `c`): σ device px, `color`. */
function shadowOnly(
  c: OffscreenCanvasRenderingContext2D,
  img: OffscreenCanvas,
  color: string,
  sigma: number,
): void {
  const far = img.width + c.canvas.width + 64;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.shadowColor = color;
  c.shadowBlur = Math.max(0, 2 * sigma);
  c.shadowOffsetX = far;
  c.shadowOffsetY = 0;
  c.drawImage(img, -far, 0);
  c.restore();
}

/** The silhouette of the shape in `c` (opaque), grown by `grow` box units. */
function silhouette(c: OffscreenCanvasRenderingContext2D, src: EffectSource, grow: number): void {
  c.fillStyle = '#000';
  c.strokeStyle = '#000';
  c.lineJoin = 'round';
  c.lineCap = 'round';
  if (src.fill) {
    c.fill(src.fill, 'nonzero');
    if (grow > 0) {
      c.lineWidth = 2 * grow;
      c.stroke(src.fill);
    }
  }
  if (src.strokes?.length && src.lineWidth > 0) {
    // The outline as drawn (its joins and caps), grown round.
    c.lineJoin = grow > 0 ? 'round' : (src.join ?? 'miter');
    c.lineCap = grow > 0 ? 'round' : (src.cap ?? 'butt');
    c.miterLimit = 8;
    c.lineWidth = src.lineWidth + 2 * grow;
    for (const p of src.strokes) c.stroke(p);
  }
}

/**
 * The soft edge's mask in `c`: the silhouette shrunk by `e` box units. An outline at least 2e wide is kept
 * thinner (its outer edge moves in by e); else the fill shrinks by what is left of e past the outline.
 */
function eroded(c: OffscreenCanvasRenderingContext2D, src: EffectSource, e: number): void {
  c.fillStyle = '#000';
  c.strokeStyle = '#000';
  c.lineJoin = 'round';
  c.lineCap = 'round';
  const stroked = !!src.strokes?.length && src.lineWidth > 0;
  if (stroked && src.lineWidth / 2 >= e) {
    if (src.fill) c.fill(src.fill, 'nonzero');
    if (src.lineWidth - 2 * e > 0) {
      c.lineJoin = src.join ?? 'miter';
      c.lineCap = src.cap ?? 'butt';
      c.miterLimit = 8;
      c.lineWidth = src.lineWidth - 2 * e;
      for (const p of src.strokes!) c.stroke(p);
    }
    return;
  }
  if (!src.fill) return;
  c.fill(src.fill, 'nonzero');
  const rest = e - (stroked ? src.lineWidth / 2 : 0);
  c.globalCompositeOperation = 'destination-out';
  c.lineWidth = 2 * rest;
  c.stroke(src.fill);
  c.globalCompositeOperation = 'source-over';
}

/**
 * Integer device rect cut to the canvas (keeping `reach` past its edges), or undefined when empty. The
 * canvas's origin lies at (-ox, -oy) of `b`'s space (`drawEffected` takes whole device px out of the
 * transform).
 */
function region(b: Bounds, cw: number, ch: number, reach: number, ox = 0, oy = 0) {
  let { x0, y0, x1, y1 } = b;
  if (cw > 0 && ch > 0) {
    x0 = Math.max(x0, -reach - ox);
    y0 = Math.max(y0, -reach - oy);
    x1 = Math.min(x1, cw + reach - ox);
    y1 = Math.min(y1, ch + reach - oy);
  }
  const X = Math.floor(x0);
  const Y = Math.floor(y0);
  const W = Math.ceil(x1) - X;
  const H = Math.ceil(y1) - Y;
  return W >= 1 && H >= 1 && Number.isFinite(W + H) ? { X, Y, W, H } : undefined;
}

/**
 * A blurred layer: `paint` draws the silhouette (under the transform given) into a sprite of the device rect
 * `r` at 1/k resolution, blurred by σ device px in `color`; the silhouette is moved by (dx, dy) device px.
 */
function blurLayer(
  m: Affine,
  r: { X: number; Y: number; W: number; H: number },
  sigma: number,
  dx: number,
  dy: number,
  color: string,
  paint: (c: OffscreenCanvasRenderingContext2D) => void,
): Sprite | undefined {
  let k = Math.min(BLUR_MAX_REDUCTION, Math.max(1, sigma / 2));
  k = Math.max(k, Math.sqrt((r.W * r.H) / BLUR_MAX_PIXELS));
  const w = Math.max(1, Math.ceil(r.W / k));
  const h = Math.max(1, Math.ceil(r.H / k));
  const a = sprite(w, h);
  const b = sprite(w, h);
  if (!a || !b) return undefined;
  a.setTransform(m.a / k, m.b / k, m.c / k, m.d / k, (m.e + dx - r.X) / k, (m.f + dy - r.Y) / k);
  paint(a);
  shadowOnly(b, a.canvas, color, sigma / k);
  return { canvas: b.canvas, x: r.X, y: r.Y, w: w * k, h: h * k, bytes: w * h * 4 };
}

/**
 * Bytes of a composite sprite (a shape with its layers at full resolution) always composed: a smaller one is
 * composed once, cached and copied 1:1. A larger one (up to half the cache) is composed and cached too until
 * the cache lets it go and it is needed again: a slide holding more of them than the cache (three large
 * shadowed panels at 4K, 24 MB each) would rebuild them on every raster, so such a shape is drawn layered
 * from then on (its reduced layers cached and enlarged, the shape drawn over them).
 */
export const EFFECT_COMPOSITE_BYTES = 8 * 1024 * 1024;

/**
 * Draws a shape with its effects on `ctx` (whose transform the source's `transform` already is), at `opacity`.
 * - A shape whose device bounds and layers fit EFFECT_COMPOSITE_BYTES (or one below full opacity, drawn as a
 *   group) is composed into one sprite: its reduced layers enlarged into it, the shape over them (a soft
 *   edge cut by its mask); the sprite is cached (up to half the cache) and copied 1:1. A larger one is
 *   composed and cached the same way until the cache lets its sprite go and it is drawn again (`thrashed`).
 * - From then on it draws its reduced layers (each at most BLUR_MAX_PIXELS, cached on its own: a few MB)
 *   enlarged onto `ctx`, then the shape as vectors, or, soft-edged, through a sprite of its device bounds cut
 *   by its reduced mask (the sprite made each time, the mask cached as the layers are; the slide's effect
 *   budget, `geom/cost.ts` `EFFECT_COST`, bounds how much of it there is).
 * False when it could not (no OffscreenCanvas, a sprite past EFFECT_MAX_PIXELS, a non-finite transform):
 * the caller then draws the shape without its effects.
 *
 * The layers and sprites are made, keyed and cached with the transform's whole device px taken out (`ox`,
 * `oy`), which are put back where they are drawn: the same shape at another whole-pixel offset (a slide's
 * tight sprite of another rect, design/27 §7.3 M7) draws from the same cached layers. Only a cut at the
 * canvas's edge depends on the offset, and changes the key with it.
 */
export function drawEffected(ctx: Ctx2D, src: EffectSource, opacity: number): boolean {
  if (typeof OffscreenCanvas === 'undefined') return false;
  const t = src.transform;
  if (![t.a, t.b, t.c, t.d, t.e, t.f].every(Number.isFinite)) return false;
  const ox = Math.floor(t.e);
  const oy = Math.floor(t.f);
  const m: Affine = { a: t.a, b: t.b, c: t.c, d: t.d, e: t.e - ox, f: t.f - oy };
  const s = Number.isFinite(src.scale) && src.scale > 0 ? src.scale : 1;
  const content = deviceBounds(m, src.bounds);
  const canvas = ctx.canvas as { width?: number; height?: number } | undefined;
  const cw = canvas?.width ?? 0;
  const ch = canvas?.height ?? 0;

  // The device rects of the layers and of the shape, and the one the final sprite covers.
  const sh = src.shadow && src.shadow.color.a > 0 ? src.shadow : undefined;
  const shadowSigma = sh ? sh.blur * STACK_BLUR_SIGMA * s : 0;
  const shadowReach = 3 * shadowSigma + 2;
  const sdx = sh ? sh.dx * s : 0;
  const sdy = sh ? sh.dy * s : 0;
  const gl = src.glow && src.glow.radius > 0 && src.glow.color.a > 0 ? src.glow : undefined;
  const glowSigma = gl ? (gl.radius / 2) * STACK_BLUR_SIGMA * s : 0;
  const glowReach = gl ? (gl.radius / 2) * s + 3 * glowSigma + 2 : 0;
  const all: Bounds = { ...content };
  if (sh) {
    all.x0 = Math.min(all.x0, content.x0 + sdx - shadowReach);
    all.y0 = Math.min(all.y0, content.y0 + sdy - shadowReach);
    all.x1 = Math.max(all.x1, content.x1 + sdx + shadowReach);
    all.y1 = Math.max(all.y1, content.y1 + sdy + shadowReach);
  }
  if (gl) {
    all.x0 = Math.min(all.x0, content.x0 - glowReach);
    all.y0 = Math.min(all.y0, content.y0 - glowReach);
    all.x1 = Math.max(all.x1, content.x1 + glowReach);
    all.y1 = Math.max(all.y1, content.y1 + glowReach);
  }
  // What blurs onto the canvas from just outside it is kept: a layer is cut at its own reach past the edges.
  const r = region(
    all,
    cw,
    ch,
    Math.max(shadowReach + Math.max(Math.abs(sdx), Math.abs(sdy)), glowReach),
    ox,
    oy,
  );
  if (!r) return true;
  if (r.W * r.H > EFFECT_MAX_PIXELS) return false;
  const key =
    src.key === undefined
      ? undefined
      : `${src.key}|${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f}|${r.X} ${r.Y} ${r.W} ${r.H}`;
  const tagged = (tag: string) => (key === undefined ? undefined : `${key}|${tag}`);
  const soft = !!src.softEdge && src.softEdge > 0;
  const shadowOf = () =>
    sh
      ? blurLayer(m, r, shadowSigma, sdx, sdy, rgbaCss(sh.color), (c) => {
          src.draw(c);
          if (soft) softened(c, src, m, s);
        })
      : undefined;
  const glowOf = () =>
    gl
      ? blurLayer(m, r, glowSigma, 0, 0, rgbaCss(gl.color), (c) => silhouette(c, src, gl.radius / 2))
      : undefined;
  const bytes = r.W * r.H * 4;

  const allKey = tagged('all');
  let out = cached(allKey);
  let compose = !!out || bytes <= EFFECT_COMPOSITE_BYTES || opacity < 1;
  if (!compose && allKey !== undefined && bytes <= EFFECT_CACHE_BYTES / 2 && !thrashed.has(allKey)) {
    if (composed.has(allKey)) {
      if (thrashed.size >= KEYS_MAX) thrashed.clear();
      thrashed.add(allKey);
    } else {
      if (composed.size >= KEYS_MAX) composed.clear();
      composed.add(allKey);
      compose = true;
    }
  }
  if (compose) {
    if (!out) {
      const f = sprite(r.W, r.H);
      if (!f) return false;
      // Bilinear, as the layered path enlarges them: the layers are blurs ('medium' differs by 2 levels at
      // most and costs a third more at 4K).
      f.imageSmoothingEnabled = true;
      f.imageSmoothingQuality = 'low';
      const place = (layer: Sprite) => {
        f.drawImage(layer.canvas, layer.x - r.X, layer.y - r.Y, layer.w, layer.h);
      };
      if (sh) {
        const layer = shadowOf();
        if (!layer) return false;
        place(layer);
      }
      if (gl) {
        const layer = glowOf();
        if (!layer) return false;
        place(layer);
      }
      if (!body(f, src, m, s, r, soft, !!(sh || gl), tagged('softmask'))) return false;
      out = { canvas: f.canvas, x: r.X, y: r.Y, w: r.W, h: r.H, bytes };
      remember(allKey, out);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha *= opacity;
    ctx.drawImage(out.canvas, out.x + ox, out.y + oy);
    ctx.restore();
    return true;
  }

  // Large: the reduced layers, each cached on its own, enlarged onto the canvas; the shape over them.
  const layer = (tag: string, make: () => Sprite | undefined): Sprite | undefined => {
    const hit = cached(tagged(tag));
    if (hit) return hit;
    const made = make();
    if (made) remember(tagged(tag), made);
    return made;
  };
  const shadowLayer = sh ? layer('shadow', shadowOf) : undefined;
  const glowLayer = gl ? layer('glow', glowOf) : undefined;
  if ((sh && !shadowLayer) || (gl && !glowLayer)) return false;
  // A soft-edged shape: drawn into a sprite of its device rect (empty: no copy of it is needed) and cut by its
  // mask, which is cached as the layers are (an eroded, blurred silhouette made each raster cost about a
  // shadow's layer five times over at 4K).
  let softBody: OffscreenCanvasRenderingContext2D | undefined;
  if (soft) {
    softBody = sprite(r.W, r.H);
    if (!softBody) return false;
    softBody.setTransform(m.a, m.b, m.c, m.d, m.e - r.X, m.f - r.Y);
    src.draw(softBody);
    softened(softBody, src, m, s, r, tagged('softmask'));
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= opacity;
  // Bilinear: the layers are blurs, and 'low' enlarges them a third faster than 'medium' at 4K.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  for (const l of [shadowLayer, glowLayer]) if (l) ctx.drawImage(l.canvas, l.x + ox, l.y + oy, l.w, l.h);
  if (softBody) ctx.drawImage(softBody.canvas, r.X + ox, r.Y + oy);
  else {
    ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
    src.draw(ctx);
  }
  ctx.restore();
  return true;
}

/**
 * The shape drawn into `c`, a sprite of the device rect `r`: soft-edged, cut by its mask. `layered`: `c` holds
 * layers already (the soft edge must not cut them).
 */
function body(
  c: OffscreenCanvasRenderingContext2D,
  src: EffectSource,
  m: Affine,
  s: number,
  r: { X: number; Y: number; W: number; H: number },
  soft: boolean,
  layered: boolean,
  maskKey?: string,
): boolean {
  if (!soft || !layered) {
    // Alone in the sprite: drawn and, soft-edged, cut in place (a copy of a 4K sprite costs about 17 ms cold).
    c.save();
    c.setTransform(m.a, m.b, m.c, m.d, m.e - r.X, m.f - r.Y);
    src.draw(c);
    c.restore();
    if (soft) {
      c.save();
      c.setTransform(m.a, m.b, m.c, m.d, m.e - r.X, m.f - r.Y);
      softened(c, src, m, s, r, maskKey);
      c.restore();
    }
    return true;
  }
  // The soft edge multiplies what the sprite holds: drawn alone first, as the sprite has layers in it.
  const alone = sprite(r.W, r.H);
  if (!alone) return false;
  alone.setTransform(m.a, m.b, m.c, m.d, m.e - r.X, m.f - r.Y);
  src.draw(alone);
  softened(alone, src, m, s, r, maskKey);
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.drawImage(alone.canvas, 0, 0);
  c.restore();
  return true;
}

/**
 * Multiplies the alpha of what `c` holds (the shape, drawn under its transform) by the soft edge's mask: the
 * silhouette shrunk by `softEdge` and blurred by it, made at a reduced resolution. `r` is the device rect `c`
 * covers (undefined: `c` is a reduced blur sprite, whose own transform maps box space). With `maskKey` the
 * reduced mask is cached under it (a body sprite of `r` under `m`: what the key names).
 */
function softened(
  c: OffscreenCanvasRenderingContext2D,
  src: EffectSource,
  m: Affine,
  s: number,
  r?: { X: number; Y: number; W: number; H: number },
  maskKey?: string,
): void {
  const e = src.softEdge ?? 0;
  if (!(e > 0)) return;
  const t = c.getTransform();
  const W = c.canvas.width;
  const H = c.canvas.height;
  // The device px per sprite px of `c`: 1 for the body, k for a reduced layer.
  const k = r ? 1 : Math.hypot(m.a, m.b) / Math.max(1e-12, Math.hypot(t.a, t.b));
  const sigma = (e * STACK_BLUR_SIGMA * s) / k;
  // Reduced as a blur layer is: by σ/2 (at most BLUR_MAX_REDUCTION), and more for a mask past BLUR_MAX_PIXELS
  // (a 1 px soft edge on a full-slide shape at 4K made four 8 MP canvases).
  let q = Math.min(BLUR_MAX_REDUCTION, Math.max(1, sigma / 2));
  q = Math.max(q, Math.sqrt((W * H) / BLUR_MAX_PIXELS));
  const w = Math.max(1, Math.ceil(W / q));
  const h = Math.max(1, Math.ceil(H / q));
  let made = cached(maskKey);
  if (!made || made.canvas.width !== w || made.canvas.height !== h) {
    const mask = sprite(w, h);
    const blurred = sprite(w, h);
    if (!mask || !blurred) return;
    mask.setTransform(t.a / q, t.b / q, t.c / q, t.d / q, t.e / q, t.f / q);
    eroded(mask, src, e);
    shadowOnly(blurred, mask.canvas, '#000', sigma / q);
    made = { canvas: blurred.canvas, x: 0, y: 0, w, h, bytes: w * h * 4 };
    remember(maskKey, made);
  }
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'low';
  c.drawImage(made.canvas, 0, 0, w * q, h * q);
  c.restore();
}

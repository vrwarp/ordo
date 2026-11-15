import {
  DECOR_LIMITS,
  type DecorData,
  type DecorPaint,
  type DecorPart,
  type Shadow,
  type ShapeObject,
} from '@ordo/domain';
import { parsePathData } from '@ordo/domain/pathdata.ts';
import { CLAMP, num } from '../clamp.ts';
import type { Ctx2D } from '../ctx.ts';
import { digest } from '../digest.ts';
import { BLUR_MAX_REDUCTION, drawEffected, STACK_BLUR_SIGMA } from '../effects.ts';
import { type Bounds, outlineReach, placedBounds } from '../geom/bounds.ts';
import { drawCost, effectArea, fillPaintOf } from '../geom/cost.ts';
import {
  drawGeom,
  type GeomFill,
  type GeomSpacePaint,
  type GeomStroke,
  type GeomStyle,
  geomFillPath2D,
  geomPath2D,
} from '../geom/draw.ts';
import { type Outline, outlineOf, SHAPE_MITER_LIMIT } from '../geom/outline.ts';
import { gradientStyle } from '../geom/paint.ts';
import {
  CMD_CLOSE,
  CMD_CUBIC,
  CMD_LINE,
  CMD_MOVE,
  CMD_QUAD,
  PATH_FILLS,
  type PathFill,
} from '../geom/ops.ts';
import type { BuiltGeom, GeomPath } from '../geom/path.ts';
import { clampShapeObject, placeBox } from '../shape.ts';
import { spriteCache } from '../spritecache.ts';
import { clampDecorData, parsedPart } from './clamp.ts';
import { decorFilesVersion, decorParts, decorPending } from './files.ts';

/*
 * Decorations (design/27 §15 M9, `ShapeObject.decor`; budget-decorations.md §3.3; decor-render): a z-run of
 * plain PowerPoint shapes the converter wrote as one locked object, drawn exactly as the separate shapes are
 * drawn (`drawGeomShape`), shape after shape in z-order:
 *
 * - **Source shapes.** Parts from one `s: 1` to the next are one shape (a part whose paint differs starts one
 *   too); a `cont` part is joined to the path before it (one path stored in pieces: one even-odd fill, holes
 *   and all), any other part is a path of its own with its own fill mode and stroke flag, as a preset's paths
 *   are. Each is built in the decoration's own `w` x `h` space, which `placeBox` and a scale map onto the box.
 * - **Paint.** A colour, or a gradient laid over the shape's own frame (`DecorPart.frame`: x, y, w, h and
 *   rotation in the decoration's space; its flips are folded into the gradient by the converter), as
 *   `drawGeomShape` lays a shape's gradient over its box; an outline with its dash (the thinnest dashed one
 *   0.5 px, as `clamp.ts` draws one), miter joins (limit 8) and flat caps: `DecorPaint` has no others.
 * - **Shadow.** Each shadowed shape is drawn through `drawEffected` with its own geometry and paint, its own
 *   sprites keyed by its paths and paint (small, as separate shapes have), shadow under the shape. The
 *   converter closes a run at `DECOR_LIMITS.shadowed` (24) shadowed shapes; a decoration it did not write that
 *   holds more draws the later ones without their shadows (the clamp's bound on a hostile file's work).
 * - **Opacity** applies to each shape, as each separate shape drew at it.
 * - **Sprite.** A decoration of more than `DECOR_SPRITE.points` points or more than `DECOR_SPRITE.shadowed`
 *   shadowed shapes, drawn a second time at the same device transform, is drawn into a sprite of its device
 *   bounds (cut to the canvas) and copied 1:1 from then on (`spritecache.ts` kind 'decor'; its first draw is
 *   direct, so a slide drawn once pays nothing for it), keyed by a digest of the clamped decoration and the
 *   device transform with its whole pixels taken out: a layout's decorations repeat on every slide, and a
 *   slide is drawn again for every look and refresh. None larger than a 4K frame; none while `withDirectDecor`
 *   runs (a caller that cuts its work into slices, `drawDecorRange`, which a sprite made at once would not);
 *   none the cache would not keep (`SpriteCache.room`: beside the sprites the slide's raster holds already, and
 *   within `DECOR_SPRITE.share` of the budget for all decorations, other slides' oldest decoration sprites
 *   evicted to make room, `SpriteCache.fitKind`): such a decoration is drawn directly, so a
 *   slide whose sprites pass the cache (a 4K slide of four large decorations and 220 shadowed shapes) never
 *   makes, on every draw, sprites the cache then drops (r2a repair: 208 ms a warm draw at 3840, now 20-30).
 * - **Files.** `ref` names a decoration file (`DecorFile`, stored as a geometry file is; read into the store of
 *   `files.ts` before the slide is drawn); while it is read its parts are drawn and `parts` is ignored; until
 *   then the decoration draws its inline parts (the converter leaves them empty: nothing).
 * - **Time.** One decoration is drawn in one call: at its caps (16,384 points, 24 shadowed shapes) about
 *   100 ms cold at 3840 on a shared 4-CPU machine, past design/27 §13's 50 ms task, until the outputs' effect
 *   units draw it in slices of `drawDecorRange` (design/27 §13, an open must item before release).
 *
 * `index.ts` registers `drawDecor` as the 'decor' drawer of the shape dispatch (`shape.ts`).
 */

// ── The full clamp ──────────────────────────────────────────────────────────────────────────────────────

const full = new WeakMap<object, DecorData | null>();

/**
 * A shape's decoration as drawn: the render plan's clamp only re-validated it against the schema
 * (`clamp/decor.ts`); the drawer reads it field by field (`clamp.ts` `clampDecorData`), once per decoration.
 * Undefined: nothing drawable (the shape draws nothing, as its legacy line does).
 */
function drawnDecor(o: ShapeObject): DecorData | undefined {
  const d = o.decor;
  if (!d || typeof d !== 'object') return undefined;
  let c = full.get(d);
  if (c === undefined) full.set(d, (c = clampDecorData(d) ?? null));
  return c ?? undefined;
}

// ── Source shapes ────────────────────────────────────────────────────────────────────────────────────────

/** A decoration's sprite thresholds (budget-decorations.md §3.3 "Layer sprite"). */
export const DECOR_SPRITE = {
  /** Points of all parts past which the decoration is drawn once into a sprite. */
  points: 2_048,
  /** Shadowed shapes past which it is. */
  shadowed: 4,
  /** Device pixels of a sprite at most: one 4K frame. */
  pixels: 3840 * 2160,
  /** The share of the sprite cache's budget the decorations' sprites hold at most. */
  share: 0.5,
} as const;

/** One source shape of a decoration, built in its space. */
export interface DecorShape {
  readonly built: BuiltGeom;
  readonly paint: DecorPaint;
  /** The paint's shadow, unless past `DECOR_LIMITS.shadowed` shadowed shapes. */
  readonly shadow?: Shadow;
  /** The gradient frame (x, y, w, h, rotation in the decoration's space). */
  readonly frame?: readonly [number, number, number, number, number];
  readonly outline?: Outline;
  /** What it draws in the decoration's space, its outline included (`shapeBounds`). */
  readonly bounds: Bounds;
  readonly points: number;
  /** The parts' strings, for its effect sprites' key (made when first needed). */
  readonly source: string;
}

/** A decoration as built: its shapes and what they hold. */
export interface DecorGeometry {
  readonly shapes: readonly DecorShape[];
  readonly points: number;
  readonly shadowed: number;
  /** The union of the shapes' bounds (decoration space), shadows not included; undefined: nothing. */
  readonly bounds: Bounds | undefined;
}

const geometries = new WeakMap<DecorData, { version: number; geo: DecorGeometry }>();

/** Points of a built path as the clamp counts them (M L Z 1, Q 2, C 3). */
function pointsOf(p: GeomPath): number {
  let n = 0;
  for (const c of p.cmds) n += c === CMD_CUBIC ? 3 : c === CMD_QUAD ? 2 : 1;
  return n;
}

const CMD_OF: Readonly<Record<string, number>> = {
  M: CMD_MOVE,
  L: CMD_LINE,
  Q: CMD_QUAD,
  C: CMD_CUBIC,
  Z: CMD_CLOSE,
};

/**
 * A part's path in the decoration's space, from what the clamp read of its string (else read here, as
 * `geom/built.ts` `storedPath` reads a stored path), with its fill mode and stroke flag.
 */
function partPath(part: DecorPart): GeomPath {
  const parsed = parsedPart(part) ?? parsePathData(part.d);
  const cmds: number[] = [];
  for (const c of parsed.cmds) cmds.push(CMD_OF[c]!);
  const fill: PathFill = PATH_FILLS.includes(part.fill as PathFill) ? (part.fill as PathFill) : 'norm';
  return { cmds, pts: parsed.pts.slice(), fill, stroke: part.stroke !== false };
}

/**
 * What one source shape draws in the decoration's space: its points (control points included) grown by its
 * outline's joins and caps (`outlineReach`). Not `drawnBounds`, which unites a geometry with its box: every
 * shape of a decoration is built in the decoration's whole box, and its shadow's layers must be made over the
 * shape alone (24 full-slide blurs took a second at 4K).
 */
function shapeBounds(built: BuiltGeom, o: Outline | undefined): Bounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of built.paths)
    for (let i = 0; i + 1 < p.pts.length; i += 2) {
      const x = p.pts[i]!;
      const y = p.pts[i + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (!(x1 >= x0 && y1 >= y0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  const grow = outlineReach(built, o, false);
  return { x0: x0 - grow, y0: y0 - grow, x1: x1 + grow, y1: y1 + grow };
}

/** An outline as a decoration's paint draws it: miter joins, flat caps, a dashed one at least 0.5 px wide. */
function outlineOfPaint(paint: DecorPaint): Outline | undefined {
  const s = paint.stroke;
  if (!s || !(s.width > 0)) return undefined;
  const dashed = paint.dash !== undefined && paint.dash !== 'solid';
  const width = dashed && s.width < 0.5 ? 0.5 : s.width;
  return outlineOf({ stroke: s, ...(dashed ? { dash: paint.dash } : {}) }, width);
}

/**
 * The source shapes of a clamped decoration (see the header), memoised per decoration and files read. The
 * decoration's own parts, or its read file's.
 */
export function decorShapes(d: DecorData): DecorGeometry {
  const version = decorFilesVersion();
  const hit = geometries.get(d);
  if (hit && (hit.version === version || d.ref === undefined)) return hit.geo;
  const parts = decorParts(d);
  const w = d.w;
  const h = d.h;
  const shapes: DecorShape[] = [];
  let points = 0;
  let shadowed = 0;
  let bounds: Bounds | undefined;
  let cur: { paths: GeomPath[]; p: number; frame?: DecorPart['frame']; source: string[] } | undefined;
  const flush = () => {
    if (!cur?.paths.length) return;
    const paint = d.paints[cur.p] ?? {};
    const outline = outlineOfPaint(paint);
    if (!paint.fill && !paint.gradient && !outline) return;
    const built: BuiltGeom = { w, h, paths: cur.paths, text: { l: 0, t: 0, r: w, b: h }, sites: [] };
    const b = shapeBounds(built, outline);
    let n = 0;
    for (const p of cur.paths) n += pointsOf(p);
    points += n;
    const sh = paint.shadow && paint.shadow.color.a > 0 && shadowed < DECOR_LIMITS.shadowed;
    if (sh) shadowed++;
    if (Number.isFinite(b.x0 + b.y0 + b.x1 + b.y1))
      bounds = bounds
        ? {
            x0: Math.min(bounds.x0, b.x0),
            y0: Math.min(bounds.y0, b.y0),
            x1: Math.max(bounds.x1, b.x1),
            y1: Math.max(bounds.y1, b.y1),
          }
        : b;
    shapes.push({
      built,
      paint,
      ...(sh ? { shadow: paint.shadow } : {}),
      ...(cur.frame ? { frame: cur.frame } : {}),
      ...(outline ? { outline } : {}),
      bounds: b,
      points: n,
      source: cur.source.join('|'),
    });
  };
  for (const part of parts) {
    if (part.p >= d.paints.length) continue;
    if (part.s === 1 || !cur || part.p !== cur.p) {
      flush();
      cur = { paths: [], p: part.p, source: [] };
    }
    const path = partPath(part);
    if (!path.cmds.length) continue;
    const prev = cur.paths[cur.paths.length - 1];
    if (part.cont === true && prev)
      cur.paths[cur.paths.length - 1] = {
        ...prev,
        cmds: prev.cmds.concat(path.cmds),
        pts: prev.pts.concat(path.pts),
      };
    else cur.paths.push(path);
    if (!cur.frame && part.frame) cur.frame = part.frame;
    cur.source.push(part.d);
  }
  flush();
  const geo: DecorGeometry = { shapes, points, shadowed, bounds };
  geometries.set(d, { version, geo });
  return geo;
}

// ── Paint ────────────────────────────────────────────────────────────────────────────────────────────────

type Affine = [number, number, number, number, number, number];

/** `p` after `t`: the affine mapping a point by `t` first. */
function compose(p: Affine, t: readonly number[]): Affine {
  return [
    p[0] * t[0]! + p[2] * t[1]!,
    p[1] * t[0]! + p[3] * t[1]!,
    p[0] * t[2]! + p[2] * t[3]!,
    p[1] * t[2]! + p[3] * t[3]!,
    p[0] * t[4]! + p[2] * t[5]! + p[4],
    p[1] * t[4]! + p[3] * t[5]! + p[5],
  ];
}

const isSpacePaint = (v: GeomStyle | GeomSpacePaint): v is GeomSpacePaint =>
  typeof v === 'object' && v !== null && 'transform' in v && 'style' in v;

/**
 * A shape's fill on `ctx`: its colour, or its gradient laid over its frame (the box `drawGeomShape` would lay
 * it over: [0, w] x [0, h] turned about its centre and moved to x, y), one style per brightness.
 */
function fillOf(ctx: Ctx2D, s: DecorShape, w: number, h: number): GeomFill | null {
  const g = s.paint.gradient;
  if (!g) return s.paint.fill ?? null;
  const [fx, fy, fw, fh, rot] = s.frame ?? [0, 0, w, h, 0];
  const styles = new Map<number, GeomStyle | GeomSpacePaint>();
  return (brightness: number) => {
    let st = styles.get(brightness);
    if (st) return st;
    if (!rot && g.kind !== 'radial') {
      // A linear gradient moved to the frame: built there (gradientStyle's offsets), as exact as the shape's.
      st = gradientStyle(ctx, g, fw, fh, brightness, { x0: fx, y0: fy });
    } else if (!rot && Math.abs(fw - fh) <= 1e-9 * Math.max(fw, fh)) {
      // A radial one over a square frame: a circle, built there.
      st = gradientStyle(ctx, g, fw, fh, brightness, { x0: fx, y0: fy });
    } else {
      const a = (rot * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const place: Affine = [
        cos,
        sin,
        -sin,
        cos,
        fx + fw / 2 - (cos * fw) / 2 + (sin * fh) / 2,
        fy + fh / 2 - (sin * fw) / 2 - (cos * fh) / 2,
      ];
      const own = gradientStyle(ctx, g, fw, fh, brightness);
      st = isSpacePaint(own)
        ? { style: own.style, transform: compose(place, own.transform) }
        : { style: own, transform: place };
    }
    styles.set(brightness, st);
    return st;
  };
}

function strokeOf(s: DecorShape): GeomStroke | null {
  const o = s.outline;
  if (!o || !s.paint.stroke) return null;
  return { color: s.paint.stroke.color, width: o.width, ...(o.dash ? { dash: o.dash } : {}) };
}

/** The joins and caps a decoration draws with (`DecorPaint` has none of its own). */
function styleLines(c: Ctx2D): void {
  c.lineJoin = 'miter';
  c.miterLimit = SHAPE_MITER_LIMIT;
  c.lineCap = 'butt';
}

const shapeKeys = new WeakMap<DecorShape, string>();

/** A digest of what a source shape draws (its paths and paint), for its effect sprites. */
function shapeKey(s: DecorShape, d: DecorData): string {
  let k = shapeKeys.get(s);
  if (k === undefined) {
    k = `decor|${digest(`${d.w} ${d.h}|${JSON.stringify(s.paint)}|${JSON.stringify(s.frame ?? null)}|${s.source}`)}`;
    shapeKeys.set(s, k);
  }
  return k;
}

const fillPaths = new WeakMap<DecorShape, Path2D>();
const strokePaths = new WeakMap<DecorShape, Path2D[]>();

/** Draws one source shape under the context's transform (the decoration's space), at `opacity`. */
function drawDecorShape(ctx: Ctx2D, s: DecorShape, d: DecorData, opacity: number, base: number): void {
  const fill = fillOf(ctx, s, d.w, d.h);
  const stroke = strokeOf(s);
  if (!fill && !stroke) return;
  if (s.shadow && typeof ctx.getTransform === 'function') {
    ctx.globalAlpha = base;
    const m = ctx.getTransform();
    const device = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    const drawn = drawEffected(
      ctx,
      {
        transform: m,
        scale: device,
        bounds: s.bounds,
        draw: (c) => {
          styleLines(c);
          drawGeom(c, s.built, fill, stroke);
        },
        get fill() {
          if (!fill) return undefined;
          let p = fillPaths.get(s);
          if (!p) fillPaths.set(s, (p = geomFillPath2D(s.built)));
          return p;
        },
        get strokes() {
          if (!stroke) return undefined;
          let p = strokePaths.get(s);
          if (!p) strokePaths.set(s, (p = s.built.paths.filter((x) => x.stroke).map(geomPath2D)));
          return p;
        },
        lineWidth: stroke?.width ?? 0,
        join: 'miter',
        cap: 'butt',
        shadow: s.shadow,
        // A decoration still waiting for its file is not cached under the key it will draw with.
        key: decorPending(d) ? undefined : shapeKey(s, d),
      },
      opacity,
    );
    if (drawn) return;
  }
  ctx.globalAlpha = base * opacity;
  styleLines(ctx);
  drawGeom(ctx, s.built, fill, stroke);
}

// ── Drawing ──────────────────────────────────────────────────────────────────────────────────────────────

/** Depth of `withDirectDecor` calls running: no decoration sprite is made or used while it is above 0. */
let direct = 0;

/**
 * Runs `fn` with decorations drawn shape by shape, never through their sprites: a caller that cuts its work
 * into slices (the outputs' effect units) or measures the drawing itself (goldens, the equivalence check), which
 * a sprite of the whole decoration made at once would not.
 */
export function withDirectDecor<T>(fn: () => T): T {
  direct++;
  try {
    return fn();
  } finally {
    direct--;
  }
}

const decorDigests = new WeakMap<DecorData, string>();

function decorDigest(d: DecorData): string {
  let k = decorDigests.get(d);
  if (k === undefined) {
    k = digest(JSON.stringify(d));
    decorDigests.set(d, k);
  }
  return k;
}

/** A device-px rect from a decoration-space bounds under `m` (its corners), whole pixels outward. */
function deviceRect(m: DOMMatrix, b: Bounds, grow: number) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x0, b.y1],
    [b.x1, b.y1],
  ] as const) {
    const X = m.a * x + m.c * y + m.e;
    const Y = m.b * x + m.d * y + m.f;
    x0 = Math.min(x0, X);
    y0 = Math.min(y0, Y);
    x1 = Math.max(x1, X);
    y1 = Math.max(y1, Y);
  }
  return { x0: x0 - grow, y0: y0 - grow, x1: x1 + grow, y1: y1 + grow };
}

/** Device px a shape's shadow reaches past its drawing (`drawEffected`'s region, its enlarged last pixel). */
function shadowReach(s: DecorShape, device: number): { dx: number; dy: number; r: number } {
  const sh = s.shadow;
  if (!sh) return { dx: 0, dy: 0, r: 0 };
  return {
    dx: sh.dx * device,
    dy: sh.dy * device,
    r: 3 * sh.blur * STACK_BLUR_SIGMA * device + 2 + BLUR_MAX_REDUCTION,
  };
}

type DecorSprite = { canvas: OffscreenCanvas; bytes: number };

/**
 * Draws through the decoration's sprite (see the header): true when it did (made now or copied), false when
 * it is not drawn that way (too small to need one, too large, no OffscreenCanvas, a non-finite transform).
 */
function drawDecorSprite(ctx: Ctx2D, d: DecorData, geo: DecorGeometry, opacity: number): boolean {
  if (direct > 0 || typeof OffscreenCanvas === 'undefined' || typeof ctx.getTransform !== 'function')
    return false;
  if (!(geo.points > DECOR_SPRITE.points || geo.shadowed > DECOR_SPRITE.shadowed) || !geo.bounds)
    return false;
  if (decorPending(d)) return false;
  const m = ctx.getTransform();
  if (![m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite)) return false;
  const device = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  // What the decoration draws: its shapes, each grown by its shadow's reach, in device px.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of geo.shapes) {
    const r = deviceRect(m, s.bounds, 2);
    const sh = shadowReach(s, device);
    x0 = Math.min(x0, r.x0, r.x0 + sh.dx - sh.r);
    y0 = Math.min(y0, r.y0, r.y0 + sh.dy - sh.r);
    x1 = Math.max(x1, r.x1, r.x1 + sh.dx + sh.r);
    y1 = Math.max(y1, r.y1, r.y1 + sh.dy + sh.r);
  }
  const canvas = ctx.canvas as { width?: number; height?: number } | undefined;
  const cw = canvas?.width ?? 0;
  const ch = canvas?.height ?? 0;
  if (cw > 0 && ch > 0) {
    x0 = Math.max(x0, 0);
    y0 = Math.max(y0, 0);
    x1 = Math.min(x1, cw);
    y1 = Math.min(y1, ch);
  }
  if (!(x1 > x0 && y1 > y0)) return true; // nothing on the canvas
  const X = Math.floor(x0);
  const Y = Math.floor(y0);
  const W = Math.ceil(x1) - X;
  const H = Math.ceil(y1) - Y;
  if (W * H > DECOR_SPRITE.pixels) return false;
  const ox = Math.floor(m.e);
  const oy = Math.floor(m.f);
  const key = `${decorDigest(d)}|${m.a} ${m.b} ${m.c} ${m.d} ${m.e - ox} ${m.f - oy}|${X - ox} ${Y - oy} ${W} ${H}|${opacity}`;
  let sprite = spriteCache.get('decor', key) as DecorSprite | undefined;
  if (!sprite) {
    // Made the second time the decoration is drawn so (a slide drawn once, the common case, pays no sprite):
    // the cache's mark says it was drawn (its own small LRU, cleared with the decorations' sprites).
    if (!spriteCache.marked('decor', key)) {
      spriteCache.mark('decor', key);
      return false;
    }
    // Never made only to be dropped: a sprite the cache would not keep beside what this raster holds (or past
    // the decorations' share) would cost its drawing and a copy on every draw, more than drawing it directly.
    // The share counts this raster's decorations and evicts other slides' oldest to make room (`fitKind`): an
    // earlier slide's decorations never keep this one's from their sprites for good.
    const bytes = W * H * 4;
    if (!spriteCache.room(bytes)) return false;
    if (!spriteCache.fitKind('decor', bytes, DECOR_SPRITE.share * spriteCache.budgetBytes)) return false;
    const c = new OffscreenCanvas(W, H);
    // Software-backed, as the effect sprites are: copied to a software canvas, drawn by the CPU.
    const s2 = c.getContext('2d', { willReadFrequently: true });
    if (!s2) return false;
    s2.setTransform(m.a, m.b, m.c, m.d, m.e - X, m.f - Y);
    styleLines(s2 as unknown as Ctx2D);
    for (const s of geo.shapes) drawDecorShape(s2 as unknown as Ctx2D, s, d, opacity, 1);
    sprite = { canvas: c, bytes };
    if (spriteCache.set('decor', key, sprite)) spriteCache.unmark('decor', key);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(sprite.canvas, X, Y);
  ctx.restore();
  return true;
}

/**
 * Draws a clamped shape's decoration at `scale` device px per logical px (the shape dispatch's 'decor'
 * drawer, see the header). True: drawn (a decoration with nothing to draw draws nothing, as its legacy line
 * without a stroke would); false only without a decoration.
 */
export function drawDecor(ctx: Ctx2D, o: ShapeObject, scale: number): boolean {
  return drawDecorShapes(ctx, o, scale, 0, Number.POSITIVE_INFINITY, true);
}

/** The source shapes a shape's decoration draws (`decorShapes`), 0 without one: what `drawDecorRange` counts. */
export function decorShapeCount(raw: ShapeObject): number {
  const d = drawnDecor(clampShapeObject(raw));
  return d ? decorShapes(d).shapes.length : 0;
}

/**
 * Draws source shapes `from` to `to` (excluded) of a shape's decoration, shape by shape, never through its
 * sprite: what a caller that draws a decoration in pieces, one turn each (the outputs' effect units), draws;
 * the ranges drawn in order on one canvas give the pixels of the whole decoration drawn at once.
 */
export function drawDecorRange(ctx: Ctx2D, raw: ShapeObject, scale: number, from: number, to: number): void {
  drawDecorShapes(ctx, clampShapeObject(raw), scale, from, to, false);
}

function drawDecorShapes(
  ctx: Ctx2D,
  o: ShapeObject,
  scale: number,
  from: number,
  to: number,
  sprite: boolean,
): boolean {
  if (!o.decor) return false;
  const d = drawnDecor(o);
  if (!d) return true;
  const opacity = num(o.opacity, 0, 1, 1);
  if (opacity <= 0) return true;
  const geo = decorShapes(d);
  if (!geo.shapes.length) return true;
  const s = num(scale, 0.01, 8, 1);
  const kx = o.box.w > 0 ? o.box.w / d.w : 0;
  const ky = o.box.h > 0 ? o.box.h / d.h : 0;
  if (!(kx > 0 && ky > 0) || !Number.isFinite(kx * ky)) return true;
  ctx.save();
  placeBox(ctx, o.box, s, o.flipH === true, o.flipV === true);
  ctx.scale(kx, ky);
  const base = ctx.globalAlpha;
  if (!sprite || !drawDecorSprite(ctx, d, geo, opacity)) {
    styleLines(ctx);
    const end = Math.min(to, geo.shapes.length);
    for (let i = Math.max(0, from); i < end; i++) drawDecorShape(ctx, geo.shapes[i]!, d, opacity, base);
  }
  ctx.restore();
  return true;
}

// ── Cost ─────────────────────────────────────────────────────────────────────────────────────────────────

const costs = new WeakMap<DecorData, { version: number; est: number; effects: number }>();

/**
 * What a decoration costs to draw (the units of `geom/cost.ts` `drawCost` for each shape, its shadow pass
 * included) and its shadow layers' weighted area in slide areas (`effectArea`), as its shapes drawn one by one
 * would cost: the effect units' and health's estimate of it. Memoised per clamped decoration and files read.
 */
export function decorCost(raw: ShapeObject): { est: number; effects: number } {
  const o = clampShapeObject(raw);
  const d = drawnDecor(o);
  if (!d) return { est: 0, effects: 0 };
  const hit = costs.get(d);
  if (hit && hit.version === decorFilesVersion()) return hit;
  const geo = decorShapes(d);
  const kx = o.box.w > 0 ? o.box.w / d.w : 1;
  const ky = o.box.h > 0 ? o.box.h / d.h : 1;
  const same = Math.abs(kx - 1) < 1e-6 && Math.abs(ky - 1) < 1e-6;
  const translucent = num(o.opacity, 0, 1, 1) < 1;
  let est = 0;
  let effects = 0;
  for (const s of geo.shapes) {
    const paint = fillPaintOf({
      type: 'shape',
      opacity: translucent ? 0.5 : 1,
      ...(s.paint.fill ? { fill: s.paint.fill } : {}),
      ...(s.paint.gradient ? { gradient: s.paint.gradient } : {}),
    });
    est += drawCost(s.built, {
      fill: !!(s.paint.fill || s.paint.gradient),
      paint,
      outline: s.outline,
      ...(same ? { place: { box: o.box, flipH: o.flipH === true, flipV: o.flipV === true } } : {}),
      shadow: !!s.shadow,
      ...(s.shadow ? { shadowBlur: s.shadow.blur } : {}),
    });
    if (s.shadow)
      effects += effectArea(
        { box: { x: o.box.x, y: o.box.y, w: d.w, h: d.h, rotation: o.box.rotation }, shadow: s.shadow },
        s.bounds,
      );
  }
  const out = { version: decorFilesVersion(), est, effects };
  costs.set(d, out);
  return out;
}

/** Device px a blurred layer reaches past what its blur covers (`drawEffected`: its region's 2 px, the enlarged last pixel). */
const BLUR_SLACK_PX = 2 + BLUR_MAX_REDUCTION;
/** The smallest output scale the reach's slack covers in logical px (a 960-px-wide view); smaller ones rely on the edge check. */
const REACH_MIN_SCALE = 0.5;

/**
 * Where a clamped shape's decoration draws on the slide (logical px, slide space), its shapes' shadows included:
 * the shapes' bounds (`decorShapes`: their points grown by their outlines) scaled into the box and placed with
 * its flips and rotation, united with each shadowed shape's bounds moved by its offset and grown by 3σ of its
 * blur (σ = blur/√6), as `drawEffected` sizes the layer, both in device px of the decoration's own scale (a
 * box stretched from the decoration's space stretches its shadows by the root of its area's scale), grown by a
 * blurred layer's slack at a 960-px-wide view and a pixel of anti-aliasing. The `ShapeReach` of the 'decor'
 * drawer: tight sprites (design/27 §7.3), and where an effect unit of it is made. Undefined when the shape has
 * no decoration (it falls to its legacy line); an empty rect when the decoration draws nothing; null (the
 * layer full-frame) when its bounds are not finite.
 */
export function decorReach(
  raw: ShapeObject,
): { x: number; y: number; w: number; h: number } | null | undefined {
  const o = clampShapeObject(raw);
  if (!o.decor) return undefined;
  const empty = { x: o.box.x, y: o.box.y, w: 0, h: 0 };
  const d = drawnDecor(o);
  if (!d) return empty;
  if (num(o.opacity, 0, 1, 1) <= 0) return empty;
  const geo = decorShapes(d);
  if (!geo.bounds) return empty;
  const kx = o.box.w > 0 ? o.box.w / d.w : 0;
  const ky = o.box.h > 0 ? o.box.h / d.h : 0;
  if (!(kx > 0 && ky > 0) || !Number.isFinite(kx * ky)) return empty;
  const k = Math.sqrt(kx * ky);
  const place = { box: o.box, flipH: o.flipH === true, flipV: o.flipV === true };
  const scaled = (b: Bounds): Bounds => ({ x0: b.x0 * kx, y0: b.y0 * ky, x1: b.x1 * kx, y1: b.y1 * ky });
  let { x0, y0, x1, y1 } = placedBounds(scaled(geo.bounds), place);
  const slack = BLUR_SLACK_PX / REACH_MIN_SCALE;
  for (const s of geo.shapes) {
    const sh = s.shadow;
    if (!sh || !(sh.color.a > 0)) continue;
    const b = placedBounds(scaled(s.bounds), place);
    const dx = num(sh.dx, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0) * k;
    const dy = num(sh.dy, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0) * k;
    const r = 3 * num(sh.blur, 0, CLAMP.maxEffectPx, 0) * STACK_BLUR_SIGMA * k + slack;
    x0 = Math.min(x0, b.x0 + dx - r);
    y0 = Math.min(y0, b.y0 + dy - r);
    x1 = Math.max(x1, b.x1 + dx + r);
    y1 = Math.max(y1, b.y1 + dy + r);
  }
  if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1)))
    return null;
  return { x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 };
}

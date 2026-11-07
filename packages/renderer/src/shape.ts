import type { Box, ShapeObject } from '@ordo/domain';

import { CLAMP, clampObject, isClamped, num } from './clamp.ts';
import type { Ctx2D } from './ctx.ts';
import { digest } from './digest.ts';
import { type Bounds, drawEffected } from './effects.ts';
import { drawGeom, type GeomFill, type GeomStroke, geomFillPath2D, geomPath2D } from './geom/draw.ts';
import { arrowFor, arrowReach } from './geom/ends.ts';
import { lineStyleOf, outlineOf, SHAPE_MITER_LIMIT } from './geom/outline.ts';
import { gradientStyle } from './geom/paint.ts';
import type { BuiltGeom } from './geom/path.ts';
import { geomAwaited, geomPending, legacyGeometry, storedGeometry } from './geom/stored.ts';

/*
 * PowerPoint shapes (design/27 §3.1 ShapeObject M6 fields, §7.1, §15 M6): a shape with any of `geom`,
 * `gradient`, `dash`, `ends`, `flipH`/`flipV`, `shadow`, `glow` or `softEdge` is drawn here, through the
 * geometry engine (geom/); every other shape keeps `drawShape`'s legacy path, pixel for pixel.
 * - Geometry: the stored preset or paths at the box (geom/stored.ts), else the legacy rect, roundRect,
 *   ellipse or line.
 * - Paint: `gradient` (geom/paint.ts) over `fill`; the outline in `stroke`, with `dash` (prstDash scaled by
 *   the line width, LibreOffice's lclConvertPresetDash) and `ends` (geom/ends.ts); `lineJoin` (miter, limit 8:
 *   OOXML's usual `a:miter lim="800000"`, else round or bevel) and `lineCap` (flat, Office's default, else
 *   round or square). A round or square cap is drawn within a preset dash's length as Office draws it:
 *   LibreOffice takes one line width off each dash or dot of at least that length and adds it to the gaps
 *   (lineproperties.cxx), so a round-capped sysDot is a row of round dots.
 * - Placement: box space (0..w, 0..h, logical px) flipped about the box's centre, rotated about it, scaled to
 *   the device.
 * - Effects (effects.ts): shadow, glow and soft edge through sprites, the whole shape at its opacity.
 */

export {
  cappedDash,
  DASH_PATTERNS,
  hasShapeExtras,
  lineStyleOf,
  SHAPE_MITER_LIMIT,
} from './geom/outline.ts';

const clamped = new WeakMap<object, ShapeObject>();

/** `clampObject` of a shape, memoised by identity (a clamped shape maps to itself). */
export function clampShapeObject(o: ShapeObject): ShapeObject {
  // One `clampSlide` made is clamped already (a slide's shapes with inline paths were clamped twice a raster).
  if (isClamped(o) && o.type === 'shape') return o;
  const hit = clamped.get(o);
  if (hit) return hit;
  const out = (clampObject({ ...o, type: 'shape' }) ?? o) as ShapeObject;
  clamped.set(o, out);
  clamped.set(out, out);
  return out;
}

/** A shape's geometry at its box (logical px): the stored geometry, else the legacy shape. */
export function shapeGeometry(o: ShapeObject): BuiltGeom {
  const w = o.box.w;
  const h = o.box.h;
  return storedGeometry(o.geom, w, h) ?? legacyGeometry(o.shape, o.radius ?? 0, w, h);
}

type Plan = {
  built: BuiltGeom;
  fill: GeomFill | null;
  stroke: GeomStroke | null;
  /** Box-space bounds of what is drawn, strokes and markers included. */
  bounds: Bounds;
  /** The effects' silhouettes, built once per plan when an effect layer is first made. */
  fillPath?: Path2D;
  strokePaths?: Path2D[];
};

/** Plans per shape and context; one made while its geometry file was not read is made again once it is. */
const plans = new WeakMap<ShapeObject, { ctx: Ctx2D; plan: Plan; pending: boolean }>();

function planOf(ctx: Ctx2D, o: ShapeObject): Plan {
  const hit = plans.get(o);
  if (hit && hit.ctx === ctx && !(hit.pending && !geomPending(o.geom))) return hit.plan;
  const built = shapeGeometry(o);
  const line = o.shape === 'line' && !o.geom;
  const g = o.gradient;
  let fill: GeomFill | null = null;
  if (!line) {
    if (g) {
      const styles = new Map<number, ReturnType<typeof gradientStyle>>();
      fill = (brightness: number) => {
        let s = styles.get(brightness);
        if (!s) {
          s = gradientStyle(ctx, g, built.w, built.h, brightness);
          styles.set(brightness, s);
        }
        return s;
      };
    } else if (o.fill) fill = o.fill;
  }
  let stroke: GeomStroke | null = null;
  const outline = o.stroke ? outlineOf(o, num(o.stroke.width, 0, CLAMP.maxEffectPx, 1)) : undefined;
  if (o.stroke && outline)
    stroke = {
      color: o.stroke.color,
      width: outline.width,
      ...(outline.dash ? { dash: outline.dash } : {}),
      ...(outline.ends ? { ends: outline.ends } : {}),
    };
  const bounds = geomBounds(built);
  const grow = stroke
    ? Math.max(
        (stroke.width / 2) * (o.lineJoin === 'round' || o.lineJoin === 'bevel' ? 1.5 : SHAPE_MITER_LIMIT),
        arrowReach(stroke.ends?.head),
        arrowReach(stroke.ends?.tail),
      )
    : 0;
  bounds.x0 -= grow;
  bounds.y0 -= grow;
  bounds.x1 += grow;
  bounds.y1 += grow;
  const plan = { built, fill, stroke, bounds };
  plans.set(o, { ctx, plan, pending: geomPending(o.geom) });
  return plan;
}

/** The bounds of a geometry's points (control points included, so conservative) and its box. */
export function geomBounds(b: BuiltGeom): Bounds {
  let x0 = 0;
  let y0 = 0;
  let x1 = b.w;
  let y1 = b.h;
  for (const p of b.paths)
    for (let i = 0; i < p.pts.length; i += 2) {
      const x = p.pts[i]!;
      const y = p.pts[i + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return { x0, y0, x1, y1 };
}

/**
 * How far a shape's geometry and arrowheads reach past its box (logical px, conservative): the geometry's
 * points outside the box (control points included), plus the arrowheads' size.
 */
export function shapeReach(o: ShapeObject, built: BuiltGeom): number {
  const b = geomBounds(built);
  let m = Math.max(0, -b.x0, -b.y0, b.x1 - built.w, b.y1 - built.h);
  const lw = o.stroke ? num(o.stroke.width, 0, CLAMP.maxEffectPx, 1) : 0;
  if (o.ends && lw > 0)
    m += Math.max(
      arrowReach(arrowFor(o.ends.head?.type, o.ends.head?.w, o.ends.head?.len, lw)),
      arrowReach(arrowFor(o.ends.tail?.type, o.ends.tail?.w, o.ends.tail?.len, lw)),
    );
  return Number.isFinite(m) ? Math.min(m, 1e6) : 0;
}

/**
 * Maps box space (0..w, 0..h, logical px) onto the context: flipped about the box's centre, rotated about it,
 * at `scale` device px per logical px (composed with the context's transform).
 */
export function placeBox(ctx: Ctx2D, box: Box, scale: number, flipH = false, flipV = false): void {
  ctx.translate((box.x + box.w / 2) * scale, (box.y + box.h / 2) * scale);
  if (box.rotation) ctx.rotate((box.rotation * Math.PI) / 180);
  ctx.scale(scale * (flipH ? -1 : 1), scale * (flipV ? -1 : 1));
  ctx.translate(-box.w / 2, -box.h / 2);
}

function styleLines(c: Ctx2D, o: ShapeObject): void {
  const { join, cap } = lineStyleOf(o);
  c.lineJoin = join;
  c.miterLimit = SHAPE_MITER_LIMIT;
  c.lineCap = cap;
}

const keys = new WeakMap<ShapeObject, string | undefined>();

/** A digest of what a shape draws (its JSON without its identity), for the effect sprite cache; memoised. */
function effectKey(o: ShapeObject): string | undefined {
  if (keys.has(o)) return keys.get(o);
  let key: string | undefined;
  try {
    const { id: _id, origin: _origin, locked: _locked, ...rest } = o;
    key = digest(JSON.stringify(rest));
  } catch {
    key = undefined;
  }
  keys.set(o, key);
  return key;
}

/** Draw a shape with M6 fields (`hasShapeExtras`) at `scale` device px per logical px. */
export function drawGeomShape(ctx: Ctx2D, raw: ShapeObject, scale: number): void {
  const o = clampShapeObject(raw);
  // A geometry only in a file not read yet draws nothing until it is (`geomAwaited`).
  if (geomAwaited(o.geom)) return;
  const plan = planOf(ctx, o);
  const opacity = num(o.opacity, 0, 1, 1);
  if ((!plan.fill && !plan.stroke) || opacity <= 0) return;
  const s = num(scale, 0.01, 8, 1);
  ctx.save();
  placeBox(ctx, o.box, s, o.flipH === true, o.flipV === true);
  if ((o.shadow || o.glow || o.softEdge) && typeof ctx.getTransform === 'function') {
    const m = ctx.getTransform();
    const device = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    const drawn = drawEffected(
      ctx,
      {
        transform: m,
        scale: device,
        bounds: plan.bounds,
        draw: (c) => {
          styleLines(c, o);
          drawGeom(c, plan.built, plan.fill, plan.stroke);
        },
        // Built only when a layer is made (a cached layer needs neither), once per plan.
        get fill() {
          if (!plan.fill) return undefined;
          plan.fillPath ??= geomFillPath2D(plan.built);
          return plan.fillPath;
        },
        get strokes() {
          if (!plan.stroke) return undefined;
          plan.strokePaths ??= plan.built.paths.filter((p) => p.stroke).map(geomPath2D);
          return plan.strokePaths;
        },
        lineWidth: plan.stroke?.width ?? 0,
        ...lineStyleOf(o),
        shadow: o.shadow,
        glow: o.glow,
        softEdge: o.softEdge,
        // A shape still waiting for its geometry file is not cached under the key it will draw with.
        key: geomPending(o.geom) ? undefined : effectKey(o),
      },
      opacity,
    );
    if (drawn) {
      ctx.restore();
      return;
    }
  }
  ctx.globalAlpha *= opacity;
  styleLines(ctx, o);
  drawGeom(ctx, plan.built, plan.fill, plan.stroke);
  ctx.restore();
}

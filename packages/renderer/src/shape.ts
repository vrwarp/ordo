import type { Box, ShapeObject } from '@ordo/domain';

import { CLAMP, clampObject, isClamped, num } from './clamp.ts';
import type { Ctx2D } from './ctx.ts';
import { digest } from './digest.ts';
import { drawEffected, type Look3dPlan } from './effects.ts';
import { type Bounds, drawnBounds, geomBounds } from './geom/bounds.ts';
import {
  drawGeom,
  type GeomFill,
  type GeomStroke,
  geomFillPath2D,
  geomPath2D,
  pathOpen,
} from './geom/draw.ts';
import { arrowFor, arrowReach } from './geom/ends.ts';
import { hasShapeExtras, lineStyleOf, outlineOf, SHAPE_MITER_LIMIT } from './geom/outline.ts';
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
 *
 * Draw dispatch (M9 plan decision 10, `drawShapeObject`): a shape is drawn by the first of its `table`, `chart`
 * and `decor` (the clamp keeps one of them, in that order) whose drawer is registered (`registerShapeDrawer`:
 * the table, chart and decoration tracks of M9), else through its geometry (`hasShapeExtras`), else by the
 * legacy path. Until a kind's drawer is registered, such a shape draws what an older build draws once it
 * strips the field (design/27 §3.2): its legacy shape (a table's background rect, a chart's area, a
 * decoration's empty line). A registered 3-D look (`registerLook3d`, three-rim) decorates the geometry path:
 * a shape with `look3d` goes through `drawGeomShape` and hands the effect composite its resolved plan.
 */

export { geomBounds } from './geom/bounds.ts';
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
  // What the effect layers are made over: the geometry grown by its outline's joins, caps and arrowheads
  // (geom/bounds.ts, the same bounds the effect budget sizes them by).
  const bounds = drawnBounds(built, stroke ? outline : undefined);
  const plan = { built, fill, stroke, bounds };
  plans.set(o, { ctx, plan, pending: geomPending(o.geom) });
  return plan;
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

/** The M9 fields a registered drawer draws a shape by, in precedence order (plan decision 10). */
export const SHAPE_DRAW_KINDS = ['table', 'chart', 'decor'] as const;
export type ShapeDrawKind = (typeof SHAPE_DRAW_KINDS)[number];

/**
 * Draws a clamped shape that holds its kind's field (`o.table`, `o.chart` or `o.decor`) at `scale` device px
 * per logical px, under the caller's transform. False: nothing was drawn, and the shape falls to its legacy
 * shape (the drawer's own fallback, for a field it cannot draw yet).
 */
export type ShapeDrawer = (ctx: Ctx2D, o: ShapeObject, scale: number) => boolean;

/**
 * Where a registered drawer draws a clamped shape of its kind (logical px, slide space, effects and rotation
 * included), for the tight sprites (`sprite.ts` `objectReach`): null when that is not known (the layer stays
 * full-frame); undefined when the drawer would not draw it (it falls to its geometry or legacy shape).
 */
export type ShapeReach = (
  ctx: Ctx2D,
  o: ShapeObject,
) => { x: number; y: number; w: number; h: number } | null | undefined;

const drawers = new Map<ShapeDrawKind, ShapeDrawer>();
const reaches = new Map<ShapeDrawKind, ShapeReach>();

/**
 * Register the drawer of one kind (the last one registered wins), with where it draws (`ShapeReach`; a
 * drawer registered without one draws its shapes on a full-frame layer); returns its unregistration.
 */
export function registerShapeDrawer(kind: ShapeDrawKind, draw: ShapeDrawer, reach?: ShapeReach): () => void {
  drawers.set(kind, draw);
  if (reach) reaches.set(kind, reach);
  else reaches.delete(kind);
  return () => {
    if (drawers.get(kind) !== draw) return;
    drawers.delete(kind);
    if (reaches.get(kind) === reach) reaches.delete(kind);
  };
}

/** Whether a drawer of `kind` is registered (its module is loaded). */
export function shapeDrawerRegistered(kind: ShapeDrawKind): boolean {
  return drawers.has(kind);
}

/*
 * Drawers loaded per object kind (M9 bundle budget): a kind's drawer lives in its own module, fetched the first
 * time a slide holds that kind, so pages and workers that never meet a table (most services) never load its
 * code. The renderer's index registers each kind's loader (`registerShapeDrawerLoader`); the workers' slide
 * prepare steps (`apps/output/src/prepare`) and the editor canvas call `loadShapeDrawers` before they draw.
 * Until a kind's module is loaded its shapes draw what an older build draws (the legacy shape, design/27 §3.2).
 */

/** Imports the module that registers a kind's drawer. */
export type ShapeDrawerLoader = () => Promise<unknown>;

const loaders = new Map<ShapeDrawKind, ShapeDrawerLoader>();
const loading = new Map<ShapeDrawKind, Promise<boolean>>();

/** Register how a kind's drawer is loaded (the last one registered wins); returns its unregistration. */
export function registerShapeDrawerLoader(kind: ShapeDrawKind, load: ShapeDrawerLoader): () => void {
  loaders.set(kind, load);
  return () => {
    if (loaders.get(kind) === load) loaders.delete(kind);
  };
}

/**
 * The kinds the objects hold (`table`, `chart`, `decor`) whose drawer is not registered but has a loader: what
 * `loadShapeDrawers` would load. Reads only whether each field is there (a damaged value costs nothing here).
 */
export function shapeDrawersWanted(objects: readonly unknown[]): ShapeDrawKind[] {
  const out: ShapeDrawKind[] = [];
  for (const o of objects) {
    if (!o || typeof o !== 'object' || (o as { type?: unknown }).type !== 'shape') continue;
    for (const kind of SHAPE_DRAW_KINDS)
      if (
        (o as Record<string, unknown>)[kind] !== undefined &&
        !drawers.has(kind) &&
        loaders.has(kind) &&
        !out.includes(kind)
      )
        out.push(kind);
    if (out.length === SHAPE_DRAW_KINDS.length) break;
  }
  return out;
}

/**
 * Load the drawers the objects need (`shapeDrawersWanted`), each module once: resolves true when one was
 * registered by this call (the caller draws again), false when there was nothing to load. A load that fails
 * (offline, a stale chunk) resolves false and is tried again next time; the shapes keep their legacy look.
 */
export async function loadShapeDrawers(objects: readonly unknown[]): Promise<boolean> {
  const kinds = shapeDrawersWanted(objects);
  if (!kinds.length) return false;
  const loads = kinds.map((kind) => {
    let p = loading.get(kind);
    if (!p) {
      const load = loaders.get(kind)!;
      p = load().then(
        () => {
          loading.delete(kind);
          return drawers.has(kind);
        },
        () => {
          loading.delete(kind);
          return false;
        },
      );
      loading.set(kind, p);
    }
    return p;
  });
  return (await Promise.all(loads)).some(Boolean);
}

/**
 * Where a shape's registered drawer draws it (`ShapeReach`): undefined when the shape has no `table`,
 * `chart` or `decor`, when no drawer of its kind is registered, or when the drawer would not draw it (the
 * shape then draws its geometry or legacy shape, and reaches as they do); null when the drawer gave no reach.
 */
export function shapeDrawerReach(
  ctx: Ctx2D,
  o: ShapeObject,
): { x: number; y: number; w: number; h: number } | null | undefined {
  const kind = shapeDrawKind(o);
  if (!kind || !drawers.has(kind)) return undefined;
  const reach = reaches.get(kind);
  return reach ? reach(ctx, clampShapeObject(o)) : null;
}

/**
 * Resolves a shape's 3-D look for the transform it is drawn under (three-rim): the plan the effect composite
 * draws its face, rim and walls from, or undefined to draw it flat. Called only for a shape with `look3d`.
 */
export type Look3dResolver = (o: ShapeObject, m: DOMMatrix, built: BuiltGeom) => Look3dPlan | undefined;

let look3dResolver: Look3dResolver | undefined;

/** Register the 3-D look's resolver (one at a time); returns its unregistration. */
export function registerLook3d(resolve: Look3dResolver): () => void {
  look3dResolver = resolve;
  return () => {
    if (look3dResolver === resolve) look3dResolver = undefined;
  };
}

/** Whether a 3-D look resolver is registered (a shape with `look3d` is then drawn with its rim and walls). */
export function look3dRegistered(): boolean {
  return look3dResolver !== undefined;
}

/** Which kind's field a shape is drawn by (`SHAPE_DRAW_KINDS` order, as clamped), else undefined. */
export function shapeDrawKind(o: ShapeObject): ShapeDrawKind | undefined {
  if (o.table === undefined && o.chart === undefined && o.decor === undefined) return undefined;
  const c = clampShapeObject(o);
  return c.table ? 'table' : c.chart ? 'chart' : c.decor ? 'decor' : undefined;
}

/**
 * Draw a shape object as dispatched (see the header): `table` → `chart` → `decor` → geometry → legacy. True
 * when one of the first four drew it; false leaves it to the legacy path (`drawShape`).
 */
export function drawShapeObject(ctx: Ctx2D, o: ShapeObject, scale: number): boolean {
  const kind = shapeDrawKind(o);
  if (kind) {
    if (drawers.get(kind)?.(ctx, clampShapeObject(o), scale)) return true;
  }
  if (hasShapeExtras(o) || (o.look3d !== undefined && look3dResolver)) {
    drawGeomShape(ctx, o, scale);
    return true;
  }
  return false;
}

/**
 * A shape `drawGeomShape` draws without effects (no shadow, glow, soft edge or 3-D look), as its draw calls, in
 * its order: each path's fill and its closed outline, then the open outlines (`drawGeom`). Each step draws one
 * call under the same transform and state as the whole draw, so the steps drawn in order on one canvas give
 * the very pixels of drawing it at once: what a geometry unit draws one step at a time (units.ts). Empty for a
 * shape whose geometry file is not read yet or that draws nothing.
 */
export function geomShapeSteps(raw: ShapeObject, scale: number): ((ctx: Ctx2D) => void)[] {
  const o = clampShapeObject(raw);
  const opacity = num(o.opacity, 0, 1, 1);
  if (geomAwaited(o.geom) || opacity <= 0) return [];
  const s = num(scale, 0.01, 8, 1);
  const step =
    (at: number, fill: boolean, stroke: boolean) =>
    (ctx: Ctx2D): void => {
      const plan = planOf(ctx, o);
      const path = plan.built.paths[at];
      const f = fill ? plan.fill : null;
      const st = stroke ? plan.stroke : null;
      if (!path || (!f && !st)) return;
      ctx.save();
      placeBox(ctx, o.box, s, o.flipH === true, o.flipV === true);
      ctx.globalAlpha *= opacity;
      styleLines(ctx, o);
      drawGeom(ctx, { ...plan.built, paths: [path] }, f, st);
      ctx.restore();
    };
  const built = shapeGeometry(o);
  const steps: ((ctx: Ctx2D) => void)[] = [];
  const open: number[] = [];
  built.paths.forEach((p, i) => {
    steps.push(step(i, true, false));
    if (!o.stroke) return;
    if (pathOpen(p, built)) open.push(i);
    else steps.push(step(i, false, true));
  });
  for (const i of open) steps.push(step(i, false, true));
  return steps;
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
  const look3d =
    o.look3d && look3dResolver && typeof ctx.getTransform === 'function'
      ? look3dResolver(o, ctx.getTransform(), plan.built)
      : undefined;
  if ((o.shadow || o.glow || o.softEdge || look3d) && typeof ctx.getTransform === 'function') {
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
        ...(look3d ? { look3d } : {}),
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

import type { Box, ShapeObject } from '@ordo/domain';

import { CLAMP, clampObject, isClamped, num } from './clamp.ts';
import type { Ctx2D } from './ctx.ts';
import { digest } from './digest.ts';
import { drawEffected, type EffectSource, type Look3dPlan } from './effects.ts';
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
import { drawCost, fillPaintOf, GEOM_COST } from './geom/cost.ts';
import { CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD } from './geom/ops.ts';
import { hasShapeExtras, lineStyleOf, outlineOf, SHAPE_MITER_LIMIT } from './geom/outline.ts';
import { gradientStyle } from './geom/paint.ts';
import type { BuiltGeom, GeomPath } from './geom/path.ts';
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

/**
 * What effect units (units.ts) and the drawing budget (geombudget.ts) read of a decoration: the decoration
 * module's own functions (`decor/draw.ts`), registered with its drawer (`decor/index.ts`), so that neither
 * loads that module (it is loaded the first time a slide holds a decoration, `loadShapeDrawers`). Until it is,
 * a decoration draws nothing and costs nothing.
 */
export interface DecorHooks {
  /** Past `DECOR_SPRITE` (points or shadowed shapes): one long call drawn whole, a unit on the outputs. */
  capped(o: ShapeObject): boolean;
  /** Its source shapes (`decorShapeCount`): what `range` draws in pieces. */
  count(o: ShapeObject): number;
  /** Draws source shapes `from` to `to` (excluded), never through its sprite (`drawDecorRange`). */
  range(ctx: Ctx2D, o: ShapeObject, scale: number, from: number, to: number): void;
  /** Its drawing estimate and its shadows' weighted area (`decorCost`). */
  cost(o: ShapeObject): { est: number; effects: number };
  /** Where it draws on the slide, its shadows included (`decorReach`; logical px; null: unknown). */
  reach(o: ShapeObject): { x: number; y: number; w: number; h: number } | null | undefined;
}

let decorHooksNow: DecorHooks | undefined;
let decorHooksVersion = 0;

/** Register the decoration's hooks (one at a time); returns its unregistration. */
export function registerDecorHooks(h: DecorHooks): () => void {
  decorHooksNow = h;
  decorHooksVersion++;
  return () => {
    if (decorHooksNow !== h) return;
    decorHooksNow = undefined;
    decorHooksVersion++;
  };
}

/** The decoration's hooks, once its module is loaded. */
export function decorHooks(): DecorHooks | undefined {
  return decorHooksNow;
}

/** Changes whenever the decoration's hooks are registered or unregistered (memos of costs and plans read it). */
export function decorHooksGeneration(): number {
  return decorHooksVersion;
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

/** A 2D affine's six numbers (what a context's transform holds). */
export type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };

/**
 * The device transform of a box's space (0..w, 0..h, logical px) at `scale`: what `placeBox` sets on an
 * untransformed context (flipped about the box's centre, rotated about it, scaled), worked out without one.
 */
export function boxTransform(box: Box, scale: number, flipH = false, flipV = false): Affine {
  const th = box.rotation ? (box.rotation * Math.PI) / 180 : 0;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const sx = scale * (flipH ? -1 : 1);
  const sy = scale * (flipV ? -1 : 1);
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  return {
    a,
    b,
    c,
    d,
    e: (box.x + box.w / 2) * scale - a * (box.w / 2) - c * (box.h / 2),
    f: (box.y + box.h / 2) * scale - b * (box.w / 2) - d * (box.h / 2),
  };
}

/** Coordinate pairs a path command takes. */
function pairsOf(op: number): number {
  return op === CMD_MOVE || op === CMD_LINE ? 1 : op === CMD_QUAD ? 2 : op === CMD_CUBIC ? 3 : 0;
}

/** A path's sub-paths (each from its moveTo), as paths of their own with the path's fill mode and stroke flag. */
function subPaths(p: GeomPath): GeomPath[] {
  const out: GeomPath[] = [];
  let cmds: number[] = [];
  let pts: number[] = [];
  let at = 0;
  const flush = () => {
    if (cmds.length) out.push({ ...p, cmds, pts });
    cmds = [];
    pts = [];
  };
  for (const op of p.cmds) {
    if (op === CMD_MOVE) flush();
    cmds.push(op);
    const n = pairsOf(op);
    for (let j = 0; j < n && at + 1 < p.pts.length; j++, at += 2) pts.push(p.pts[at]!, p.pts[at + 1]!);
  }
  flush();
  return out;
}

const groupMemo = new WeakMap<GeomPath, Map<number, GeomPath[] | null>>();

/**
 * A path's sub-paths in groups (in order) whose outline is drawn within `slice` drawing units a call
 * (`drawCost` of the group, its points charged): greedily by their costs alone with a margin of two, then any
 * group over `slice` split in halves until it is within (edges side by side in one group cost more together, as
 * they share the scan converter's bands). Undefined when one sub-path's outline alone is past
 * `GEOM_COST.geometry`: no call within a task draws it. Memoised per path and slice.
 */
function strokeGroups(
  o: ShapeObject,
  built: BuiltGeom,
  p: GeomPath,
  outline: ReturnType<typeof outlineOf>,
  slice: number,
): GeomPath[] | undefined {
  let m = groupMemo.get(p);
  if (!m) groupMemo.set(p, (m = new Map()));
  const hit = m.get(slice);
  if (hit !== undefined) return hit ?? undefined;
  const spec = { fill: false, outline, paint: fillPaintOf(o) };
  const costOf = (g: GeomPath) =>
    drawCost({ w: built.w, h: built.h, paths: [g] }, spec) + (g.pts.length / 2) * GEOM_COST.point;
  const join = (g: GeomPath[]): GeomPath => ({
    ...p,
    cmds: g.flatMap((x) => x.cmds),
    pts: g.flatMap((x) => x.pts),
  });
  const out: GeomPath[] = [];
  const refine = (g: GeomPath[]) => {
    const one = join(g);
    if (g.length > 1 && costOf(one) > slice) {
      const half = Math.ceil(g.length / 2);
      refine(g.slice(0, half));
      refine(g.slice(half));
    } else out.push(one);
  };
  let group: GeomPath[] = [];
  let cost = 0;
  let hostile = false;
  for (const sub of subPaths(p)) {
    const c = costOf(sub);
    if (!(c <= GEOM_COST.geometry)) {
      hostile = true;
      break;
    }
    if (group.length && cost + c > slice / 2) {
      refine(group);
      group = [];
      cost = 0;
    }
    group.push(sub);
    cost += c;
  }
  if (!hostile && group.length) refine(group);
  const r = hostile ? undefined : out;
  m.set(slice, r ?? null);
  return r;
}

/**
 * The drawing estimates of a sliced shape's outline calls (`geomBodySteps` with `slice`: one a group of
 * sub-paths), in order; undefined when it cannot be sliced (tests and the bench read them).
 */
export function geomSlices(raw: ShapeObject, slice: number): number[] | undefined {
  const o = clampShapeObject(raw);
  if (!o.stroke || o.ends || geomAwaited(o.geom)) return undefined;
  const built = shapeGeometry(o);
  const outline = outlineOf(o, num(o.stroke.width, 0, CLAMP.maxEffectPx, 1));
  const spec = { fill: false, outline, paint: fillPaintOf(o) };
  const out: number[] = [];
  for (const p of built.paths) {
    if (!p.stroke) continue;
    const groups = strokeGroups(o, built, p, outline, slice);
    if (!groups) return undefined;
    for (const g of groups)
      out.push(drawCost({ w: built.w, h: built.h, paths: [g] }, spec) + (g.pts.length / 2) * GEOM_COST.point);
  }
  return out;
}

/**
 * A shape's draw calls under its box space (the context's transform maps it) at full alpha, in `drawGeom`'s
 * order: each path's fill and its closed outline, then the open outlines. What its effects path draws as one
 * call (`EffectSource.draw`), cut into one call a step, so the steps drawn in order on one canvas give its
 * pixels: what an effect unit draws its body and its layers' silhouettes with (units.ts). With `slice` (a
 * sliced unit: a geometry past `GEOM_COST.slide` on its own), each outline is cut further into groups of
 * sub-paths whose drawing estimates add up to at most `slice` (a fill stays one call: its holes need it whole,
 * and a fill past `GEOM_COST.geometry` is drawn as the legacy shape anyway). Undefined when one sub-path's
 * outline alone is past `GEOM_COST.geometry` (no call within a task draws it), or a sliced shape has
 * arrowheads (they follow the whole path). Empty for a shape whose geometry file is not read yet.
 */
export function geomBodySteps(raw: ShapeObject, slice?: number): ((c: Ctx2D) => void)[] | undefined {
  const o = clampShapeObject(raw);
  if (geomAwaited(o.geom)) return [];
  if (slice !== undefined && o.ends) return undefined;
  const built = shapeGeometry(o);
  const draw =
    (path: GeomPath, fill: boolean, stroke: boolean) =>
    (c: Ctx2D): void => {
      const plan = planOf(c, o);
      const f = fill ? plan.fill : null;
      const st = stroke ? plan.stroke : null;
      if (!f && !st) return;
      c.save();
      styleLines(c, o);
      drawGeom(c, { ...plan.built, paths: [path] }, f, st);
      c.restore();
    };
  const steps: ((c: Ctx2D) => void)[] = [];
  const open: GeomPath[] = [];
  const outline = o.stroke ? outlineOf(o, num(o.stroke.width, 0, CLAMP.maxEffectPx, 1)) : undefined;
  const strokes = (p: GeomPath): ((c: Ctx2D) => void)[] | undefined => {
    if (slice === undefined) return [draw(p, false, true)];
    const groups = strokeGroups(o, built, p, outline, slice);
    return groups?.map((g) => draw(g, false, true));
  };
  for (const p of built.paths) {
    steps.push(draw(p, true, false));
    if (!o.stroke || !p.stroke) continue;
    if (pathOpen(p, built)) open.push(p);
    else {
      const s = strokes(p);
      if (!s) return undefined;
      steps.push(...s);
    }
  }
  for (const p of open) {
    const s = strokes(p);
    if (!s) return undefined;
    steps.push(...s);
  }
  return steps;
}

/**
 * A shape's effects as `drawGeomShape` hands them to `drawEffected`, under the device transform `m` of its box
 * space (`boxTransform`), not cached (an effect unit keeps what it makes): its silhouettes, outline, shadow, glow
 * and soft edge, and `draw` (the whole shape at full alpha). Undefined when it has no effect to draw.
 */
export function geomEffectSource(raw: ShapeObject, m: Affine): EffectSource | undefined {
  const o = clampShapeObject(raw);
  if (geomAwaited(o.geom) || !(o.shadow || o.glow || o.softEdge)) return undefined;
  const built = shapeGeometry(o);
  const outline = o.stroke ? outlineOf(o, num(o.stroke.width, 0, CLAMP.maxEffectPx, 1)) : undefined;
  const stroked = !!(o.stroke && outline);
  const filled = !(o.shape === 'line' && !o.geom) && !!(o.gradient || o.fill);
  let fillPath: Path2D | undefined;
  let strokePaths: Path2D[] | undefined;
  return {
    transform: m as DOMMatrix,
    scale: Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)),
    bounds: drawnBounds(built, stroked ? outline : undefined),
    draw: (c) => {
      const plan = planOf(c, o);
      styleLines(c, o);
      drawGeom(c, plan.built, plan.fill, plan.stroke);
    },
    get fill() {
      if (!filled) return undefined;
      fillPath ??= geomFillPath2D(built);
      return fillPath;
    },
    get strokes() {
      if (!stroked) return undefined;
      strokePaths ??= built.paths.filter((p) => p.stroke).map(geomPath2D);
      return strokePaths;
    },
    lineWidth: stroked ? outline!.width : 0,
    ...lineStyleOf(o),
    shadow: o.shadow,
    glow: o.glow,
    softEdge: o.softEdge,
  };
}

/**
 * Draw a shape with M6 fields (`hasShapeExtras`) at `scale` device px per logical px. `part` 'body' (an effect
 * unit's 'layers', units.ts: its shadow and glow come from the unit) draws the shape without its effects.
 */
export function drawGeomShape(ctx: Ctx2D, raw: ShapeObject, scale: number, part?: 'body'): void {
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
  if (
    part !== 'body' &&
    (o.shadow || o.glow || o.softEdge || look3d) &&
    typeof ctx.getTransform === 'function'
  ) {
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

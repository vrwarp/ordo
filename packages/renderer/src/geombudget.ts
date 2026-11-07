import type { SlideObject } from '@ordo/domain';
import { effectArea, type LegacyPart, objectCost, type Rated, slidePlan, withoutPart } from './geom/cost.ts';
import { legacyGeometry } from './geom/built.ts';
import type { BuiltGeom } from './geom/path.ts';
import { geomFilesVersion, storedCost, storedGeometry } from './geom/stored.ts';
import { clampShapeObject } from './shape.ts';

/*
 * A slide's drawing budget (design/27 §12 "drawing cost", §13), the same for every drawer: the outputs'
 * asset worker and the thumbnail worker (`drawSlide2D`, `slidePictures`, `sceneSlides`) and the editor canvas.
 * - Geometry: in z-order, each shape drawn through the geometry engine and each picture mask is drawn while
 *   the drawing estimates of what is drawn (`objectCost`: fills, outlines with their joins, caps, dashes and
 *   arrowheads, effect passes) stay within `GEOM_COST.slide` and the stored paths' points within
 *   `GEOM_COST.slidePoints` (§12's 64k); a later one is drawn as its legacy shape (`withoutPart` 'geom': a
 *   shape without its stored geometry, dash, arrowheads, joins and caps; a picture without its mask), as an
 *   older build draws it. A stored geometry whose fill alone is over `GEOM_COST.geometry` is already its
 *   legacy shape (`storedGeometry`).
 * - Effects: shapes keep their shadow, glow and soft edge while the area of their layers (`effectArea`) stays
 *   within `EFFECT_COST.slide`; later ones are drawn without them.
 * The loop is `slidePlan`, which the converter runs on what it emits (`pptx-scene` `emit.ts`), after keeping
 * native slides within the same budgets as it reads them (`walk.ts` `slideCost`, `fitEffects`), so this
 * changes only what an edit, a save or a hostile file makes. Worked out again once a geometry file the slide
 * names is read.
 */

const memo = new WeakMap<
  readonly SlideObject[],
  { version: number; drawn: ReadonlyMap<SlideObject, SlideObject>; over: ReadonlySet<SlideObject> }
>();
const copies = new WeakMap<SlideObject, { geom?: SlideObject; effects?: SlideObject; both?: SlideObject }>();
const rated = new WeakMap<SlideObject, { version: number; r: Rated }>();

/**
 * An object as drawn past a budget (`withoutPart`): without its stored geometry and costly outline fields
 * (`geom`), without its effects (`effects`), or both. Memoised per object, so the drawers' caches see one copy.
 */
export function legacyCopy<T extends SlideObject>(o: T, what: LegacyPart): T {
  let c = copies.get(o);
  if (!c) copies.set(o, (c = {}));
  const hit = c[what];
  if (hit) return hit as T;
  const out = withoutPart(o, what);
  c[what] = out;
  return out;
}

/** An object as its legacy shape: a shape without its stored geometry, a picture without its mask. */
export function withoutGeom<T extends SlideObject>(o: T): T {
  return legacyCopy(o, 'geom');
}

/** The geometry an object draws at its box, as the drawers build it, and its stored points. */
function drawnGeometry(o: SlideObject): { g: BuiltGeom | undefined; points: number } {
  if (o.type === 'shape') {
    const g = storedGeometry(o.geom, o.box.w, o.box.h);
    if (g) return { g, points: storedCost(g)?.points ?? 0 };
    return { g: legacyGeometry(o.shape, o.radius ?? 0, o.box.w, o.box.h), points: 0 };
  }
  if (o.type === 'image' && o.mask) {
    const g = storedGeometry(o.mask, o.box.w, o.box.h);
    return { g, points: (g && storedCost(g)?.points) ?? 0 };
  }
  return { g: undefined, points: 0 };
}

/** What an object costs to draw (`objectCost`, clamped as drawn), memoised per object and files read. */
export function drawnCost(o: SlideObject): Rated {
  const version = geomFilesVersion();
  const hit = rated.get(o);
  if (hit && hit.version === version) return hit.r;
  let r: Rated = { est: 0, points: 0 };
  if (o?.box && (o.type === 'shape' || o.type === 'image')) {
    const c = o.type === 'shape' ? clampShapeObject(o) : o;
    const { g, points } = drawnGeometry(c);
    r = { est: objectCost(c, g), points };
  }
  rated.set(o, { version, r });
  return r;
}

/**
 * The objects of `objects` (a slide's, in z-order) that its drawing budget changes, each with what is drawn
 * instead (`legacyCopy`). Memoised per objects array and geometry files read.
 */
export function slideBudget(objects: readonly SlideObject[]): ReadonlyMap<SlideObject, SlideObject> {
  return planOf(objects).drawn;
}

function planOf(objects: readonly SlideObject[]) {
  const version = geomFilesVersion();
  const hit = memo.get(objects);
  if (hit && hit.version === version) return hit;
  const drawn = new Map<SlideObject, SlideObject>();
  const over = new Set<SlideObject>();
  const parts = slidePlan(
    objects,
    (o, part) => drawnCost(part ? legacyCopy(o, part) : o),
    (o) => (o?.type === 'shape' && o.box ? effectArea(o) : 0),
  );
  parts.forEach((part, i) => {
    const o = objects[i]!;
    if (!part) return;
    drawn.set(o, legacyCopy(o, part));
    if (part !== 'effects') over.add(o);
  });
  const out = { version, drawn, over };
  memo.set(objects, out);
  return out;
}

/** The objects of `objects` that draw as their legacy shapes for the slide's geometry budget (`geom`, `both`). */
export function overGeomBudget(objects: readonly SlideObject[]): ReadonlySet<SlideObject> {
  return planOf(objects).over;
}

/** `objects` as the slide's drawing budget draws them (the same array when it changes none). */
export function withinDrawBudget(objects: readonly SlideObject[]): readonly SlideObject[] {
  const drawn = slideBudget(objects);
  return drawn.size ? objects.map((o) => drawn.get(o) ?? o) : objects;
}

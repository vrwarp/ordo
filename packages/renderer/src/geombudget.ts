import type { ShapeGeom, SlideObject } from '@ordo/domain';
import { drawWeight, EFFECT_COST, effectArea, GEOM_COST } from './geom/cost.ts';
import { geomFilesVersion, storedCost, storedGeometry } from './geom/stored.ts';

/*
 * A slide's drawing budget (design/27 §12 "drawing cost", §13), the same for every drawer: the outputs'
 * asset worker and the thumbnail worker (`drawSlide2D`, `slidePictures`) and the editor canvas.
 * - Geometry: the stored geometries of its shapes and picture masks (presets aside, which the table bounds)
 *   are drawn in z-order while their points stay within `GEOM_COST.slidePoints` (§12's 64k) and their drawing
 *   estimates (`geom/cost.ts`), weighted by the passes that draw them (`drawWeight`), within
 *   `GEOM_COST.slide`; a later one is drawn as its legacy shape (a shape without `geom`, a picture without
 *   `mask`), as an older build draws it. A geometry over `GEOM_COST.geometry` on its own is already its
 *   legacy shape (`storedGeometry`).
 * - Effects: shapes keep their shadow, glow and soft edge while the area of their layers (`effectArea`) stays
 *   within `EFFECT_COST.slide`; later ones are drawn without them.
 * The converter keeps native slides within the same budgets (`pptx-scene` `slideCustom`, `fitEffects`), so
 * this bounds only what an edit, a save or a hostile file makes. Worked out again once a geometry file the
 * slide names is read.
 */

const memo = new WeakMap<
  readonly SlideObject[],
  { version: number; drawn: ReadonlyMap<SlideObject, SlideObject> }
>();
const copies = new WeakMap<SlideObject, { geom?: SlideObject; effects?: SlideObject; both?: SlideObject }>();

function storedOf(o: SlideObject): ShapeGeom | undefined {
  return o.type === 'shape' ? o.geom : o.type === 'image' ? o.mask : undefined;
}

/**
 * An object as drawn past a budget: without its stored geometry (`geom`: a shape without `geom`, a picture
 * without `mask`), without its effects (`effects`: a shape without shadow, glow and soft edge), or both.
 * Memoised per object, so the drawers' caches see one copy.
 */
export function legacyCopy<T extends SlideObject>(o: T, what: 'geom' | 'effects' | 'both'): T {
  let c = copies.get(o);
  if (!c) copies.set(o, (c = {}));
  const hit = c[what];
  if (hit) return hit as T;
  const out = { ...o } as SlideObject & Record<string, unknown>;
  if (what !== 'effects') {
    if (o.type === 'shape') delete out.geom;
    else if (o.type === 'image') delete out.mask;
  }
  if (what !== 'geom' && o.type === 'shape') {
    delete out.shadow;
    delete out.glow;
    delete out.softEdge;
  }
  c[what] = out;
  return out as T;
}

/** An object as its legacy shape: a shape without its stored geometry, a picture without its mask. */
export function withoutGeom<T extends SlideObject>(o: T): T {
  return legacyCopy(o, 'geom');
}

/**
 * The objects of `objects` (a slide's, in z-order) that its drawing budget changes, each with what is drawn
 * instead (`legacyCopy`). Memoised per objects array and geometry files read.
 */
export function slideBudget(objects: readonly SlideObject[]): ReadonlyMap<SlideObject, SlideObject> {
  const version = geomFilesVersion();
  const hit = memo.get(objects);
  if (hit && hit.version === version) return hit.drawn;
  const drawn = new Map<SlideObject, SlideObject>();
  let points = 0;
  let cost = 0;
  let area = 0;
  for (const o of objects) {
    if (!o?.box) continue;
    let geomOver = false;
    const g = storedOf(o);
    const c = g ? storedCost(storedGeometry(g, o.box.w, o.box.h)) : undefined;
    const effects =
      o.type === 'shape' ? { shadow: !!o.shadow, glow: !!o.glow, softEdge: !!o.softEdge } : undefined;
    if (c) {
      const weight =
        o.type === 'shape' ? drawWeight({ stroked: !!o.stroke && o.stroke.width > 0, ...effects }) : 1;
      if (points + c.points > GEOM_COST.slidePoints || cost + c.est * weight > GEOM_COST.slide)
        geomOver = true;
      else {
        points += c.points;
        cost += c.est * weight;
      }
    }
    let effectsOver = false;
    if (o.type === 'shape') {
      const a = effectArea(o);
      if (a > 0) {
        if (area + a > EFFECT_COST.slide) effectsOver = true;
        else area += a;
      }
    }
    if (geomOver || effectsOver)
      drawn.set(o, legacyCopy(o, geomOver && effectsOver ? 'both' : geomOver ? 'geom' : 'effects'));
  }
  memo.set(objects, { version, drawn });
  return drawn;
}

/** The objects of `objects` that draw as their legacy shapes for the slide's geometry budget. */
export function overGeomBudget(objects: readonly SlideObject[]): ReadonlySet<SlideObject> {
  const out = new Set<SlideObject>();
  for (const [o, d] of slideBudget(objects)) if (storedOf(o) && !storedOf(d)) out.add(o);
  return out;
}

/** `objects` as the slide's drawing budget draws them (the same array when it changes none). */
export function withinDrawBudget(objects: readonly SlideObject[]): readonly SlideObject[] {
  const drawn = slideBudget(objects);
  return drawn.size ? objects.map((o) => drawn.get(o) ?? o) : objects;
}

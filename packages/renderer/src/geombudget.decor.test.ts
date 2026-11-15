import { LOOK_MAIN, type ShapeObject, type Slide } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { clampSlide } from './clamp.ts';
import { drawableContent } from './content.ts';
import { decorCost } from './decor/index.ts';
import { cappedSlide } from './decor/test-util.ts';
import { charged } from './geom/cost.ts';
import { slideBudget, slideDrawCost, slideJobCost, withinDrawBudget } from './geombudget.ts';
import { heavySlide } from './health.ts';
import { clearUnits, slideUnitsCost, unitsOfSlide } from './units.ts';

/*
 * Decorations rated (r2a Follow-ups, r2b effect units): `decorCost` feeds the slide's drawing budget, so the
 * budget, health's raster alarm and `heavySlide` count the decorations r2a switched on (E has slides of 19-23);
 * a decoration is never drawn as a lesser copy (never dropped); on the outputs a unit drawn from is rated at its
 * copy when warm, its making at arm.
 */

afterEach(() => clearUnits());

const objectsOf = (s: Slide) => drawableContent(clampSlide(s)).objects;

/** `n` capped decorations, each its own (moved by a pixel and a fraction: its own unit key). */
function decorated(n: number): Slide {
  const one = cappedSlide().objects[0] as ShapeObject;
  return {
    id: `decorated-${n}`,
    objects: Array.from({ length: n }, (_, i) => ({ ...one, id: `d${i}`, box: { ...one.box, x: i * 1.25 } })),
  };
}

describe('decorations rated', () => {
  it('a slide of N capped decorations reports N times one decoration estimate', () => {
    const one = objectsOf(decorated(1))[0] as ShapeObject;
    const c = decorCost(one);
    expect(c.est).toBeGreaterThan(0);
    for (const n of [1, 3, 5]) {
      const cost = slideDrawCost(objectsOf(decorated(n)));
      // 62a1c3a: about 0 (a decoration was rated as its empty legacy line).
      expect(cost.units).toBeCloseTo(n * charged({ est: c.est, points: c.points }), -2);
      expect(cost.effects).toBeCloseTo(n * c.effects, 6);
    }
  });

  it('never draws a decoration as a lesser copy, however far past the budget', () => {
    const objects = objectsOf(decorated(5));
    expect(slideDrawCost(objects).units).toBeGreaterThan(0);
    expect(slideBudget(objects).size).toBe(0);
    expect(withinDrawBudget(objects)).toBe(objects);
  });

  it('heavySlide counts them, and rates a unit at its copy when warm, its making at arm', () => {
    const slide = decorated(5);
    const cold = slideJobCost(slide, LOOK_MAIN);
    expect(heavySlide(cold, 3840, 2160)).toBe(true);
    // Planned for units on this thread (the outputs' prepare step): the raster copies the one that fits the
    // frame, so its making cost leaves the raster's rating and its copy joins the 1:1 pictures.
    const units = unitsOfSlide(slide, 2, LOOK_MAIN);
    expect(units.map((u) => u.of)).toEqual(['decor']);
    const warm = slideJobCost(slide, LOOK_MAIN);
    expect(warm.units).toBeLessThan(cold.units);
    expect(warm.pictures ?? 0).toBeGreaterThan(cold.pictures ?? 0);
    const one = objectsOf(decorated(1))[0] as ShapeObject;
    const c = decorCost(one);
    expect(cold.units - warm.units).toBeCloseTo(charged({ est: c.est, points: c.points }), -2);
    // Its making, reported apart (the prepare step's, at arm).
    const arm = slideUnitsCost(slide, 2, LOOK_MAIN);
    expect(arm.making).toBeCloseTo(charged({ est: c.est, points: c.points }), -2);
    expect(arm.copy).toBeGreaterThan(0.9);
  });
});

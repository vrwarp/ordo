import type { ShapeObject, Slide } from '@ordo/domain';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clampSlide } from './clamp.ts';
import { drawableContent } from './content.ts';
import { EFFECT_COST } from './geom/cost.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { legacyOf, slideBudget, withinDrawBudget } from './geombudget.ts';
import { drawSlide2D } from './text2d.ts';
import { traceCtx } from './trace.test-util.ts';
import { effectsSlide, PANEL_SHADOW } from './units.effects.test-util.ts';
import { clearUnits, type GeomUnit, putUnit, slideUnits, slideUnitsLeft, UNIT_SLIDE_AREAS } from './units.ts';

/*
 * Effect units (design/14 "Effect units"): on the outputs an object past the slide's effect budget is drawn with
 * its effects from a unit made beforehand, within one frame of units a slide; past it, its legacy copy is drawn
 * this time and counted ('area'), for live-frame's frame unit.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterEach(() => clearUnits());

const objectsOf = (s: Slide) => drawableContent(clampSlide(s)).objects;
const FRAME = 1920 * 1080;

describe('effect units', () => {
  it('draws every shadow past the effect budget from a unit, within one frame of units', () => {
    const slide = effectsSlide();
    const objects = objectsOf(slide);
    const copies = slideBudget(objects);
    // The soft edge and nine shadows are kept; the last three are left out by the budget.
    const left = objects.filter((o) => legacyOf(copies.get(o) ?? o)?.part === 'effects');
    expect(left.map((o) => o.id)).toEqual(['p9', 'p10', 'p11']);
    for (const o of left)
      expect((withinDrawBudget(objects)[objects.indexOf(o)] as ShapeObject).shadow).toBeUndefined();
    // Each gets a unit of its layers (its body is drawn live), with its shadow, together within 0.8 of a frame.
    const units = slideUnits(objects, 1);
    expect(units.map((u) => u.object.id)).toEqual(['p9', 'p10', 'p11']);
    for (const u of units) {
      expect(u.kind).toBe('layers');
      expect((u.drawn as ShapeObject).shadow).toEqual(PANEL_SHADOW);
    }
    const area = units.reduce((a, u) => a + (u.rect.w * u.rect.h) / FRAME, 0);
    expect(area).toBeLessThanOrEqual(0.8);
    expect(slideUnitsLeft(objects, 1)).toEqual([]);
    // Drawn with them ready: each past-budget panel is its unit's copy, then its body over it, in z-order.
    for (const u of units) putUnit(u, fake(u) as unknown as CanvasImageSource);
    const t = traceCtx(1920, 1080);
    drawSlide2D(t, slide, { scale: 1 });
    const copied = t.trace
      .filter((e) => e[0] === 'call' && e[1] === 'drawImage')
      .map((e) => (e[2] as { image: unknown[] }).image[2]);
    for (const u of units) expect(copied).toContain(`unit-${u.object.id}`);
  });

  it('keeps the legacy copies of objects past one frame of units, counted as area', () => {
    // Larger panels: more of them past the budget, and their units past one frame.
    const objects = objectsOf(effectsSlide({ w: 1100, h: 700 }));
    const copies = slideBudget(objects);
    const left = objects.filter((o) => legacyOf(copies.get(o) ?? o)?.part === 'effects');
    expect(left.length).toBeGreaterThan(3);
    const units = slideUnits(objects, 1);
    const area = units.reduce((a, u) => a + (u.rect.w * u.rect.h) / FRAME, 0);
    expect(area).toBeLessThanOrEqual(UNIT_SLIDE_AREAS);
    expect(units.length).toBeLessThan(left.length);
    expect(slideUnitsLeft(objects, 1)).toEqual(Array(left.length - units.length).fill('area'));
    // The soft edge's weight is the effect budget's (8 of 10): the corpus never gets here.
    expect(EFFECT_COST.softEdge).toBe(8);
  });
});

/** A picture standing in for a unit's bitmap (the trace logs it by its size and id). */
function fake(u: GeomUnit) {
  return { width: u.rect.w, height: u.rect.h, id: `unit-${u.object.id}`, close() {} };
}

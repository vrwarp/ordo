import type { ShapeObject, SlideObject } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { EFFECT_COST, effectArea, GEOM_COST } from './geom/cost.ts';
import { clearGeomFiles, putGeomFile, storedCost, storedGeometry } from './geom/stored.ts';
import { overGeomBudget, slideBudget, withinDrawBudget, withoutGeom } from './geombudget.ts';

/** A path zigzagging across a 2000 x 2000 space (a costly fill within the per-geometry bound). */
function zigzag(points: number): string {
  let d = 'M 1000 1000';
  for (let k = 1; k < points; k++) {
    const a = (k / points) * Math.PI * 2 * 37;
    const r = k % 2 ? 1000 : 50;
    d += ` L ${(1000 + r * Math.cos(a)).toFixed(1)} ${(1000 + r * Math.sin(a)).toFixed(1)}`;
  }
  return `${d} Z`;
}

function circle(points: number): string {
  let d = 'M 2000 1000';
  for (let k = 1; k < points; k++) {
    const a = (k / points) * Math.PI * 2;
    d += ` L ${(1000 + 1000 * Math.cos(a)).toFixed(2)} ${(1000 + 1000 * Math.sin(a)).toFixed(2)}`;
  }
  return `${d} Z`;
}

const shape = (id: string, d: string, extra: Partial<ShapeObject> = {}): ShapeObject => ({
  id,
  type: 'shape',
  box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
  shape: 'rect',
  fill: { r: 1, g: 2, b: 3, a: 1 },
  opacity: 1,
  radius: 0,
  geom: { paths: [{ d, w: 2000, h: 2000 }] },
  ...extra,
});

afterEach(() => clearGeomFiles());

describe("a slide's drawing budget (design/27 §12 drawing cost)", () => {
  it('draws stored geometries while their weighted estimates fit, the rest as legacy shapes', () => {
    const one = storedCost(storedGeometry(shape('a', zigzag(380)).geom, 1920, 1080))!.est;
    const fit = Math.floor(GEOM_COST.slide / one);
    expect(fit).toBeGreaterThanOrEqual(2);
    const objects: SlideObject[] = Array.from({ length: fit + 2 }, (_, i) => shape(`z${i}`, zigzag(380)));
    const over = overGeomBudget(objects);
    expect([...over].map((o) => o.id)).toEqual([`z${fit}`, `z${fit + 1}`]);
    const drawn = withinDrawBudget(objects);
    expect(drawn.slice(0, fit)).toEqual(objects.slice(0, fit));
    expect(drawn[fit]).toMatchObject({ id: `z${fit}`, shape: 'rect' });
    expect((drawn[fit] as ShapeObject).geom).toBeUndefined();
    // Memoised: the same objects give the same set, and a legacy copy is made once.
    expect(slideBudget(objects)).toBe(slideBudget(objects));
    expect(withoutGeom(objects[fit]!)).toBe(drawn[fit]);
  });

  it('weighs an outline and effects: an outlined, shadowed zigzag counts four times, past the budget alone', () => {
    const plain = [shape('a', zigzag(380)), shape('b', zigzag(380))];
    expect(overGeomBudget(plain).size).toBe(0);
    const heavy = [
      shape('a', zigzag(380), {
        stroke: { width: 2, color: { r: 0, g: 0, b: 0, a: 1 } },
        shadow: { dx: 1, dy: 1, blur: 4, color: { r: 0, g: 0, b: 0, a: 1 } },
      }),
      shape('b', zigzag(380)),
    ];
    expect([...overGeomBudget(heavy)].map((o) => o.id)).toEqual(['a']);
  });

  it("holds a slide's stored path points to 64k (§12)", () => {
    const objects = Array.from({ length: 17 }, (_, i) => shape(`c${i}`, circle(4_000)));
    // 16 of 4,001 points fit 65,536; the 17th does not.
    expect([...overGeomBudget(objects)].map((o) => o.id)).toEqual(['c16']);
  });

  it('counts picture masks, ignores presets, and is worked out again once a geometry file is read', () => {
    const mask: SlideObject = {
      id: 'p',
      type: 'image',
      mediaId: 'm',
      box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
      fit: 'cover',
      opacity: 1,
      radius: 0,
      mask: { ref: 'f' },
    };
    const presets = Array.from({ length: 50 }, (_, i) => ({
      ...shape(`s${i}`, ''),
      geom: { preset: 'star32' },
    }));
    const one = storedCost(storedGeometry(shape('a', zigzag(380)).geom, 1920, 1080))!.est;
    const fit = Math.floor(GEOM_COST.slide / one);
    const zigs = Array.from({ length: fit }, (_, i) => shape(`z${i}`, zigzag(380)));
    const objects: SlideObject[] = [...presets, ...zigs, mask];
    expect(overGeomBudget(objects).size).toBe(0); // the file is not read: the mask draws its fallback
    putGeomFile('f', { paths: [{ d: zigzag(380), w: 2000, h: 2000 }] });
    expect([...overGeomBudget(objects)].map((o) => o.id)).toEqual(['p']);
    expect((withinDrawBudget(objects)[50 + fit] as { mask?: unknown }).mask).toBeUndefined();
  });

  it("draws later shapes without their effects past the slide's effect budget", () => {
    // A full-slide panel with a shadow and a glow weighs about 2.4 slides; four fit 10, the fifth does not.
    const panel = (id: string): ShapeObject => ({
      ...shape(id, ''),
      geom: { preset: 'rect' },
      shadow: { dx: 6, dy: 6, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.5 } },
      glow: { radius: 20, color: { r: 255, g: 255, b: 0, a: 0.5 } },
    });
    const objects: SlideObject[] = Array.from({ length: 5 }, (_, i) => panel(`p${i}`));
    const area = effectArea(objects[0] as ShapeObject);
    expect(area).toBeGreaterThan(2);
    const drawn = withinDrawBudget(objects) as ShapeObject[];
    const fit = Math.floor(EFFECT_COST.slide / area);
    expect(drawn.map((o) => !!o.shadow)).toEqual(objects.map((_, i) => i < fit));
    expect(drawn[fit]).toMatchObject({ id: `p${fit}`, geom: { preset: 'rect' } });
    expect(drawn[fit]!.glow).toBeUndefined();
    // A soft edge weighs twice; an object with none weighs nothing.
    expect(
      effectArea({ ...objects[0]!, shadow: undefined, glow: undefined, softEdge: 4 } as ShapeObject),
    ).toBeCloseTo(2 * ((1920 * 1080) / (1920 * 1080)));
    expect(effectArea(shape('x', ''))).toBe(0);
  });

  it('gives back the same array when nothing is over', () => {
    const objects: SlideObject[] = [shape('a', circle(100))];
    expect(withinDrawBudget(objects)).toBe(objects);
  });
});

import type { ShapeObject, SlideObject } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { charged, EFFECT_COST, effectArea, GEOM_COST } from './geom/cost.ts';
import { clearGeomFiles, putGeomFile, storedCost, storedGeometry } from './geom/stored.ts';
import { drawnCost, overGeomBudget, slideBudget, withinDrawBudget, withoutGeom } from './geombudget.ts';

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

/** A circle of `points` points in a 2000 x 2000 space, in integers (3,000 points stay within 40,000 characters). */
function circle(points: number): string {
  let d = 'M 2000 1000';
  for (let k = 1; k < points; k++) {
    const a = (k / points) * Math.PI * 2;
    d += ` L ${Math.round(1000 + 1000 * Math.cos(a))} ${Math.round(1000 + 1000 * Math.sin(a))}`;
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
  it('draws stored geometries while their estimates and points fit, the rest as legacy shapes', () => {
    const one = charged(drawnCost(shape('a', zigzag(250))));
    expect(one).toBeGreaterThan(storedCost(storedGeometry(shape('a', zigzag(250)).geom, 1920, 1080))!.est);
    const fit = Math.floor(GEOM_COST.slide / one);
    expect(fit).toBeGreaterThanOrEqual(2);
    const objects: SlideObject[] = Array.from({ length: fit + 2 }, (_, i) => shape(`z${i}`, zigzag(250)));
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

  it('rates the outline and effects as drawn: an outlined, shadowed zigzag is past the budget alone', () => {
    const plain = [shape('a', zigzag(250)), shape('b', zigzag(250))];
    expect(overGeomBudget(plain).size).toBe(0);
    const heavy = [
      shape('a', zigzag(250), {
        stroke: { width: 2, color: { r: 0, g: 0, b: 0, a: 1 } },
        shadow: { dx: 1, dy: 1, blur: 4, color: { r: 0, g: 0, b: 0, a: 1 } },
      }),
      shape('b', zigzag(250)),
    ];
    expect([...overGeomBudget(heavy)].map((o) => o.id)).toEqual(['a']);
  });

  it("holds a slide's stored path points to 64k (§12)", () => {
    // Small boxes: what they fill is little (GEOM_COST.area), so the points decide.
    const objects = Array.from({ length: 22 }, (_, i) => ({
      ...shape(`c${i}`, circle(3_000)),
      box: { x: i * 80, y: 0, w: 80, h: 80, rotation: 0 },
    }));
    // 21 of 3,001 points fit 65,536 (and the slide's budget, at GEOM_COST.point a point); the 22nd does not.
    expect(charged(drawnCost(objects[0]!)) * 22).toBeLessThan(GEOM_COST.slide);
    expect([...overGeomBudget(objects)].map((o) => o.id)).toEqual(['c21']);
  });

  it("counts picture masks and presets' outlines, and is worked out again once a geometry file is read", () => {
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
      box: { x: (i % 10) * 190, y: Math.floor(i / 10) * 200, w: 100, h: 100, rotation: 0 },
      geom: { preset: 'star32' },
    }));
    const one = charged(drawnCost(shape('a', zigzag(250))));
    const presetCost = presets.reduce((n, o) => n + charged(drawnCost(o)), 0);
    const fit = Math.floor((GEOM_COST.slide - presetCost) / one);
    expect(fit).toBeGreaterThanOrEqual(1);
    const zigs = Array.from({ length: fit }, (_, i) => shape(`z${i}`, zigzag(250)));
    const objects: SlideObject[] = [...presets, ...zigs, mask];
    expect(overGeomBudget(objects).size).toBe(0); // the file is not read: the mask draws its fallback
    putGeomFile('f', { paths: [{ d: zigzag(250), w: 2000, h: 2000 }] });
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
    // A soft edge weighs EFFECT_COST.softEdge (its body is cut by its mask at full resolution on every raster
    // past the composite cache); an object with none weighs nothing.
    expect(
      effectArea({ ...objects[0]!, shadow: undefined, glow: undefined, softEdge: 4 } as ShapeObject),
    ).toBeCloseTo(EFFECT_COST.softEdge);
    expect(effectArea(shape('x', ''))).toBe(0);
  });

  it("draws the re-review's hostile outlines as legacy shapes (M6 finish)", () => {
    const rand = (() => {
      let x = 7;
      return () => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return ((x >>> 0) % 1_000_000) / 1_000_000;
      };
    })();
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const centre = { x: 460, y: 40, w: 1000, h: 1000, rotation: 0 };
    // Eight paths of 2,000 points scattered within 0.5 px, stroked 400 px wide: 3.9 s at 3840 for two such
    // shapes before (round joins), each now its legacy rect.
    const cloud = () => {
      let d = 'M 500 500';
      for (let k = 1; k < 2_000; k++) {
        const a = rand() * Math.PI * 2;
        const q = Math.sqrt(rand()) * 0.5;
        d += ` L ${(500 + q * Math.cos(a)).toFixed(2)} ${(500 + q * Math.sin(a)).toFixed(2)}`;
      }
      return { d, w: 1000, h: 1000 };
    };
    const wide = (id: string): ShapeObject => ({
      ...shape(id, ''),
      box: centre,
      geom: { paths: Array.from({ length: 8 }, cloud) },
      stroke: { width: 400, color: black },
      lineJoin: 'round',
    });
    // Eight paths of 1,500 open 1 px sub-paths, a 100 px line with large triangles at both ends: 24,000
    // arrowhead fills (2.6 s at 3840).
    const bits = () => {
      let d = '';
      for (let k = 0; k < 1_500; k++) {
        const x = 500 + (rand() - 0.5) * 20;
        const y = 500 + (rand() - 0.5) * 20;
        const a = rand() * Math.PI * 2;
        d += `M ${x.toFixed(1)} ${y.toFixed(1)} L ${(x + Math.cos(a)).toFixed(1)} ${(y + Math.sin(a)).toFixed(1)} `;
      }
      return { d: d.trim(), w: 1000, h: 1000, fill: 'none' as const };
    };
    const arrows: ShapeObject = {
      ...shape('e', ''),
      box: centre,
      fill: undefined,
      geom: { paths: Array.from({ length: 8 }, bits) },
      stroke: { width: 100, color: black },
      ends: {
        head: { type: 'triangle', w: 'lg', len: 'lg' },
        tail: { type: 'triangle', w: 'lg', len: 'lg' },
      },
    };
    // Twenty full-slide rects with a sysDot outline at 0.01 px (627 ms at 3840): drawn 0.5 px wide
    // (CLAMP.minDashedStrokePx), the dashes past the budget as plain rects.
    const dashed = Array.from({ length: 20 }, (_, i) => ({
      ...shape(`d${i}`, ''),
      geom: { preset: 'rect' },
      stroke: { width: 0.01, color: black },
      dash: 'sysDot' as const,
    }));
    const objects: SlideObject[] = [wide('w1'), wide('w2'), arrows, ...dashed];
    const over = overGeomBudget(objects);
    for (const id of ['w1', 'w2', 'e']) expect([...over].some((o) => o.id === id)).toBe(true);
    const drawn = withinDrawBudget(objects) as ShapeObject[];
    expect(drawn.slice(0, 3).every((o) => o.geom === undefined && o.lineJoin === undefined && !o.ends)).toBe(
      true,
    );
    const kept = drawn.slice(3).filter((o) => o.dash);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(20);
    // What is drawn natively charges the slide's budget at most.
    let total = 0;
    for (const o of drawn) total += charged(drawnCost(o));
    expect(total).toBeLessThanOrEqual(GEOM_COST.slide);
  });

  it('charges the area each path covers: eight full-slide paths a shape paint the slide eight times (M6 finish)', () => {
    // The self-check's: few edges, each path filled on its own over the whole box (80 translucent full-slide
    // fills took 149 ms at 3840). Its legacy rect paints the box once.
    const stacked = (id: string): ShapeObject => ({
      ...shape(id, ''),
      fill: { r: 40, g: 90, b: 160, a: 0.5 },
      geom: {
        paths: Array.from({ length: 8 }, () => ({
          d: 'M 0 0 L 1000 0 L 1000 1000 L 0 1000 Z',
          w: 1000,
          h: 1000,
        })),
      },
    });
    const objects: SlideObject[] = Array.from({ length: 10 }, (_, i) => stacked(`r${i}`));
    const one = charged(drawnCost(objects[0]!));
    expect(one).toBeGreaterThan(7 * 1920 * 1080 * GEOM_COST.area);
    const fit = Math.floor(GEOM_COST.slide / one);
    expect([...overGeomBudget(objects)].map((o) => o.id)).toEqual(objects.slice(fit).map((o) => o.id));
  });

  it('gives back the same array when nothing is over', () => {
    const objects: SlideObject[] = [shape('a', circle(100))];
    expect(withinDrawBudget(objects)).toBe(objects);
  });
});

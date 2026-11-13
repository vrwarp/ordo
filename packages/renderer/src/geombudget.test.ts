import { LOOK_LOWER_THIRD, LOOK_MAIN, type ShapeObject, type SlideObject } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { charged, EFFECT_COST, effectArea, GEOM_COST } from './geom/cost.ts';
import { clearGeomFiles, putGeomFile, storedCost, storedGeometry } from './geom/stored.ts';
import {
  drawnCost,
  drawnEffectArea,
  overGeomBudget,
  slideBudget,
  slideDrawCost,
  slideJobCost,
  withinDrawBudget,
  withoutGeom,
} from './geombudget.ts';

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

  it('counts pictures with a shadow or soft edge in the effect budget and draws later ones without them', () => {
    // ProPresenter picture elements with a shadow and a feather, a quarter of the slide each.
    const photo = (id: string): SlideObject => ({
      id,
      type: 'image',
      box: { x: 480, y: 270, w: 960, h: 540, rotation: 0 },
      mediaId: 'photo',
      fit: 'cover',
      opacity: 1,
      radius: 40,
      softEdge: 54,
      shadow: { dx: 10, dy: 10, blur: 30, color: { r: 0, g: 0, b: 0, a: 0.6 } },
    });
    const objects = Array.from({ length: 12 }, (_, i) => photo(`p${i}`));
    const area = drawnEffectArea(objects[0]!);
    // A shadow (1) and a soft edge (EFFECT_COST.softEdge, as a shape's: drawn from the source, in the editor
    // and the thumbnails, its body is cut at full resolution as a shape's is) over a quarter of a slide.
    expect(area).toBeGreaterThan((1 + EFFECT_COST.softEdge) / 4);
    expect(area).toBeLessThan((1 + EFFECT_COST.softEdge) / 2);
    const fit = Math.floor(EFFECT_COST.slide / area);
    expect(fit).toBeGreaterThanOrEqual(1);
    expect(fit).toBeLessThan(objects.length);
    const drawn = withinDrawBudget(objects) as readonly {
      shadow?: unknown;
      softEdge?: unknown;
      radius?: number;
    }[];
    expect(drawn.map((o) => !!o.shadow && !!o.softEdge)).toEqual(objects.map((_, i) => i < fit));
    // Past the budget the picture is drawn as it is, its round corners kept.
    expect(drawn[fit]).toMatchObject({ id: `p${fit}`, radius: 40 });
    expect(drawn[fit]!.softEdge).toBeUndefined();
    // A picture without effects weighs nothing.
    expect(drawnEffectArea({ ...objects[0]!, shadow: undefined, softEdge: undefined } as SlideObject)).toBe(
      0,
    );
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
      fill: undefined,
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
    // Each object drawn natively fits, with everything drawn below it (legacy copies counted), the slide's
    // budget.
    let total = 0;
    drawn.forEach((o, i) => {
      total += charged(drawnCost(o));
      if (!over.has(objects[i]!)) expect(total).toBeLessThanOrEqual(GEOM_COST.slide);
    });
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
    const objects: SlideObject[] = Array.from({ length: 4 }, (_, i) => stacked(`r${i}`));
    const one = charged(drawnCost(objects[0]!));
    expect(one).toBeGreaterThan(8 * 1920 * 1080 * GEOM_COST.area);
    // Every one paints the slide at least once as its legacy rect, counted first; what fits on top is drawn.
    const legacy = charged(drawnCost(withoutGeom(objects[0]!)));
    expect(legacy).toBeGreaterThan(1920 * 1080 * GEOM_COST.area);
    const fit = Math.floor((GEOM_COST.slide - objects.length * legacy) / (one - legacy));
    expect(fit).toBe(1);
    expect([...overGeomBudget(objects)].map((o) => o.id)).toEqual(objects.slice(fit).map((o) => o.id));
  });

  it("sizes effects by what the shape draws: the review's out-of-box custGeom and wide outline (M6 finish review)", () => {
    const shadow = { dx: 2.83, dy: 2.83, blur: 6, color: { r: 0, g: 0, b: 0, a: 0.4 } };
    // A 10 px box at the centre whose path covers the slide (kept by the converter, as PowerPoint and
    // LibreOffice draw it), 60 % filled: each shadow layer covers the canvas (20 took 793 ms at 3840).
    const outside = (i: number): ShapeObject => ({
      ...shape(`o${i}`, ''),
      box: { x: 955, y: 535, w: 10, h: 10, rotation: 0 },
      fill: { r: (i * 37) % 255, g: 120, b: 160, a: 0.6 },
      geom: { paths: [{ d: 'M -960 -540 L 970 -540 L 970 550 L -960 550 Z', w: 10, h: 10 }] },
      shadow,
    });
    const objects: SlideObject[] = Array.from({ length: 20 }, (_, i) => outside(i));
    const one = drawnEffectArea(objects[0]!);
    expect(one).toBeGreaterThan(1);
    expect(one).toBeLessThan(1.05);
    const drawn = withinDrawBudget(objects) as ShapeObject[];
    const shadowed = drawn.filter((o) => o.shadow);
    expect(shadowed.length).toBeLessThanOrEqual(9);
    // What keeps its effects stays within the effect budget, and what is drawn natively within the slide's.
    let area = 0;
    for (const o of drawn) if (o.shadow) area += drawnEffectArea(o);
    expect(area).toBeLessThanOrEqual(EFFECT_COST.slide);
    let total = 0;
    drawn.forEach((o, i) => {
      total += charged(drawnCost(o));
      if (!overGeomBudget(objects).has(objects[i]!)) expect(total).toBeLessThanOrEqual(GEOM_COST.slide);
    });
    // A 10 px rect with a 500 px outline (the editor's clamp) and the editor's shadow: its layers cover the
    // outline (250 √2 past each corner), about a quarter slide, not 0.001.
    const wide = (i: number): ShapeObject => ({
      ...shape(`w${i}`, ''),
      box: { x: 955, y: 535, w: 10, h: 10, rotation: 0 },
      geom: undefined,
      stroke: { width: 500, color: { r: 0, g: 0, b: 0, a: 1 } },
      shadow: { dx: 6, dy: 6, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.5 } },
    });
    const w = drawnEffectArea(wide(0));
    expect(w).toBeGreaterThan(0.25);
    expect(w).toBeLessThan(0.3);
    // Twenty of them keep their shadows (the effect budget would keep 36). Thirty outlines, drawn in any case
    // (their legacy copies, counted first), fill the drawing budget alone: none gets a shadow on top.
    const twenty = (withinDrawBudget(Array.from({ length: 20 }, (_, i) => wide(i))) as ShapeObject[]).filter(
      (o) => o.shadow,
    );
    expect(twenty.length).toBe(20);
    expect(twenty.reduce((a, o) => a + drawnEffectArea(o), 0)).toBeLessThanOrEqual(EFFECT_COST.slide);
    const thirty = Array.from({ length: 30 }, (_, i) => wide(i));
    const floor = thirty.reduce((n, o) => n + charged(drawnCost({ ...o, shadow: undefined })), 0);
    expect(floor).toBeGreaterThan(GEOM_COST.slide);
    expect((withinDrawBudget(thirty) as ShapeObject[]).some((o) => o.shadow)).toBe(false);
  });

  it("draws gradients past the slide's budget as their legacy colours: the review's stack (M6 finish review)", () => {
    // Full-slide legacy rects with a 50 % linear gradient each, as the editor stores them: 200 took 2.25 s at
    // 3840, none changed by the budget. A gradient paints about five times a colour's cost a pixel.
    const stops = [
      { at: 0, color: { r: 255, g: 0, b: 0, a: 0.5 } },
      { at: 1, color: { r: 0, g: 0, b: 255, a: 0.5 } },
    ];
    const objects: SlideObject[] = Array.from({ length: 200 }, (_, i) => ({
      ...shape(`g${i}`, ''),
      geom: undefined,
      fill: stops[0]!.color,
      gradient: { kind: i % 2 ? ('radial' as const) : ('linear' as const), stops, angle: 90 },
    }));
    // Their legacy colours alone (each a full-slide translucent fill, drawn in any case) pass the budget: every
    // one is its first stop, drawn by the legacy path as an older build draws it.
    const drawn = withinDrawBudget(objects) as ShapeObject[];
    expect(drawn.every((o) => !o.gradient && o.fill?.a === 0.5)).toBe(true);
    // Six (the first six of the converter's 140, 78 ms at 3840 cold): two keep theirs on top of the six
    // legacy fills, within the budget.
    const six = withinDrawBudget(objects.slice(0, 6)) as ShapeObject[];
    expect(six.filter((o) => o.gradient).length).toBe(2);
    expect(six.reduce((n, o) => n + charged(drawnCost(o)), 0)).toBeLessThanOrEqual(GEOM_COST.slide);
  });

  it('sums what the slide draws as the budget draws it: the units health predicts a raster by (M6 merge review)', () => {
    const one = charged(drawnCost(shape('a', zigzag(250))));
    const fit = Math.floor(GEOM_COST.slide / one);
    const objects: SlideObject[] = Array.from({ length: fit + 2 }, (_, i) => shape(`z${i}`, zigzag(250)));
    const drawn = withinDrawBudget(objects);
    const want = drawn.reduce((n, o) => n + charged(drawnCost(o)), 0);
    const cost = slideDrawCost(objects);
    expect(cost.units).toBeCloseTo(want, 6);
    expect(cost.units).toBeLessThanOrEqual(GEOM_COST.slide);
    expect(cost.units).toBeGreaterThan(fit * one);
    expect(cost.effects).toBe(0);
    expect(slideDrawCost(objects)).toBe(cost);
    // A slide job: what drawSlide2D draws for the look; a lyric-only look draws its bands, no geometry.
    const slide = { id: 's', objects };
    expect(slideJobCost(slide, LOOK_MAIN).units).toBeCloseTo(want, 6);
    expect(slideJobCost(slide, LOOK_LOWER_THIRD)).toEqual({ units: 0, effects: 0 });
    // Effects kept are counted by their layers' area.
    const shadowed = [
      shape('s', circle(100), { shadow: { dx: 4, dy: 4, blur: 10, color: { r: 0, g: 0, b: 0, a: 0.5 } } }),
    ];
    expect(slideDrawCost(shadowed).effects).toBeCloseTo(drawnEffectArea(shadowed[0]!), 9);
  });

  it('gives back the same array when nothing is over', () => {
    const objects: SlideObject[] = [shape('a', circle(100))];
    expect(withinDrawBudget(objects)).toBe(objects);
  });
});

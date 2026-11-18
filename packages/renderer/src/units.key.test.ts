import {
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  LOOK_STAGE,
  type Look,
  type ShapeObject,
  type Slide,
  type SlideObject,
} from '@ordo/domain';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { clampSlide } from './clamp.ts';
import { drawableContent } from './content.ts';
import { slideBudget } from './geombudget.ts';
import './decor/index.ts';
import { decorOf } from './decor/test-util.ts';
import { lineArtSlide } from './units.test-util.ts';
import {
  clearUnits,
  prepareSlideUnits,
  SLICE_MS,
  setUnitMedia,
  slideUnits,
  UNIT_VERSION,
  unitKey,
  unitOf,
  unitsOfSlide,
} from './units.ts';

/*
 * The unit key (bake-on-save critic corrections, design/14 "Effect units"): what a unit draws, never what names
 * it, by canonical JSON through `digest.ts`; its position only where the frame cuts it; a picture by its file.
 */

afterEach(() => {
  clearUnits();
  setUnitMedia(undefined);
});

const black = { r: 0, g: 0, b: 0, a: 0.5 };
const shadow = { dx: 8, dy: 8, blur: 30, color: black };

/** A shadowed preset shape (a geometry-engine shape: its effects past the budget make an effect unit). */
const panel = (id: string, x: number, y: number, extra: Partial<ShapeObject> = {}): ShapeObject => ({
  id,
  type: 'shape',
  box: { x, y, w: 400, h: 300, rotation: 0 },
  shape: 'rect',
  fill: { r: 30, g: 90, b: 160, a: 1 },
  opacity: 1,
  radius: 0,
  geom: { preset: 'roundRect' },
  shadow,
  ...extra,
});

/** The clamped objects a slide draws. */
const objectsOf = (s: Slide) => drawableContent(clampSlide(s)).objects;
/** One object, clamped as a slide holds it. */
const clamped = (o: SlideObject) => objectsOf({ id: 's', objects: [o] })[0]!;

describe('unit keys', () => {
  it('keys what a unit draws: not its id, origin or lock; its fields, effects and kind', () => {
    const a = clamped(panel('a', 100, 100));
    const u = unitOf(a, 1, 'effects')!;
    expect(u.kind).toBe('layers');
    expect(u.key.startsWith(`u${UNIT_VERSION}:`)).toBe(true);
    // Names and editor fields: the same unit.
    const renamed = clamped({
      ...panel('b', 100, 100),
      origin: { src: 'pptx' },
      locked: true,
    } as ShapeObject);
    expect(unitOf(renamed, 1, 'effects')!.key).toBe(u.key);
    // Anything drawn: another unit.
    const other = (extra: Partial<ShapeObject>) =>
      unitOf(clamped(panel('a', 100, 100, extra)), 1, 'effects')!.key;
    expect(other({ shadow: { ...shadow, blur: 31 } })).not.toBe(u.key);
    expect(other({ shadow: { ...shadow, color: { ...black, a: 0.6 } } })).not.toBe(u.key);
    expect(other({ glow: { radius: 10, color: black } })).not.toBe(u.key);
    expect(other({ fill: { r: 31, g: 90, b: 160, a: 1 } })).not.toBe(u.key);
    expect(other({ flipH: true })).not.toBe(u.key);
    // A soft edge makes it another kind ('whole': the body is in the unit), keyed apart.
    const soft = unitOf(clamped(panel('a', 100, 100, { softEdge: 12 })), 1, 'effects')!;
    expect(soft.kind).toBe('whole');
    expect(soft.key).not.toBe(u.key);
    // The kind and what it is of are in the key, and so are the scale and the size.
    const rect = { x: 0, y: 0, w: 10, h: 10 };
    const k = unitKey({ kind: 'whole', of: 'shape', drawn: a }, 1, rect, [0, 0], false);
    expect(unitKey({ kind: 'layers', of: 'shape', drawn: a }, 1, rect, [0, 0], false)).not.toBe(k);
    expect(unitKey({ kind: 'whole', of: 'decor', drawn: a }, 1, rect, [0, 0], false)).not.toBe(k);
    expect(unitKey({ kind: 'whole', of: 'shape', drawn: a }, 2, rect, [0, 0], false)).not.toBe(k);
    expect(unitKey({ kind: 'whole', of: 'shape', drawn: a }, 1, { ...rect, w: 11 }, [0, 0], false)).not.toBe(
      k,
    );
    // A geometry file by its hash.
    const f = (ref: string) =>
      unitKey(
        { kind: 'whole', of: 'shape', drawn: { ...a, geom: { ref } } as SlideObject },
        1,
        rect,
        [0, 0],
        false,
      );
    expect(f('f'.repeat(64))).not.toBe(f('e'.repeat(64)));
  });

  it('leaves the position out while the frame does not cut the unit, and keeps it where it does', () => {
    const at = (x: number, y: number) => unitOf(clamped(panel('a', x, y)), 1, 'effects')!;
    const here = at(100, 100);
    // Moved by whole device px inside the frame: the same pixels, so the same unit, copied at its new place.
    const there = at(700, 400);
    expect(there.key).toBe(here.key);
    expect(there.rect.x - here.rect.x).toBe(600);
    // Another sub-pixel phase draws other pixels: another unit.
    expect(at(100.5, 100).key).not.toBe(here.key);
    // Past the frame's edge (its shadow's reach cut): the cut depends on where it is, and so does its key.
    const cut1 = at(-50, 100);
    const cut2 = at(-80, 100);
    expect(cut1.rect.x).toBe(0);
    expect(cut1.key).not.toBe(cut2.key);
    expect(cut1.key).not.toBe(here.key);
  });

  it('keys a picture by its file: a deleted media changes the key', () => {
    const pic = clamped({
      id: 'p',
      type: 'image',
      mediaId: 'm1',
      box: { x: 200, y: 100, w: 800, h: 600, rotation: 0 },
      fit: 'cover',
      opacity: 1,
      radius: 0,
      mask: { preset: 'ellipse' },
    } as SlideObject);
    const files = new Map([['m1', 'a'.repeat(64)]]);
    setUnitMedia((id) => files.get(id));
    const u = unitOf(pic, 1, 'geom')!;
    expect(u.of).toBe('prepared');
    files.set('m1', 'b'.repeat(64));
    setUnitMedia((id) => files.get(id));
    const replaced = unitOf(pic, 1, 'geom')!;
    expect(replaced.key).not.toBe(u.key);
    files.delete('m1');
    setUnitMedia((id) => files.get(id));
    const gone = unitOf(pic, 1, 'geom')!;
    expect(gone.key).not.toBe(u.key);
    expect(gone.key).not.toBe(replaced.key);
  });
});

/** Slides asking for each kind: line art past the geometry budget, shadows past the effect budget, a decoration. */
function everyKind(): Slide[] {
  const panels = Array.from({ length: 16 }, (_, i) =>
    panel(`p${i}`, 0, 0, {
      box: { x: 200 + i * 10, y: 100, w: 900, h: 700, rotation: 0 },
      glow: { radius: 20, color: black },
    }),
  );
  const shapes = Array.from({ length: 6 }, (_, i) =>
    panel(`d${i}`, 0, 0, { box: { x: 100 + i * 200, y: 100, w: 150, h: 150, rotation: 0 } }),
  );
  return [lineArtSlide(), { id: 'panels', objects: panels }, { id: 'decor', objects: [decorOf(shapes)] }];
}

describe('the look gate', () => {
  it('makes no unit of any kind for a lyric-only, hidden or band look', () => {
    const kinds = new Set<string>();
    const hidden: Look = { ...LOOK_MAIN, layers: { ...LOOK_MAIN.layers, slide: { mode: 'hidden' } } } as Look;
    for (const slide of everyKind()) {
      const units = unitsOfSlide(slide, 1, LOOK_MAIN);
      expect(units.length, slide.id).toBeGreaterThan(0);
      for (const u of units) kinds.add(`${u.kind} ${u.of}`);
      for (const look of [LOOK_STAGE, LOOK_LOWER_THIRD, hidden])
        expect(unitsOfSlide(slide, 1, look)).toEqual([]);
    }
    expect(kinds).toEqual(new Set(['whole shape', 'layers shape', 'whole decor']));
  });
});

describe('the plan', () => {
  it("plans a 300-object slide's units and keys within one SLICE_MS turn", async () => {
    const slide = (): Slide => ({
      id: 'many',
      objects: Array.from({ length: 300 }, (_, i) =>
        panel(`p${i}`, (i % 20) * 90, Math.floor(i / 20) * 70, {
          box: { x: (i % 20) * 90, y: Math.floor(i / 20) * 70, w: 120, h: 90, rotation: 0 },
          glow: { radius: 12, color: black },
          softEdge: 6,
        }),
      ),
    });
    // The best of a few fresh plans (each slide new: nothing memoised but its drawing budget, which the raster
    // works out too: about 8-10 ms of rating 300 effected shapes, the same at 62a1c3a), in the asset worker's
    // turn: each unit's kind, reach and key.
    let best = Infinity;
    let budget = Infinity;
    let units = 0;
    for (let i = 0; i < 5; i++) {
      const s = slide();
      const t0 = performance.now();
      slideBudget(objectsOf(s));
      budget = Math.min(budget, performance.now() - t0);
      const turns: number[] = [];
      await prepareSlideUnits(
        s,
        2,
        LOOK_MAIN,
        {
          slice: async (fn) => {
            const t1 = performance.now();
            const out = fn();
            turns.push(performance.now() - t1);
            return out;
          },
          check: () => {},
        },
        // Nothing made: the plan alone is timed.
        { waitMs: -1 },
      );
      best = Math.min(best, turns[0]!);
      units = slideUnits(objectsOf(s), 2).length;
    }
    console.log(
      `300 objects: budget ${budget.toFixed(1)} ms, units plan turn ${best.toFixed(1)} ms, ${units} units`,
    );
    expect(units).toBeGreaterThan(0);
    expect(best).toBeLessThan(budgetMs(SLICE_MS));
  });
});

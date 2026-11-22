import type { ShapeObject, Slide, SlideObject } from '@ordo/domain';
import { drawnPart } from '@ordo/domain/prerender.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { bakeCuts } from './clamp.ts';
import {
  awaitedFiles,
  forgetFrame,
  frameImage,
  frameIncomplete,
  frameKey,
  frameSize,
  frameWorkKeys,
  setFrames,
  splitFrame,
  wholeSplit,
} from './frame.ts';
import { picture, slideOf, squares, textBox } from './frame.test-util.ts';
import { clearGeomFiles, putGeomFile } from './geom/stored.ts';
import { clearUnits, setUnitMedia, unitCache } from './units.ts';

/*
 * The whole-under variant of the underlay frame (bake-render, sub-wave 3): the split the bake draws a whole slide
 * with. `splitFrame` cannot give one (it always keeps the top object direct and gives nothing for a slide within
 * the counts); `wholeSplit` is a FrameSplit whose under part is every drawn object and whose direct part is empty,
 * driven by the same step machine (`makeFrame`) as the live frame, whose key and output do not change
 * (bake.pins.test.ts).
 */

afterEach(() => {
  clearUnits();
  clearGeomFiles();
  setUnitMedia(undefined);
  setFrames(true);
});

/** The objects of `n` squares and one text box on top: ids are stable. */
const objectsOf = (n: number): SlideObject[] => [...squares(n), textBox('top', 'Top')];

describe('wholeSplit: every drawn object under, nothing direct', () => {
  for (const n of [0, 4, 199, 200, 339, 999]) {
    it(`a slide of ${n + 1} objects at scale 2`, () => {
      const objs = objectsOf(n);
      const s = wholeSplit(slideOf(objs), 2);
      expect(s.under.map((o) => o.id)).toEqual(objs.map((o) => o.id));
      expect(s.direct.objects).toEqual([]);
      expect(s.rect).toEqual({ x: 0, y: 0, w: 3840, h: 2160 });
      expect(s.bytes).toBe(33_177_600);
      expect(s.why).toEqual({ objects: false, images: false, targets: false, bytes: false, area: false });
      expect(s.cut).toBe(0);
      expect(s.scale).toBe(2);
    });
  }

  it('a crowded slide with 24 pictures keeps every picture under', () => {
    const pics = Array.from({ length: 24 }, (_, i) =>
      picture(`pic${i}`, `photo${i}`, { x: 40 + (i % 8) * 220, y: 100, w: 200, h: 240 }),
    );
    const s = wholeSplit(slideOf([...squares(300), ...pics]), 2);
    expect(s.under).toHaveLength(324);
    expect(s.under.filter((o) => o.type === 'image')).toHaveLength(24);
    expect(s.direct.objects).toEqual([]);
  });

  it('the rect follows frameSize at any scale', () => {
    for (const scale of [0.5, 1, 1.5, 2]) {
      const s = wholeSplit(slideOf(objectsOf(3)), scale);
      const f = frameSize(scale);
      expect(s.rect).toEqual({ x: 0, y: 0, w: f.w, h: f.h });
      expect(s.bytes).toBe(f.w * f.h * 4);
    }
  });
});

describe('wholeSplit gives a split where splitFrame does not', () => {
  it('a slide within the counts, and an empty slide', () => {
    const small = slideOf(objectsOf(4));
    expect(splitFrame(small, 2)).toBeUndefined();
    expect(wholeSplit(small, 2).under).toHaveLength(5);
    expect(wholeSplit(slideOf([]), 2).under).toEqual([]);
  });

  it('does not depend on the troubleshooting switch that turns frames off', () => {
    setFrames(false);
    expect(splitFrame(slideOf(objectsOf(400)), 2)).toBeUndefined();
    const s = wholeSplit(slideOf(objectsOf(400)), 2);
    expect(s.under).toHaveLength(401);
  });

  it('its key is a function of the objects only, and differs from the live split of the same slide', () => {
    const slide = slideOf(objectsOf(339), 'k');
    const whole = wholeSplit(slide, 2);
    const live = splitFrame(slide, 2)!;
    expect(live.under.length).toBeLessThan(whole.under.length);
    expect(frameKey(whole, 0)).not.toBe(frameKey(live, 0));
    expect(frameKey(whole, 0)).toBe(frameKey(wholeSplit({ ...slide, id: 'renamed' }, 2), 0));
    expect(frameKey(whole, 0)).not.toBe(frameKey(whole, 1));
    expect(frameKey(whole, 0)).not.toBe(frameKey(wholeSplit(slide, 1), 0));
    const moved = objectsOf(339);
    moved[7] = { ...moved[7]!, opacity: 0.5 };
    expect(frameKey(wholeSplit(slideOf(moved, 'k'), 2), 0)).not.toBe(frameKey(whole, 0));
  });
});

describe('wholeSplit: the live set is left out', () => {
  const slideWith = (live?: string[]): Slide => ({
    ...slideOf(objectsOf(10), 'live'),
    ...(live ? { prerender: { why: 'count', file: 'f', live, uses: [] } as never } : {}),
  });

  it('the ids given are left out and only those', () => {
    const s = wholeSplit(slideWith(), 2, { live: ['sq3', 'top'] });
    expect(s.under.map((o) => o.id)).not.toContain('sq3');
    expect(s.under.map((o) => o.id)).not.toContain('top');
    expect(s.under).toHaveLength(9);
  });

  it("with none given it reads the RAW slide's record: the clamped copy has none (clamp.ts builds it field by field)", () => {
    const s = wholeSplit(slideWith(['top']), 2);
    expect(s.under.map((o) => o.id)).not.toContain('top');
    expect(s.under).toHaveLength(10);
    // an explicit empty list wins over the record: this release always passes [] (the hook of Q24.a)
    expect(wholeSplit(slideWith(['top']), 2, { live: [] }).under).toHaveLength(11);
  });

  it('the objects under are the objects the key hashes: drawnPart without id, origin and lock', () => {
    const slide = slideWith(['sq2']);
    const s = wholeSplit(slide, 2);
    const drawn = drawnPart(slide).objects;
    const keyed = s.under.map((o) => {
      const { id: _id, origin: _origin, locked: _locked, ...rest } = o as Record<string, unknown>;
      return rest;
    });
    expect(keyed).toEqual(drawn);
  });
});

describe('wholeSplit: a slide shown as its PowerPoint picture', () => {
  it("the imported objects are not under, the operator's own are", () => {
    const imported: ShapeObject = { ...(squares(1)[0] as ShapeObject), id: 'imp', origin: { src: 'pptx' } };
    const own = textBox('own', 'Mine');
    const slide: Slide = {
      ...slideOf([imported, own], 'ref'),
      pptx: { show: 'picture', refMediaId: 'ref-media' } as never,
    };
    const s = wholeSplit(slide, 2);
    expect(s.under.map((o) => o.id)).toEqual(['own']);
    // and drawnPart agrees: the key's drawn part is the same objects
    expect(drawnPart(slide).objects).toHaveLength(1);
    expect(drawnPart(slide).picture).toBe('ref-media');
  });
});

describe('wholeSplit: memo and bound', () => {
  it('the same (slide, scale, live) gives the same object, another live set another one, at most 8 per slide', () => {
    const slide = slideOf(objectsOf(20), 'memo');
    const a = wholeSplit(slide, 2);
    expect(wholeSplit(slide, 2)).toBe(a);
    expect(wholeSplit(slide, 1)).not.toBe(a);
    expect(wholeSplit(slide, 2, { live: ['sq1'] })).not.toBe(a);
    expect(wholeSplit(slide, 2, { live: ['sq1'] })).toBe(wholeSplit(slide, 2, { live: ['sq1'] }));
    // past eight entries the oldest are dropped, as splitFrame's memo is
    for (let i = 0; i < 12; i++) wholeSplit(slide, 2, { live: [`sq${i}`] });
    expect(wholeSplit(slide, 2)).not.toBe(a);
  });

  it("a raw slide of 20,001 objects is cut at the bake clamp's 20,000 and counted", () => {
    const before = bakeCuts();
    const s = wholeSplit(slideOf(squares(20_001), 'huge'), 1);
    expect(s.under).toHaveLength(20_000);
    expect(bakeCuts()).toBe(before + 1);
  });
});

describe('awaitedFiles and forgetFrame', () => {
  const awaiting = (id: string): ShapeObject => ({
    ...(squares(1)[0] as ShapeObject),
    id,
    geom: { ref: 'e'.repeat(64), w: 100, h: 100 } as never,
  });

  it('awaitedFiles lists the under objects that wait for a geometry file, and none once it is read', () => {
    const s = wholeSplit(slideOf([squares(1)[0]!, awaiting('g'), ...squares(3).slice(1)]), 2);
    expect(awaitedFiles(s)).toEqual([1]);
    putGeomFile('e'.repeat(64), { paths: [{ d: 'M0 0L10 0L10 10Z', w: 10, h: 10 }] } as never);
    expect(
      awaitedFiles(wholeSplit(slideOf([squares(1)[0]!, awaiting('g'), ...squares(3).slice(1)], 'again'), 2)),
    ).toEqual([]);
  });

  it("forgetFrame drops the frame's work, its incomplete mark and its unit-cache entry (closing the bitmap)", () => {
    const key = 'f2:forget-me@2';
    let closed = 0;
    expect(
      unitCache.set('unit', key, { source: {} as never, w: 1, h: 1, bytes: 4, close: () => closed++ }),
    ).toBe(true);
    expect(frameImage(key)).toBeDefined();
    forgetFrame(key);
    expect(frameImage(key)).toBeUndefined();
    expect(closed).toBe(1);
    expect(frameIncomplete(key)).toBe(false);
    expect(frameWorkKeys()).not.toContain(key);
    // a key that was never there is a no-op
    forgetFrame('f2:never@2');
  });
});

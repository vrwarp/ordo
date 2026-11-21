import type { Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { BAKE_MAX_OBJECTS, CLAMP, bakeCuts, clampSlide } from './clamp.ts';
import { picture, slideOf, squares, texts } from './frame.test-util.ts';

/*
 * The clamp profile (design 29 section 2.3): 'live' is the cut every live output has always had, 'bake' keeps
 * every object up to the slide-file bound and every picture; the two never serve each other's memo.
 */

const pics = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    picture(`p${i}`, `m${i}`, { x: 10 + (i % 8) * 200, y: 10 + Math.floor(i / 8) * 200, w: 180, h: 180 }),
  );

describe('clampSlide profiles', () => {
  it("'bake' keeps 340 objects and 24 distinct pictures, 'live' still cuts at 200 and 16", () => {
    const s = slideOf([...squares(316), ...pics(24)]);
    const bake = clampSlide(s, 'bake');
    expect(bake.objects).toHaveLength(340);
    expect(
      new Set(bake.objects.filter((o) => o.type === 'image').map((o) => (o as { mediaId: string }).mediaId))
        .size,
    ).toBe(24);
    const live = clampSlide(s);
    expect(live.objects.length).toBeLessThanOrEqual(CLAMP.maxObjects);
    expect(live.objects.filter((o) => o.type === 'image')).toHaveLength(0);
    // the live default is the profile argument left out
    expect(clampSlide(s, 'live')).toBe(live);
  });

  it("'live' keeps its memo: the same slide object gives the same clamped slide", () => {
    const s = slideOf(texts(250));
    const a = clampSlide(s);
    expect(clampSlide(s)).toBe(a);
    expect(clampSlide(a)).toBe(a);
    expect(a.objects).toHaveLength(CLAMP.maxObjects);
  });

  it('the two memos are separate: neither profile serves the other', () => {
    const s = slideOf(texts(250));
    const live = clampSlide(s);
    const bake = clampSlide(s, 'bake');
    expect(bake).not.toBe(live);
    expect(bake.objects).toHaveLength(250);
    expect(clampSlide(s)).toBe(live);
    expect(clampSlide(s, 'bake')).toBe(bake);
    // a bake slide is its own bake memo, and clamping it live cuts it
    expect(clampSlide(bake, 'bake')).toBe(bake);
    expect(clampSlide(bake).objects).toHaveLength(CLAMP.maxObjects);
    // a live slide clamped for bake keeps what it has
    expect(clampSlide(live, 'bake').objects).toHaveLength(CLAMP.maxObjects);
  });

  it('25,000 objects are cut at the slide-file bound and counted', () => {
    const many = Array.from({ length: 25_000 }, () => texts(1)[0]!).map((o, i) => ({
      ...o,
      id: `t${i}`,
    }));
    const before = bakeCuts();
    const bake = clampSlide(slideOf(many), 'bake');
    expect(bake.objects).toHaveLength(BAKE_MAX_OBJECTS);
    expect(bakeCuts()).toBe(before + 1);
    // a slide under the bound is not counted
    clampSlide(slideOf(texts(300)), 'bake');
    expect(bakeCuts()).toBe(before + 1);
  });

  it('the objects the two profiles keep are clamped alike', () => {
    const s = slideOf([...texts(5), ...pics(3)]);
    const live = clampSlide(s);
    const bake = clampSlide(s, 'bake');
    expect(bake.objects).toEqual(live.objects);
    // a hostile box is clamped by both
    const hostile = slideOf([{ ...texts(1)[0]!, box: { x: -1e9, y: 1e9, w: 1e12, h: 5, rotation: 0 } }]);
    expect(clampSlide(hostile, 'bake').objects[0]).toEqual(clampSlide(hostile).objects[0]);
  });

  it('imported images under a reference picture are not counted for either profile', () => {
    const s: Slide = {
      ...slideOf([...pics(10)]),
      pptx: {
        fileId: 'f',
        slide: 1,
        digest: 'd',
        show: 'picture',
        refMediaId: 'ref',
      } as unknown as Slide['pptx'],
    };
    expect(clampSlide(s, 'bake').objects.length).toBe(10);
  });
});

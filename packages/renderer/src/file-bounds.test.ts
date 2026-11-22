import { DEFAULT_LYRIC_STYLE } from '@ordo/domain';
import { heavyForm } from '@ordo/domain/heavyform.ts';
import type { Slide, SlideObject } from '@ordo/domain';
import { FILE_OBJECTS_MAX, INLINE_OBJECTS_MAX, TEXT_DRAWN_MAX } from '@ordo/domain/slidefile.ts';
import { describe, expect, it } from 'vitest';
import { BAKE_MAX_OBJECTS, CLAMP, clampSlide, clampText } from './clamp.ts';
import { FRAME_MAX_OBJECTS } from './frame.ts';
import { GEOM_LIMITS } from './geom/ops.ts';

/*
 * The bounds of a slide FILE (import-files step 1(d), Q53: no limit is raised). The domain's slide-file bound is the
 * number the bake clamp and the underlay frame read, so a slide the hub keeps whole is a slide the bake draws whole,
 * and the geometry bounds stay where Q53 left them (a custom path of more than 128 points is pictured, never given a
 * larger stored form). The numbers are written as literals on purpose: a bound that moves fails here until its owner
 * says so.
 */
describe('file bounds (HF12, Q53)', () => {
  it("the slide-file object bound is the bake clamp's and the frame's", () => {
    expect(FILE_OBJECTS_MAX).toBe(20_000);
    expect(BAKE_MAX_OBJECTS).toBe(20_000);
    expect(FRAME_MAX_OBJECTS).toBe(20_000);
    expect(FILE_OBJECTS_MAX).toBe(BAKE_MAX_OBJECTS);
    expect(FILE_OBJECTS_MAX).toBe(FRAME_MAX_OBJECTS);
  });

  it('an inline slide still holds 1,000 objects and a stored shape 8 paths of 4,096 points', () => {
    expect(INLINE_OBJECTS_MAX).toBe(1000);
    expect(GEOM_LIMITS.paths).toBe(8);
    expect(GEOM_LIMITS.points).toBe(4096);
  });

  it('the characters of one box a screen draws are the characters the stand-in keeps of one box', () => {
    expect(TEXT_DRAWN_MAX).toBe(10_000);
    expect(CLAMP.maxTextChars).toBe(TEXT_DRAWN_MAX);
    expect(clampText('x'.repeat(TEXT_DRAWN_MAX)).length).toBe(TEXT_DRAWN_MAX);
    expect(clampText('x'.repeat(TEXT_DRAWN_MAX + 1)).length).toBe(TEXT_DRAWN_MAX);
  });

  it('a stand-in of heavyForm loses no word to the live clamp (HF13: no box is cut on a screen)', () => {
    const box = { x: 0, y: 0, w: 400, h: 100, rotation: 0 };
    const objects: SlideObject[] = [
      {
        id: 'bg',
        type: 'shape',
        box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
        shape: 'rect',
        fill: { r: 1, g: 2, b: 3, a: 1 },
        opacity: 1,
        radius: 0,
        origin: { src: 'pptx', role: 'bg' },
      } as SlideObject,
      ...Array.from(
        { length: 250 },
        (_, i) =>
          ({
            id: `t${i}`,
            type: 'text',
            box,
            text: `${i}${'w'.repeat(267)}`,
            style: { ...DEFAULT_LYRIC_STYLE },
            opacity: 1,
          }) as SlideObject,
      ),
    ];
    const r = heavyForm({ id: 'big', objects } as Slide, { why: ['count'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const texts = (s: Slide) =>
      s.objects.filter((o) => o.type === 'text').map((o) => (o as { text: string }).text);
    const drawn = clampSlide(r.standIn);
    expect(texts(drawn)).toEqual(texts(r.standIn));
    expect(Math.max(...texts(r.standIn).map((t) => t.length))).toBeLessThanOrEqual(CLAMP.maxTextChars);
  });
});

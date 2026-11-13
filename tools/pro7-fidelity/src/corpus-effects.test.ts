import type { ImageObject, ShapeObject, TextObject } from '@ordo/domain';
import { importPro7 } from '@ordo/importers';
import { describe, expect, it } from 'vitest';
import { buildEffectsCorpus } from './corpus-effects.ts';

/** The text, line mask and picture effect decks import as the references assume (corpus-effects.ts). */
describe('corpus-effects', () => {
  const decks = buildEffectsCorpus();
  const slidesOf = (name: string) => {
    const deck = decks.find((d) => d.name === name)!;
    const r = importPro7(deck.files, { phase: 'documents', exportCompat: true });
    const slides = r.presentations[0]!.sections.flatMap((s) => s.slides);
    expect(slides).toHaveLength(deck.referenceSlides.length);
    return slides;
  };
  /** The slide's own shapes, not its backdrop (its colour, `origin.role: 'bg'`). */
  const shapes = (s: { objects: unknown[] }) =>
    (s.objects as ShapeObject[]).filter((o) => o.type === 'shape' && o.origin?.role !== 'bg');
  const px = (img: { width: number; data: Uint8Array }, x: number, y: number) =>
    [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)] as number[];

  it('text boxes and line masks: a filled box, a stroked one, full-width straps over the slide height', () => {
    const [s1, s2, s3, s4] = slidesOf('pro7-synth-text-and-masks');
    // The box behind the text (the text drawn in its colour: only the geometry counts).
    const box = shapes(s1!)[0]!;
    expect(box).toMatchObject({ box: { x: 360, y: 300, w: 1200, h: 480 }, fill: { r: 230, g: 220, b: 190 } });
    expect(shapes(s2!)[0]!.stroke).toMatchObject({ width: 16 });
    const solid = s3!.objects.find((o) => o.type === 'text') as TextObject;
    expect(solid.style.lineMask).toMatchObject({
      style: 'fullWidth',
      heightOffsetPx: 2000,
      widthOffsetPx: 80,
      hOffsetPx: 20,
      fill: { r: 40, g: 140, b: 200 },
    });
    // No box behind a line mask.
    expect(shapes(s3!)).toEqual([]);
    expect(
      (s4!.objects.find((o) => o.type === 'text') as TextObject).style.lineMask?.gradient?.stops,
    ).toHaveLength(2);
    const [r1, , r3] = decks[0]!.referenceSlides;
    expect(px(r1!, 960, 540)).toEqual([230, 220, 190]);
    expect(px(r1!, 100, 100)).toEqual([15, 20, 30]);
    // The strap spans [480 - 40 + 20, + 1040) on every row.
    expect(px(r3!, 470, 5)).toEqual([40, 140, 200]);
    expect(px(r3!, 455, 1070)).toEqual([15, 20, 30]);
    expect(px(r3!, 1495, 1070)).toEqual([40, 140, 200]);
  });

  it('pictures: round corners, a shadow, a feather, all three, three pictures a slide', () => {
    const slides = slidesOf('pro7-synth-picture-effects');
    const pics = slides.map((s) => (s.objects as ImageObject[]).filter((o) => o.type === 'image'));
    for (const p of pics) expect(p.map((o) => o.box.x).sort((x, y) => x - y)).toEqual([120, 710, 1300]);
    expect(pics[0]![0]).toMatchObject({ radius: 90, box: { y: 390, w: 500, h: 300 } });
    expect(pics[0]![0]!.shadow).toBeUndefined();
    expect(pics[1]![0]!.shadow).toMatchObject({ blur: 40, color: { r: 0, g: 0, b: 0, a: 1 } });
    expect(pics[1]![0]!.shadow!.dx).toBeCloseTo(28.28, 1);
    expect(pics[1]![0]!.shadow!.dy).toBeCloseTo(28.28, 1);
    expect(pics[2]![0]).toMatchObject({ softEdge: 45, radius: 0 });
    expect(pics[3]![0]).toMatchObject({ softEdge: 45, radius: 90 });
    expect(pics[3]![0]!.shadow).toBeDefined();
    const [r1, r2, r3] = decks[1]!.referenceSlides;
    // Round corner: outside its arc the slide; the centre the picture; the shadow darkens past the corner.
    expect(px(r1!, 712, 392)).toEqual([205, 210, 220]);
    expect(px(r1!, 960, 540)).toEqual([240, 150, 40]);
    expect(px(r2!, 1215, 600)[0]).toBeLessThan(120);
    // The feather fades the edge to about half at the erosion line, with no hard cut at the box.
    const edge = px(r3!, 710 + 45, 540)[2]!;
    expect(edge).toBeGreaterThan(80);
    expect(edge).toBeLessThan(180);
    expect(px(r3!, 711, 540)[2]).toBeGreaterThan(200);
  });
});

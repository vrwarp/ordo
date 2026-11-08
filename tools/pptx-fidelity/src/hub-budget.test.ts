/**
 * `--hub-budget` (M9 `ladder`): the native column draws each slide, its LibreOffice-policy form and its
 * LibreOffice-less form as the hub stores them (`withHubBudget`), and `hubStoredSlide` gives the stored form.
 */
import { DEFAULT_LYRIC_STYLE, type Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { hubLadder, hubStoredSlide, type NativeDeck, type NativeSlide, withHubBudget } from './native.ts';

const box = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
const text = (id: string, t: string): Slide['objects'][number] => ({
  id,
  type: 'text',
  box,
  text: t,
  style: DEFAULT_LYRIC_STYLE,
  opacity: 1,
});
const rect = (i: number): Slide['objects'][number] => ({
  id: `r${i}`,
  type: 'shape',
  shape: 'rect',
  box: { ...box, x: i },
  fill: { r: 1, g: 2, b: 3, a: 1 },
  radius: 0,
  opacity: 1,
});
/** Its text and 700 rectangles: past 64 KB with them, within it without most. */
const crowded = (t: string): Slide => ({
  id: 's',
  objects: [text('t', t), ...Array.from({ length: 700 }, (_, i) => rect(i))],
});

function nativeSlide(index: number, slide: Slide, extra: Partial<NativeSlide> = {}): NativeSlide {
  return {
    index,
    shown: index,
    hidden: false,
    tier: 'T1',
    class: 'native',
    reasons: [],
    convertMs: 0,
    notes: [],
    slide,
    textFeatures: [],
    compat: [],
    ...extra,
  } as NativeSlide;
}

describe('--hub-budget (M9 ladder)', () => {
  it('draws every form of a slide as the hub stores it: simplified, never a picture for its size', () => {
    const small: Slide = { id: 'a', objects: [text('t', 'Welcome')] };
    const deck: NativeDeck = {
      slides: [
        nativeSlide(0, small),
        nativeSlide(1, crowded('Grace'), {
          compatSlide: crowded('Grace (LibreOffice)'),
          noLoSlide: crowded('Grace (no LibreOffice)'),
          noLoClass: 'hybrid',
        }),
        nativeSlide(2, { id: 'p', objects: [text('t', 'Kept for search')] }, { class: 'picture' }),
      ],
      slideRect: { x: 0, y: 0, w: 1920, h: 1080 },
      media: [],
      geoms: [],
      notes: [],
      embeddedFonts: false,
      textFeatures: [],
      extractMs: 0,
      parseMs: 0,
      emitMs: 0,
    };
    const out = withHubBudget(deck);
    expect(out.slides[0]!.slide).toBe(small);
    for (const s of [out.slides[1]!.slide, out.slides[1]!.compatSlide!, out.slides[1]!.noLoSlide!]) {
      expect(s.objects.filter((o) => o.type === 'text')).toHaveLength(1);
      expect(s.objects.filter((o) => o.type === 'shape').length).toBeLessThan(700);
      expect(JSON.stringify(s).length).toBeLessThan(64 * 1024);
    }
    expect((out.slides[1]!.compatSlide!.objects[0] as { text: string }).text).toBe('Grace (LibreOffice)');
    // The converter's class stays; a picture-class slide is stored without its objects.
    expect(out.slides[1]!.class).toBe('native');
    expect(out.slides[2]!.slide.objects).toEqual([]);
    // The stored form, given the ladder's answer (or only a class, as before M9).
    const [h] = hubLadder([{ class: 'native', slide: crowded('x'), notes: [] }]);
    expect(h).toMatchObject({ hub: 'hybrid', why: 'slide', level: 'minimal', missing: ['decoration'] });
    expect(hubStoredSlide(crowded('x'), h!)).toBe(h!.slide);
    expect(hubStoredSlide(small, 'native')).toBe(small);
    expect(hubStoredSlide(small, 'picture').objects).toEqual([]);
  });
});

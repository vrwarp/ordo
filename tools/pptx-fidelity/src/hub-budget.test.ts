/**
 * `--hub-budget` (M9 `ladder`): the native column draws each slide, its LibreOffice-policy form and its
 * LibreOffice-less form as the hub stores them (`withHubBudget`), and `hubStoredSlide` gives the stored form.
 */
import { DEFAULT_LYRIC_STYLE, type Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { PPTX_LIMITS } from '../../../apps/hub/src/pptx/shared.ts';
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

describe('--hub-budget with the whole option (Q24.b, step 8a)', () => {
  const whole = (slides: Slide[]) =>
    hubLadder(
      slides.map((slide) => ({ class: 'native' as const, slide, notes: [] })),
      [],
      PPTX_LIMITS.geomFileBytes,
      true,
    );

  it('stores a crowded slide whole where the base ladder simplifies it: every object, its bytes counted, the level grid', () => {
    const base = hubLadder([{ class: 'native', slide: crowded('x'), notes: [] }]);
    expect(base[0]!.level).not.toBe('full');
    const [h] = whole([crowded('x')]);
    expect(h).toMatchObject({ hub: 'native', why: null, missing: [], whole: true });
    expect(h!.slide.objects).toHaveLength(701);
    expect(h!.stored).toBeGreaterThan(64 * 1024);
    expect(h!.level).toBe('grid');
  });

  it('is the base for a slide that is not heavy, and without the option', () => {
    const small: Slide = { id: 'a', objects: [text('t', 'Welcome')] };
    const [h] = whole([small]);
    expect(h).not.toHaveProperty('whole');
    expect(h!.level).toBe('full');
    const off = hubLadder(
      [{ class: 'native', slide: crowded('x'), notes: [] }],
      [],
      PPTX_LIMITS.geomFileBytes,
      false,
    );
    expect(off[0]).not.toHaveProperty('whole');
    expect(off[0]!.slide.objects.length).toBeLessThan(701);
  });

  it('keeps whole only what the 2 MiB share holds: the later heavy slides are cut to the counts and listed', () => {
    const slides = Array.from({ length: 30 }, (_, i) => crowded(`s${i}`));
    const out = whole(slides);
    const flags = out.map((h) => h.whole === true);
    const firstCut = flags.indexOf(false);
    expect(firstCut).toBeGreaterThan(5);
    expect(flags.slice(firstCut).every((f) => !f)).toBe(true);
    for (const h of out.slice(firstCut)) {
      expect(h.slide.objects.length).toBeLessThanOrEqual(200);
      expect(h.hub).toBe('hybrid');
      expect(h.missing.length).toBeGreaterThan(0);
    }
  });
});

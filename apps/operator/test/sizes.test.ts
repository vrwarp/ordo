import { jsonBytes, type Media, type Presentation, SIZE_BUDGETS, type Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { previewMessage, saveSizeCheck } from '../src/lib/sizes.ts';

const MiB = 1024 * 1024;
const style = {
  fontFamily: 'Calibri',
  fontWeight: 400,
  fontStyle: 'normal' as const,
  fontSizePx: 40,
  color: { r: 255, g: 255, b: 255, a: 1 },
  align: 'left' as const,
  valign: 'top' as const,
  lineHeight: 1.2,
  letterSpacing: 0,
  padding: 0,
  transform: 'none' as const,
};

function slide(i: number, chars: number, objects = 1): Slide {
  return {
    id: `s${i}`,
    objects: Array.from({ length: objects }, (_, k) => ({
      id: `t${i}_${k}`,
      type: 'text' as const,
      box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
      text: 'z'.repeat(chars),
      style,
      opacity: 1,
    })),
  };
}

function presentation(slides: Slide[]): Presentation {
  return {
    id: 'p',
    rev: 3,
    title: 'Imported deck',
    kind: 'slides',
    meta: { tags: [] },
    backgroundMediaId: 'bg',
    sections: [{ id: 'sec', label: 'Deck', short: '', slides }],
    arrangements: [{ id: 'a', name: 'Default', sectionIds: ['sec'] }],
    archived: false,
  };
}

const media: Media[] = [
  {
    id: 'bg',
    rev: 1,
    name: 'Background',
    tags: ['pptx'],
    kind: 'image',
    original: { hash: 'h'.repeat(64), bytes: 1000, mime: 'image/jpeg', path: 'media/h.jpg' },
    state: 'ready',
    loop: false,
    isBackground: false,
  },
];

describe('previewMessage (design/27 §3.4)', () => {
  it('sends only the slide section, under 1 MiB, from a deck far over the socket cap', () => {
    const slides = Array.from({ length: 2000 }, (_, i) => slide(i, 3000 + (i % 7) * 500, 3));
    const p = presentation(slides);
    expect(jsonBytes(p)).toBeGreaterThan(SIZE_BUDGETS.socketMax);
    for (const i of [0, 6, 1000, 1999]) {
      const r = previewMessage('out1', p, `s${i}`, media);
      if (!r.ok) throw new Error(r.reason);
      expect(r.bytes).toBeLessThan(SIZE_BUDGETS.previewMax);
      expect(r.bytes).toBe(jsonBytes(r.message));
      expect(r.message).toMatchObject({ t: 'preview', to: 'out1', slideId: `s${i}` });
      expect(r.message.presentation).toMatchObject({ id: 'p', rev: 3, backgroundMediaId: 'bg', media });
      expect(r.message.presentation.sections[0]!.slides[0]!.id).toBe(`s${i}`);
    }
  });

  it('refuses a slide that alone would trip the socket cap', () => {
    const giant = slide(0, 20_000, 1000);
    const r = previewMessage('out1', presentation([giant]), 's0', []);
    expect(r.ok).toBe(false);
    expect(r.bytes).toBeGreaterThan(SIZE_BUDGETS.adoptMax);
    if (!r.ok) expect(r.reason).toMatch(/too large to preview \(\d+\.\d MiB; at most 15\.0 MiB\)/);
  });
});

describe('saveSizeCheck', () => {
  it('saves quietly within 4 MiB, warns above it, and refuses above the hub body limit', () => {
    expect(saveSizeCheck(presentation([slide(0, 1000)]))).toEqual({ bytes: expect.any(Number) });
    const big = saveSizeCheck(presentation(Array.from({ length: 300 }, (_, i) => slide(i, 15_000))));
    expect(big.bytes).toBeGreaterThan(4 * MiB);
    expect(big.refuse).toBeUndefined();
    expect(big.warn).toMatch(/^This presentation is 4\.\d MiB, over the 4\.0 MiB budget/);
    const huge = saveSizeCheck(presentation(Array.from({ length: 1700 }, (_, i) => slide(i, 20_000))));
    expect(huge.bytes).toBeGreaterThan(SIZE_BUDGETS.putMax);
    expect(huge.refuse).toMatch(/more than the hub accepts \(32\.0 MiB\)/);
  });
});

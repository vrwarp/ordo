import { describe, expect, it } from 'vitest';
import { Presentation } from '@ordo/domain';
import { sanitizePresentation } from './sanitize.ts';

/** A one-image presentation; `crop`, when given, is set raw, as an importer may hand it over. */
function deck(crop?: unknown): Presentation {
  const p = Presentation.parse({
    id: 'p',
    title: 'Deck',
    kind: 'slides',
    sections: [
      {
        id: 's',
        label: 'Slides',
        short: 'S',
        slides: [
          {
            id: 'sl',
            objects: [
              { id: 'i', type: 'image', box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 }, mediaId: 'm' },
            ],
          },
        ],
      },
    ],
  });
  if (crop !== undefined) (p.sections[0]!.slides[0]!.objects[0] as { crop?: unknown }).crop = crop;
  return p;
}

const objectOf = (p: Presentation) => p.sections[0]!.slides[0]!.objects[0]!;

describe('sanitizePresentation and ImageObject.crop', () => {
  it('carries a valid crop through unchanged', () => {
    const crop = { l: -0.25, t: 0.1, r: 0, b: 0.5 };
    const p = sanitizePresentation(deck(crop));
    expect(objectOf(p)).toMatchObject({ crop });
    expect(Presentation.safeParse(p).success).toBe(true);
  });

  it('bounds every share to -1..1 so the saved presentation validates', () => {
    const p = sanitizePresentation(deck({ l: -3, t: Number.NaN, r: 2, b: Number.POSITIVE_INFINITY }));
    expect(objectOf(p)).toMatchObject({ crop: { l: -1, t: 0, r: 1, b: 0 } });
    expect(Presentation.safeParse(p).success).toBe(true);
  });

  it('drops a crop that is not an object, and adds none to images without one', () => {
    expect(objectOf(sanitizePresentation(deck('half')))).not.toHaveProperty('crop');
    expect(objectOf(sanitizePresentation(deck()))).not.toHaveProperty('crop');
  });
});

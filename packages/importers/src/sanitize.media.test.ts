import { Presentation } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { sanitizePresentation } from './sanitize.ts';

/** An importer's slide media (design/27 §3.1) is brought within the schema's bounds, and kept. */

function deck(play?: unknown, audio?: unknown): Presentation {
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
              { id: 'v', type: 'image', box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 }, mediaId: 'poster' },
            ],
          },
        ],
      },
    ],
  });
  const sl = p.sections[0]!.slides[0]!;
  if (play !== undefined) (sl.objects[0] as { play?: unknown }).play = play;
  if (audio !== undefined) (sl as { audio?: unknown }).audio = audio;
  return p;
}

describe('sanitizePresentation slide media', () => {
  it('keeps play and the slide sound, bounding their numbers', () => {
    const p = sanitizePresentation(
      deck(
        { mediaId: 'clip', start: 'click', loop: true, gainDb: -400 },
        { mediaId: 'song', slides: 2.4, gainDb: Number.NaN },
      ),
    );
    const sl = p.sections[0]!.slides[0]!;
    const v = sl.objects[0]!;
    expect(v.type === 'image' && v.play).toEqual({
      mediaId: 'clip',
      start: 'click',
      loop: true,
      gainDb: -100,
    });
    expect(sl.audio).toEqual({ mediaId: 'song', slides: 2, gainDb: 0 });
    expect(Presentation.safeParse(p).success).toBe(true);
  });

  it('leaves slides without media as they were', () => {
    const p = sanitizePresentation(deck());
    const sl = p.sections[0]!.slides[0]!;
    expect('play' in sl.objects[0]!).toBe(false);
    expect('audio' in sl).toBe(false);
  });
});

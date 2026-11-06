import { describe, expect, it } from 'vitest';
import { drawnMediaIds, fromImport, referencePicture, slideContent } from './content.ts';
import { CONTENT_CASES, contentCase } from './content.test-util.ts';
import { DEFAULT_GENERAL, DEFAULT_LOOKS } from './defaults.ts';
import { localDigest, resolvePlaylist } from './goLive.ts';
import { referencedMediaIds } from './resolve.ts';
import { type Media, Presentation, Slide } from './schemas.ts';

/** design/27 §5 "One rule for every drawer": what a slide draws, for each class and show mode. */
describe('slideContent', () => {
  for (const c of CONTENT_CASES)
    it(`${c.name}: the picture, then the objects drawn`, () => {
      // The fixtures are stored slides.
      expect(Slide.safeParse(c.slide).success).toBe(true);
      const drawn = slideContent(c.slide);
      expect(drawn.pictureMediaId).toBe(c.picture);
      expect(drawn.reference).toBe(c.picture === 'ref');
      expect(drawnMediaIds(c.slide)).toEqual(c.pictures);
      expect(drawn.objects.flatMap((o) => (o.type === 'text' ? [o.text] : []))).toEqual(c.texts);
      for (const id of c.hidden) expect(drawnMediaIds(c.slide)).not.toContain(id);
    });

  it('keeps every object, in order and as the same array, unless a reference picture hides some', () => {
    const native = contentCase('native').slide;
    expect(slideContent(native).objects).toBe(native.objects);
    const hybrid = contentCase('hybrid').slide;
    expect(slideContent(hybrid).objects.map((o) => o.id)).toEqual([
      'bg',
      'under',
      'art-o',
      'photo-o',
      'over',
    ]);
    const ref = contentCase('ref').slide;
    expect(slideContent(ref).objects.map((o) => o.id)).toEqual(['mine-o', 'added']);
  });

  it('reads unclamped slides without throwing', () => {
    const odd = {
      objects: [
        null,
        { id: 'x', type: 'text', origin: 'not an object' },
        { id: 'y', origin: { src: 'pptx' } },
      ],
      pptx: { show: 'picture', refMediaId: 'ref' },
      imported: { imageMediaId: 42 },
    } as unknown as Slide;
    const drawn = slideContent(odd);
    expect(drawn.pictureMediaId).toBe('ref');
    // Only an object whose origin is an object counts as imported (as the render clamp reads it).
    expect(drawn.objects.map((o) => (o as { id?: string } | null)?.id)).toEqual([undefined, 'x']);
    expect(slideContent({ objects: 'nope', imported: { imageMediaId: 42 } } as unknown as Slide)).toEqual({
      pictureMediaId: undefined,
      reference: false,
      objects: [],
    });
    expect(
      referencePicture({ pptx: { show: 'picture', refMediaId: '' } } as unknown as Slide),
    ).toBeUndefined();
    expect(fromImport(undefined)).toBe(false);
    expect(fromImport({ origin: null })).toBe(false);
  });
});

const media = (id: string, state: Media['state'] = 'ready'): Media => ({
  id,
  rev: 1,
  name: `${id} picture`,
  tags: [],
  kind: 'image',
  original: { hash: `${id}-hash`, bytes: 10, mime: 'image/png', path: `files/${id}-hash` },
  state,
  loop: false,
  isBackground: false,
});

/** One presentation holding every case, in one playlist item. */
function playlistOf(slides: Slide[], extra: Partial<Presentation> = {}) {
  const deck = Presentation.parse({
    id: 'deck',
    rev: 1,
    title: 'Deck',
    kind: 'slides',
    sections: [{ id: 's', label: 'Slides', short: 'S', slides }],
    arrangements: [{ id: 'arr', name: 'Default', sectionIds: ['s'] }],
    ...extra,
  });
  const playlist = {
    id: 'pl',
    rev: 1,
    name: 'Sunday',
    items: [{ id: 'i', kind: 'presentation' as const, presentationId: 'deck' }],
  };
  return { deck, playlist };
}

describe('the media a goLive ships follow the rule (design/27 §5, §8)', () => {
  it('referencedMediaIds names exactly the pictures each slide draws', () => {
    for (const c of CONTENT_CASES) {
      const { deck, playlist } = playlistOf([c.slide]);
      expect([...referencedMediaIds(playlist, { deck })].sort(), c.name).toEqual([...c.pictures].sort());
    }
  });

  const resolve = (slides: Slide[], have: (id: string) => Media | undefined) => {
    const { deck, playlist } = playlistOf(slides);
    return resolvePlaylist(
      {
        playlist,
        presentation: (id) => (id === 'deck' ? deck : undefined),
        media: have,
        fonts: () => [],
        looks: DEFAULT_LOOKS,
        general: DEFAULT_GENERAL,
      },
      'pl',
      { digest: localDigest },
    );
  };

  it('ships the reference picture and the operator pictures, not the imported pictures it hides', () => {
    const r = resolve([contentCase('ref').slide], (id) => (id === 'photo' ? undefined : media(id)));
    expect(Object.keys(r.media).sort()).toEqual(['mine', 'ref']);
    expect(r.files.map((f) => f.hash).sort()).toEqual(['mine-hash', 'ref-hash']);
    expect(r.degraded).toBeUndefined();
  });

  it('a missing or unready reference picture never refuses the service: a degraded note names the slide', () => {
    for (const have of [() => undefined, (id: string) => media(id, 'processing')]) {
      const r = resolve([contentCase('page-ref').slide, contentCase('native').slide], (id) =>
        id === 'ref' ? have(id) : media(id),
      );
      expect(r.media.ref).toBeUndefined();
      expect(r.degraded).toHaveLength(1);
      expect(r.degraded![0]).toMatchObject({ cueIndex: 0, presentationId: 'deck', slideId: 'page-ref' });
      expect(r.degraded![0]!.reason).toMatch(/PowerPoint picture/);
      expect(r.degraded![0]!.reason).toMatch(/only the objects added in ordo/);
    }
  });

  it('an imported page picture and the hybrid art stay required', () => {
    expect(() => resolve([contentCase('page').slide], () => undefined)).toThrow(/media page is missing/);
    expect(() =>
      resolve([contentCase('hybrid').slide], (id) => (id === 'art' ? undefined : media(id))),
    ).toThrow(/media art is missing/);
  });

  it('a reference picture another slide draws as an object stays required', () => {
    const other: Slide = {
      id: 'other',
      objects: [
        {
          id: 'o',
          type: 'image',
          box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
          mediaId: 'ref',
          fit: 'contain',
          opacity: 1,
          radius: 0,
        },
      ],
    };
    expect(() =>
      resolve([contentCase('ref').slide, other], (id) => (id === 'ref' ? undefined : media(id))),
    ).toThrow(/media ref is missing/);
  });
});

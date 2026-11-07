import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERAL, DEFAULT_LOOKS } from './defaults.ts';
import {
  degradedKind,
  localDigest,
  MISSING_SLIDE_REASON,
  missingSlideReason,
  PENDING_SLIDE_REASON,
  resolvePlaylist,
} from './goLive.ts';
import { m9Slide } from './m9.test-util.ts';
import { Presentation, type ShapeObject, type Slide } from './schemas.ts';

/**
 * design/27 M9: a slide with PowerPoint elements nothing draws (`Slide.pptx.missing`, written when the hub has
 * no LibreOffice) goes live as it is, with a `degraded` note at its cue naming what is left out; and the
 * decoration files slides draw go into the manifest with the geometry files.
 */
const FILE = 'f'.repeat(64);
const slide = (id: string, pptx: Record<string, unknown> = {}): Slide =>
  ({
    id,
    objects: [],
    pptx: { fileId: FILE, index: 0, class: 'native', version: 2, ...pptx },
  }) as Slide;

function resolve(
  slides: Slide[],
  file?: (hash: string) => { hash: string; bytes: number; mime: string; path: string } | undefined,
) {
  const deck = Presentation.parse({
    id: 'deck',
    rev: 1,
    title: 'Giving',
    kind: 'slides',
    sections: [{ id: 's', label: 'Slides', short: 'S', slides }],
    arrangements: [{ id: 'arr', name: 'Default', sectionIds: ['s'] }],
    source: { kind: 'pptx', fileId: FILE },
  });
  return resolvePlaylist(
    {
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'Sunday',
        items: [{ id: 'i', kind: 'presentation', presentationId: 'deck' }],
      },
      presentation: (id) => (id === 'deck' ? deck : undefined),
      media: () => undefined,
      fonts: () => [],
      looks: DEFAULT_LOOKS,
      general: DEFAULT_GENERAL,
      ...(file ? { file } : {}),
    },
    'pl',
    { digest: localDigest },
  );
}

describe('resolvePlaylist: slides with missing elements', () => {
  it('a slide with pptx.missing is reported with its kinds', () => {
    const r = resolve([
      slide('a'),
      slide('b', { class: 'hybrid', missing: ['chart:surface', 'ole', 'chart:radar', 'hologram:x'] }),
      slide('c'),
    ]);
    const reason = missingSlideReason(['chart', 'ole', 'element']);
    expect(reason).toBe(
      'PowerPoint slide with something ordo cannot draw (a chart, an embedded object, an element): it is left out',
    );
    expect(r.degraded).toEqual([{ cueIndex: 1, presentationId: 'deck', slideId: 'b', reason }]);
    expect(degradedKind(reason)).toBe('drawing');
    expect(reason.startsWith(MISSING_SLIDE_REASON)).toBe(true);
  });

  it('a slide still waiting for LibreOffice is reported as waiting, once', () => {
    const r = resolve([slide('a', { class: 'hybrid', pending: true, missing: ['smartart'] })]);
    expect(r.degraded).toEqual([
      { cueIndex: 0, presentationId: 'deck', slideId: 'a', reason: PENDING_SLIDE_REASON },
    ]);
  });

  it('an empty or malformed list reports nothing', () => {
    expect(resolve([slide('a', { missing: [] })]).degraded).toBeUndefined();
    // The schema drops a malformed list (.catch), so the slide goes live without a note.
    expect(resolve([slide('a', { missing: 'ole' })]).degraded).toBeUndefined();
  });
});

describe('resolvePlaylist: decoration files', () => {
  it("ships a decoration's file with the geometry files, and notes one the library lacks", () => {
    const s = m9Slide();
    const decor = s.objects.find((o) => o.id === 'decor') as ShapeObject;
    decor.decor = { ...decor.decor!, ref: 'd'.repeat(64) };
    const pie = s.objects.find((o) => o.id === 'pie') as ShapeObject;
    pie.geom = { ...pie.geom!, ref: 'e'.repeat(64) };
    delete s.pptx!.missing;
    // Its picture's media is not what this test is about.
    s.objects = s.objects.filter((o) => o.type !== 'image');
    const files = new Map([
      ['d'.repeat(64), { hash: 'd'.repeat(64), bytes: 9, mime: 'application/json', path: 'x' }],
    ]);
    const r = resolve([s], (h) => files.get(h));
    expect(r.geoms).toEqual([files.get('d'.repeat(64))]);
    expect(r.files.map((f) => f.hash)).toContain('d'.repeat(64));
    expect(r.degraded).toEqual([
      expect.objectContaining({ slideId: 'm9', reason: expect.stringContaining('1 shape outline(s)') }),
    ]);
  });
});

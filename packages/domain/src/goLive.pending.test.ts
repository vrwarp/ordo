import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERAL, DEFAULT_LOOKS } from './defaults.ts';
import { localDigest, PENDING_SLIDE_REASON, resolvePlaylist } from './goLive.ts';
import { Presentation } from './schemas.ts';

/**
 * design/27 §5 "Two-phase save": slides of a native PowerPoint import that still wait for LibreOffice go live
 * as version 1 left them, with a `degraded` note at each cue showing them; goLive is never refused for them.
 */
const FILE = 'f'.repeat(64);
const slide = (id: string, pending: boolean) => ({
  id,
  objects: [],
  pptx: {
    fileId: FILE,
    index: 0,
    class: pending ? 'hybrid' : 'native',
    version: 1,
    ...(pending ? { pending } : {}),
  },
});
const deck = Presentation.parse({
  id: 'deck',
  rev: 1,
  title: 'Giving',
  kind: 'slides',
  sections: [
    {
      id: 's',
      label: 'Slides',
      short: 'S',
      slides: [slide('a', false), slide('b', true), slide('c', false)],
    },
  ],
  arrangements: [{ id: 'arr', name: 'Default', sectionIds: ['s'] }],
  source: { kind: 'pptx', fileId: FILE },
});

describe('resolvePlaylist: slides waiting for LibreOffice', () => {
  it('goes live with a degraded note at the cue of each waiting slide', () => {
    const r = resolvePlaylist(
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
      },
      'pl',
      { digest: localDigest },
    );
    expect(r.degraded).toEqual([
      { cueIndex: 1, presentationId: 'deck', slideId: 'b', reason: PENDING_SLIDE_REASON },
    ]);
    // Once version 2 is saved nothing is listed.
    const done = structuredClone(deck);
    delete done.sections[0]!.slides[1]!.pptx!.pending;
    const again = resolvePlaylist(
      {
        playlist: {
          id: 'pl',
          rev: 1,
          name: 'Sunday',
          items: [{ id: 'i', kind: 'presentation', presentationId: 'deck' }],
        },
        presentation: () => done,
        media: () => undefined,
        fonts: () => [],
        looks: DEFAULT_LOOKS,
        general: DEFAULT_GENERAL,
      },
      'pl',
      { digest: localDigest },
    );
    expect(again.degraded).toBeUndefined();
  });
});

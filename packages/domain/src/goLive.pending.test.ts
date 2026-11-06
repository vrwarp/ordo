import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERAL, DEFAULT_LOOKS } from './defaults.ts';
import { expandCues } from './cues.ts';
import { FAILED_SLIDE_REASON, localDigest, PENDING_SLIDE_REASON, resolvePlaylist } from './goLive.ts';
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

  const resolve = (p: Presentation) =>
    resolvePlaylist(
      {
        playlist: {
          id: 'pl',
          rev: 1,
          name: 'Sunday',
          items: [{ id: 'i', kind: 'presentation', presentationId: 'deck' }],
        },
        presentation: () => p,
        media: () => undefined,
        fonts: () => [],
        looks: DEFAULT_LOOKS,
        general: DEFAULT_GENERAL,
      },
      'pl',
      { digest: localDigest },
    );

  it('names a slide LibreOffice could not draw, at its cue', () => {
    const failed = structuredClone(deck);
    const b = failed.sections[0]!.slides[1]!;
    delete b.pptx!.pending;
    b.pptx!.failed = true;
    expect(resolve(failed).degraded).toEqual([
      { cueIndex: 1, presentationId: 'deck', slideId: 'b', reason: FAILED_SLIDE_REASON },
    ]);
  });

  it('keeps a hidden slide in the service as a flagged cue, named while it waits (a click shows it)', () => {
    const hidden = structuredClone(deck);
    hidden.sections[0]!.slides[1]!.hidden = true;
    const r = resolve(hidden);
    const cues = expandCues(r);
    expect(cues.map((c) => [c.slideId, c.hidden])).toEqual([
      ['a', undefined],
      ['b', true],
      ['c', undefined],
    ]);
    expect(r.degraded).toEqual([
      { cueIndex: 1, presentationId: 'deck', slideId: 'b', reason: PENDING_SLIDE_REASON },
    ]);
  });

  it("gives a slide's own transition to its cue, under the playlist item's", () => {
    const t = structuredClone(deck);
    t.sections[0]!.slides[0]!.transition = { kind: 'cut' };
    t.transition = { kind: 'crossfade', ms: 400 };
    const cues = expandCues(resolve(t));
    expect(cues.map((c) => c.transition)).toEqual([
      { kind: 'cut' },
      { kind: 'crossfade', ms: 400 },
      { kind: 'crossfade', ms: 400 },
    ]);
  });
});

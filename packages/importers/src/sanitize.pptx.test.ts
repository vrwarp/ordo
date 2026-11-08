import { Presentation } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { sanitizePresentation } from './sanitize.ts';

/** A one-slide presentation; `slide` fields are set raw afterwards, as an importer may hand them over. */
function deck(slide: Record<string, unknown>, native?: unknown): Presentation {
  const p = Presentation.parse({
    id: 'p',
    title: 'Deck',
    kind: 'slides',
    sections: [{ id: 's', label: 'Slides', short: 'S', slides: [{ id: 'sl' }] }],
    source: { kind: 'pptx', fileId: 'h' },
  });
  Object.assign(p.sections[0]!.slides[0]!, slide);
  if (native !== undefined) (p.source as Record<string, unknown>).native = native;
  return p;
}

describe('sanitizePresentation: PowerPoint fields (design/27 §3.1, §12)', () => {
  it('keeps valid provenance unchanged and the result passes the schema', () => {
    const pptx = {
      fileId: 'h',
      index: 2,
      shown: 1,
      class: 'hybrid',
      version: 1,
      digest: 'd',
      pending: true,
      notes: ['n'],
      artText: 'Q3',
      show: 'objects',
    };
    const p = sanitizePresentation(
      deck(
        { hidden: true, transition: { kind: 'crossfade', ms: 700 }, pptx },
        {
          version: 1,
          slides: 1,
          native: 0,
          hybrid: 1,
          picture: 0,
          slideRect: { x: 240, y: 0, w: 1440, h: 1080 },
        },
      ),
    );
    const sl = p.sections[0]!.slides[0]!;
    expect(sl.pptx).toEqual(pptx);
    expect(sl.hidden).toBe(true);
    expect(sl.transition).toEqual({ kind: 'crossfade', ms: 700 });
    expect(p.source?.native?.slideRect).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
    expect(Presentation.safeParse(p).success).toBe(true);
  });

  it('bounds hostile values so the save never fails on them', () => {
    const p = sanitizePresentation(
      deck(
        {
          hidden: false,
          transition: { kind: 'crossfade', ms: Number.NaN },
          imported: { fileId: 'f', page: 1, imageMediaId: 'm', textAligned: false },
          pptx: {
            fileId: 'x'.repeat(5000),
            index: -3,
            shown: 1e9,
            class: 'fragments',
            version: 0,
            digest: 'd'.repeat(500),
            pending: false,
            notes: [...Array.from({ length: 40 }, (_, i) => `[error] forged\nline ${i}\u0000`), ''],
            artText: 'a'.repeat(50_000),
            refMediaId: 'r'.repeat(900),
            show: 'video',
          },
        },
        {
          version: Number.POSITIVE_INFINITY,
          slides: -1,
          native: 1e12,
          hybrid: 0,
          picture: 0,
          slideRect: { x: Number.NaN, y: 0, w: -5, h: 1e9 },
        },
      ),
    );
    const sl = p.sections[0]!.slides[0]!;
    expect(sl.hidden).toBeUndefined();
    expect(sl.transition).toEqual({ kind: 'crossfade', ms: 700 });
    expect(sl.imported?.textAligned).toBeUndefined();
    const x = sl.pptx!;
    expect(x.fileId.length).toBe(200);
    expect([x.index, x.shown, x.class, x.version, x.show]).toEqual([0, 100_000, 'native', 1, 'objects']);
    expect(x.digest!.length).toBe(100);
    expect(x.pending).toBeUndefined();
    expect(x.notes).toHaveLength(16);
    for (const n of x.notes!) expect(n).toMatch(/^\[error\] forged line \d+$/);
    expect(x.artText!.length).toBe(10_000);
    expect(x.refMediaId!.length).toBe(200);
    expect(p.source?.native).toEqual({
      version: 1,
      slides: 0,
      native: 100_000,
      hybrid: 0,
      picture: 0,
      slideRect: { x: 0, y: 0, w: 0, h: 4320 },
    });
    expect(Presentation.safeParse(p).success).toBe(true);
  });

  it('drops a transition of a kind it does not know, as the schema does', () => {
    const p = sanitizePresentation(deck({ transition: { kind: 'push', ms: 300 } }));
    expect(p.sections[0]!.slides[0]!.transition).toBeUndefined();
    expect(
      sanitizePresentation(deck({ transition: { kind: 'cut', ms: 5 } })).sections[0]!.slides[0]!.transition,
    ).toEqual({ kind: 'cut' });
  });
});

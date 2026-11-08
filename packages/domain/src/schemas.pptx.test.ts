import { describe, expect, it } from 'vitest';
import { Font, Presentation, Slide } from './schemas.ts';

const pptx = { fileId: 'deckhash', index: 3, shown: 2, class: 'hybrid', version: 1 } as const;

describe('PowerPoint slide fields (design/27 §3.1, M3)', () => {
  it('are optional: slides without them parse as before', () => {
    const s = Slide.parse({ id: 's' });
    expect(s).toEqual({ id: 's', objects: [] });
  });

  it('keeps provenance, hidden, transition and textAligned', () => {
    const s = Slide.parse({
      id: 's',
      hidden: true,
      transition: { kind: 'crossfade', ms: 700 },
      pptx: {
        ...pptx,
        digest: 'abc',
        pending: true,
        notes: ['tab drawn as a space'],
        artText: 'Q3',
        show: 'picture',
      },
      imported: { fileId: 'f', page: 3, imageMediaId: 'm', textAligned: true },
    });
    expect(s.hidden).toBe(true);
    expect(s.transition).toEqual({ kind: 'crossfade', ms: 700 });
    expect(s.pptx).toEqual({
      ...pptx,
      digest: 'abc',
      pending: true,
      notes: ['tab drawn as a space'],
      artText: 'Q3',
      show: 'picture',
    });
    expect(s.imported?.textAligned).toBe(true);
  });

  it('degrades unknown enum values a later release may add instead of refusing the slide', () => {
    const s = Slide.parse({
      id: 's',
      transition: { kind: 'push', ms: 300 },
      pptx: { ...pptx, class: 'fragments', show: 'video' },
    });
    expect(s.transition).toBeUndefined();
    expect(s.pptx?.class).toBe('native');
    expect(s.pptx?.show).toBe('objects');
  });

  it('refuses out-of-bound provenance', () => {
    for (const bad of [
      { ...pptx, index: -1 },
      { ...pptx, version: 0 },
      { ...pptx, notes: Array.from({ length: 17 }, () => 'n') },
      { ...pptx, notes: ['x'.repeat(201)] },
      { ...pptx, fileId: '' },
    ])
      expect(Slide.safeParse({ id: 's', pptx: bad }).success).toBe(false);
  });
});

describe('Presentation.source.native and Font.unicodeRange', () => {
  it('parse and stay optional', () => {
    const p = Presentation.parse({
      id: 'p',
      title: 'Deck',
      kind: 'slides',
      source: {
        kind: 'pptx',
        fileId: 'h',
        native: {
          version: 1,
          slides: 3,
          native: 2,
          hybrid: 1,
          picture: 0,
          slideRect: { x: 240, y: 0, w: 1440, h: 1080 },
        },
      },
    });
    expect(p.source?.native?.hybrid).toBe(1);
    expect(p.source?.renderer).toBeUndefined();
    const file = { hash: 'h', bytes: 1, mime: 'font/woff2', path: 'fonts/h.woff2' };
    const f = Font.parse({
      id: 'f',
      family: 'Noto Sans Hebrew',
      weight: 400,
      style: 'normal',
      file,
      source: 'google',
      unicodeRange: 'U+0590-05FF, U+200C-2010',
    });
    expect(f.unicodeRange).toBe('U+0590-05FF, U+200C-2010');
    expect(
      Font.parse({ id: 'f', family: 'X', weight: 400, style: 'normal', file, source: 'upload' }),
    ).not.toHaveProperty('unicodeRange');
  });
});

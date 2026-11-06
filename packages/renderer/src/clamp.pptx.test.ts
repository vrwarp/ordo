import { describe, expect, it } from 'vitest';
import { clampPptx, clampSlide, clampTransition } from './clamp.ts';

describe('PowerPoint slide fields through clampSlide (design/27 §3.1, M3)', () => {
  it('adds nothing to slides without them', () => {
    expect(clampSlide({ id: 's', objects: [] })).toEqual({ id: 's', objects: [] });
  });

  it('keeps hidden, the transition, textAligned and what drawers read of pptx', () => {
    const s = clampSlide({
      id: 's',
      objects: [],
      hidden: true,
      transition: { kind: 'crossfade', ms: 700 },
      imported: { fileId: 'f', page: 2, imageMediaId: 'm', textAligned: true },
      pptx: {
        fileId: 'deck',
        index: 4,
        shown: 3,
        class: 'picture',
        version: 1,
        digest: 'abc',
        notes: ['n'],
        artText: 'chart title',
        refMediaId: 'ref',
        show: 'picture',
        pending: true,
      },
    });
    expect(s.hidden).toBe(true);
    expect(s.transition).toEqual({ kind: 'crossfade', ms: 700 });
    expect(s.imported?.textAligned).toBe(true);
    expect(s.pptx).toEqual({
      fileId: 'deck',
      index: 4,
      shown: 3,
      class: 'picture',
      version: 1,
      pending: true,
      refMediaId: 'ref',
      show: 'picture',
    });
  });

  it('bounds hostile values and never throws', () => {
    expect(clampTransition({ kind: 'crossfade', ms: Number.POSITIVE_INFINITY })).toEqual({
      kind: 'crossfade',
      ms: 300,
    });
    expect(clampTransition({ kind: 'crossfade', ms: 1e9 })).toEqual({ kind: 'crossfade', ms: 10_000 });
    expect(clampTransition({ kind: 'zoom' })).toBeUndefined();
    expect(clampTransition('cut')).toBeUndefined();
    const p = clampPptx({
      fileId: 7,
      index: -5,
      class: 'fragments',
      version: Number.NaN,
      show: 'video',
      shown: 1e9,
    });
    expect(p).toEqual({ fileId: '', index: 0, class: 'native', version: 1, shown: 100_000 });
    expect(clampPptx(null)).toBeUndefined();
    expect(clampSlide({ id: 's', objects: [], hidden: 'yes', transition: 5, pptx: [] })).toEqual({
      id: 's',
      objects: [],
    });
  });
});

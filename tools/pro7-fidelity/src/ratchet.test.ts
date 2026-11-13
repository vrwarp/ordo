import { describe, expect, it } from 'vitest';
import { compareBaseline } from './ratchet.ts';
import type { DeckScore, SummaryReport } from './types.ts';

function makeReport(decks: DeckScore[]): SummaryReport {
  return {
    createdAt: new Date().toISOString(),
    exportCompat: true,
    meanSsim: decks.length > 0 ? decks.reduce((a, d) => a + d.ssim, 0) / decks.length : 0,
    totalSlides: decks.reduce((a, d) => a + d.slideCount, 0),
    decks,
    clusters: [],
  };
}

function makeDeck(name: string, slideSsims: number[]): DeckScore {
  const perSlide = slideSsims.map((ssim, i) => ({
    n: i + 1,
    ssim,
    transparentRef: false,
    overallMae: 0,
    backgroundMae: 0,
    alphaMae: 0,
    boxMaes: [],
    features: [],
    refPngPath: `/ref/${i + 1}.png`,
    ordoPngPath: `/ordo/${i + 1}.png`,
  }));
  const mean = slideSsims.length > 0 ? slideSsims.reduce((a, b) => a + b, 0) / slideSsims.length : 0;
  return {
    name,
    kind: 'sample',
    title: name,
    slideCount: slideSsims.length,
    ssim: mean,
    minSlideSsim: Math.min(...slideSsims, 1),
    perSlide,
    importNotes: [],
  };
}

describe('compareBaseline', () => {
  it('passes when current equals baseline', () => {
    const base = makeReport([makeDeck('Deck A', [0.95, 0.96, 0.97])]);
    const curr = makeReport([makeDeck('Deck A', [0.95, 0.96, 0.97])]);

    const res = compareBaseline(curr, base, {
      maxSlideDrop: 0.005,
      maxDeckDrop: 0.002,
    });

    expect(res.passed).toBe(true);
    expect(res.regressedSlides).toHaveLength(0);
    expect(res.regressedDecks).toHaveLength(0);
    expect(res.meanDelta).toBeCloseTo(0, 5);
  });

  it('fails when a slide regresses beyond maxSlideDrop', () => {
    const base = makeReport([makeDeck('Deck A', [0.95, 0.96, 0.97])]);
    // Slide 2 drops from 0.96 to 0.95 (drop = 0.01 > 0.005)
    const curr = makeReport([makeDeck('Deck A', [0.95, 0.95, 0.97])]);

    const res = compareBaseline(curr, base, {
      maxSlideDrop: 0.005,
      maxDeckDrop: 0.05, // large deck tolerance
    });

    expect(res.passed).toBe(false);
    expect(res.regressedSlides).toHaveLength(1);
    expect(res.regressedSlides[0]).toMatchObject({
      deck: 'Deck A',
      n: 2,
      before: 0.96,
      after: 0.95,
    });
    expect(res.regressedSlides[0]!.drop).toBeCloseTo(0.01, 5);
  });

  it('fails when a deck regresses beyond maxDeckDrop', () => {
    const base = makeReport([makeDeck('Deck A', [0.95, 0.96, 0.97])]);
    // Each slide drops slightly by 0.003 (less than slide drop 0.005, but deck drop 0.003 > 0.002)
    const curr = makeReport([makeDeck('Deck A', [0.947, 0.957, 0.967])]);

    const res = compareBaseline(curr, base, {
      maxSlideDrop: 0.005,
      maxDeckDrop: 0.002,
    });

    expect(res.passed).toBe(false);
    expect(res.regressedSlides).toHaveLength(0);
    expect(res.regressedDecks).toEqual(['Deck A']);
  });

  it('enforces requireGain condition', () => {
    const base = makeReport([makeDeck('Deck A', [0.95, 0.96])]);
    const currNoGain = makeReport([makeDeck('Deck A', [0.95, 0.96])]);
    const currWithGain = makeReport([makeDeck('Deck A', [0.96, 0.97])]);

    const resFail = compareBaseline(currNoGain, base, {
      maxSlideDrop: 0.005,
      maxDeckDrop: 0.002,
      requireGain: true,
    });
    expect(resFail.passed).toBe(false);

    const resPass = compareBaseline(currWithGain, base, {
      maxSlideDrop: 0.005,
      maxDeckDrop: 0.002,
      requireGain: true,
    });
    expect(resPass.passed).toBe(true);
    expect(resPass.meanDelta).toBeGreaterThan(0.005);
  });

  it('respects slidesFilter when subset is evaluated', () => {
    const base = makeReport([makeDeck('Deck A', [0.95, 0.96, 0.97]), makeDeck('Deck B', [0.9, 0.91])]);
    // In curr, Deck A slide 3 regressed badly, but slideFilter only looks at slide 1
    const curr = makeReport([makeDeck('Deck A', [0.95, 0.96, 0.5]), makeDeck('Deck B', [0.9, 0.91])]);

    const filter = new Map<string, Set<number>>([['deck a', new Set([1])]]);

    const res = compareBaseline(curr, base, {
      maxSlideDrop: 0.005,
      maxDeckDrop: 0.002,
      slidesFilter: filter,
    });

    // Deck A slide 3 was not evaluated, so no regression reported
    expect(res.passed).toBe(true);
    expect(res.regressedSlides).toHaveLength(0);
  });

  it('fails when a baseline deck is missing from the run (it stopped importing or rendering)', () => {
    const base = makeReport([makeDeck('Deck A', [0.95, 0.96]), makeDeck('Deck B', [0.9, 0.91])]);
    const curr = makeReport([makeDeck('Deck A', [0.95, 0.96])]);
    const res = compareBaseline(curr, base, { maxSlideDrop: 0.005, maxDeckDrop: 0.002 });
    expect(res.passed).toBe(false);
    expect(res.missing).toEqual([{ deck: 'Deck B' }]);
    expect(res.lines.join('\n')).toContain('"Deck B" (the whole deck)');
  });

  it('fails when a baseline slide is missing from the run, and not for one a filter leaves out', () => {
    const base = makeReport([makeDeck('Deck A', [0.95, 0.96, 0.97])]);
    const curr = makeReport([makeDeck('Deck A', [0.95, 0.96])]);
    const res = compareBaseline(curr, base, { maxSlideDrop: 0.005, maxDeckDrop: 0.002 });
    expect(res.passed).toBe(false);
    expect(res.missing).toEqual([{ deck: 'Deck A', n: 3 }]);
    // A run of slides 1-2 only (--slides) was not meant to score slide 3.
    const filtered = compareBaseline(curr, base, {
      maxSlideDrop: 0.005,
      maxDeckDrop: 0.002,
      slidesFilter: new Map([['deck a', new Set([1, 2])]]),
    });
    expect(filtered.passed).toBe(true);
    expect(filtered.missing).toEqual([]);
  });

  it('expects only the decks the run was meant to score (its kinds and deck filter)', () => {
    const sample = { ...makeDeck('Sample deck', [0.9]), kind: 'sample' as const };
    const synthetic = { ...makeDeck('pro7-synth-core', [0.99]), kind: 'synthetic' as const };
    const base = makeReport([sample, synthetic]);
    const curr = makeReport([synthetic]);
    // A --corpus run without --sample-dir: the sample deck is not expected.
    const res = compareBaseline(curr, base, {
      maxSlideDrop: 0.005,
      maxDeckDrop: 0.002,
      expected: (d) => d.kind === 'synthetic',
    });
    expect(res.passed).toBe(true);
    expect(res.missing).toEqual([]);
    expect(compareBaseline(curr, base, { maxSlideDrop: 0.005, maxDeckDrop: 0.002 }).passed).toBe(false);
  });
});

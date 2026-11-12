import type { SummaryReport } from './types.ts';

export type SlideRegression = {
  deck: string;
  n: number;
  before: number;
  after: number;
  drop: number;
};

export type DeckDelta = {
  deck: string;
  before: number;
  after: number;
  delta: number;
  regressed: boolean;
};

export type RatchetResult = {
  passed: boolean;
  meanBefore: number;
  meanAfter: number;
  meanDelta: number;
  deckDeltas: DeckDelta[];
  regressedDecks: string[];
  regressedSlides: SlideRegression[];
  lines: string[];
};

export function compareBaseline(
  current: SummaryReport,
  baseline: SummaryReport,
  opts: {
    maxSlideDrop: number;
    maxDeckDrop: number;
    requireGain?: boolean;
    slidesFilter?: Map<string, Set<number>>;
  },
): RatchetResult {
  const regressedSlides: SlideRegression[] = [];
  const regressedDecks: string[] = [];
  const deckDeltas: DeckDelta[] = [];

  const allBefore: number[] = [];
  const allAfter: number[] = [];

  for (const currentDeck of current.decks) {
    const baselineDeck = baseline.decks.find((b) => b.name.toLowerCase() === currentDeck.name.toLowerCase());
    if (!baselineDeck) continue;

    const deckKey = currentDeck.name.toLowerCase();
    const slideFilter = opts.slidesFilter?.get(deckKey);

    const deckBeforeVals: number[] = [];
    const deckAfterVals: number[] = [];

    for (const currentSlide of currentDeck.perSlide) {
      if (slideFilter && !slideFilter.has(currentSlide.n)) continue;

      const baselineSlide = baselineDeck.perSlide.find((s) => s.n === currentSlide.n);
      if (!baselineSlide) continue;

      const before = baselineSlide.ssim;
      const after = currentSlide.ssim;
      const drop = before - after;

      deckBeforeVals.push(before);
      deckAfterVals.push(after);
      allBefore.push(before);
      allAfter.push(after);

      if (drop > opts.maxSlideDrop) {
        regressedSlides.push({
          deck: currentDeck.name,
          n: currentSlide.n,
          before,
          after,
          drop,
        });
      }
    }

    if (deckBeforeVals.length > 0) {
      const beforeMean = deckBeforeVals.reduce((a, b) => a + b, 0) / deckBeforeVals.length;
      const afterMean = deckAfterVals.reduce((a, b) => a + b, 0) / deckAfterVals.length;
      const delta = afterMean - beforeMean;
      const deckDrop = beforeMean - afterMean;
      const regressed = deckDrop > opts.maxDeckDrop;

      if (regressed) {
        regressedDecks.push(currentDeck.name);
      }

      deckDeltas.push({
        deck: currentDeck.name,
        before: beforeMean,
        after: afterMean,
        delta,
        regressed,
      });
    }
  }

  const meanBefore = allBefore.length > 0 ? allBefore.reduce((a, b) => a + b, 0) / allBefore.length : 0;
  const meanAfter = allAfter.length > 0 ? allAfter.reduce((a, b) => a + b, 0) / allAfter.length : 0;
  const meanDelta = meanAfter - meanBefore;

  let passed = regressedSlides.length === 0 && regressedDecks.length === 0;
  if (opts.requireGain && meanDelta <= 1e-6) {
    passed = false;
  }

  const lines: string[] = [];
  lines.push(
    `Overall SSIM: ${meanBefore.toFixed(4)} -> ${meanAfter.toFixed(4)} (delta: ${meanDelta >= 0 ? '+' : ''}${meanDelta.toFixed(4)}) [${allBefore.length} slides]`,
  );

  for (const d of deckDeltas) {
    lines.push(
      `  Deck "${d.deck}": ${d.before.toFixed(4)} -> ${d.after.toFixed(4)} (${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(4)})${d.regressed ? ' [REGRESSED]' : ''}`,
    );
  }

  if (regressedSlides.length > 0) {
    lines.push('Regressed slides:');
    for (const s of regressedSlides) {
      lines.push(
        `  "${s.deck}" slide ${s.n}: ${s.before.toFixed(4)} -> ${s.after.toFixed(4)} (drop: ${s.drop.toFixed(4)} > ${opts.maxSlideDrop})`,
      );
    }
  }

  if (regressedDecks.length > 0) {
    lines.push(`Regressed decks: ${regressedDecks.join(', ')}`);
  }

  if (opts.requireGain && meanDelta <= 1e-6) {
    lines.push(`Require-gain check failed: meanDelta ${meanDelta.toFixed(6)} <= 1e-6`);
  }

  lines.push(`Ratchet status: ${passed ? 'PASSED' : 'FAILED'}`);

  return {
    passed,
    meanBefore,
    meanAfter,
    meanDelta,
    deckDeltas,
    regressedDecks,
    regressedSlides,
    lines,
  };
}

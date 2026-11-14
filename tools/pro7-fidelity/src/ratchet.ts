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

/** A baseline deck, or a slide of one, that the run was meant to score and did not (`compareBaseline`). */
export type MissingScore = { deck: string; n?: number };

export type RatchetResult = {
  passed: boolean;
  meanBefore: number;
  meanAfter: number;
  meanDelta: number;
  deckDeltas: DeckDelta[];
  regressedDecks: string[];
  regressedSlides: SlideRegression[];
  /** Baseline decks and slides the run should have scored and has not: a deck that stopped importing fails. */
  missing: MissingScore[];
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
    /**
     * Whether the run was meant to score this baseline deck (its kind was run, the deck and slide filters
     * keep it). A deck it was meant to score and did not, or a slide of it, fails the ratchet. Default: every
     * baseline deck.
     */
    expected?: (deck: SummaryReport['decks'][number]) => boolean;
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

  // What the run should have scored and did not: a deck that no longer imports, renders or scores is a
  // regression the per-slide drops cannot see (the loop above walks the current run only).
  const missing: MissingScore[] = [];
  for (const baselineDeck of baseline.decks) {
    if (opts.expected && !opts.expected(baselineDeck)) continue;
    const key = baselineDeck.name.toLowerCase();
    const slideFilter = opts.slidesFilter?.get(key);
    const currentDeck = current.decks.find((d) => d.name.toLowerCase() === key);
    if (!currentDeck) {
      missing.push({ deck: baselineDeck.name });
      continue;
    }
    for (const s of baselineDeck.perSlide) {
      if (slideFilter && !slideFilter.has(s.n)) continue;
      if (!currentDeck.perSlide.some((c) => c.n === s.n)) missing.push({ deck: baselineDeck.name, n: s.n });
    }
  }

  const meanBefore = allBefore.length > 0 ? allBefore.reduce((a, b) => a + b, 0) / allBefore.length : 0;
  const meanAfter = allAfter.length > 0 ? allAfter.reduce((a, b) => a + b, 0) / allAfter.length : 0;
  const meanDelta = meanAfter - meanBefore;

  let passed = regressedSlides.length === 0 && regressedDecks.length === 0 && missing.length === 0;
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

  if (missing.length > 0) {
    lines.push('Missing from this run (scored in the baseline):');
    for (const m of missing)
      lines.push(`  "${m.deck}"${m.n === undefined ? ' (the whole deck)' : ` slide ${m.n}`}`);
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
    missing,
    lines,
  };
}

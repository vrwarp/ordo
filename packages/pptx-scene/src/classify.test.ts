import { describe, expect, it } from 'vitest';
import { tierOf } from './classify.ts';
import { parseDeck } from './index.ts';
import { buildDeck, grpSp, solid, sp } from './test-util.ts';

describe('tierOf (the census rules)', () => {
  it('places feature sets in the census tiers with the features that block the tier below', () => {
    expect(tierOf(new Set())).toEqual({ tier: 'T1', reasons: [] });
    expect(tierOf(new Set(['bullet', 'superSub']))).toEqual({ tier: 'T2', reasons: ['bullet', 'superSub'] });
    expect(tierOf(new Set(['deco:group', 'crop']))).toEqual({ tier: 'T3', reasons: ['deco:group'] });
    expect(tierOf(new Set(['video', 'glow']))).toEqual({ tier: 'T4', reasons: ['glow', 'video'] });
    expect(tierOf(new Set(['softEdge']))).toEqual({ tier: 'T5', reasons: ['softEdge'] });
    expect(tierOf(new Set(['deco:chart', 'group']))).toEqual({ tier: 'fallback', reasons: ['deco:chart'] });
    expect(tierOf(new Set(['artistic', 'somethingNew']))).toEqual({ tier: 'T1', reasons: [] });
  });

  it('reads features from the slide and, as deco:, from the decorations it shows', () => {
    const shape = sp({ id: 5, x: 0, y: 0, cx: 100, cy: 100, fill: solid('FF0000') });
    const scene = parseDeck(
      buildDeck({
        master: { shapes: grpSp({ id: 9, x: 0, y: 0, cx: 100, cy: 100 }, shape) },
        slides: [{}, { attrs: 'showMasterSp="0"' }],
      }),
    );
    expect(scene.slides.map((s) => s.classification.tier)).toEqual(['T3', 'T1']);
    expect(scene.slides[0]!.classification.reasons).toEqual(['deco:group']);
  });
});

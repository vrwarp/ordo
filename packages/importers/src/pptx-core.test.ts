import { convertDeck } from '@ordo/pptx-scene';
import { PPTX_SHEETS } from '@ordo/pptx-scene/version.ts';
import { describe, expect, it } from 'vitest';
import { artKinds, type Draft, ImportCore } from './pptx-core.ts';
import { pictureGuardDeck } from './pptx-guard.test-util.ts';
import { ImportLog } from './pptx-report.ts';

const core = (lo: boolean) =>
  new ImportCore({ lo, log: new ImportLog(), warn: () => {}, geomFileBytes: 1 << 20 });

describe("ImportCore.budgetLeft: what the slide budgets' guard left out (M9, lo-forms)", () => {
  it('budgetLeft lists nothing when the guard sent its left-outs to the art', () => {
    const r = convertDeck(pictureGuardDeck(), { sheets: PPTX_SHEETS });
    const s = r.slides[0]!;
    // The converter planned LibreOffice's art for the topmost pictures and lists nothing.
    expect(s.art?.elements).toHaveLength(5);
    expect(s.missing).toBeUndefined();
    const d: Draft = {
      ref: r.listed[0]!,
      slide: s.slide,
      media: new Map(),
      cls: s.classification.class,
      notes: [],
      art: s.art,
    };
    core(true).budgetLeft(d, s);
    expect(d.dropped).toBeUndefined();
    expect(d.cls).toBe('hybrid');
    // If LibreOffice fails, the art's kinds say what the slide lacks.
    expect(artKinds(s.classification.reasons)).toEqual(['decoration']);
  });

  it('still lists what a scene says the guard left out (a converter that culled it)', () => {
    const r = convertDeck(pictureGuardDeck(), { sheets: PPTX_SHEETS, libreoffice: false });
    const s = r.slides[0]!;
    expect(s.missing).toEqual(['decoration']);
    const d: Draft = { ref: r.listed[0]!, slide: s.slide, media: new Map(), cls: 'native', notes: [] };
    core(true).budgetLeft(d, s);
    expect(d.dropped).toEqual(['decoration']);
    expect(d.cls).toBe('hybrid');
  });
});

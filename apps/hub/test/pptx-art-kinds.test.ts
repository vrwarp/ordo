import { drawnWithoutArt, missingKindOf, RESIDUAL_ROWS } from '@ordo/pptx-scene';
import { describe, expect, it } from 'vitest';
import { artKinds } from '../src/pptx/nativeJob.ts';

// design/27 M9: what a hub records for a hybrid slide's art (`PptxLoSlide.kinds`, `Slide.pptx.missing`) is
// what the converter records for the same elements without LibreOffice (`residual.ts` `missingKindOf`).
describe('artKinds', () => {
  it('gives every reason of the decision table the kind the converter records without LibreOffice', () => {
    const rows = RESIDUAL_ROWS.filter((r) => r.missing && !r.reason.endsWith(':*'));
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect(artKinds([`art:${r.reason}`])).toEqual([missingKindOf([r.reason])]);
    // A row version 1 draws (`drawn`) lacks nothing, in both.
    for (const r of RESIDUAL_ROWS.filter((x) => x.drawn)) {
      expect(artKinds([`art:${r.reason}`])).toEqual([]);
      expect(drawnWithoutArt([r.reason])).toBe(true);
    }
  });

  it('keeps its own reading of reasons the table does not name, once per kind, in order', () => {
    expect(artKinds(['art:pic:emf', 'art:pic:wmf'])).toEqual(['metafile']);
    expect(artKinds(['art:preset:star5', 'art:path'])).toEqual(['decoration']);
    expect(artKinds(['native', 'art:chart', 'art:budget:shapes', 'art:custGeom'])).toEqual([
      'chart',
      'decoration',
    ]);
    // Real 3-D past the object budget: version 1 draws it flat, as the converter does without LibreOffice.
    expect(artKinds(['art:budget:3d'])).toEqual([]);
    expect(artKinds(['art:budget:3d', 'art:chart'])).toEqual(['chart']);
    expect(artKinds(['art:something-new', 'art:'])).toEqual(['element']);
    expect(artKinds([])).toEqual(['element']);
  });
});

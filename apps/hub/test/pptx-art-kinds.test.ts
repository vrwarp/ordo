import { missingKindOf, RESIDUAL_ROWS } from '@ordo/pptx-scene';
import { describe, expect, it } from 'vitest';
import { artKinds } from '../src/pptx/nativeJob.ts';

// design/27 M9: what a hub records for a hybrid slide's art (`PptxLoSlide.kinds`, `Slide.pptx.missing`) is
// what the converter records for the same elements without LibreOffice (`residual.ts` `missingKindOf`).
describe('artKinds', () => {
  it('gives every reason of the decision table the kind the converter records without LibreOffice', () => {
    const rows = RESIDUAL_ROWS.filter((r) => r.missing && !r.reason.endsWith(':*'));
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect(artKinds([`art:${r.reason}`])).toEqual([missingKindOf([r.reason])]);
  });

  it('keeps its own reading of reasons the table does not name, once per kind, in order', () => {
    expect(artKinds(['art:pic:emf', 'art:pic:wmf'])).toEqual(['metafile']);
    expect(artKinds(['art:preset:star5', 'art:path'])).toEqual(['decoration']);
    expect(artKinds(['native', 'art:chart', 'art:budget:shapes', 'art:custGeom'])).toEqual([
      'chart',
      'decoration',
    ]);
    expect(artKinds(['art:budget:3d'])).toEqual(['decoration']);
    expect(artKinds(['art:something-new', 'art:'])).toEqual(['element']);
    expect(artKinds([])).toEqual(['element']);
  });
});

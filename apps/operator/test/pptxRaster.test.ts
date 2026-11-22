/**
 * The words of the pictures of shapes (Q53, Q57.d, Q67, Q68): the import card's lines for each way the picture step ended, the
 * counts read from a hub's result, the editor's report counted from the slides, and the Re-import dialog's line. Plain English:
 * the owner's words are "picture" and "shape"; the tool's name only in the one line that tells a hub what it needs.
 */
import type { Slide } from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { importReport, readNativeResult } from '../src/lib/pptxImport.ts';
import {
  holdsRaster,
  RASTER_PICTURE_CARD,
  RASTER_REIMPORT_LINE,
  RASTER_RESET_CONFIRM,
  RASTER_RESET_HINT,
  rasterDrawnLine,
  rasterLines,
  rasterTotals,
  rasterWordsLine,
  readRasterCounts,
} from '../src/lib/pptxRaster.ts';
import { ReimportDialogView } from '../src/views/editor/PptxReport.tsx';

const base = {
  candidates: 4,
  shapes: 0,
  pictures: 0,
  stored: 0,
  reused: 0,
  putBack: 0,
  words: 0,
  skipped: { text: 0, effects: 0, fill: 0, anchored: 0, other: 0 },
  reasons: [] as string[],
};
const JARGON = /\b(raster|recipe|converter|put back|provenance|pdftoppm|poppler|stand-in|stand in)\b/i;

describe('the import card lines of the picture step', () => {
  it('says what was drawn into pictures, with the words in them', () => {
    const lines = rasterLines({ ...base, shapes: 743, pictures: 4, stored: 3, reused: 1, words: 2 });
    expect(lines).toEqual([
      "743 shapes were drawn into 4 pictures so the slide shows them whole (the pictures can be moved and resized, but the shapes in them cannot be edited; Reset slide from PowerPoint brings back the shapes that fit ordo's limits as shapes, and shapes too large stay boxes)",
      '2 shapes have words: the words are part of the picture now (they cannot be edited and the font is fixed); search finds them, and the cue label and the Stage show them when the slide has no other text',
    ]);
    expect(rasterLines({ ...base, shapes: 1, pictures: 1, stored: 1, words: 1 })[1]).toMatch(
      /^1 shape has words/,
    );
  });

  it('says why a hub made none: needs Chromium, or LibreOffice draws them as before', () => {
    expect(rasterLines({ ...base, off: 'no-maker' })).toEqual([
      'this computer cannot draw pictures of shapes (it needs Chromium): these shapes are as they were',
    ]);
    expect(rasterLines({ ...base, off: 'libreoffice' })).toEqual([
      'the pictures of these shapes come from LibreOffice, as before',
    ]);
    // Nothing to say when the deck holds none of these shapes.
    expect(rasterLines({ ...base, candidates: 0, off: 'no-maker' })).toEqual([]);
    expect(rasterLines(undefined)).toEqual([]);
  });

  it('names the shapes that stay as they were and the pictures that were not made', () => {
    expect(rasterLines({ ...base, skipped: { ...base.skipped, effects: 2, fill: 1 } })).toEqual([
      '3 shapes with a shadow, a glow, a soft edge, a 3-D look or a picture fill stay as they were',
    ]);
    const one = (putBack: number, reasons: string[]) => rasterLines({ ...base, putBack, reasons });
    expect(one(2, ['timeout'])).toEqual([
      '2 pictures could not be made in time and the shapes are as before',
    ]);
    expect(one(1, ['live'])[0]).toBe(
      '1 picture was not made because a service started; the shapes are as before: use Re-import from PowerPoint after the service',
    );
    expect(one(3, ['bytes'])[0]).toBe(
      'the pictures of this presentation would pass the picture limit: the shapes of 3 pictures stay as they were',
    );
    expect(one(1, ['font'])[0]).toContain('a font for the words in it is missing');
    expect(one(1, ['crash'])[0]).toBe('1 picture could not be made; the shapes are as before');
  });

  it('uses no jargon in any line, any card text or the dialog line', () => {
    const all = [
      ...rasterLines({
        ...base,
        shapes: 9,
        pictures: 2,
        stored: 2,
        words: 3,
        skipped: { ...base.skipped, effects: 1 },
      }),
      ...rasterLines({ ...base, putBack: 2, reasons: ['live', 'timeout', 'bytes', 'font'] }),
      ...rasterLines({ ...base, off: 'libreoffice' }),
      rasterDrawnLine(1, 1),
      rasterWordsLine(1),
      RASTER_PICTURE_CARD,
      RASTER_RESET_HINT,
      RASTER_RESET_CONFIRM,
      RASTER_REIMPORT_LINE,
    ];
    for (const line of all) expect(line, line).not.toMatch(JARGON);
    // The tool's name is in the one technician line only.
    expect(all.filter((l) => /Chromium/.test(l))).toEqual([]);
    expect(rasterLines({ ...base, off: 'no-maker' }).filter((l) => /Chromium/.test(l))).toHaveLength(1);
  });
});

describe('what a hub says and what the stored slides say', () => {
  it('reads the counts defensively', () => {
    expect(readRasterCounts(undefined)).toBeUndefined();
    expect(readRasterCounts([])).toBeUndefined();
    expect(
      readRasterCounts({
        candidates: 3,
        shapes: '9',
        pictures: 2,
        stored: 1.4,
        reused: -5,
        putBack: 1e12,
        words: 1,
        off: 'bogus',
        skipped: { text: 1, effects: 2 },
        reasons: ['font', 7, 'x'.repeat(100)],
      }),
    ).toEqual({
      candidates: 3,
      shapes: 0,
      pictures: 2,
      stored: 1,
      reused: 0,
      putBack: 1_000_000,
      words: 1,
      skipped: { text: 1, effects: 2, fill: 0, anchored: 0, other: 0 },
      reasons: ['font', 'x'.repeat(40)],
    });
    const r = readNativeResult({
      presentationId: 'p',
      slides: 1,
      rasters: { candidates: 1, off: 'no-maker' },
    });
    expect(r?.rasters).toMatchObject({ candidates: 1, off: 'no-maker' });
    expect(readNativeResult({ presentationId: 'p', slides: 1 })?.rasters).toBeUndefined();
  });

  const pictured = (n: number): Pick<Slide, 'objects'> =>
    ({
      objects: [
        {
          id: 'a',
          type: 'image',
          origin: {
            src: 'pptx',
            role: 'raster',
            raster: { cv: 3, rv: 1, pts: 128, h: 'x', n, from: 'slide' },
          },
        },
        { id: 'b', type: 'text' },
      ],
    }) as unknown as Pick<Slide, 'objects'>;

  it('counts pictures and the shapes in them from the slides (the report says the same after a re-open)', () => {
    expect(holdsRaster(pictured(3))).toBe(true);
    expect(holdsRaster({ objects: [{ id: 'b', type: 'text' } as never] })).toBe(false);
    expect(rasterTotals([pictured(3), pictured(4), { objects: [] }])).toEqual({ shapes: 7, pictures: 2 });
    expect(rasterTotals([{ objects: [] }])).toBeUndefined();
    const p = {
      source: { kind: 'pptx' as const, fileId: 'deck' },
      sections: [
        { id: 's', name: 'S', slides: [{ id: 'a', ...pictured(5), pptx: { class: 'native' } } as never] },
      ],
    };
    expect(importReport(p as never)?.rasters).toEqual({ shapes: 5, pictures: 1 });
    expect(
      importReport({ ...p, sections: [{ id: 's', name: 'S', slides: [] }] } as never)?.rasters,
    ).toBeUndefined();
  });
});

describe('the Re-import dialog line (Q67)', () => {
  const plan = {
    presentationId: 'p1',
    fileId: 'deck',
    slides: [
      { slideId: 'a', number: 1, kind: 'native' as const, action: 'regenerate' as const, userObjects: 0 },
    ],
  };
  const dialog = (pictured: boolean) =>
    renderToStaticMarkup(
      createElement(ReimportDialogView, {
        plan,
        keep: new Set<string>(),
        dirty: false,
        onKeep: () => undefined,
        onConfirm: () => undefined,
        onClose: () => undefined,
        pictured,
      }),
    );

  it('says a whole Re-import draws the pictures again, only for a presentation that holds one', () => {
    expect(dialog(true)).toContain(RASTER_REIMPORT_LINE);
    expect(dialog(false)).not.toContain('drawn into pictures again');
  });
});

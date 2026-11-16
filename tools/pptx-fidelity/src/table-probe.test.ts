import { spawnSync } from 'node:child_process';
import { readZip } from '@ordo/importers/zip.ts';
import { parseDeck, type TableElement } from '@ordo/pptx-scene';
import { describe, expect, it } from 'vitest';
import { hostFace } from './faces.ts';
import {
  LAYOUT_SLIDES,
  LO_PROBE_LAYOUT,
  LO_PROBE_ROWS,
  PROBE_FACES,
  PROBE_SIZES,
  pdfColWidths,
  pdfRowHeights,
  probeDeck,
  probeRows,
  probeSlides,
} from './table-probe.ts';

const EMU_PER_PT = 12_700;

/** The faces LibreOffice drew the probe with, when this machine has them (fontconfig). */
function hasFace(family: string): boolean {
  const r = spawnSync('fc-match', ['-f', '%{family}', family], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes(family);
}
const faces = hasFace('Carlito') && hasFace('Liberation Sans');

/** Each slide's tables: the probe slides', then the layouter slides'. */
async function probeTables() {
  const parts = await readZip(probeDeck());
  const scene = parseDeck(parts, { fontFace: hostFace });
  return scene.slides.map((s) => s.elements.filter((e): e is TableElement => e.kind === 'table'));
}

/** LibreOffice's PDF page draws the slide at this scale (its strokes' matrix): the probe's points are scaled by it. */
const PDF_SCALE = 0.998969;
/** 1/100 mm (LibreOffice's logic unit) per point. */
const MM100_PER_PT = 2540 / 72;
/** A size LibreOffice drew, read off its PDF in points (to 0.01 pt), in its own whole 1/100 mm. */
const loMm100 = (pt: number) => Math.round((pt / PDF_SCALE) * MM100_PER_PT);

/** Sizes as LibreOffice drew them, to the 1/100 mm: `got` in EMU (360 a 1/100 mm), `want` in its PDF's points. */
function near(got: readonly number[], want: readonly number[]): void {
  expect(got.map((v) => v / 360)).toEqual(want.map(loMm100));
}

describe('table probe deck', () => {
  it('writes every face at every size, alone and under an autogrow text box, the same bytes each time', async () => {
    const slides = probeSlides();
    expect(slides).toHaveLength(2 * PROBE_FACES.length * PROBE_SIZES.length);
    expect(slides.filter((s) => s.autogrow)).toHaveLength(slides.length / 2);
    expect(probeDeck()).toEqual(probeDeck());
    const all = await probeTables();
    expect(all).toHaveLength(slides.length + LAYOUT_SLIDES.length);
    const tables = all.slice(0, slides.length);
    tables.forEach((t, i) => {
      const rows = probeRows(slides[i]!.pt);
      expect(t.map((e) => e.rows.length)).toEqual([rows.left.length, rows.right.length]);
      for (const e of t) {
        expect(e.support).toBe('native');
        // Every row is stored 1 pt tall: each grows to its text.
        for (const h of e.rows) expect(h).toBeGreaterThan(EMU_PER_PT);
        expect(e.lo?.lines ?? 'font').toBe(slides[i]!.autogrow ? 'independent' : 'font');
      }
    });
    expect(LO_PROBE_ROWS).toHaveLength(slides.length);
    expect(LO_PROBE_LAYOUT).toHaveLength(LAYOUT_SLIDES.length);
  });

  it.skipIf(!faces)("sizes LibreOffice's rows as LibreOffice 24.2 drew them, to the 1/100 mm", async () => {
    const tables = (await probeTables()).slice(0, probeSlides().length);
    tables.forEach((t, i) => {
      t.forEach((e, k) => {
        // LibreOffice's rows in its whole 1/100 mm (the PDF's points, to 0.01 pt, at the page's scale, rounded:
        // each of the 324 rows reads within 0.27 of a whole 1/100 mm), the converter's in EMU (360 a 1/100 mm).
        const want = LO_PROBE_ROWS[i]![k]!.map(loMm100);
        const got = (e.lo?.rows ?? e.rows).map((h) => h / 360);
        expect(got, `slide ${i + 1}, table ${k + 1}`).toEqual(want);
      });
    });
  });

  it("widens narrow columns and sizes merges from the first column as LibreOffice 24.2's layouter", async () => {
    // Column widths depend on the cells' margins only, not on the faces.
    const tables = (await probeTables()).slice(probeSlides().length);
    LAYOUT_SLIDES.forEach((l, j) => {
      expect(tables[j]).toHaveLength(2);
      tables[j]!.forEach((e, k) => {
        expect(e.support).toBe('native');
        expect(e.cols).toEqual(l.tables[k]!.cols);
        if (l.measure === 'cols') near(e.lo?.cols ?? e.cols, LO_PROBE_LAYOUT[j]![k]!);
      });
    });
  });

  it.skipIf(!faces)(
    "sizes merges from the first row as LibreOffice 24.2's layouter, to the 1/100 mm",
    async () => {
      const tables = (await probeTables()).slice(probeSlides().length);
      LAYOUT_SLIDES.forEach((l, j) => {
        if (l.measure !== 'rows') return;
        tables[j]!.forEach((e, k) => {
          near(e.lo?.rows ?? e.rows, LO_PROBE_LAYOUT[j]![k]!);
        });
      });
    },
  );

  it.skipIf(!faces)(
    'sets lines apart by about 1.217 × the size alone and 1.2 × after an autogrow shape',
    () => {
      // Calibri 14 pt, seven paragraphs: LibreOffice's rows less the margins and its extra 1/100 mm.
      const n = PROBE_SIZES.length;
      const at = PROBE_SIZES.indexOf(14);
      const line = (row: number) => (row - 7.2 - 0.028) / 7 / 14;
      expect(line(LO_PROBE_ROWS[at]![0][2]!)).toBeCloseTo(1.216, 2);
      expect(line(LO_PROBE_ROWS[PROBE_FACES.length * n + at]![0][2]!)).toBeCloseTo(1.199, 2);
      // Font-independent spacing does not depend on the face: Arial's rows are Calibri's there.
      const arial = PROBE_FACES.findIndex((f) => f.family === 'Arial');
      expect(LO_PROBE_ROWS[(PROBE_FACES.length + arial) * n + at]).toEqual(
        LO_PROBE_ROWS[PROBE_FACES.length * n + at],
      );
    },
  );

  it("reads the rows' borders out of LibreOffice's PDF as SVG", () => {
    const stroke = (x0: number, y: number, x1: number) =>
      `<path fill="none" stroke-width="0.85" d="M ${x0} ${y} L ${x1} ${y} " transform="matrix(0.5, 0, 0, -0.5, 0, 540)"/>`;
    const vertical = '<path fill="none" d="M 60 900 L 60 100 " transform="matrix(0.5, 0, 0, -0.5, 0, 540)"/>';
    const svg = [
      stroke(60, 1000, 800),
      stroke(60, 950, 800),
      stroke(60, 850, 800),
      vertical,
      stroke(1100, 1000, 1800),
      stroke(1100, 990, 1800),
    ].join('');
    expect(pdfRowHeights(svg)).toEqual([[25, 50], [5]]);
    // Column widths from the vertical strokes alike (the first one of the left table's is at x 30).
    const across = (x: number, y0: number, y1: number) =>
      `<path fill="none" d="M ${x} ${y0} L ${x} ${y1} " transform="matrix(0.5, 0, 0, -0.5, 0, 540)"/>`;
    const cols = [across(60, 900, 100), across(460, 900, 500), across(560, 900, 100), across(1100, 900, 100)];
    expect(pdfColWidths([...cols, stroke(60, 1000, 800), across(1180, 900, 100)].join(''))).toEqual([
      [200, 50],
      [40],
    ]);
  });
});

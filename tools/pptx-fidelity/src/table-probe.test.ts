import { spawnSync } from 'node:child_process';
import { readZip } from '@ordo/importers/zip.ts';
import { parseDeck, type TableElement } from '@ordo/pptx-scene';
import { describe, expect, it } from 'vitest';
import { hostFace } from './faces.ts';
import {
  LO_PROBE_ROWS,
  PROBE_FACES,
  PROBE_SIZES,
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

async function probeTables() {
  const parts = await readZip(probeDeck());
  const scene = parseDeck(parts, { fontFace: hostFace });
  return scene.slides.map((s) => s.elements.filter((e): e is TableElement => e.kind === 'table'));
}

describe('table probe deck', () => {
  it('writes every face at every size, alone and under an autogrow text box, the same bytes each time', async () => {
    const slides = probeSlides();
    expect(slides).toHaveLength(2 * PROBE_FACES.length * PROBE_SIZES.length);
    expect(slides.filter((s) => s.autogrow)).toHaveLength(slides.length / 2);
    expect(probeDeck()).toEqual(probeDeck());
    const tables = await probeTables();
    expect(tables).toHaveLength(slides.length);
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
  });

  it.skipIf(!faces)("sizes LibreOffice's rows as LibreOffice 24.2 drew them, within 0.25 pt", async () => {
    const tables = await probeTables();
    let worst = 0;
    tables.forEach((t, i) => {
      t.forEach((e, k) => {
        const want = LO_PROBE_ROWS[i]![k]!;
        const got = (e.lo?.rows ?? e.rows).map((h) => h / EMU_PER_PT);
        expect(got).toHaveLength(want.length);
        got.forEach((h, r) => {
          // The PDF page is the slide scaled by 0.99897: allow for it on tall rows.
          worst = Math.max(worst, Math.abs(h - want[r]!));
          expect(Math.abs(h - want[r]!)).toBeLessThanOrEqual(0.05 + 0.0015 * want[r]!);
        });
      });
    });
    expect(worst).toBeLessThan(0.25);
  });

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
  });
});

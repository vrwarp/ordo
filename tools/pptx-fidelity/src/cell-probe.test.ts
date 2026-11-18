import { spawnSync } from 'node:child_process';
import { readZip } from '@ordo/importers/zip.ts';
import { parseDeck, type TableElement } from '@ordo/pptx-scene';
import { loAscent, loBlockTop, loLineHeight } from '@ordo/pptx-scene/tables.ts';
import { describe, expect, it } from 'vitest';
import {
  CELL_TABLES,
  type CellPara,
  cellProbeDeck,
  cellRows,
  cellSlides,
  LO_CELL_PROBE,
  pdfBaselines,
  pdfRowEdges,
} from './cell-probe.ts';
import { hostFace } from './faces.ts';

/** 1/100 mm per EMU. */
const MM100 = 360;

/** Carlito, which LibreOffice draws Calibri with, when this machine has it (fontconfig). */
function hasFace(family: string): boolean {
  const r = spawnSync('fc-match', ['-f', '%{family}', family], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes(family);
}
const faces = hasFace('Carlito');

async function probeTables(): Promise<TableElement[][]> {
  const scene = parseDeck(await readZip(cellProbeDeck()), { fontFace: hostFace });
  return scene.slides.map((s) => s.elements.filter((e): e is TableElement => e.kind === 'table'));
}

/**
 * A probe cell's lines as LibreOffice draws them (`tables.ts` `loLayout`'s drawn block, the face's own
 * spacing): each line as tall as its tallest portion (a line no taller than the paragraph's first size is that
 * size), 107 % truncated with what it adds above the baseline; an empty paragraph one line of its end mark.
 */
function drawnLines(paras: readonly CellPara[]): { height: number; ascent: number; glyphs: boolean }[] {
  const face = hostFace('Calibri', false, false);
  return paras.map((p) => {
    const sizes = p.runs.length ? [Math.max(...p.runs)] : [p.endPt ?? 1];
    let asc = 0;
    let desc = 0;
    for (const pt of sizes) {
      const a = loAscent(pt, face, 'font');
      asc = Math.max(asc, a);
      desc = Math.max(desc, loLineHeight(pt, face, 'font') - a);
    }
    const natural = asc + desc;
    if (!p.line) return { height: natural, ascent: asc, glyphs: p.runs.length > 0 };
    const height = Math.trunc((natural * Math.round(p.line * 100)) / 100);
    return { height, ascent: asc + height - natural, glyphs: p.runs.length > 0 };
  });
}

describe('cell probe deck', () => {
  it('writes both sizes and parts, alone and under an autogrow text box, the same bytes each time', async () => {
    const slides = cellSlides();
    expect(slides).toHaveLength(8);
    expect(slides.filter((s) => s.autogrow)).toHaveLength(4);
    expect(cellProbeDeck()).toEqual(cellProbeDeck());
    const all = await probeTables();
    expect(all).toHaveLength(slides.length);
    expect(LO_CELL_PROBE).toHaveLength(slides.length);
    all.forEach((t, i) => {
      const rows = cellRows(slides[i]!.pt, slides[i]!.part);
      expect(t.map((e) => e.rows.length)).toEqual([rows.length, rows.length]);
      expect(LO_CELL_PROBE[i]!.map((lo) => lo.length)).toEqual([rows.length, rows.length]);
      for (const e of t) {
        expect(e.support).toBe('native');
        expect(e.lo?.lines ?? 'font').toBe(slides[i]!.autogrow ? 'independent' : 'font');
      }
    });
  });

  it.skipIf(!faces)("sizes LibreOffice's rows as LibreOffice 24.2 drew them, to the 1/100 mm", async () => {
    const tables = await probeTables();
    tables.forEach((t, i) => {
      t.forEach((e, k) => {
        const got = (e.lo?.rows ?? e.rows).map((h) => h / MM100);
        expect(got, `slide ${i + 1}, table ${k + 1}`).toEqual(LO_CELL_PROBE[i]![k]!.map(([h]) => h));
      });
    });
  });

  it.skipIf(!faces)(
    'puts the lines of a centred cell where LibreOffice 24.2 drew them, full, overflowing or with room',
    async () => {
      const tables = await probeTables();
      cellSlides().forEach((s, i) => {
        const rows = cellRows(s.pt, s.part);
        tables[i]!.forEach((e, k) => {
          const margin = CELL_TABLES[k]!.mar ? 0 : 127;
          rows.forEach((r, j) => {
            const lines = drawnLines(r.paras);
            const drawn = lines.reduce((a, l) => a + l.height, 0);
            const inner = (e.lo?.rows ?? e.rows)[j]! / MM100 - 2 * margin;
            let y = margin + loBlockTop(inner, drawn, 'middle');
            const got: number[] = [];
            for (const l of lines) {
              if (l.glyphs) got.push(y + l.ascent);
              y += l.height;
            }
            expect(got, `slide ${i + 1}, table ${k + 1}, row ${r.name}`).toEqual(
              LO_CELL_PROBE[i]![k]![j]![1],
            );
          });
        });
      });
    },
  );

  it("reads the rows' borders and the glyphs' baselines out of LibreOffice's PDF as SVG", () => {
    const stroke = (x0: number, y: number, x1: number) =>
      `<path fill="none" stroke-width="0.85" d="M ${x0} ${y} L ${x1} ${y} " transform="matrix(0.5, 0, 0, -0.5, 0, 540)"/>`;
    const glyph = (x: number, y: number) => `<use xlink:href="#glyph-0-3" x="${x}" y="${y}"/>`;
    const svg = [
      stroke(60, 1000, 800),
      stroke(60, 950, 800),
      stroke(1100, 1000, 1800),
      glyph(40, 30.5),
      glyph(45, 30.5),
      glyph(40, 44.25),
      glyph(600, 12),
    ].join('');
    expect(pdfRowEdges(svg)).toEqual([[40, 65], [40]]);
    expect(pdfBaselines(svg)).toEqual([[30.5, 44.25], [12]]);
  });
});

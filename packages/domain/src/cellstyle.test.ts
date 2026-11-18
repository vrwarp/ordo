import { describe, expect, it } from 'vitest';
import { cellStyleOf, cellTextStyle } from './cellstyle.ts';
import type { CellStyle, TextStyle } from './schemas.ts';
import * as table from './table.ts';

const BASE: TextStyle = {
  fontFamily: 'Calibri',
  fontWeight: 400,
  fontStyle: 'normal',
  fontSizePx: 36,
  color: { r: 0, g: 0, b: 0, a: 1 },
  align: 'left',
  valign: 'top',
  lineHeight: 1.2,
  letterSpacing: 0,
  padding: 0,
  transform: 'none',
  lineModel: 'office',
  insets: { l: 14, t: 7, r: 14, b: 7 },
};

/** Cell box styles that differ from `BASE` in every way a cell style can, and in ways it cannot. */
const STYLES: TextStyle[] = [
  BASE,
  { ...BASE, fontWeight: 700, color: { r: 255, g: 255, b: 255, a: 1 } },
  { ...BASE, align: 'right', valign: 'bottom', fontStyle: 'italic' },
  { ...BASE, justify: true },
  { ...BASE, align: 'center', justify: true },
  { ...BASE, insets: { l: 0, t: 0, r: 0, b: 0 }, lang: 'ko-KR', fallbackFonts: ['Noto Sans KR'] },
  { ...BASE, direction: 'rtl', fontFamily: 'Noto Naskh Arabic', fontSizePx: 20 },
  { ...BASE, autofit: 'shrink', fitScale: { font: 0.8, spacing: 1 }, lineHeight: 1.5, letterSpacing: 2 },
];
const ENTRIES: (CellStyle | undefined)[] = [
  undefined,
  {},
  { fontWeight: 700 },
  { align: 'justify' },
  { align: 'center', valign: 'middle', vert: 'vert270' },
  { insets: { l: 1, t: 2, r: 3, b: 4 }, lang: 'ar', direction: 'rtl', fallbackFonts: ['Noto Naskh Arabic'] },
];

describe('cell styles (cellstyle.ts, the pure module the converter writes entries with)', () => {
  it("are the domain table model's: table.ts re-exports them, and they agree on every case", () => {
    expect(table.cellStyleOf).toBe(cellStyleOf);
    expect(table.cellTextStyle).toBe(cellTextStyle);
    for (const s of STYLES)
      for (const vert of [undefined, 'horz', 'vert', 'eaVert'] as const)
        expect(cellStyleOf(BASE, s, vert)).toEqual(table.cellStyleOf(BASE, s, vert));
    for (const base of STYLES)
      for (const e of ENTRIES) expect(cellTextStyle(base, e)).toEqual(table.cellTextStyle(base, e));
  });

  it('round-trip: a cell style entry over the base gives back the cell box style it was made from', () => {
    // A justified cell is left aligned and justified (PowerPoint's algn="just"): centre and justify is not one.
    for (const s of STYLES.slice(0, 7).filter((x) => !(x.justify && x.align !== 'left'))) {
      const entry = cellStyleOf(BASE, s);
      const back = cellTextStyle(BASE, entry);
      for (const k of [
        'fontWeight',
        'color',
        'align',
        'valign',
        'fontStyle',
        'insets',
        'lang',
        'direction',
      ] as const)
        expect(back[k], k).toEqual(s[k]);
      expect(!!back.justify).toBe(!!s.justify);
      expect(back.autofit).toBeUndefined();
    }
  });
});

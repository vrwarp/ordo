import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import type { TableCell, TableData } from './schemas.ts';

/*
 * A table with East Asian vertical cells as the PowerPoint converter stores it since sub-wave 1c (rule V: LibreOffice
 * 24.2 draws `eaVert` cells as horizontal ones, so such a table is the table object; the cell style keeps `vert`
 * for a later vertical text engine and today's renderer draws it horizontally): the Korean bulletin's slide 2 in
 * small, a narrow first column whose '1년차' and '２년차' cells are eaVert and centred over four rows each, beside
 * the years and the days. For the editing, older-build and renderer tests (vitest only runs *.test.ts).
 */

const navy = { r: 20, g: 40, b: 90, a: 1 };
const grey = { r: 200, g: 200, b: 200, a: 1 };

/** Its vertical cells (indices in `cells`): '1년차' and '２년차'. */
export const VERTICAL_CELLS = [0, 9] as const;

/** 3 columns (a 70 px one first) by 8 rows of 40 px; cells 0 and 9 eaVert over 4 rows (style 0). */
export function verticalTable(): TableData {
  const cells: TableCell[] = [];
  for (const [r, label] of [
    [0, '1년차'],
    [4, '２년차'],
  ] as const) {
    cells.push({ text: label, rowSpan: 4, style: 0 }, { text: `${2019 + r}` }, { text: '3일간' });
    for (let k = 1; k < 4; k++) cells.push({ text: `${2019 + r + k}` }, { text: '4일간' });
  }
  return {
    cols: [70, 150, 300],
    rows: Array(8).fill(40),
    cells,
    base: {
      ...DEFAULT_LYRIC_STYLE,
      fontFamily: 'Noto Sans KR',
      fontSizePx: 24,
      color: navy,
      align: 'center',
      valign: 'middle',
      lineModel: 'office',
      insets: { l: 7, t: 3, r: 7, b: 3 },
    },
    styles: [{ vert: 'eaVert' }],
    lineStyles: [{ width: 1, color: grey }],
    h: [...Array(9)].map((_, k) => [k, 0, 3, 0] as [number, number, number, number]),
    v: [...Array(4)].map((_, k) => [k, 0, 8, 0] as [number, number, number, number]),
    rowRule: 'fixed',
  };
}

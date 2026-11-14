import { compatRule } from './rule.ts';

/**
 * A table's rows are as tall as LibreOffice 24.2 makes them (`TableElement.lo`, measured with the table
 * probe deck, `table-probe.ts`): its lines at the face's ascent and descent at a 600 dpi reference device, or
 * at 1.2 × the font height (font-independent line spacing) once a text shape that grows to its text came
 * before the table on the slide; text taller than such a row runs into the cell's margins, each line's
 * baseline sits at the face's ascent, and the text is laid out and drawn at the font's whole-pixel size at
 * that device (`loSizePt`). ordo sizes rows by the faces' line heights, as PowerPoint does. The rule also
 * lays the grid out as LibreOffice's `TableLayouter` does with an imported table (`LayoutTableWidth`,
 * `LayoutTableHeight`, not fitted to the frame; `tables.ts` `loColumns`, `loGrowRows`, the probe's layouter
 * slides): every column is at least as wide as the widest minimum of its single-column cells, the left and
 * right margins and 1 mm in 1/100 mm (`Cell::getMinimumWidth`), the table growing to the right; and a
 * merge's minimum width or height is checked only at its last column or row, less the ones it spans before,
 * where LibreOffice's subtraction loop ends at once for a merge from the first column or row: such a merge
 * puts its whole minimum width, or its whole text height, on its last column or row. ordo keeps the grid's
 * widths and gives a merge only its shortfall over the rows it spans.
 */
export const cellRows = compatRule({
  key: 'cellRows',
  text:
    'table rows and columns as LibreOffice lays them out (its line heights, font-independent after an ' +
    'autogrow shape; column minimums; merges from the first row or column sized at their last)',
  hits: (e) => e.kind === 'table' && e.support !== 'residual' && !!e.lo,
});

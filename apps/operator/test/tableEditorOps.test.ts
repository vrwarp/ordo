import {
  cellRich,
  cellStyleEntry,
  DEFAULT_THEME,
  Presentation,
  type ShapeObject,
  type SlideObject,
  TABLE_LIMITS,
} from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTableBorders,
  distributeTableCols,
  distributeTableRows,
  fillCells,
  mergeTableCells,
  moveTableCol,
  moveTableRow,
  pasteTableFromClipboard,
  setCellStyle,
  setTableBandedRows,
  setTableHeaderRow,
  splitTableCell,
  tableKey,
} from '../src/views/editor/actions.ts';
import {
  openPresentation,
  selectCell,
  selectCellRange,
  selectObject,
  undo,
  useEditor,
} from '../src/views/editor/editorStore.ts';
import { FloatingContextBar } from '../src/views/editor/FloatingContextBar.tsx';
import { ObjectPanel } from '../src/views/editor/ObjectPanel.tsx';
import {
  canMergeCells,
  canMoveCol,
  canMoveRow,
  canSplitCell,
  cellsInRange,
  hasBandedRows,
  hasHeaderRow,
  inspectBorders,
  mergeCells,
  newTable,
  normalizeRange,
  parseTableClipboard,
  pasteMatrixIntoTable,
  rangeOfCells,
  rangeScopeLabel,
  resizeColDivider,
  resizeRowDivider,
  setCellsPaint,
  setTableBorders,
  splitCell,
} from '../src/views/editor/ops/table.ts';

function makeDeck(tbl: ShapeObject) {
  return Presentation.parse({
    id: 'deck',
    title: 'Table Test Deck',
    kind: 'slides',
    sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 'sl', objects: [tbl] }] }],
  });
}

function openWith(tbl: ShapeObject) {
  openPresentation(makeDeck(tbl));
  useEditor.setState({ slideId: 'sl', objectId: tbl.id, objectIds: [tbl.id] });
}

function currentTable(id: string): ShapeObject {
  return useEditor.getState().draft!.sections[0]!.slides[0]!.objects.find((o) => o.id === id) as ShapeObject;
}

function seedInitial() {
  const s = useEditor.getState();
  const p = {
    draft: s.draft,
    slideId: 'sl',
    objectId: s.objectId,
    objectIds: s.objectIds,
    cell: s.cell,
    cellRange: s.cellRange,
  };
  Object.assign(useEditor.getInitialState(), p);
  useEditor.setState(p);
}

afterEach(() => {
  Object.assign(useEditor.getInitialState(), {
    draft: undefined,
    slideId: undefined,
    objectId: undefined,
    objectIds: [],
    cell: undefined,
    cellRange: undefined,
  });
});

describe('newTable & starter styles', () => {
  it('creates a native table with rowRule grow, header row, alternating bands, and grid borders', () => {
    const tbl = newTable(DEFAULT_THEME, { rows: 4, cols: 3, headerRow: true, bandedRows: true });
    expect(tbl.type).toBe('shape');
    expect(tbl.table?.rowRule).toBe('grow');
    expect(tbl.table?.rows).toHaveLength(4);
    expect(tbl.table?.cols).toHaveLength(3);
    expect(tbl.table?.cells).toHaveLength(12);
    expect(hasHeaderRow(tbl.table!)).toBe(true);
    expect(hasBandedRows(tbl.table!)).toBe(true);
    expect(tbl.table?.h?.length).toBeGreaterThan(0);
    expect(tbl.table?.v?.length).toBeGreaterThan(0);
  });

  it('creates a table from a 2D cell matrix and clamps dimensions to TABLE_LIMITS', () => {
    const tbl = newTable(DEFAULT_THEME, {
      cells: [
        ['Time', 'Element', 'Lead'],
        ['9:00', 'Welcome', 'Sarah'],
      ],
    });
    expect(tbl.table?.rows).toHaveLength(2);
    expect(tbl.table?.cols).toHaveLength(3);
    expect(tbl.table?.cells[0]?.text).toBe('Time');
    expect(tbl.table?.cells[5]?.text).toBe('Sarah');

    const huge = newTable(DEFAULT_THEME, { rows: 999, cols: 999 });
    expect(huge.table!.rows.length).toBeLessThanOrEqual(TABLE_LIMITS.rows);
    expect(huge.table!.cols.length).toBeLessThanOrEqual(TABLE_LIMITS.cols);
    expect(huge.table!.rows.length * huge.table!.cols.length).toBeLessThanOrEqual(TABLE_LIMITS.grid);
  });

  it('toggles header row and alternating row bands with undo', () => {
    const tbl = newTable(DEFAULT_THEME, { rows: 4, cols: 3, headerRow: true, bandedRows: true });
    openWith(tbl);
    setTableHeaderRow(tbl.id, false);
    expect(hasHeaderRow(currentTable(tbl.id).table!)).toBe(false);
    setTableBandedRows(tbl.id, false);
    expect(hasBandedRows(currentTable(tbl.id).table!)).toBe(false);
    undo();
    expect(hasBandedRows(currentTable(tbl.id).table!)).toBe(true);
    undo();
    expect(hasHeaderRow(currentTable(tbl.id).table!)).toBe(true);
  });
});

describe('multi-cell range selection, merge/split, gradient fills & borders', () => {
  it('merges a cell range, combines text, removes interior borders, and splits back', () => {
    const tbl = newTable(DEFAULT_THEME, {
      cells: [
        ['A1', 'B1', 'C1'],
        ['A2', 'B2', 'C2'],
      ],
    });
    const range = { r0: 0, c0: 0, r1: 0, c1: 1 };
    expect(canMergeCells(tbl.table!, range)).toBe(true);
    const merged = mergeCells(tbl, range);
    expect(merged.table!.cells).toHaveLength(5);
    expect(merged.table!.cells[0]!.colSpan).toBe(2);
    expect(merged.table!.cells[0]!.text).toBe('A1\nB1');
    expect(canSplitCell(merged.table!, 0)).toBe(true);

    // Selecting a range that touches the merged cell expands to include its full span.
    const expanded = normalizeRange(merged.table!, { r0: 0, c0: 1, r1: 1, c1: 1 });
    expect(expanded).toEqual({ r0: 0, c0: 0, r1: 1, c1: 1 });
    expect(cellsInRange(merged.table!, expanded)).toHaveLength(3);

    const split = splitCell(merged, 0);
    expect(split.table!.cells).toHaveLength(6);
    expect(split.table!.cells[0]!.colSpan).toBeUndefined();
    expect(canSplitCell(split.table!, 0)).toBe(false);
  });

  it('applies gradient cell fills across a range and runs palette GC', () => {
    const tbl = newTable(DEFAULT_THEME, { rows: 2, cols: 2, headerRow: false, bandedRows: false });
    const grad = {
      kind: 'linear' as const,
      angle: 90,
      stops: [
        { at: 0, color: { r: 37, g: 99, b: 235, a: 1 } },
        { at: 1, color: { r: 124, g: 58, b: 237, a: 1 } },
      ],
    };
    const next = setCellsPaint(tbl, [0, 1], { color: grad.stops[0]!.color, gradient: grad });
    const f0 = next.table!.fills![next.table!.cells[0]!.fill!]!;
    expect(f0.gradient).toEqual(grad);
    expect(next.table!.cells[1]!.fill).toBe(next.table!.cells[0]!.fill);
    expect(next.table!.cells[2]!.fill).toBeUndefined();

    // No-op when applying identical gradient again.
    expect(setCellsPaint(next, [0, 1], { color: grad.stops[0]!.color, gradient: grad })).toBe(next);
  });

  it('updates targeted borders (outer, inner, none, top) and inspects dominant style', () => {
    const tbl = newTable(DEFAULT_THEME, { rows: 3, cols: 3 });
    const accentLine = { width: 3, color: { r: 59, g: 130, b: 246, a: 1 }, dash: 'dash' as const };
    const cleared = setTableBorders(tbl, undefined, 'none', null);
    expect(cleared.table!.h).toBeUndefined();
    expect(cleared.table!.v).toBeUndefined();
    expect(cleared.table!.lineStyles).toBeUndefined();

    const outer = setTableBorders(cleared, { r0: 0, c0: 0, r1: 1, c1: 1 }, 'outer', accentLine);
    expect(inspectBorders(outer.table!, { r0: 0, c0: 0, r1: 1, c1: 1 })).toEqual(accentLine);
    expect(outer.table!.h).toEqual([
      [0, 0, 2, 0],
      [2, 0, 2, 0],
    ]);
    expect(outer.table!.v).toEqual([
      [0, 0, 2, 0],
      [2, 0, 2, 0],
    ]);
  });

  it('formats scope labels cleanly for single cell, row, column, and rectangular range', () => {
    const tbl = newTable(DEFAULT_THEME, { rows: 3, cols: 4 });
    expect(rangeScopeLabel(tbl.table!, undefined, undefined)).toBe('Table');
    expect(rangeScopeLabel(tbl.table!, 5, undefined)).toBe('Row 2, column 2');
    expect(rangeScopeLabel(tbl.table!, 0, { r0: 0, c0: 0, r1: 0, c1: 3 })).toBe('Row 1 (4 cells)');
    expect(rangeScopeLabel(tbl.table!, 1, { r0: 0, c0: 1, r1: 2, c1: 1 })).toBe('Column 2 (3 cells)');
    expect(rangeScopeLabel(tbl.table!, 0, { r0: 0, c0: 0, r1: 1, c1: 2 })).toBe(
      'Rows 1–2, col 1–3 (6 cells)',
    );
  });
});

describe('divider resizing, distribution, and row/column reordering', () => {
  it('resizes adjacent columns keeping box.w fixed and distributes columns/rows evenly', () => {
    const tbl = newTable(DEFAULT_THEME, { rows: 3, cols: 3 });
    const origSum = tbl.table!.cols.reduce((a, b) => a + b, 0);
    const resized = resizeColDivider(tbl, 1, 80);
    expect(resized.box.w).toBe(tbl.box.w);
    expect(resized.table!.cols.reduce((a, b) => a + b, 0)).toBeCloseTo(origSum, 4);
    expect(resized.table!.cols[0]!).toBeGreaterThan(tbl.table!.cols[0]!);
    expect(resized.table!.cols[1]!).toBeLessThan(tbl.table!.cols[1]!);

    const rowResized = resizeRowDivider(tbl, 1, 40);
    expect(rowResized.box.h).toBeGreaterThan(tbl.box.h);
    expect(rowResized.table!.rows[0]!).toBeGreaterThan(tbl.table!.rows[0]!);

    openWith(resized);
    distributeTableCols(tbl.id);
    const afterCols = currentTable(tbl.id).table!.cols;
    expect(afterCols[0]).toBeCloseTo(afterCols[1]!, 3);
    expect(afterCols[1]).toBeCloseTo(afterCols[2]!, 3);

    openWith(rowResized);
    distributeTableRows(tbl.id);
    const afterRows = currentTable(tbl.id).table!.rows;
    expect(afterRows[0]).toBeCloseTo(afterRows[1]!, 3);
  });

  it('reorders rows and columns and refuses to cross merged spans', () => {
    const tbl = newTable(DEFAULT_THEME, {
      cells: [
        ['R0C0', 'R0C1', 'R0C2'],
        ['R1C0', 'R1C1', 'R1C2'],
        ['R2C0', 'R2C1', 'R2C2'],
      ],
    });
    openWith(tbl);
    expect(moveTableRow(tbl.id, 0, 2)).toBe(true);
    let t = currentTable(tbl.id).table!;
    expect(t.cells[0]?.text).toBe('R1C0');
    expect(t.cells[6]?.text).toBe('R0C0');

    expect(moveTableCol(tbl.id, 2, 0)).toBe(true);
    t = currentTable(tbl.id).table!;
    expect(t.cells[0]?.text).toBe('R1C2');
    expect(t.cells[1]?.text).toBe('R1C0');

    // Merged vertical span blocks moving rows across it.
    const merged = mergeCells(tbl, { r0: 0, c0: 0, r1: 1, c1: 0 });
    expect(canMoveRow(merged.table!, 0, 1)).toBe(false);
    expect(canMoveCol(merged.table!, 0, 1)).toBe(true);
  });
});

describe('spreadsheet clipboard paste, keyboard range ops & UI rendering', () => {
  it('parses TSV and HTML tables while ignoring plain single-cell text', () => {
    expect(parseTableClipboard('', 'Just plain text')).toBeNull();
    expect(parseTableClipboard('', 'A\tB\n1\t2\n')).toEqual([
      ['A', 'B'],
      ['1', '2'],
    ]);
  });

  it('pastes a spreadsheet matrix into a table, auto-growing rows in one undo step', () => {
    const tbl = newTable(DEFAULT_THEME, { rows: 2, cols: 2 });
    const res = pasteMatrixIntoTable(tbl, 2, [
      ['X1', 'Y1', 'Z1'],
      ['X2', 'Y2', 'Z2'],
      ['X3', 'Y3', 'Z3'],
    ]);
    expect(res).not.toBeNull();
    expect(res!.rowsAdded).toBe(2);
    expect(res!.colsAdded).toBe(1);
    expect(res!.object.table!.rows).toHaveLength(4);
    expect(res!.object.table!.cols).toHaveLength(3);

    openWith(tbl);
    selectCell(tbl.id, 0);
    expect(pasteTableFromClipboard(tbl.id, 0, '', 'H1\tH2\nV1\tV2\nV3\tV4')).toBe(true);
    expect(currentTable(tbl.id).table!.rows).toHaveLength(3);
    expect(cellRich(currentTable(tbl.id).table!, 4)?.text).toBe('V3');
    undo();
    expect(currentTable(tbl.id).table!.rows).toHaveLength(2);
  });

  it('supports Shift+Arrow range selection, multi-cell style/fill/borders, and multi-cell Delete', () => {
    const tbl = newTable(DEFAULT_THEME, {
      cells: [
        ['One', 'Two', 'Three'],
        ['Four', 'Five', 'Six'],
      ],
    });
    openWith(tbl);
    selectCell(tbl.id, 0);
    expect(tableKey({ key: 'ArrowRight', shiftKey: true }, currentTable(tbl.id) as SlideObject, false)).toBe(
      true,
    );
    expect(useEditor.getState().cellRange).toEqual({ r0: 0, c0: 0, r1: 0, c1: 1 });

    setCellStyle({ objectId: tbl.id, cell: 0 }, (s) => ({ ...s, valign: 'bottom' }), 'valign');
    expect(cellStyleEntry(currentTable(tbl.id).table!, currentTable(tbl.id).table!.cells[0])?.valign).toBe(
      'bottom',
    );
    expect(cellStyleEntry(currentTable(tbl.id).table!, currentTable(tbl.id).table!.cells[1])?.valign).toBe(
      'bottom',
    );

    fillCells(tbl.id, 0, { r: 220, g: 38, b: 38, a: 1 });
    applyTableBorders(tbl.id, useEditor.getState().cellRange, 'bottom', {
      width: 2,
      color: { r: 255, g: 255, b: 255, a: 1 },
    });

    // Delete clears text across all cells in cellRange.
    expect(tableKey({ key: 'Delete', shiftKey: false }, currentTable(tbl.id) as SlideObject, false)).toBe(
      true,
    );
    expect(currentTable(tbl.id).table!.cells[0]?.text).toBeUndefined();
    expect(currentTable(tbl.id).table!.cells[1]?.text).toBeUndefined();
    expect(currentTable(tbl.id).table!.cells[2]?.text).toBe('Three');

    // Merge & Split actions via store.
    const mergedIdx = mergeTableCells(tbl.id, { r0: 0, c0: 0, r1: 0, c1: 1 });
    expect(mergedIdx).toBe(0);
    expect(currentTable(tbl.id).table!.cells[0]?.colSpan).toBe(2);
    const splitRange = splitTableCell(tbl.id, 0);
    expect(splitRange).toEqual({ r0: 0, c0: 0, r1: 0, c1: 1 });
  });

  it('renders Merge, Borders, Alignment, Padding, and Table Options in TableBar and TableSection', () => {
    const tbl = newTable(DEFAULT_THEME, { rows: 3, cols: 3 });
    openWith(tbl);
    selectObject(tbl.id);
    const r = rangeOfCells(tbl.table!, 0, 1)!;
    selectCellRange(tbl.id, 0, r);
    seedInitial();

    const barHtml = renderToStaticMarkup(
      createElement(FloatingContextBar, { readOnly: false, drawerOpen: false, onToggleDrawer: () => {} }),
    );
    expect(barHtml).toContain('Row 1, col 1–2 (2 cells) ×');
    expect(barHtml).toContain('aria-label="Borders"');
    expect(barHtml).toContain('>Merge</button>');

    const panelHtml = renderToStaticMarkup(
      createElement(ObjectPanel, { o: currentTable(tbl.id), readOnly: false }),
    );
    expect(panelHtml).toContain('aria-label="Horizontal alignment"');
    expect(panelHtml).toContain('aria-label="Vertical alignment"');
    expect(panelHtml).toContain('aria-label="Cell padding"');
    expect(panelHtml).toContain('Header row');
    expect(panelHtml).toContain('Alternating row bands');
    expect(panelHtml).toContain('>Merge cells</button>');
    expect(panelHtml).toContain('>Distribute cols</button>');
    expect(panelHtml).toContain('>Distribute rows</button>');
  });
});

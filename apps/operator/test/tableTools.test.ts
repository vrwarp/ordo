/**
 * The table's bar and panel section (design/15 "Table editing"): the table bar (objectBars' one M9 line) has
 * Cell fill and Rows & columns, and the selected cell's text format without uppercase, contrast or
 * shrink-to-fit; the Object panel's Table section stands in for the shape section, with the cell's text field
 * and the same tools; a table is never the lyric box ('Make lyric box' is not offered). The fill and row and
 * column actions: one undo step each, disabled at the bounds and at the last row or column, the selection
 * following its cell. (Server-rendered with `createElement`, as the panel tests are.)
 */
import {
  cellRich,
  Presentation,
  type ShapeObject,
  type SlideObject,
  TABLE_LIMITS,
  type TextStyle,
} from '@ordo/domain';
import { m9Table } from '@ordo/domain/m9.test-util.ts';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COARSE_QUERY } from '../src/components/pointer.ts';
import { cellRect, tableEditLayout } from '@ordo/renderer/table/edit.ts';
import { clearTableCache } from '@ordo/renderer/table/layout.ts';
import { LEGACY_FONT_ENV } from '@ordo/renderer/text/fonts.ts';
import { recordingCtx } from '@ordo/renderer/text/test-util.ts';
import { canRowCol, fillCells, rowCol, setCellStyle } from '../src/views/editor/actions.ts';
import {
  openPresentation,
  selectCell,
  selectObject,
  undo,
  useEditor,
} from '../src/views/editor/editorStore.ts';
import { BUILTIN_BARS, FloatingContextBar } from '../src/views/editor/FloatingContextBar.tsx';
import { objectBarFor, OBJECT_BARS } from '../src/views/editor/objectBars.ts';
import { BUILTIN_SECTIONS, ObjectPanel } from '../src/views/editor/ObjectPanel.tsx';
import { OBJECT_SECTIONS, objectSectionsFor } from '../src/views/editor/objectSections.ts';
import { nextAlign } from '../src/views/editor/TextControls.tsx';

const white = { r: 255, g: 255, b: 255, a: 1 };
const red = { r: 200, g: 30, b: 30, a: 1 };
const TABLE = {
  id: 'table',
  type: 'shape',
  box: { x: 120, y: 160, w: 1320, h: 410, rotation: 0 },
  shape: 'rect',
  fill: white,
  opacity: 1,
  radius: 0,
  table: m9Table(),
} as SlideObject;
const LYRIC_STYLE = { fontFamily: 'Inter', fontSizePx: 60, color: white } as TextStyle;
const LYRIC = {
  id: 'lyric',
  type: 'text',
  box: { x: 100, y: 700, w: 1700, h: 300, rotation: 0 },
  text: 'Amazing grace',
  style: { fontFamily: 'Inter', fontSizePx: 60, color: white },
  opacity: 1,
} as SlideObject;

function deck(kind: 'slides' | 'song' = 'slides', lyricObjectId?: string) {
  return Presentation.parse({
    id: 'deck',
    title: 'Order of service',
    kind,
    sections: [
      {
        id: 'sec',
        label: 'Main',
        short: 'M',
        slides: [{ id: 'sl', objects: [TABLE, LYRIC], ...(lyricObjectId ? { lyricObjectId } : {}) }],
      },
    ],
  });
}

/** Server rendering reads a zustand store's initial state, so the test seeds it there too. */
function seed() {
  const s = useEditor.getState();
  const p = { draft: s.draft, slideId: 'sl', objectId: s.objectId, objectIds: s.objectIds, cell: s.cell };
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
  });
});

const html = (el: ReactElement) => renderToStaticMarkup(el);
const bar = () =>
  html(createElement(FloatingContextBar, { readOnly: false, drawerOpen: false, onToggleDrawer: () => {} }));
const table = () =>
  useEditor.getState().draft!.sections[0]!.slides[0]!.objects.find((o) => o.id === 'table') as ShapeObject;
const panel = () => html(createElement(ObjectPanel, { o: table(), readOnly: false }));

function open(kind: 'slides' | 'song' = 'slides', lyricObjectId?: string) {
  openPresentation(deck(kind, lyricObjectId));
  useEditor.setState({ slideId: 'sl' });
}

describe('the table bar', () => {
  it('is the table line of objectBars: Cell fill and Rows & columns, never the shape fields', () => {
    expect(OBJECT_BARS.map((b) => b.id)).toEqual(['table']);
    expect(objectBarFor(TABLE, false, BUILTIN_BARS)?.id).toBe('table');
    expect(objectBarFor(LYRIC, false, BUILTIN_BARS)?.id).toBe('text');
    open();
    selectObject('table');
    seed();
    const h = bar();
    expect(h).toContain('<span class="ed-scope-pill">Table</span>');
    expect(h).toContain('aria-label="Cell fill"');
    expect(h).toContain('Rows &amp; columns');
    expect(h).not.toContain('aria-label="Shape geometry"');
    expect(h).not.toContain('aria-label="Shape fill"');
    expect(h).toContain('aria-label="Delete object"');
  });

  it("with a cell selected: that cell's text format, without uppercase, contrast or shrink to fit", () => {
    open();
    selectCell('table', 5);
    seed();
    const h = bar();
    expect(h).toContain('Row 2, column 3');
    expect(h).toContain('aria-label="Bold"');
    expect(h).toContain('aria-label="Cycle text alignment"');
    expect(h).toContain('aria-label="Text color"');
    expect(h).not.toContain('aria-label="Uppercase"');
    expect(h).not.toContain('>Clean ▾<');
    expect(h).not.toContain('Shrink to fit');
    expect(h).toContain('aria-label="Cell fill"');
  });
});

describe('the Table section of the Object panel', () => {
  it('stands in for the shape section, with the cell text field and the tools', () => {
    expect(OBJECT_SECTIONS.map((s) => s.id)).toEqual(['table']);
    expect(objectSectionsFor(TABLE, BUILTIN_SECTIONS).map((s) => s.id)).toEqual([
      'heading',
      'notes',
      'box',
      'opacity',
      'slideOps',
      'table',
    ]);
    open();
    selectObject('table');
    seed();
    const whole = panel();
    expect(whole).toContain('<h4>Table</h4>');
    expect(whole).not.toContain('<h4>Shape</h4>');
    expect(whole).toContain('Click a cell to edit its text');
    expect(whole).toContain('aria-label="Cell fill"');
    expect(whole).toContain('>Row below</button>');
    // No cell: a delete has nothing to delete.
    expect(whole).toMatch(/disabled="">Delete row<\/button>/);
    selectCell('table', 9);
    seed();
    const one = panel();
    expect(one).toContain('id="ordo-text-editor"');
    expect(one).toContain('aria-label="Cell text"');
    expect(one).toContain('>Worship team</textarea>');
    expect(one).toContain('Row 3, column 4');
    expect(one).not.toMatch(/disabled="">Delete row<\/button>/);
  });

  it('on a tablet (a coarse pointer) its hint speaks of taps, not clicks', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q === COARSE_QUERY,
      addEventListener() {},
      removeEventListener() {},
    }));
    try {
      open();
      selectObject('table');
      seed();
      const whole = panel();
      expect(whole).toContain('Tap a cell, then double-tap to type.');
      expect(whole).not.toContain('Click a cell');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a table is never the lyric box, even when lyricObjectId names it, and Make lyric box is not offered', () => {
    open('song', 'table');
    selectObject('table');
    seed();
    const h = panel();
    expect(h).not.toContain('Lyric text box');
    expect(h).not.toContain('Make lyric box');
    expect(h).toContain('<b class="grow">Table</b>');
  });
});

describe('fills, rows and columns', () => {
  it('Cell fill fills the selected cell, or every cell, or clears it; one undo step', () => {
    open();
    fillCells('table', 3, red);
    const t = table().table!;
    expect(t.fills![t.cells[3]!.fill!]!.color).toEqual(red);
    expect(t.cells[4]!.fill).toBeUndefined();
    fillCells('table', 3, null);
    expect(table().table!.cells[3]!.fill).toBeUndefined();
    fillCells('table', undefined, red);
    expect(table().table!.cells.every((c) => c.fill !== undefined)).toBe(true);
    undo();
    undo();
    undo();
    expect(table().table).toEqual(m9Table());
  });

  it('a fill the cells already have records no undo step (the paint picker sends the same colour again)', () => {
    open();
    const t = m9Table();
    const grey = t.fills![t.cells[3]!.fill!]!.color;
    const draft = useEditor.getState().draft;
    fillCells('table', 3, grey);
    // Cell 4 has no fill.
    fillCells('table', 4, null);
    expect(useEditor.getState().draft).toBe(draft);
    expect(useEditor.getState().canUndo).toBe(false);
    fillCells('table', 3, red);
    fillCells('table', 3, red);
    undo();
    expect(table().table).toEqual(m9Table());
  });

  it('Rows & columns insert and delete around the selected cell, the selection following it', () => {
    open();
    const R = m9Table().rows.length;
    const C = m9Table().cols.length;
    // Cell 9 ('Worship team') sits in row 3, column 4.
    expect(rowCol('table', 'rowAbove', 9)).toBeDefined();
    let t = table().table!;
    expect(t.rows).toHaveLength(R + 1);
    const moved = rowCol('table', 'rowBelow', 9);
    undo();
    undo();
    const above = rowCol('table', 'rowAbove', 9)!;
    expect(cellRich(table().table!, above)!.text).toBe('Worship team');
    undo();
    expect(moved).toBeDefined();
    const left = rowCol('table', 'colLeft', 9)!;
    t = table().table!;
    expect(t.cols).toHaveLength(C + 1);
    expect(cellRich(t, left)!.text).toBe('Worship team');
    undo();
    const after = rowCol('table', 'deleteRow', 9)!;
    expect(table().table!.rows).toHaveLength(R - 1);
    expect(after).toBeDefined();
    undo();
    rowCol('table', 'deleteCol', 9);
    expect(table().table!.cols).toHaveLength(C - 1);
    undo();
    // No cell: rows and columns at the table's edges.
    rowCol('table', 'rowBelow');
    expect(table().table!.rows).toHaveLength(R + 1);
    undo();
    expect(table().table).toEqual(m9Table());
  });

  it('in a right-to-left table, Column left and Column right add the column on that side as drawn', () => {
    // A 2 x 2 rtl table: logical column 0 is drawn on the right.
    const rtl = {
      ...m9Table(),
      cols: [300, 300],
      rows: [80, 80],
      cells: [{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }],
      styles: undefined,
      runStyles: undefined,
      fills: undefined,
      lineStyles: undefined,
      h: undefined,
      v: undefined,
      background: undefined,
      rtl: true,
    };
    openPresentation(
      Presentation.parse({
        ...deck(),
        sections: [
          {
            ...deck().sections[0]!,
            slides: [{ id: 'sl', objects: [{ ...TABLE, table: rtl } as SlideObject] }],
          },
        ],
      }),
    );
    useEditor.setState({ slideId: 'sl' });
    const ctx = recordingCtx(0.5);
    const xOf = (i: number) => {
      const o = table();
      return cellRect(o, tableEditLayout(ctx, o, LEGACY_FONT_ENV)!, i)!.x;
    };
    const texts = () => table().table!.cells.map((c) => c.text ?? '');
    // The new cell of the first row: the one that is neither 'A' nor 'B'.
    const added = () => texts().findIndex((t, i) => i < 3 && t === '');
    clearTableCache();
    expect(xOf(0)).toBeGreaterThan(xOf(1));
    for (const [op, side] of [
      ['colLeft', -1],
      ['colRight', 1],
    ] as const) {
      const a = rowCol('table', op, 0)!;
      expect(texts()[a]).toBe('A');
      const n = added();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(Math.sign(xOf(n) - xOf(a))).toBe(side);
      undo();
      // Without a cell: at the table's left or right edge as drawn.
      rowCol('table', op);
      const edge = added();
      const xs = [0, 1, 2].map(xOf);
      expect(xOf(edge)).toBe(side < 0 ? Math.min(...xs) : Math.max(...xs));
      undo();
    }
  });

  it("the bar's alignment button changes a justified cell, and a justified text box, to the next alignment", () => {
    const t = m9Table();
    t.styles = [...(t.styles ?? []), { align: 'justify' }];
    t.cells[9] = { ...t.cells[9]!, style: t.styles.length - 1 };
    openPresentation(
      Presentation.parse({
        ...deck(),
        sections: [
          {
            ...deck().sections[0]!,
            slides: [{ id: 'sl', objects: [{ ...TABLE, table: t } as SlideObject] }],
          },
        ],
      }),
    );
    useEditor.setState({ slideId: 'sl' });
    expect(cellRich(table().table!, 9)!.style).toMatchObject({ align: 'left', justify: true });
    // What the button does with no characters selected (TextFloatingControls' align button).
    setCellStyle({ objectId: 'table', cell: 9 }, nextAlign, 'align');
    const after = cellRich(table().table!, 9)!.style;
    expect({ align: after.align, justify: after.justify ?? false }).toEqual({
      align: 'center',
      justify: false,
    });
    // Stored: the cell no longer says 'justify' (centre is the table's own here, so the cell keeps no style).
    const k = table().table!.cells[9]!.style;
    expect(k === undefined ? undefined : table().table!.styles?.[k]?.align).not.toBe('justify');
    // A justified text box: the same.
    const box = nextAlign({ ...LYRIC_STYLE, align: 'left', justify: true });
    expect(box.align).toBe('center');
    expect('justify' in box).toBe(false);
    expect(nextAlign(nextAlign(box)).align).toBe('left');
  });

  it('disables a delete without a cell or at the last row or column, an insert past TABLE_LIMITS', () => {
    const t = m9Table();
    expect(canRowCol(t, 'deleteRow')).toBe(false);
    expect(canRowCol(t, 'deleteRow', 9)).toBe(true);
    const one = { rows: [40], cols: [100], cells: [{ text: 'x' }] };
    expect(canRowCol(one, 'deleteRow', 0)).toBe(false);
    expect(canRowCol(one, 'deleteCol', 0)).toBe(false);
    expect(canRowCol(one, 'rowBelow', 0)).toBe(true);
    const tall = { rows: Array(TABLE_LIMITS.rows).fill(10), cols: [100], cells: [] };
    expect(canRowCol(tall, 'rowBelow')).toBe(false);
    expect(canRowCol(tall, 'colRight')).toBe(true);
    const wide = { rows: [10], cols: Array(TABLE_LIMITS.cols).fill(10), cells: [] };
    expect(canRowCol(wide, 'colLeft')).toBe(false);
    const full = { rows: Array(64).fill(10), cols: Array(64).fill(10), cells: [] };
    expect(canRowCol(full, 'rowAbove')).toBe(false);
    expect(canRowCol(full, 'colRight')).toBe(false);
    // A locked table takes none of them.
    openPresentation(
      Presentation.parse({
        ...deck(),
        sections: [
          {
            ...deck().sections[0]!,
            slides: [{ id: 'sl', objects: [{ ...TABLE, locked: true } as SlideObject] }],
          },
        ],
      }),
    );
    useEditor.setState({ slideId: 'sl' });
    expect(rowCol('table', 'rowBelow', 9)).toBeUndefined();
    expect(table().table!.rows).toHaveLength(m9Table().rows.length);
  });
});

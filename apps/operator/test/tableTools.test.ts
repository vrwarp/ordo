/**
 * The table's bar and panel section (design/15 "Table editing"): the table bar (objectBars' one M9 line) has
 * Cell fill and Rows & columns, and the selected cell's text format without uppercase, contrast or
 * shrink-to-fit; the Object panel's Table section stands in for the shape section, with the cell's text field
 * and the same tools; a table is never the lyric box ('Make lyric box' is not offered). The fill and row and
 * column actions: one undo step each, disabled at the bounds and at the last row or column, the selection
 * following its cell. (Server-rendered with `createElement`, as the panel tests are.)
 */
import { cellRich, Presentation, type ShapeObject, type SlideObject, TABLE_LIMITS } from '@ordo/domain';
import { m9Table } from '@ordo/domain/m9.test-util.ts';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { canRowCol, fillCells, rowCol } from '../src/views/editor/actions.ts';
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

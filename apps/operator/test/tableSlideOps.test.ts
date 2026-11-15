/**
 * The slide ops over a table's cells (design/15 "Table editing"): Find & Replace finds and replaces in cells
 * as in text boxes (through `findInCells`, the one place the find walks them; locked tables are not searched),
 * the Find dialog lists a cell's match and opens it for editing on the canvas, and 'New slide like this'
 * empties a table's cells, keeping their look.
 */
import { cellRich, Presentation, type ShapeObject, type SlideObject } from '@ordo/domain';
import { m9Table } from '@ordo/domain/m9.test-util.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { findRows, goToMatch } from '../src/views/editor/FindReplaceDialog.tsx';
import { inlineTarget, openPresentation, useEditor } from '../src/views/editor/editorStore.ts';
import { findInCells, findReplace, findText, newSlideLike } from '../src/views/editor/ops/slides.ts';

const white = { r: 255, g: 255, b: 255, a: 1 };
const table = (id: string, extra: Partial<ShapeObject> = {}): SlideObject =>
  ({
    id,
    type: 'shape',
    box: { x: 120, y: 160, w: 1320, h: 410, rotation: 0 },
    shape: 'rect',
    fill: white,
    opacity: 1,
    radius: 0,
    table: m9Table(),
    ...extra,
  }) as SlideObject;
const text = (id: string, t: string): SlideObject =>
  ({
    id,
    type: 'text',
    box: { x: 100, y: 800, w: 1700, h: 200, rotation: 0 },
    text: t,
    style: { fontFamily: 'Inter', fontSizePx: 60, color: white },
    opacity: 1,
  }) as SlideObject;

const deck = () =>
  Presentation.parse({
    id: 'deck',
    title: 'Order of service',
    kind: 'slides',
    sections: [
      {
        id: 'sec',
        label: 'Main',
        short: 'M',
        slides: [
          { id: 's1', objects: [table('t1'), text('x1', 'Pastor Kim welcomes you')] },
          { id: 's2', objects: [table('t2', { locked: true })] },
        ],
      },
    ],
  });

const objOf = (p: Presentation, slide: string, id: string) =>
  p.sections[0]!.slides.find((s) => s.id === slide)!.objects.find((o) => o.id === id)!;
const cells = (p: Presentation, slide: string, id: string) => (objOf(p, slide, id) as ShapeObject).table!;

describe('Find & Replace over table cells', () => {
  it('finds in cells in reading order with their cell, text boxes as before, never a locked table', () => {
    const p = deck();
    expect(findText(p, 'pastor kim')).toEqual([
      { slideId: 's1', objectId: 't1', cell: 6, start: 0, end: 10 },
      { slideId: 's1', objectId: 't1', cell: 12, start: 0, end: 10 },
      { slideId: 's1', objectId: 'x1', start: 0, end: 10 },
    ]);
    expect(findText(p, 'shepherd', {}, 1)).toEqual([
      { slideId: 's1', objectId: 't1', cell: 11, start: 17, end: 25 },
    ]);
    expect(findInCells(objOf(p, 's2', 't2'), 'Pastor').matches).toEqual([]);
  });

  it('replaces in cells keeping their formatting, one count per match, and leaves the rest alone', () => {
    const p = deck();
    const r = findReplace(p, 'Pastor Kim', 'Pastor Lee');
    expect(r.replaced).toBe(3);
    const t = cells(r.p, 's1', 't1');
    expect(cellRich(t, 6)!.text).toBe('Pastor Lee');
    expect(cellRich(t, 12)!.text).toBe('Pastor Lee');
    // The italic run over 'The Good Shepherd' moves with an edit before it.
    const sermon = findReplace(p, 'Sermon:', 'Message:');
    const c11 = cellRich(cells(sermon.p, 's1', 't1'), 11)!;
    expect(c11.text).toBe('Message: The Good Shepherd');
    expect(c11.runs).toEqual([expect.objectContaining({ start: 9, end: 26, fontStyle: 'italic' })]);
    // The locked table keeps its text; nothing to replace leaves the presentation itself.
    expect(objOf(r.p, 's2', 't2')).toBe(objOf(p, 's2', 't2'));
    expect(findReplace(p, 'Christmas', 'Easter').p).toBe(p);
  });

  it('the Find dialog lists a cell match with its text around it and opens the cell on the canvas', () => {
    const p = deck();
    openPresentation(p);
    const rows = findRows(p, findText(p, 'Psalm'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ objectId: 't1', cell: 5, slide: 1, match: 'Psalm', after: ' 23' });
    expect(goToMatch(rows[0]!, false)).toBe(true);
    expect(useEditor.getState()).toMatchObject({ objectId: 't1', cell: 5 });
    expect(inlineTarget()).toEqual({ objectId: 't1', cell: 5 });
    expect(useEditor.getState().textRange).toMatchObject({ start: 0, end: 5 });
    // Read-only: the match is selected, not edited.
    expect(goToMatch(rows[0]!, true)).toBe(false);
  });
});

describe('New slide like this', () => {
  beforeEach(() => openPresentation(deck()));

  it("empties a table's cells and keeps their styles, fills and spans", () => {
    const p = deck();
    const r = newSlideLike(p, 's1');
    const copy = r.p.sections[0]!.slides[1]!;
    expect(copy.id).toBe(r.id);
    const t = (copy.objects[0] as ShapeObject).table!;
    const before = cells(p, 's1', 't1');
    expect(t.cells.every((c) => c.text === undefined && c.runs === undefined && c.paras === undefined)).toBe(
      true,
    );
    expect(t.cells.map((c) => [c.style, c.fill, c.colSpan, c.rowSpan])).toEqual(
      before.cells.map((c) => [c.style, c.fill, c.colSpan, c.rowSpan]),
    );
    expect(t.runStyles).toBeUndefined();
    // A locked table is copied as it is.
    const locked = newSlideLike(p, 's2');
    expect((locked.p.sections[0]!.slides[2]!.objects[0] as ShapeObject).table).toEqual(cells(p, 's2', 't2'));
  });
});

/**
 * Table cells edited as text (design/15 "Table editing"): the editor's text actions take a cell target
 * `{ objectId, cell }`: typing, formatting, paragraph styles and pastes edit the cell's text object view
 * (`cellTextObject`) and go back through `setCell`, typing coalesces into one undo step per cell
 * (`cell:<id>:<i>`), Tab moves through the cells (adding a row past the last), and the store's cell selection
 * survives what keeps the cell and drops what takes it away.
 */
import { cellRich, Presentation, type ShapeObject, type SlideObject } from '@ordo/domain';
import { m9Table } from '@ordo/domain/m9.test-util.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatSelection,
  handleTextPaste,
  nextCell,
  pasteRichSelection,
  resizeSelection,
  setParagraphs,
  tabCell,
  typeText,
} from '../src/views/editor/actions.ts';
import {
  inlineTarget,
  openPresentation,
  redo,
  selectCell,
  selectObject,
  startInlineEditing,
  stopInlineEditing,
  undo,
  useEditor,
} from '../src/views/editor/editorStore.ts';

const white = { r: 255, g: 255, b: 255, a: 1 };
const TABLE: SlideObject = {
  id: 'table',
  type: 'shape',
  box: { x: 120, y: 160, w: 1320, h: 410, rotation: 0 },
  shape: 'rect',
  fill: white,
  opacity: 1,
  radius: 0,
  table: m9Table(),
} as SlideObject;
const LYRIC: SlideObject = {
  id: 'lyric',
  type: 'text',
  box: { x: 100, y: 700, w: 1700, h: 300, rotation: 0 },
  text: 'Amazing grace',
  style: { fontFamily: 'Inter', fontSizePx: 60, color: white },
  opacity: 1,
} as SlideObject;

const deck = Presentation.parse({
  id: 'deck',
  title: 'Order of service',
  kind: 'slides',
  sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 'sl', objects: [TABLE, LYRIC] }] }],
});

const table = () =>
  useEditor.getState().draft!.sections[0]!.slides[0]!.objects.find((o) => o.id === 'table') as ShapeObject;
const cellText = (i: number) => cellRich(table().table!, i)!.text;
const lyric = () =>
  useEditor.getState().draft!.sections[0]!.slides[0]!.objects.find((o) => o.id === 'lyric') as SlideObject;

beforeEach(() => {
  openPresentation(deck);
  useEditor.setState({ slideId: 'sl' });
});

describe('typing in a table cell', () => {
  it('types into the cell through its text view, one undo step per cell', () => {
    const at = { objectId: 'table', cell: 9 };
    expect(cellText(9)).toBe('Worship team');
    typeText(at, 'Worship team!', 13);
    typeText(at, 'Worship team!!', 14);
    expect(cellText(9)).toBe('Worship team!!');
    // The other cells, and the lyric box, are untouched.
    expect(cellText(8)).toBe('찬양과 경배');
    expect(lyric()).toBe(deck.sections[0]!.slides[0]!.objects[1]);
    // Another cell is its own step.
    typeText({ objectId: 'table', cell: 3 }, '10:05', 5);
    expect(cellText(3)).toBe('10:05');
    undo();
    expect(cellText(3)).toBe('10:00');
    expect(cellText(9)).toBe('Worship team!!');
    undo();
    expect(cellText(9)).toBe('Worship team');
    redo();
    expect(cellText(9)).toBe('Worship team!!');
  });

  it("keeps the cell's runs as typing shifts them, and formats, resizes and pastes into the cell", () => {
    const at = { objectId: 'table', cell: 4 };
    const before = cellRich(table().table!, 4)!;
    expect(before.runs).toEqual([{ start: 0, end: 4, fontWeight: 700 }]);
    // A letter typed inside the bold word is bold; one typed after its first word shifts nothing before it.
    typeText(at, `Ca-${before.text.slice(2)}`, 3);
    expect(cellRich(table().table!, 4)!.runs).toEqual([{ start: 0, end: 5, fontWeight: 700 }]);
    formatSelection(at, 6, 8, { fontStyle: 'italic' });
    expect(cellRich(table().table!, 4)!.runs).toContainEqual({ start: 6, end: 8, fontStyle: 'italic' });
    resizeSelection(at, 1, 5, 1.5);
    expect(cellRich(table().table!, 4)!.runs?.find((r) => r.start === 1)?.sizeScale).toBe(1.5);
    setParagraphs(at, 0, 0, { align: 'center' });
    expect(cellRich(table().table!, 4)!.paras?.[0]).toMatchObject({ align: 'center' });
    const caret = pasteRichSelection(at, 0, 0, { text: 'Opening: ' });
    expect(caret).toBe(9);
    expect(cellText(4)).toBe('Opening: Ca-ll to worship\nOpening hymn');
    // A plain-text paste from the system clipboard into the cell (a view of it, with its target).
    const view = { ...lyric(), text: cellText(4) } as never;
    const data = { getData: (t: string) => (t === 'text/plain' ? '(all stand) ' : '') } as DataTransfer;
    expect(handleTextPaste(view, 9, 9, data, at)).toBe(21);
    expect(cellText(4)).toBe('Opening: (all stand) Ca-ll to worship\nOpening hymn');
    // The lyric box was never touched.
    expect(lyric()).toBe(deck.sections[0]!.slides[0]!.objects[1]);
  });

  it('leaves a locked table and a missing cell alone', () => {
    useEditor.setState({
      draft: {
        ...deck,
        sections: [
          {
            ...deck.sections[0]!,
            slides: [{ id: 'sl', objects: [{ ...TABLE, locked: true } as SlideObject, LYRIC] }],
          },
        ],
      },
    });
    const draft = useEditor.getState().draft;
    typeText({ objectId: 'table', cell: 9 }, 'x', 1);
    typeText({ objectId: 'table', cell: 999 }, 'x', 1);
    expect(useEditor.getState().draft).toBe(draft);
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it('a text box still takes its id: typing coalesces per box', () => {
    typeText('lyric', 'Amazing grace!', 14);
    typeText('lyric', 'Amazing grace!!', 15);
    expect((lyric() as { text: string }).text).toBe('Amazing grace!!');
    undo();
    expect((lyric() as { text: string }).text).toBe('Amazing grace');
  });
});

describe('moving between cells', () => {
  it('Tab goes to the next cell in reading order, Shift+Tab back; Tab in the last cell adds a row', () => {
    const t = table().table!;
    expect(nextCell(t, 0, false)).toBe(1);
    expect(nextCell(t, 1, true)).toBe(0);
    expect(nextCell(t, 0, true)).toBeUndefined();
    expect(nextCell(t, t.cells.length - 1, false)).toBeUndefined();
    expect(tabCell('table', 3, false)).toBe(4);
    const rows = t.rows.length;
    const cells = t.cells.length;
    const last = cells - 1;
    const made = tabCell('table', last, false);
    expect(table().table!.rows).toHaveLength(rows + 1);
    // The new row's cells come last: its first cell is the next index.
    expect(made).toBe(cells);
    expect(cellText(made!)).toBe('');
    // One undo step takes the row back.
    undo();
    expect(table().table!.rows).toHaveLength(rows);
    // Read-only (no grow): the last cell stays the last.
    expect(tabCell('table', last, false, false)).toBeUndefined();
    expect(table().table!.rows).toHaveLength(rows);
  });
});

describe('the cell selection and the inline target', () => {
  it('selects a cell of the table alone, keeps it on a click of the table, drops it elsewhere', () => {
    selectCell('table', 4);
    expect(useEditor.getState()).toMatchObject({ objectId: 'table', objectIds: ['table'], cell: 4 });
    selectObject('table');
    expect(useEditor.getState().cell).toBe(4);
    selectObject('lyric');
    expect(useEditor.getState().cell).toBeUndefined();
    selectCell('table', 2);
    startInlineEditing('table', { start: 0, end: 0 }, 2);
    expect(inlineTarget()).toEqual({ objectId: 'table', cell: 2 });
    // Another cell selected: editing stops.
    selectCell('table', 3);
    expect(inlineTarget()).toBeUndefined();
    startInlineEditing('table', undefined, 3);
    stopInlineEditing();
    expect(useEditor.getState()).toMatchObject({
      inlineEditingId: undefined,
      inlineEditingCell: undefined,
      cell: 3,
    });
    startInlineEditing('lyric');
    expect(inlineTarget()).toEqual({ objectId: 'lyric' });
  });

  it('an undo that takes the selected cell away drops the selection and the editing of it', () => {
    const cells = table().table!.cells.length;
    const made = tabCell('table', cells - 1, false)!;
    selectCell('table', made);
    startInlineEditing('table', undefined, made);
    undo();
    expect(useEditor.getState()).toMatchObject({
      objectId: 'table',
      cell: undefined,
      inlineEditingId: undefined,
    });
  });
});

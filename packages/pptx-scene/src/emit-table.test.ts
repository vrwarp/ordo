import { type ShapeObject, Slide, TABLE_LIMITS, TableData } from '@ordo/domain';
import { cellRich } from '@ordo/domain/table.ts';
import * as prev from '@ordo/domain/schemas.prev05.test-util.ts';
import { describe, expect, it } from 'vitest';
import { MAX_SLIDE_OBJECTS } from './classify.ts';
import { storedSlideBytes } from './emit-budget.ts';
import { M9_FIELDS } from './emit-ctx.ts';
import * as emitTable from './emit-table.ts';
import { convertDeck, type ConvertOptions } from './index.ts';
import type { FaceSource } from './metrics.ts';
import {
  buildDeck,
  type DeckSpec,
  denseTableDeck,
  solid,
  sp,
  tableFrame,
  tc,
  tcWith,
  withTableStyles,
} from './test-util.ts';

const IN = 914_400;
/** Logical px per inch on a standard 16:9 slide. */
const PX = 144;
/** Every character half an em wide. */
const HALF_EM: FaceSource = () => ({ advance: () => 0.5 });
/** The stored fields but the table object: the kill switch (`M9_WRITES` without 'table'), tables as M6 groups. */
const NO_TABLE = new Set(M9_FIELDS.filter((f) => f !== 'table'));

type Table = Parameters<typeof tableFrame>[0];
const table = (o: Partial<Table> & Pick<Table, 'cols' | 'rows'>): string =>
  tableFrame({ id: 7, x: IN, y: IN, ...o });

/** Convert a deck; every slide must be an ordinary ordo slide. */
function convert(spec: DeckSpec, opts: ConvertOptions & { styles?: string } = {}) {
  let parts = buildDeck(spec);
  if (opts.styles !== undefined) parts = withTableStyles(parts, opts.styles);
  const out = convertDeck(parts, { fontFace: HALF_EM, ...opts });
  for (const s of out.slides) expect(Slide.parse(s.slide)).toEqual(s.slide);
  return out;
}

/** The table objects of a slide. */
const tablesOf = (objects: readonly unknown[]) =>
  (objects as ShapeObject[]).filter((o) => o.type === 'shape' && o.table !== undefined);

/** A one-slide deck's only table object, and the slide. */
function one(shapes: string, opts: ConvertOptions & { styles?: string } = {}) {
  const out = convert({ slides: [{ shapes }] }, opts);
  const s = out.slides[0]!;
  const tables = tablesOf(s.slide.objects);
  expect(tables).toHaveLength(1);
  return { s, o: tables[0]!, t: tables[0]!.table! };
}

/** A cell of two runs: `plain`, then `marked` with the run properties `rPr` (the plain run is the longer). */
const tc2 = (plain: string, marked: string, rPr: string) =>
  `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${plain}</a:t></a:r><a:r><a:rPr ${rPr}/><a:t>${marked}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;

const STYLE = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';
const HEAD_BAND = `<a:tblStyle styleId="${STYLE}" styleName="Probe"><a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"/><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:insideH><a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></a:insideH></a:tcBdr><a:fill><a:solidFill><a:srgbClr val="DDEEFF"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl><a:firstRow><a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="224488"/></a:solidFill></a:fill></a:tcStyle></a:firstRow></a:tblStyle>`;

describe('the table object (M9, ShapeObject.table)', () => {
  it('emits one table object with palettes', () => {
    const shapes = table({
      cols: [2 * IN, 3 * IN],
      rows: [
        { h: IN / 2, cells: [tc('Day'), tc('Service')] },
        { h: IN / 2, cells: [tc('Sunday'), tc2('in the hall ', '10:00', 'i="1"')] },
        { h: IN / 2, cells: [tc('Monday'), tc2('Prayer, ', '19:00', 'b="1"')] },
      ],
      tblPr: `<a:tblPr firstRow="1"><a:tableStyleId>${STYLE}</a:tableStyleId></a:tblPr>`,
    });
    const { s, o, t } = one(shapes, { styles: HEAD_BAND });
    expect(s.classification.class).toBe('native');
    // One object: the table, an editable rect at the frame, the cells in it.
    expect(s.slide.objects).toHaveLength(2); // the background, then the table
    expect(o).toMatchObject({
      shape: 'rect',
      opacity: 1,
      origin: { src: 'pptx', role: 'table', shapeId: 7 },
      box: { x: PX, y: PX, w: 5 * PX, h: 1.5 * PX, rotation: 0 },
    });
    expect(o.locked).toBeUndefined();
    expect(TableData.parse(t)).toEqual(t);
    expect(t.cols).toEqual([2 * PX, 3 * PX]);
    expect(t.rows).toEqual([PX / 2, PX / 2, PX / 2]);
    expect(t.cells.map((c) => c.text)).toEqual([
      'Day',
      'Service',
      'Sunday',
      'in the hall 10:00',
      'Monday',
      'Prayer, 19:00',
    ]);
    // The base is the most common cell style (the body's); the head row's white bold is one entry.
    expect(t.base).toMatchObject({ lineModel: 'office', valign: 'top', fontWeight: 400 });
    expect(t.base.autofit).toBeUndefined();
    expect(t.styles).toHaveLength(1);
    expect(t.styles![0]).toMatchObject({ fontWeight: 700, color: { r: 255, g: 255, b: 255, a: 1 } });
    expect(t.cells[0]!.style).toBe(0);
    expect(t.cells[1]!.style).toBe(0);
    expect(t.cells[2]!.style).toBeUndefined();
    // Runs that differ from their cell's style go to the run palette: italic and bold, each once.
    expect(t.runStyles).toEqual([{ fontStyle: 'italic' }, { fontWeight: 700 }]);
    expect(t.cells[3]!.runs).toEqual([[12, 17, 0]]);
    expect(t.cells[5]!.runs).toEqual([[8, 13, 1]]);
    // Two fills (head and body) and one line style (the white insideH, inside the body only).
    expect(t.fills).toEqual([
      { color: { r: 0x22, g: 0x44, b: 0x88, a: 1 } },
      { color: { r: 0xdd, g: 0xee, b: 0xff, a: 1 } },
    ]);
    expect(t.cells.map((c) => c.fill)).toEqual([0, 0, 1, 1, 1, 1]);
    expect(t.lineStyles).toEqual([{ width: 2, color: { r: 255, g: 255, b: 255, a: 1 } }]);
    expect(t.h).toEqual([
      [1, 0, 2, 0],
      [2, 0, 2, 0],
    ]);
    expect(t.v).toBeUndefined();
    expect(t.background).toBeUndefined();
    expect(o.fill).toBeUndefined();
  });

  it('writes the table background as its legacy fill, and a gradient cell with its first stop as colour', () => {
    const grad =
      '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill>';
    const { o, t } = one(
      table({
        cols: [IN, IN],
        rows: [{ h: IN / 2, cells: [tcWith('a', grad), tc('b')] }],
        tblPr: `<a:tblPr>${solid('FFFF00')}</a:tblPr>`,
      }),
    );
    expect(o.fill).toEqual({ r: 255, g: 255, b: 0, a: 1 });
    expect(t.fills![t.background!]).toEqual({ color: { r: 255, g: 255, b: 0, a: 1 } });
    const f = t.fills![t.cells[0]!.fill!]!;
    expect(f.color).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(f.gradient).toMatchObject({ kind: 'linear', angle: 0 });
    expect(t.cells[1]!.fill).toBeUndefined();
  });

  it('keeps spans, diagonals, dashes and right-to-left columns', () => {
    const red = (tag: string) =>
      `<a:${tag} w="25400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="dash"/></a:${tag}>`;
    const { s, t } = one(
      table({
        cols: [IN, IN, IN],
        rows: [
          {
            h: IN / 2,
            cells: [tc('wide', { attrs: 'gridSpan="2"' }), tc('', { attrs: 'hMerge="1"' }), tc('v')],
          },
          {
            h: IN / 2,
            cells: [
              tcWith('x', red('lnTlToBr') + red('lnBlToTr')),
              tc('tall', { attrs: 'rowSpan="2"' }),
              tc('c'),
            ],
          },
          { h: IN / 2, cells: [tc('d'), tc('', { attrs: 'vMerge="1"' }), tc('e')] },
        ],
        tblPr: '<a:tblPr rtl="1"/>',
      }),
    );
    expect(t.rtl).toBe(true);
    expect(t.cells.map((c) => [c.text ?? '', c.colSpan ?? 1, c.rowSpan ?? 1])).toEqual([
      ['wide', 2, 1],
      ['v', 1, 1],
      ['x', 1, 1],
      ['tall', 1, 2],
      ['c', 1, 1],
      ['d', 1, 1],
      ['e', 1, 1],
    ]);
    const diag = t.cells[2]!.diag!;
    expect(diag.down).toBe(diag.up);
    expect(t.lineStyles![diag.down!]).toEqual({
      width: 4,
      color: { r: 255, g: 0, b: 0, a: 1 },
      dash: 'dash',
    });
    expect(s.classification.class).toBe('native');
  });

  it('leaves a table with vertical cell text to LibreOffice, as before the table object (no vertical text engine yet)', () => {
    const out = convert({
      slides: [
        { shapes: table({ cols: [IN], rows: [{ h: IN, cells: [tc('v', { tcPr: ' vert="vert270"' })] }] }) },
      ],
    });
    const s = out.slides[0]!;
    expect(tablesOf(s.slide.objects)).toEqual([]);
    expect(s.classification.reasons).toContain('art:table');
    expect(s.notes).toContain('a table with vertical cell text is drawn by LibreOffice (M8)');
  });

  it("writes each cell's style as the domain reads it back (cellRich is the converter's cell box)", () => {
    const { t } = one(
      table({
        cols: [2 * IN, 2 * IN],
        rows: [
          { h: IN / 2, cells: [tc('Head', { rPr: 'b="1" sz="2800"' }), tc('right', { pPr: 'algn="r"' })] },
          { h: IN / 2, cells: [tc('body'), tc('just', { pPr: 'algn="just"' })] },
          { h: IN / 2, cells: [tc('more'), tc('text')] },
        ],
      }),
    );
    // The bold 28 pt head and the right-aligned cell: two style entries over one base (the body's); the
    // justified cell keeps its paragraph's alignment (`paras`, as a text box's). The head is stored in
    // LibreOffice's form: at 28 pt's size at 600 dpi (233 device px: 27.96 pt, 55.92 logical px), its row grown
    // to LibreOffice's line (1.2 x 28 pt = 1.2 x 988 = 1,185.6, rounded 1,186/100 mm with no face metrics, + 1 +
    // its margins 2 x 127: 1,441/100 mm), its text 588 EMU lower than ordo's office line puts it (the
    // converter's lift, in its insets).
    expect(t.styles).toHaveLength(2);
    const head = cellRich(t, 0)!;
    expect(head.style.fontWeight).toBe(700);
    expect(head.style.fontSizePx).toBeCloseTo(55.92, 6);
    expect(head.style.insets!.t).toBeCloseTo(7.2 + 588 / 6350, 6);
    expect(head.style.insets!.b).toBeCloseTo(7.2 - 588 / 6350, 6);
    expect(t.rows[0]!).toBeCloseTo((1441 * 360) / 6350, 6);
    expect(t.rows.slice(1)).toEqual([PX / 2, PX / 2]);
    expect(head.style.autofit).toBeUndefined();
    expect(cellRich(t, 1)!.style.align).toBe('right');
    expect(cellRich(t, 2)!.style).toEqual({ ...t.base });
    expect(cellRich(t, 3)!.style).toEqual({ ...t.base });
    expect(cellRich(t, 3)!.paras).toEqual([{ align: 'justify' }]);
  });

  it('a 96-cell bulletin is native', () => {
    // 32 rows of 3 cells: M6 sent it to LibreOffice past 60 cells (budget:table); one object now.
    const rows = Array.from({ length: 32 }, (_, r) => ({
      h: IN / 8,
      cells: [tc(`${r + 1}`), tc(`Hymn ${r + 1}`), tc(`${100 + r}`)],
    }));
    const { s, t } = one(table({ cols: [IN / 2, 4 * IN, IN], rows }));
    expect(s.classification.class).toBe('native');
    expect(s.classification.reasons.filter((r) => r.startsWith('art:'))).toEqual([]);
    expect(t.cells).toHaveLength(96);
    expect(s.slide.objects).toHaveLength(2);
  });

  it("160 cells native: past M6's cell cap (150), one table object, nothing left to LibreOffice", () => {
    // 32 rows of 5 cells: M6 left it to LibreOffice unmeasured (budget:table); one object of the slide now.
    const rows = Array.from({ length: 32 }, (_, r) => ({
      h: IN / 8,
      cells: [tc(`${r + 1}`), tc(`Hymn ${r + 1}`), tc('Page'), tc(`${100 + r}`), tc(r % 2 ? 'choir' : '')],
    }));
    const { s, t } = one(table({ cols: [IN / 2, 3 * IN, IN, IN / 2, IN], rows }));
    expect(s.classification.class).toBe('native');
    expect(s.classification.reasons).not.toContain('art:budget:table');
    expect(t.cells).toHaveLength(160);
    expect(t.cells[159]!.text).toBe('choir');
    expect(s.slide.objects).toHaveLength(2);
  });

  it('the 640-cell master grid is one object per slide', () => {
    // A template's 20 × 32 grid of empty cells on its master, shown under every slide.
    const grid = tableFrame({
      id: 9,
      x: 0,
      y: 0,
      cols: Array(32).fill(IN / 4),
      rows: Array.from({ length: 20 }, () => ({
        h: IN / 4,
        cells: Array.from({ length: 32 }, () => tc('')),
      })),
    });
    const out = convert({
      master: { shapes: grid },
      slides: [{ shapes: '' }, { shapes: '' }, { shapes: '' }],
    });
    for (const s of out.slides) {
      const tables = tablesOf(s.slide.objects);
      expect(tables).toHaveLength(1);
      expect(tables[0]!.table!.cells).toHaveLength(640);
      expect(tables[0]!.table!.cells.every((c) => c.text === undefined && c.style === undefined)).toBe(true);
      expect(s.slide.objects.length).toBeLessThanOrEqual(3);
      expect(JSON.stringify(s.slide).length).toBeLessThan(8 * 1024);
    }
  });

  it('writes no legacy group (M9 decision 4): an older build strips the table and draws the background rect', () => {
    const { s, o } = one(
      table({
        cols: [IN, IN],
        rows: [{ h: IN / 2, cells: [tc('a'), tc('b')] }],
        tblPr: `<a:tblPr>${solid('336699')}</a:tblPr>`,
      }),
    );
    // Nothing but the table: no grid shapes or cell text boxes beside it.
    expect(s.slide.objects.filter((x) => x.origin?.role === 'grid' || x.origin?.role === 'cell')).toEqual([]);
    const old = (prev.Slide.parse(s.slide) as Slide).objects.find((x) => x.id === o.id) as ShapeObject;
    expect(old).toBeDefined();
    expect((old as { table?: unknown }).table).toBeUndefined();
    expect(old).toMatchObject({ shape: 'rect', fill: { r: 0x33, g: 0x66, b: 0x99, a: 1 }, box: o.box });
    // Without 'table' in m9Writes (the kill switch) the M6 group is written.
    const group = convert(
      { slides: [{ shapes: table({ cols: [IN, IN], rows: [{ h: IN / 2, cells: [tc('a'), tc('b')] }] }) }] },
      { m9Writes: NO_TABLE },
    ).slides[0]!.slide.objects;
    expect(tablesOf(group)).toEqual([]);
    expect(group.filter((x) => x.origin?.role === 'cell')).toHaveLength(2);
  });

  it('without table no slide passes 150 objects: the budgets count the M6 group, and its cell cap holds', () => {
    // A 100-cell table (its M6 group: 100 cell boxes, a fill and lines) under 60 squares of one look.
    const rows = Array.from({ length: 20 }, (_, r) => ({
      h: IN / 8,
      cells: Array.from({ length: 5 }, (_, c) => tc(`${r}.${c}`)),
    }));
    const head = `<a:tblPr>${solid('EEEEEE')}</a:tblPr>`;
    let squares = '';
    for (let i = 0; i < 60; i++)
      squares += sp({
        id: 100 + i,
        x: (i % 30) * 380_000,
        y: 5 * IN + Math.floor(i / 30) * 400_000,
        cx: 300_000,
        cy: 300_000,
        fill: solid('336699'),
      });
    const spec = { slides: [{ shapes: table({ cols: Array(5).fill(IN), rows, tblPr: head }) + squares }] };
    const off = convert(spec, { m9Writes: NO_TABLE }).slides[0]!;
    expect(tablesOf(off.slide.objects)).toEqual([]);
    expect(off.slide.objects.filter((o) => o.origin?.role === 'cell')).toHaveLength(100);
    expect(off.slide.objects.length).toBeLessThanOrEqual(MAX_SLIDE_OBJECTS);
    // The table object: one object, the squares as they are.
    const on = convert(spec).slides[0]!;
    expect(tablesOf(on.slide.objects)).toHaveLength(1);
    expect(on.slide.objects.length).toBe(62);
    // A table of more drawn cells than a slide may have objects stays LibreOffice's art without the table object.
    const big = Array.from({ length: 32 }, (_, r) => ({
      h: IN / 8,
      cells: Array.from({ length: 5 }, () => tc(`${r}`)),
    }));
    const capped = convert(
      { slides: [{ shapes: table({ cols: Array(5).fill(IN), rows: big }) }] },
      { m9Writes: NO_TABLE },
    ).slides[0]!;
    expect(capped.classification.reasons).toContain('art:budget:table');
    expect(capped.slide.objects.length).toBeLessThanOrEqual(MAX_SLIDE_OBJECTS);
    expect(capped.notes).toContain(
      `a table of 160 cells passes the slide's budget of ${MAX_SLIDE_OBJECTS} objects: LibreOffice draws it`,
    );
  });

  it("fixes LibreOffice's rows at import: box.h is their sum, a row grown to its lines as LibreOffice grows it", () => {
    // A cell of four lines in a row stored a quarter inch tall: LibreOffice's row holds the four lines at 18 pt
    // (1.2 x 635/100 mm each, no face metrics: 4 x 762 + 1 + the margins 2 x 127 = 3,303/100 mm), the row of
    // one line 762 + 1 + 254 = 1,017/100 mm, taller than its quarter inch; both fixed (the drawer keeps them).
    const { o, t } = one(
      table({
        cols: [IN],
        rows: [
          { h: IN / 4, cells: [tc('one\ntwo\nthree\nfour')] },
          { h: IN / 4, cells: [tc('x')] },
        ],
      }),
    );
    expect(t.rows[0]!).toBeCloseTo((3303 * 360) / 6350, 6);
    expect(t.rows[1]!).toBeCloseTo((1017 * 360) / 6350, 6);
    expect(o.box.h).toBeCloseTo(((3303 + 1017) * 360) / 6350, 6);
    expect(t.rowRule).toBe('fixed');
    expect(t.cells[0]!.paras ?? []).toHaveLength(0);
  });

  it("stores LibreOffice's rows on every hub, as the harness's policies draw them: fixed, its sizes, its lines", () => {
    // Three lines of 18 pt in a row stored 1 pt tall: LibreOffice's row of 3 x 762 + 1 + 254 = 2,541/100 mm,
    // the same with and without loCompat.
    const rows = [{ h: 12_700, cells: [tc('one\ntwo\nthree')] }];
    const own = one(table({ cols: [2 * IN], rows }));
    const lo = one(table({ cols: [2 * IN], rows }), { loCompat: true });
    expect(own.t.rowRule).toBe('fixed');
    expect(own.t.rows[0]!).toBeCloseTo((2541 * 360) / 6350, 6);
    expect(own.o.box.h).toBeCloseTo(own.t.rows[0]!, 6);
    expect(own.t).toEqual(lo.t);
    expect(own.o.box).toEqual(lo.o.box);
  });

  it("stores LibreOffice's form on every hub: the grid, rows, sizes and insets are the same with and without loCompat", () => {
    // A head of 28 pt bold, a cell of two sizes (14 pt then 9 pt), three lines in a row stored 1 pt tall (the
    // text spills into the margins), a centred cell (its baseline lift goes into the insets) and an empty cell.
    const shapes = table({
      cols: [2 * IN, IN],
      rows: [
        { h: IN / 3, cells: [tc('Head', { rPr: 'b="1" sz="2800"' }), tc('', { rPr: 'sz="1800"' })] },
        { h: IN / 3, cells: [tc2('Large ', 'and small', 'sz="900"'), tc('mid', { tcPr: ' anchor="ctr"' })] },
        { h: 12_700, cells: [tc('one\ntwo\nthree', { rPr: 'sz="1400"' }), tc('x')] },
      ],
    });
    const own = one(shapes);
    const lo = one(shapes, { loCompat: true });
    expect(own.o.box).toEqual(lo.o.box);
    expect(own.t).toEqual(lo.t);
    // LibreOffice's form: fixed rows, the third grown to its three lines, the head at 28 pt's size at 600 dpi
    // (233 device px: 27.96 pt, 55.92 logical px).
    expect(own.t.rowRule).toBe('fixed');
    expect(own.t.rows[2]!).toBeGreaterThan(3 * 28);
    expect(own.o.box.h).toBeCloseTo(
      own.t.rows.reduce((s, h) => s + h, 0),
      6,
    );
    expect(cellRich(own.t, 0)!.style.fontSizePx).toBeCloseTo(55.92, 6);
  });

  it('counts the cells against the slide text budget and writes the later ones plain past it', () => {
    // 135 cells of 300 characters in 20 runs of alternating looks (40,500 characters, within the table's
    // 60,000): past the slide's 128 KB of text formatting (`TEXT_BUDGET_BYTES`).
    const word = (k: number) => `w${k % 10} `.repeat(5);
    const cell = (k: number) =>
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${Array.from(
        { length: 20 },
        (_, j) =>
          `<a:r><a:rPr lang="en-US"${j % 2 ? ' b="1"' : ''} sz="${1000 + (k % 40)}"/><a:t>${word(j)}</a:t></a:r>`,
      ).join('')}</a:p></a:txBody><a:tcPr/></a:tc>`;
    const rows = Array.from({ length: 45 }, (_, r) => ({
      h: IN / 16,
      cells: [cell(r * 3), cell(r * 3 + 1), cell(r * 3 + 2)],
    }));
    const out = convert({ slides: [{ shapes: table({ cols: [IN, IN, IN], rows }) }] });
    const s = out.slides[0]!;
    const t = tablesOf(s.slide.objects)[0]!.table!;
    expect(t.cells).toHaveLength(135);
    expect(t.cells.every((c) => c.text?.length === 300)).toBe(true);
    expect(t.cells[0]!.runs?.length).toBeGreaterThan(0);
    expect(t.cells[134]!.runs).toBeUndefined();
    expect(s.notes.some((n) => n.includes('KB of text formatting'))).toBe(true);
  });

  it('keeps the bounds of the stored table (TABLE_LIMITS of @ordo/domain)', () => {
    expect(emitTable.TABLE_OBJECT_LIMITS).toBeDefined();
    for (const [k, v] of Object.entries(emitTable.TABLE_OBJECT_LIMITS ?? {}))
      expect(v, k).toBe(TABLE_LIMITS[k as keyof typeof TABLE_LIMITS]);
  });

  it("cuts a cell's text at 10,000 characters and the table's at 60,000, later cells empty", () => {
    const long = 'x'.repeat(12_000);
    const rows = Array.from({ length: 8 }, () => ({ h: IN / 8, cells: [tc(long)] }));
    const { s, t } = one(table({ cols: [8 * IN], rows }));
    expect(t.cells.map((c) => c.text?.length ?? 0)).toEqual([
      10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 0, 0,
    ]);
    expect(s.notes).toContain('a table has more than 60000 characters: its later cells are empty');
  });
});

describe('with LibreOffice no table is emitted twice (the owner: every table is the table object)', () => {
  const dense = (rows: number, opts: ConvertOptions = {}) =>
    convertDeck(denseTableDeck(rows), { fontFace: HALF_EM, ...opts });

  it('with LibreOffice the slide is emitted as without it: no M6 group weighed, nothing written for one', () => {
    const deck = dense(28);
    const native = deck.slides[0]!;
    const nolo = dense(28, { libreoffice: false });
    expect(tablesOf(native.slide.objects)).toHaveLength(1);
    // No second emission: no group's bytes on the slide, the emitter's notes and slide as without LibreOffice.
    expect(native).not.toHaveProperty('tableGroupBytes');
    expect(native.notes).toEqual(nolo.slides[0]!.notes);
    expect(native.slide.objects).toHaveLength(2);
    expect(native.slide).toEqual({ ...nolo.slides[0]!.slide, id: native.slide.id });
    expect(deck.geoms).toEqual([]);
    // The M6 group the interim rule weighed is still past 64 KB as stored (the kill switch writes it).
    const kill = dense(28, { m9Writes: NO_TABLE });
    const group = kill.slides[0]!;
    expect(tablesOf(group.slide.objects)).toHaveLength(0);
    expect(kill.geoms.length).toBeGreaterThan(0);
    expect(storedSlideBytes(group.slide, [])).toBeGreaterThan(64 * 1024);
  });

  it('nothing for a table M6 never grouped (past 150 cells), nor for a slide without a table', () => {
    const big = dense(32).slides[0]!;
    expect(tablesOf(big.slide.objects)[0]!.table!.cells).toHaveLength(160);
    expect(big).not.toHaveProperty('tableGroupBytes');
    const plain = convert({
      slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('FF0000') }) }],
    });
    expect(plain.slides[0]!).not.toHaveProperty('tableGroupBytes');
  });
});

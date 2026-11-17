import { parsePathData, type Rgba, type ShapeObject, Slide, type TextObject } from '@ordo/domain';
import * as prev from '@ordo/domain/schemas.prev05.test-util.ts';
import { cellRich } from '@ordo/domain/table.ts';
import { TABLE_LIMITS as DOMAIN_LIMITS } from '@ordo/domain';
import { CMD_MOVE, GEOM_LIMITS } from '@ordo/renderer/geom/ops.ts';
import { storedGeometry } from '@ordo/renderer/geom/stored.ts';
import { describe, expect, it } from 'vitest';
import { MAX_TABLE_CELLS } from './budget.ts';
import { MAX_SLIDE_OBJECTS } from './classify.ts';
import { MAX_PATH_CHARS } from './geom.ts';
import { M9_FIELDS } from './emit-ctx.ts';
import { convertDeck, parseDeck } from './index.ts';
import type { Line, TableCell, TableElement, TableLine } from './ir.ts';
import type { FaceSource } from './metrics.ts';
import {
  asLibreOffice,
  GRID_LINES_PER_PATH,
  GRID_RECTS_PER_PATH,
  gridObjects,
  loAscent,
  loLineHeight,
  TABLE_LIMITS,
} from './tables.ts';
import { PREDEFINED_TABLE_STYLE_IDS, predefinedTableStyle } from './tablestyles.ts';
import {
  body,
  buildDeck,
  type DeckSpec,
  para,
  run,
  scheme,
  solid,
  sp,
  tableFrame,
  tc,
  tcWith,
  withTableStyles,
} from './test-util.ts';
import { child, path } from './xml.ts';

const IN = 914_400;
/** Logical px per inch on a standard 16:9 slide. */
const PX = 144;
/** Every character half an em wide: 18 px at PowerPoint's default 18 pt (36 px). */
const HALF_EM: FaceSource = () => ({ advance: () => 0.5 });

type Table = Parameters<typeof tableFrame>[0];
const table = (o: Partial<Table> & Pick<Table, 'cols' | 'rows'>): string =>
  tableFrame({ id: 7, x: IN, y: IN, ...o });

/** A grid object's box-space point in slide px. */
function toPage(o: ShapeObject, u: number, v: number): [number, number] {
  const b = o.box;
  const t = (b.rotation * Math.PI) / 180;
  const du = u - b.w / 2;
  const dv = v - b.h / 2;
  return [
    b.x + b.w / 2 + du * Math.cos(t) - dv * Math.sin(t),
    b.y + b.h / 2 + du * Math.sin(t) + dv * Math.cos(t),
  ];
}

/** A grid object's sub-paths (`M` and `L` points only, as the converter writes them) in slide px. */
function subPaths(o: ShapeObject): [number, number][][] {
  const out: [number, number][][] = [];
  for (const p of o.geom?.paths ?? []) {
    const sx = p.w > 0 ? o.box.w / p.w : 1;
    const sy = p.h > 0 ? o.box.h / p.h : 1;
    const t = p.d.split(' ');
    for (let i = 0; i < t.length; ) {
      const c = t[i++];
      if (c === 'M') out.push([]);
      if (c === 'M' || c === 'L')
        out[out.length - 1]!.push(toPage(o, Number(t[i++]) * sx, Number(t[i++]) * sy));
    }
  }
  return out;
}

/** A table's line as drawn: one sub-path of a line object, in slide px. */
interface Seg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  color: Rgba;
}
/** A table's fill rect as drawn (unturned tables): the background, or one rect sub-path of a fill object. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: Rgba;
}

const segmentsOf = (o: ShapeObject): Seg[] =>
  subPaths(o).map(([a, b]) => ({
    x0: a![0],
    y0: a![1],
    x1: b![0],
    y1: b![1],
    width: o.stroke!.width,
    color: o.stroke!.color,
  }));
const rectsOf = (o: ShapeObject): Rect[] =>
  o.geom
    ? subPaths(o).map((pts) => {
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, fill: o.fill! };
      })
    : [{ x: o.box.x, y: o.box.y, w: o.box.w, h: o.box.h, fill: o.fill! }];

/**
 * M9: the stored fields but the table object (`M9_WRITES` without 'table'): tables as their M6 group of
 * shapes and text boxes, which these tests read (the table object: `emit-table.test.ts`).
 */
const M6_GROUP = new Set(M9_FIELDS.filter((f) => f !== 'table'));

/** Convert one slide; it must be an ordinary ordo slide. */
function convert(
  shapes: string,
  opts: {
    styles?: string;
    /** The style list's default (`a:tblStyleLst def`), with `styles`. */
    def?: string;
    fontFace?: FaceSource;
    deck?: Partial<DeckSpec>;
    loCompat?: boolean;
    budgetArt?: boolean;
  } = {},
) {
  let parts = buildDeck({ slides: [{ shapes }], ...opts.deck });
  if (opts.styles !== undefined) parts = withTableStyles(parts, opts.styles, opts.def);
  const out = convertDeck(parts, {
    fontFace: opts.fontFace ?? HALF_EM,
    m9Writes: M6_GROUP,
    ...(opts.loCompat ? { loCompat: true } : {}),
    ...(opts.budgetArt ? { budgetArt: true } : {}),
  });
  const s = out.slides[0]!;
  expect(Slide.parse(s.slide)).toEqual(s.slide);
  const objects = s.slide.objects.slice(1); // the background first
  const shapes_ = objects.filter((o): o is ShapeObject => o.type === 'shape');
  const lineObjects = shapes_.filter((o) => o.stroke);
  const fillObjects = shapes_.filter((o) => o.fill);
  return {
    s,
    objects,
    texts: objects.filter((o): o is TextObject => o.type === 'text'),
    lineObjects,
    fillObjects,
    /** Every fill rect: the background's, then each fill object's runs. */
    rects: fillObjects.flatMap(rectsOf),
    /** Every line run. */
    lines: lineObjects.flatMap(segmentsOf),
  };
}

const close = (a: number, b: number, d = 0.01) => Math.abs(a - b) <= d;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const rgb = (o: { fill?: { r: number; g: number; b: number } }) => o.fill && [o.fill.r, o.fill.g, o.fill.b];

describe('tables: grid, cells and objects', () => {
  it('writes one editable text object per cell over locked grid shapes, all in one group', () => {
    const shapes = table({
      cols: [2 * IN, 3 * IN],
      rows: [
        { h: IN / 2, cells: [tc('Day'), tc('Service')] },
        { h: IN / 2, cells: [tc('Sunday'), tc('10:00')] },
      ],
    });
    const { s, objects, texts } = convert(shapes);
    expect(s.classification.class).toBe('native');
    expect(texts.map((t) => t.text)).toEqual(['Day', 'Service', 'Sunday', '10:00']);
    // Cells at their grid places: the table at (1 in, 1 in), columns 2 and 3 in wide, rows half an inch.
    expect(texts[1]!.box).toMatchObject({ x: 3 * PX, y: PX, w: 3 * PX, h: PX / 2 });
    expect(texts[2]!.box).toMatchObject({ x: PX, y: 1.5 * PX, w: 2 * PX, h: PX / 2 });
    // The cell's margins are its insets: 0.1 in left and right, 0.05 in top and bottom by default.
    const ins = texts[0]!.style.insets!;
    for (const [k, v] of [
      ['l', 14.4],
      ['t', 7.2],
      ['r', 14.4],
      ['b', 7.2],
    ] as const)
      expect(ins[k]).toBeCloseTo(v, 6);
    expect(texts[0]!.style).toMatchObject({ valign: 'top', autofit: 'shrink', lineModel: 'office' });
    expect(texts[0]!.style.fitScale).toBeUndefined();
    for (const o of objects) expect(o.origin).toMatchObject({ src: 'pptx', shapeId: 7, group: 1 });
    for (const t of texts) {
      expect(t.origin?.role).toBe('cell');
      expect(t.locked).toBeUndefined();
    }
    for (const o of objects.filter((o) => o.type === 'shape')) {
      expect(o.origin?.role).toBe('grid');
      expect(o.locked).toBe(true);
    }
  });

  it('keeps an empty cell as an empty text object to type into, in its end mark style', () => {
    const { texts } = convert(
      table({ cols: [IN, IN], rows: [{ h: IN / 2, cells: [tc('A'), tc('', { rPr: 'sz="2400"' })] }] }),
    );
    expect(texts).toHaveLength(2);
    expect(texts[1]!.text).toBe('');
    expect(texts[1]!.style.fontSizePx).toBe(36); // the default 18 pt: an empty a:p has no end mark size here
    expect(texts[1]!.runs).toBeUndefined();
  });

  it("lays a cell's text out in the master's otherStyle before defaultTextStyle, as LibreOffice does", () => {
    // The deck's defaultTextStyle centres its text at 120 % lines; the master's otherStyle sets it left at 100 %
    // (CbcKk Dedication Service and golden w65_00H differ so, both ways): a cell takes otherStyle's, as
    // LibreOffice lays table text out; a text box, which is no placeholder, keeps defaultTextStyle's.
    const deck: Partial<DeckSpec> = {
      defaultTextStyle:
        '<a:lvl1pPr algn="ctr"><a:lnSpc><a:spcPct val="120000"/></a:lnSpc><a:defRPr sz="2000"/></a:lvl1pPr>',
      master: {
        txStyles:
          '<p:titleStyle/><p:bodyStyle/><p:otherStyle><a:lvl1pPr algn="l"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:defRPr sz="1600"/></a:lvl1pPr></p:otherStyle>',
      },
    };
    const box = sp({ id: 9, x: 0, y: 5 * IN, cx: 2 * IN, cy: IN / 2, txBody: body(para(run('box'))) });
    const shapes = table({ cols: [2 * IN], rows: [{ h: IN / 2, cells: [tc('cell')] }] }) + box;
    // The M6 group: a text object per cell.
    const { texts } = convert(shapes, { deck });
    const cell = texts.find((t) => t.text === 'cell')!;
    // 100 % of the office model's single line (1.2 x the size), where defaultTextStyle's 120 % gives 1.44.
    expect(cell.style).toMatchObject({ align: 'left', fontSizePx: 32, lineHeight: 1.2 });
    expect(texts.find((t) => t.text === 'box')!.style).toMatchObject({ align: 'center', fontSizePx: 40 });
    // The table object: the same cell.
    const out = convertDeck(buildDeck({ slides: [{ shapes }], ...deck }), { fontFace: HALF_EM });
    const o = out.slides[0]!.slide.objects.find((x): x is ShapeObject => x.type === 'shape' && !!x.table)!;
    expect(cellRich(o.table!, 0)!.style).toMatchObject({ align: 'left', lineHeight: 1.2 });
    expect(cellRich(o.table!, 0)!.style.fontSizePx).toBeCloseTo(31.92, 6); // 16 pt at 600 dpi (133 px): 15.96 pt
  });

  it('runs the cells of a right-to-left table right to left, starting at the right unless set (rtl)', () => {
    const { texts } = convert(
      table({
        cols: [IN, IN],
        rows: [{ h: IN / 2, cells: [tc('שלום'), tc('x', { pPr: 'algn="ctr"' })] }],
        tblPr: '<a:tblPr rtl="1"/>',
      }),
    );
    // One paragraph a cell: its alignment and direction are the box's.
    expect(texts[0]!.style).toMatchObject({ align: 'right', direction: 'rtl' });
    expect(texts[1]!.style).toMatchObject({ align: 'center', direction: 'rtl' });
    // A left-to-right table is as before.
    const ltr = convert(table({ cols: [IN], rows: [{ h: IN / 2, cells: [tc('a')] }] })).texts;
    expect(ltr[0]!.style.align).toBe('left');
    expect(ltr[0]!.style.direction).not.toBe('rtl');
  });

  it('places the table in its group: a table in a group shares the group number', () => {
    const shapes =
      sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('FF0000') }) +
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${4 * IN}" cy="${2 * IN}"/><a:chOff x="0" y="0"/><a:chExt cx="${4 * IN}" cy="${2 * IN}"/></a:xfrm></p:grpSpPr>` +
      sp({ id: 4, x: 0, y: 0, cx: IN, cy: IN, fill: solid('00FF00') }) +
      table({ cols: [IN], rows: [{ h: IN / 2, cells: [tc('x')] }] }) +
      '</p:grpSp>';
    const { texts } = convert(shapes);
    expect(texts[0]!.origin?.group).toBe(1);
  });
});

describe('tables: merges', () => {
  it('draws a gridSpan or rowSpan merge as one cell and no line inside it', () => {
    const grid = '<a:tblPr><a:tableStyleId>{5940675A-B579-460E-94D1-54222C63F5DA}</a:tableStyleId></a:tblPr>';
    const shapes = table({
      cols: [IN, IN, IN],
      tblPr: grid, // "No Style, Table Grid": every edge a line
      rows: [
        {
          h: IN / 2,
          cells: [tc('wide', { attrs: 'gridSpan="2"' }), tc('', { attrs: 'hMerge="1"' }), tc('c')],
        },
        { h: IN / 2, cells: [tc('d'), tc('e'), tc('tall', { attrs: 'rowSpan="2"' })] },
        { h: IN / 2, cells: [tc('f'), tc('g'), tc('', { attrs: 'vMerge="1"' })] },
      ],
    });
    const { texts, lines } = convert(shapes);
    expect(texts.map((t) => t.text)).toEqual(['wide', 'c', 'd', 'e', 'tall', 'f', 'g']);
    expect(texts[0]!.box).toMatchObject({ x: PX, w: 2 * PX, h: PX / 2 });
    expect(texts[4]!.box).toMatchObject({ x: 3 * PX, y: 1.5 * PX, w: PX, h: PX });
    // The column edge between the merged cells has no line in the first row; the row edge under "tall"
    // has none in the last column.
    const vertical = lines.filter((l) => close(l.x0, l.x1));
    const atX = (x: number) => vertical.filter((l) => close(l.x0, x, 0.5));
    // Rows 2 and 3 only, stretched 1 px.
    expect(atX(2 * PX).map((l) => [r6(l.y0), r6(l.y1)])).toEqual([[1.5 * PX - 1, 2.5 * PX + 1]]);
    const horizontal = lines.filter((l) => close(l.y0, l.y1));
    const atY = (y: number) => horizontal.filter((l) => close(l.y0, y, 0.5));
    expect(atY(2 * PX).map((l) => [r6(l.x0), r6(l.x1)])).toEqual([[PX - 1, 3 * PX + 1]]);
  });

  it('cuts spans at the grid and ignores cells past it', () => {
    const { texts } = convert(
      table({
        cols: [IN, IN],
        rows: [{ h: IN / 2, cells: [tc('a', { attrs: 'gridSpan="9" rowSpan="9"' }), tc('b'), tc('c')] }],
      }),
    );
    expect(texts.map((t) => t.text)).toEqual(['a']);
    expect(texts[0]!.box).toMatchObject({ w: 2 * PX, h: PX / 2 });
  });
});

describe('tables: styles', () => {
  const STYLE_ID = '{11111111-2222-3333-4444-555555555555}';
  const ln = (color: string, w = 12_700) => `<a:ln w="${w}"><a:solidFill>${color}</a:solidFill></a:ln>`;
  const style =
    `<a:tblStyle styleId="${STYLE_ID}" styleName="Test">` +
    `<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef>${scheme('dk1')}</a:tcTxStyle>` +
    `<a:tcStyle><a:tcBdr><a:insideH>${ln(scheme('lt1'))}</a:insideH></a:tcBdr><a:fill>${solid(scheme('accent1', '<a:tint val="20000"/>'))}</a:fill></a:tcStyle></a:wholeTbl>` +
    `<a:band1H><a:tcStyle><a:tcBdr/><a:fill>${solid('AABBCC')}</a:fill></a:tcStyle></a:band1H>` +
    `<a:firstRow><a:tcTxStyle b="on">${scheme('lt1')}</a:tcTxStyle><a:tcStyle><a:tcBdr><a:bottom>${ln(scheme('lt1'), 38_100)}</a:bottom></a:tcBdr><a:fill>${solid(scheme('accent1'))}</a:fill></a:tcStyle></a:firstRow>` +
    '</a:tblStyle>';
  const rows = (n: number) =>
    Array.from({ length: n }, (_, r) => ({ h: IN / 2, cells: [tc(`r${r}a`), tc(`r${r}b`)] }));
  const tblPr = (attrs: string, id = STYLE_ID) =>
    `<a:tblPr ${attrs}><a:tableStyleId>${id}</a:tableStyleId></a:tblPr>`;

  it("applies the deck's style: first row, bands and the whole table, rows joined into one rect", () => {
    const { texts, rects, lines, fillObjects } = convert(
      table({ cols: [IN, IN], rows: rows(4), tblPr: tblPr('firstRow="1" bandRow="1"') }),
      {
        styles: style,
      },
    );
    // One rect per row (two cells of the same fill join): header accent1, band1H, the whole table's, band1H.
    const byRow = [...rects].sort((a, b) => a.y - b.y);
    expect(byRow.map(rgb)).toEqual([[68, 114, 196], [170, 187, 204], rgb(byRow[2]!), [170, 187, 204]]);
    expect(byRow[2]!.fill).not.toEqual(byRow[0]!.fill);
    expect(byRow.every((r) => close(r.w, 2 * PX) && close(r.h, PX / 2))).toBe(true);
    // One object per fill, the one whose runs span the most first: band1H (rows 2 and 4), then the others.
    expect(fillObjects.map(rgb)).toEqual([[170, 187, 204], [68, 114, 196], rgb(byRow[2]!)]);
    // Header text bold and white, body text dark (wholeTbl's dk1), the run's own properties untouched.
    expect(texts[0]!.style).toMatchObject({ fontWeight: 700, color: { r: 255, g: 255, b: 255 } });
    expect(texts[2]!.style).toMatchObject({ fontWeight: 400, color: { r: 0, g: 0, b: 0 } });
    // insideH between rows, the header's 3 pt bottom line wider than it.
    const widths = [...lines].sort((a, b) => a.y0 - b.y0).map((l) => [Math.round(l.y0), l.width]);
    expect(widths).toEqual([
      [Math.round(1.5 * PX), 6],
      [2 * PX, 2],
      [Math.round(2.5 * PX), 2],
    ]);
  });

  it('turns parts off with their flags and leaves a run its own colour', () => {
    const { texts, rects, fillObjects } = convert(
      table({
        cols: [IN],
        rows: [
          { h: IN / 2, cells: [tc('own', { rPrChildren: solid('FF0000') })] },
          { h: IN / 2, cells: [tc('b')] },
        ],
        tblPr: tblPr(''),
      }),
      { styles: style },
    );
    // No firstRow, no banding: both rows take the whole table's fill, in one object.
    expect(rects).toHaveLength(2);
    expect(fillObjects).toHaveLength(1);
    expect(rects[1]!.fill).toEqual(rects[0]!.fill);
    expect(texts[0]!.style.color).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("draws a built-in style the deck names but does not define (LibreOffice's table)", () => {
    // Medium Style 2 - Accent 1, the default style of PowerPoint's tables.
    const { texts, rects } = convert(
      table({
        cols: [IN, IN],
        rows: rows(3),
        tblPr: tblPr('firstRow="1" bandRow="1"', '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'),
      }),
    );
    expect([...rects].sort((a, b) => a.y - b.y).map(rgb)).toEqual([
      [68, 114, 196], // accent1
      [207, 213, 233], // band1H: accent1 tint 40 %
      [232, 235, 244], // wholeTbl: accent1 tint 20 %
    ]);
    expect(texts[0]!.style).toMatchObject({ fontWeight: 700, color: { r: 255, g: 255, b: 255 } });
  });

  it("gives a table that names no style none, whatever the deck's default (a:tblStyleLst def), as LibreOffice", () => {
    // LibreOffice 24.2 draws such a table without a style (regroup/r2b/tables-conv/lodef: the default named
    // and undefined, or defined in ppt/tableStyles.xml, both leave the cells unfilled; only a:tableStyleId
    // fills them). The worship deck "Depression" (white text on black cells, a list defining Medium Style 2 -
    // Accent 1 as its default) fell from 0.86 to 0.05 when the default was taken.
    const shapes = table({
      cols: [IN, IN],
      rows: [
        { h: IN / 2, cells: [tcWith('own', solid('111111')), tc('b')] },
        { h: IN / 2, cells: [tc('c'), tc('d')] },
      ],
      tblPr: '<a:tblPr/>',
    });
    const DEF = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';
    const fills = (styles: string, def?: string) =>
      convert(shapes, { styles, ...(def ? { def } : {}) })
        .rects.sort((a, b) => a.y - b.y || a.x - b.x)
        .map(rgb);
    const deckDefault = `<a:tblStyle styleId="${DEF}" styleName="Deck"><a:wholeTbl><a:tcStyle><a:fill>${solid('DDEEFF')}</a:fill></a:tcStyle></a:wholeTbl></a:tblStyle>`;
    // Only the cell's own fill, with the default named (built in) or defined, or no default at all.
    expect(fills('', DEF)).toEqual([[17, 17, 17]]);
    expect(fills(deckDefault, DEF)).toEqual([[17, 17, 17]]);
    expect(fills(deckDefault)).toEqual([[17, 17, 17]]);
    // Named, the same style fills every cell.
    const named = convert(
      table({
        cols: [IN, IN],
        rows: [{ h: IN / 2, cells: [tc('a'), tc('b')] }],
        tblPr: `<a:tblPr><a:tableStyleId>${DEF}</a:tableStyleId></a:tblPr>`,
      }),
      { styles: deckDefault, def: DEF },
    );
    expect(named.rects.map(rgb)).toEqual([[221, 238, 255]]);
  });

  it('puts the table background (the own fill of a:tblPr) under every cell', () => {
    const { rects } = convert(
      table({
        cols: [IN, IN],
        rows: [{ h: IN / 2, cells: [tc('a'), tcWith('b', solid('00FF00'))] }],
        tblPr: `<a:tblPr>${solid('0000FF')}</a:tblPr>`,
      }),
    );
    expect(rects.map(rgb)).toEqual([
      [0, 0, 255],
      [0, 255, 0],
    ]);
    expect(rects[0]!.w).toBeCloseTo(2 * PX, 6);
  });
});

describe('tables: lines', () => {
  const ln = (side: string, color: string, w: number) =>
    `<a:${side} w="${w}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:prstDash val="solid"/></a:${side}>`;
  const noLn = (side: string) => `<a:${side} w="12700"><a:noFill/></a:${side}>`;
  const two = (upper: string, lower: string) =>
    table({
      cols: [IN],
      rows: [
        { h: IN / 2, cells: [tcWith('a', upper)] },
        { h: IN / 2, cells: [tcWith('b', lower)] },
      ],
    });
  const shared = (lines: Seg[]) => lines.filter((l) => close(l.y0, l.y1) && close(l.y0, 1.5 * PX, 0.5));

  it("gives a shared edge the wider of the two cells' lines, the upper one on a tie", () => {
    let l = shared(convert(two(ln('lnB', 'FF0000', 12_700), ln('lnT', '0000FF', 25_400))).lines);
    expect(l.map((x) => [x.color.b, x.width])).toEqual([[255, 4]]);
    l = shared(convert(two(ln('lnB', 'FF0000', 12_700), ln('lnT', '0000FF', 12_700))).lines);
    expect(l.map((x) => x.color.r)).toEqual([255]);
  });

  it('draws a line where only one side has it, and none where both say none', () => {
    expect(shared(convert(two(noLn('lnB'), ln('lnT', '0000FF', 12_700))).lines)).toHaveLength(1);
    expect(shared(convert(two(noLn('lnB'), noLn('lnT'))).lines)).toHaveLength(0);
  });

  it("lets a cell's line change one property of the style's, as LibreOffice merges them", () => {
    // The style's grid (No Style, Table Grid: tx1 lines); the cell asks for 3 pt only.
    const { lines } = convert(
      table({
        cols: [IN],
        rows: [
          { h: IN / 2, cells: [tcWith('a', '<a:lnB w="38100"/>')] },
          { h: IN / 2, cells: [tc('b')] },
        ],
        tblPr: '<a:tblPr><a:tableStyleId>{5940675A-B579-460E-94D1-54222C63F5DA}</a:tableStyleId></a:tblPr>',
      }),
    );
    expect(shared(lines).map((l) => [l.width, l.color])).toEqual([[6, { r: 0, g: 0, b: 0, a: 1 }]]);
  });

  it('reads diagonal lines per cell (the table object draws them; the M6 group notes them)', () => {
    const shapes = table({
      cols: [IN],
      rows: [{ h: IN / 2, cells: [tcWith('a', ln('lnTlToBr', 'FF0000', 12_700))] }],
    });
    const { s, lines } = convert(shapes);
    expect(lines).toHaveLength(0);
    expect(s.notes).toContain('diagonal lines of table cells are not drawn (M6 group)');
    const scene = parseDeck(buildDeck({ slides: [{ shapes }] }));
    const t = scene.slides[0]!.elements[0] as TableElement;
    expect(t.support).toBe('native');
    expect(t.cells[0]!.diag).toEqual({
      down: { width: 12_700, fill: { kind: 'solid', color: { r: 255, g: 0, b: 0, a: 1 } } },
    });
  });
});

describe('tables: grid objects (one per fill and line look, fidelity round 2)', () => {
  /** A deck style drawing every edge in one 1 pt black line. */
  const GRID_ID = '{22222222-3333-4444-5555-666666666666}';
  const GRID = `<a:tblPr><a:tableStyleId>${GRID_ID}</a:tableStyleId></a:tblPr>`;
  const ln = (color: string) =>
    `<a:ln w="12700"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln>`;
  const styles =
    `<a:tblStyle styleId="${GRID_ID}" styleName="Grid"><a:wholeTbl><a:tcStyle><a:tcBdr>` +
    ['left', 'right', 'top', 'bottom', 'insideH', 'insideV']
      .map((k) => `<a:${k}>${ln('000000')}</a:${k}>`)
      .join('') +
    '</a:tcBdr></a:tcStyle></a:wholeTbl></a:tblStyle>';
  const BLACK = { r: 0, g: 0, b: 0, a: 1 };
  const cells = (rows: number, cols: number, cell = (r: number, c: number) => tc(`${r}${c}`)) =>
    Array.from({ length: rows }, (_, r) => ({
      h: IN / 2,
      cells: Array.from({ length: cols }, (_, c) => cell(r, c)),
    }));
  const tablesOf = (shapes: string) =>
    parseDeck(withTableStyles(buildDeck({ slides: [{ shapes }] }), styles)).slides[0]!.elements.filter(
      (e): e is TableElement => e.kind === 'table',
    );
  const tableOf = (shapes: string) => tablesOf(shapes)[0]!;
  const horizontal = (o: ShapeObject) => segmentsOf(o).every((l) => close(l.y0, l.y1));
  const vertical = (o: ShapeObject) => segmentsOf(o).every((l) => close(l.x0, l.x1));

  it('draws all lines of one look as one object of open sub-paths, its legacy shape the table outline', () => {
    const shapes = table({ cols: [IN, IN, IN], rows: cells(3, 3), tblPr: GRID });
    const { objects, lineObjects, lines, texts, s } = convert(shapes, { styles });
    expect(lineObjects).toHaveLength(1);
    const o = lineObjects[0]!;
    expect(o).toMatchObject({
      shape: 'rect',
      stroke: { width: 2, color: BLACK },
      opacity: 1,
      locked: true,
      origin: { role: 'grid', group: 1 },
    });
    expect(o.fill).toBeUndefined();
    expect(o.box).toEqual({ x: PX, y: PX, w: 3 * PX, h: 1.5 * PX, rotation: 0 });
    expect(o.geom!.paths!.every((p) => p.fill === 'none' && p.stroke !== false)).toBe(true);
    // Four row edges and four column edges, each one run, stretched 1 px over the lines it meets.
    expect(lines).toHaveLength(8);
    expect(lines.slice(0, 4).map((l) => [r6(l.x0), r6(l.y0), r6(l.x1), r6(l.y1)])).toEqual(
      [0, 1, 2, 3].map((r) => [PX - 1, PX + (r * PX) / 2, 4 * PX + 1, PX + (r * PX) / 2]),
    );
    // The renderer reads every sub-path back.
    const built = storedGeometry(o.geom, o.box.w, o.box.h)!;
    expect(built.paths.flatMap((p) => p.cmds).filter((c) => c === CMD_MOVE)).toHaveLength(8);
    // The table costs the slide what it emits: one line object and nine cells.
    expect(texts).toHaveLength(9);
    expect(tableOf(shapes).objects).toBe(objects.length);
    expect(objects).toHaveLength(10);
    // The previous release (0.5.0) keeps the geometry; beside it, the legacy shape is the table's outline in
    // the line (what a build without geometry drew).
    const old = (prev.Slide.parse(s.slide) as Slide).objects.find((x) => x.id === o.id) as ShapeObject;
    expect(old).toMatchObject({ shape: 'rect', box: o.box, stroke: o.stroke });
    expect(old.fill).toBeUndefined();
    expect(old.geom).toEqual(o.geom);
  });

  it('splits looks by direction when there are several, so vertical lines stay over horizontal ones', () => {
    // A 3 pt red line under the first cell over the style's 1 pt black grid: two looks.
    const shapes = table({
      cols: [IN, IN, IN],
      rows: cells(3, 3, (r, c) =>
        r === 0 && c === 0
          ? tcWith('00', '<a:lnB w="38100"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:lnB>')
          : tc(`${r}${c}`),
      ),
      tblPr: GRID,
    });
    const { objects, lineObjects } = convert(shapes, { styles });
    expect(lineObjects.map((o) => [horizontal(o), vertical(o), o.stroke!.color.r, o.stroke!.width])).toEqual([
      [true, false, 0, 2], // the black horizontal runs first, as the first run is
      [true, false, 255, 6],
      [false, true, 0, 2],
    ]);
    expect(tableOf(shapes).objects).toBe(objects.length);
    expect(objects).toHaveLength(3 + 9);
  });

  it('fills the runs of one fill as one object in the box of their bounds, the largest first', () => {
    const band = (r: number, c: number) =>
      tcWith(`${r}${c}`, solid(r === 0 ? '112233' : r % 2 ? 'AABBCC' : 'DDEEFF'));
    const shapes = table({ cols: [IN, IN], rows: cells(5, 2, band) });
    const { objects, fillObjects, rects, s } = convert(shapes);
    // Rows 1 and 3, then rows 2 and 4 (the same area, as they come), then the header.
    expect(fillObjects.map(rgb)).toEqual([
      [170, 187, 204],
      [221, 238, 255],
      [17, 34, 51],
    ]);
    const box = fillObjects[0]!.box;
    expect([box.x, box.y, box.w, box.h].map(r6)).toEqual([PX, 1.5 * PX, 2 * PX, 1.5 * PX]);
    expect(fillObjects[0]!.geom!.paths!.every((p) => p.stroke === false && !p.fill)).toBe(true);
    // Each row one rect where its cells are.
    expect([...rects].sort((a, b) => a.y - b.y).map((r) => [r.x, r.y, r.w, r.h].map(r6))).toEqual(
      [0, 1, 2, 3, 4].map((r) => [PX, PX + (r * PX) / 2, 2 * PX, PX / 2]),
    );
    expect(tableOf(shapes).objects).toBe(objects.length);
    expect(objects).toHaveLength(3 + 10);
    // The previous release (0.5.0) keeps each fill's geometry; its legacy shape is its box (the header over
    // the bands, the second band over the first).
    const old = (prev.Slide.parse(s.slide) as Slide).objects.filter((o) => o.type === 'shape');
    expect(old.slice(1).map((o) => 'geom' in o)).toEqual([true, true, true]);
    expect(old.slice(1).map((o) => (o.type === 'shape' ? o.shape : ''))).toEqual(['rect', 'rect', 'rect']);
  });

  it('turns the grid with its table: the same lines and fills, rotated about the group', () => {
    const tableXml = table({
      cols: [IN, IN],
      rows: cells(2, 2, (r, c) => tcWith(`${r}${c}`, solid(c ? 'AABBCC' : '112233'))),
      tblPr: GRID,
    });
    const group = (rot: number) =>
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm rot="${rot}"><a:off x="0" y="0"/><a:ext cx="${4 * IN}" cy="${2 * IN}"/><a:chOff x="0" y="0"/><a:chExt cx="${4 * IN}" cy="${2 * IN}"/></a:xfrm></p:grpSpPr>` +
      `${tableXml}</p:grpSp>`;
    const flat = convert(group(0), { styles });
    const turned = convert(group(1_800_000), { styles });
    const points = (c: ReturnType<typeof convert>) =>
      c.objects.filter((o): o is ShapeObject => o.type === 'shape').map(subPaths);
    // 30° clockwise about the group's centre (2 in, 1 in).
    const t = Math.PI / 6;
    const turn = ([x, y]: [number, number]) => {
      const dx = x - 2 * PX;
      const dy = y - PX;
      return [2 * PX + dx * Math.cos(t) - dy * Math.sin(t), PX + dx * Math.sin(t) + dy * Math.cos(t)];
    };
    const want = points(flat).map((o) => o.map((sp) => sp.map((q) => turn(q).map((v) => v.toFixed(2)))));
    const got = points(turned).map((o) => o.map((sp) => sp.map((q) => q.map((v) => v.toFixed(2)))));
    expect(got).toEqual(want);
    expect(turned.objects.every((o) => close(o.box.rotation, 30, 1e-9))).toBe(true);
  });

  it('keeps two chart tables native that one object per line run would send to the art', () => {
    // Every cell's lines blue or red, alternating: each of a table's 84 edges is a run of its own, so it
    // was 36 cells and 84 line objects, 240 for the two; now its lines are four objects.
    const checkered = (r: number, c: number) =>
      tcWith(
        `${r}${c}`,
        ['lnL', 'lnR', 'lnT', 'lnB']
          .map(
            (k) =>
              `<a:${k} w="12700"><a:solidFill><a:srgbClr val="${(r + c) % 2 ? 'FF0000' : '0000FF'}"/></a:solidFill></a:${k}>`,
          )
          .join(''),
      );
    const chart = (id: number, y: number) =>
      tableFrame({ id, x: IN, y, cols: Array(6).fill(IN / 2), rows: cells(6, 6, checkered) });
    const shapes = chart(7, 0) + chart(8, 3.5 * IN);
    expect(tablesOf(shapes).map((t) => [t.lines.length, t.objects])).toEqual([
      [84, 40],
      [84, 40],
    ]);
    const { s, texts, lineObjects, lines } = convert(shapes);
    expect(s.classification.class).toBe('native');
    expect(s.classification.reasons.filter((r) => r.includes('budget'))).toEqual([]);
    expect(texts).toHaveLength(72);
    expect(lineObjects).toHaveLength(8);
    expect(lines).toHaveLength(168);
  });
});

describe('tables: gridObjects within the stored path bounds', () => {
  const line: Line = { width: 12_700, fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } } };
  const run = (at: number): TableLine => ({ dir: 'h', at, from: 0, to: 1, line });
  const cell = (row: number, col: number, rows = 1, cols = 1): TableCell =>
    ({ row, col, rows, cols, fill: { kind: 'solid', color: { r: 9, g: 9, b: 9, a: 1 } } }) as TableCell;

  it('cuts a look into chained paths and goes on in another object past eight paths', () => {
    const n = GRID_LINES_PER_PATH * GEOM_LIMITS.paths + 5;
    const { lines } = gridObjects(
      [],
      Array.from({ length: n }, (_, i) => run(i)),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.paths.map((p) => p.cont)).toEqual([false, true, true, true, true, true, true, true]);
    expect(lines[1]!.paths.map((p) => [p.runs.length, p.cont])).toEqual([[5, false]]);
    expect(lines.flatMap((o) => o.paths.flatMap((p) => p.runs))).toHaveLength(n);
  });

  it('keeps the most sub-paths of a path within 4,096 points and 40,000 characters at the widest coordinates', () => {
    const c = '-999999.999';
    const lineD = Array(GRID_LINES_PER_PATH).fill(`M ${c} ${c} L ${c} ${c}`).join(' ');
    const rectD = Array(GRID_RECTS_PER_PATH)
      .fill(`M ${c} ${c} L ${c} ${c} L ${c} ${c} L ${c} ${c} Z`)
      .join(' ');
    for (const [d, points] of [
      [lineD, 2 * GRID_LINES_PER_PATH],
      [rectD, 4 * GRID_RECTS_PER_PATH],
    ] as const) {
      expect(d.length).toBeLessThanOrEqual(MAX_PATH_CHARS);
      expect(parsePathData(d, GEOM_LIMITS.points).pts).toHaveLength(2 * points);
    }
  });

  it('puts fill runs of one fill that overlap (a malformed span) in paths of their own', () => {
    // A cell spanning two columns over a cell another row's span already covers.
    const { fills } = gridObjects([cell(0, 0), cell(0, 1, 2, 1), cell(1, 0, 1, 2)], []);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.paths.map((p) => [p.runs.map((r) => [r.row, r.col, r.rows, r.cols]), p.cont])).toEqual([
      [
        [
          [0, 0, 1, 1],
          [0, 1, 2, 1],
        ],
        false,
      ],
      [[[1, 0, 1, 2]], false],
    ]);
  });
});

describe('tables: rows grow to their text', () => {
  const long = 'aaaa bbbb cccc dddd';

  it('measures Korean as the renderer breaks it (words kept whole) and spaces it by the face of its Hangul', () => {
    // The deck's family has no face; ordo's default (Inter here) has no Hangul; the script's face
    // (FaceSource.script, the library's Noto Sans KR on the hub) draws it, 1 em a syllable, its line 1.26 of the
    // size. 20 pt (40 px) in a column of 5 syllables: "가나 다라마바 사" breaks at its spaces only (UAX#14 with
    // Korean words whole, the renderer's breaks.ts): three lines, where breaking between syllables gave two.
    const latin = { advance: (cp: number) => (cp === 0x20 ? 0.25 : undefined), lineHeight: 1.21 };
    const hangul = {
      advance: (cp: number) => (cp >= 0xac00 && cp <= 0xd7a3 ? 1 : undefined),
      lineHeight: 1.26,
    };
    const faces: FaceSource = Object.assign((family: string) => (family === 'Inter' ? latin : undefined), {
      script: (code: string) => (code === 'Hang' ? hangul : undefined),
    });
    const inner = 5 * 40;
    const col = Math.round(((inner + 28.8) * 12_192_000) / 1920) + 10;
    const shapes = table({
      cols: [col],
      rows: [
        {
          h: 0,
          cells: [
            tc('가나 다라마바 사', {
              rPr: 'lang="ko-KR" sz="2000"',
              rPrChildren: '<a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/>',
            }),
          ],
        },
      ],
    });
    const scene = parseDeck(buildDeck({ slides: [{ shapes }] }), { fontFace: faces });
    const t = scene.slides[0]!.elements[0] as TableElement;
    const px = (emu: number) => (emu * 1920) / 12_192_000;
    expect(px(t.rows[0]!)).toBeCloseTo(3 * 1.26 * 40 + 14.4, 3);
    // The stored cell is spaced by the Hangul face (the table object's paragraph or box line height).
    const out = convertDeck(buildDeck({ slides: [{ shapes }] }), { fontFace: faces });
    const o = out.slides[0]!.slide.objects.find((x) => x.type === 'shape' && x.table) as ShapeObject;
    const c = cellRich(o.table!, 0)!;
    expect(c.paras?.[0]?.lineSpacing ?? c.style.lineHeight / 1.2).toBeCloseTo(1.26 / 1.2, 6);
  });

  it("asks the script's face only for scripts drawn glyph by glyph (Han, Kana, Hangul), never for Arabic", () => {
    // Arabic is shaped (its letters join), which the measure does not do: its script's face (fontconfig's
    // DejaVu Sans in the harness) measured the cec bible readings' Arabic cells a line too long and spaced them
    // by its own line, and the slide's rows fell from LibreOffice's (0.805 -> 0.741). Such a cell keeps the
    // chain's faces (or the estimate) and their spacing, as before the script's face.
    const latin = { advance: (cp: number) => (cp === 0x20 ? 0.25 : undefined), lineHeight: 1.21 };
    const arabic = {
      advance: (cp: number) => (cp >= 0x600 && cp <= 0x6ff ? 2 : undefined),
      lineHeight: 1.8,
    };
    const asked: string[] = [];
    const faces: FaceSource = Object.assign((family: string) => (family === 'Inter' ? latin : undefined), {
      script: (code: string) => {
        asked.push(code);
        return code === 'Arab' ? arabic : undefined;
      },
    });
    const shapes = table({
      cols: [2 * IN],
      rows: [{ h: 0, cells: [tc('سلام عليكم', { rPr: 'lang="ar-EG" sz="2000"' })] }],
    });
    const out = convertDeck(buildDeck({ slides: [{ shapes }] }), { fontFace: faces });
    const o = out.slides[0]!.slide.objects.find((x) => x.type === 'shape' && x.table) as ShapeObject;
    const c = cellRich(o.table!, 0)!;
    // Spaced by the chain's face (Inter's 1.21), as before the script's face, not by the Arabic face's 1.8.
    expect(c.paras?.[0]?.lineSpacing ?? c.style.lineHeight / 1.2).toBeCloseTo(1.21 / 1.2, 6);
    expect(asked).not.toContain('Arab');
  });

  it('measures text with the faces in the office line model and grows the row', () => {
    // 2 in = 288 px, less 28.8 px of margins: 14 characters of 18 px fit, so "dddd" wraps: two lines of
    // 1.2 × 36 px, plus 14.4 px of margins.
    const { texts } = convert(
      table({ cols: [2 * IN, IN], rows: [{ h: 370_840, cells: [tc(long), tc('x')] }] }),
    );
    expect(texts[0]!.box.h).toBeCloseTo(2 * 1.2 * 36 + 14.4, 6);
    expect(texts[1]!.box.h).toBeCloseTo(texts[0]!.box.h, 6); // the whole row grows
  });

  it("spaces a cell's lines by its face's line height, as LibreOffice and PowerPoint do in cells", () => {
    // Carlito's ascender less descender is 1.22 of the size; the office model's single spacing is 1.2.
    const carlito: FaceSource = () => ({ advance: () => 0.5, lineHeight: 1.22 });
    const { texts } = convert(table({ cols: [2 * IN], rows: [{ h: 0, cells: [tc(long)] }] }), {
      fontFace: carlito,
    });
    expect(texts[0]!.box.h).toBeCloseTo(2 * 1.22 * 36 + 14.4, 6);
    // Drawn with the same pitch: the box's line height is 1.22 × the size.
    expect(texts[0]!.style.lineHeight).toBeCloseTo(1.22, 6);
  });

  it('keeps a stored height taller than the text', () => {
    const { texts } = convert(table({ cols: [2 * IN], rows: [{ h: 2 * IN, cells: [tc(long)] }] }));
    expect(texts[0]!.box.h).toBeCloseTo(2 * PX, 6);
  });

  it('moves the rows under a grown one down, and gives a merge its extra height in its last row', () => {
    const shapes = table({
      cols: [IN, 2 * IN],
      rows: [
        { h: IN / 4, cells: [tc('a'), tc(long, { attrs: 'rowSpan="2"' })] },
        { h: IN / 4, cells: [tc('b'), tc('', { attrs: 'vMerge="1"' })] },
        { h: IN / 4, cells: [tc('c'), tc('d')] },
      ],
    });
    const { texts } = convert(shapes);
    const [a, merged, b, c] = texts;
    const need = 2 * 1.2 * 36 + 14.4;
    // Rows 1 and 2 hold "a" and "b" (one line each, 57.6 px); the merge needs more, which row 2 takes.
    expect(a!.box.h).toBeCloseTo(1.2 * 36 + 14.4, 6);
    expect(merged!.box.h).toBeCloseTo(Math.max(need, 2 * (1.2 * 36 + 14.4)), 6);
    expect(b!.box.y + b!.box.h).toBeCloseTo(merged!.box.y + merged!.box.h, 6);
    expect(c!.box.y).toBeCloseTo(merged!.box.y + merged!.box.h, 6);
  });

  it('counts paragraphs, line spacing and space between them', () => {
    const cell =
      '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>' +
      '<a:p><a:pPr><a:lnSpc><a:spcPct val="150000"/></a:lnSpc><a:spcAft><a:spcPts val="1000"/></a:spcAft></a:pPr>' +
      `${run('one')}</a:p>${para(run('two', 'sz="3600"'))}` +
      '<a:p><a:endParaRPr sz="1000"/></a:p></a:txBody><a:tcPr marT="0" marB="0"/></a:tc>';
    const { texts } = convert(table({ cols: [4 * IN], rows: [{ h: 0, cells: [cell] }] }));
    // 1.5 × 1.2 × 36 + 10 pt after it (20 px) + 1.2 × 72 + an empty line of 10 pt (1.2 × 20).
    expect(texts[0]!.box.h).toBeCloseTo(1.5 * 1.2 * 36 + 20 + 1.2 * 72 + 1.2 * 20, 6);
  });

  it('estimates widths conservatively when no face is known, and notes it', () => {
    const { s, texts } = convert(table({ cols: [2 * IN], rows: [{ h: 0, cells: [tc(long)] }] }), {
      fontFace: () => undefined,
    });
    expect(
      s.notes.some((n) => n.startsWith('table text measured with estimated widths (no font for Calibri')),
    ).toBe(true);
    expect(texts[0]!.box.h).toBeGreaterThan(1.2 * 36 + 14.4);
  });

  it('tries the metric substitute and ordo default face after the family', () => {
    const asked: string[] = [];
    const faces: FaceSource = (family) => {
      asked.push(family);
      return family === 'Carlito' ? { advance: () => 0.5 } : undefined;
    };
    convert(table({ cols: [2 * IN], rows: [{ h: 0, cells: [tc('x')] }] }), { fontFace: faces });
    expect(asked.slice(0, 2)).toEqual(['Calibri', 'Carlito']);
  });
});

describe('tables: kerning in the measure (R1)', () => {
  // Half an em a character, and A and V kerned a tenth of an em closer in either order.
  const kerned: FaceSource = () => ({
    advance: () => 0.5,
    kern: (a, b) => ((a === 0x41 && b === 0x56) || (a === 0x56 && b === 0x41) ? -0.1 : 0),
  });

  it('keeps a word on its line when it fits once kerned, as the renderer measures it', () => {
    // 2 in less the margins is 259.2 px. 15 characters are 270 px of advances, 219.6 px kerned: one line.
    const word = 'AVAVAVAVAVAVAVA';
    const { texts } = convert(table({ cols: [2 * IN], rows: [{ h: 0, cells: [tc(word)] }] }), {
      fontFace: kerned,
    });
    expect(texts[0]!.box.h).toBeCloseTo(1.2 * 36 + 14.4, 6);
    // Without kerning the same word is cut onto a second line.
    const plain = convert(table({ cols: [2 * IN], rows: [{ h: 0, cells: [tc(word)] }] }));
    expect(plain.texts[0]!.box.h).toBeCloseTo(2 * 1.2 * 36 + 14.4, 6);
  });

  it('cuts a word only when it is still wider than the line once kerned', () => {
    // 20 characters: 360 px of advances, 291.6 px kerned, wider than 259.2 px.
    const { texts } = convert(table({ cols: [2 * IN], rows: [{ h: 0, cells: [tc('AV'.repeat(10))] }] }), {
      fontFace: kerned,
    });
    expect(texts[0]!.box.h).toBeCloseTo(2 * 1.2 * 36 + 14.4, 6);
  });

  it('kerns within one run only, never across a change of style', () => {
    // 11 + 6 characters: 306 px of advances, 252 px kerned within the runs, 248.4 px if the pair at the run
    // boundary were kerned too. The renderer measures each run apart, so 250 px of room is two lines.
    const two = `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run('AVAVAVAVAVA')}${run('VAVAVA', 'b="1"')}</a:p></a:txBody><a:tcPr/></a:tc>`;
    const col = Math.round((250 + 28.8) * 6350);
    const { texts } = convert(table({ cols: [col], rows: [{ h: 0, cells: [two] }] }), { fontFace: kerned });
    expect(texts[0]!.box.h).toBeCloseTo(2 * 1.2 * 36 + 14.4, 6);
    const one = `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run('AVAVAVAVAVAVAVAVA')}</a:p></a:txBody><a:tcPr/></a:tc>`;
    expect(
      convert(table({ cols: [col], rows: [{ h: 0, cells: [one] }] }), { fontFace: kerned }).texts[0]!.box.h,
    ).toBeCloseTo(1.2 * 36 + 14.4, 6);
  });

  it('measures an empty cell as one line of its end mark', () => {
    const { texts } = convert(
      table({ cols: [IN, IN], rows: [{ h: 0, cells: [tc(''), tc('', { rPr: 'sz="2400"' })] }] }),
    );
    // The default 18 pt end mark: one line of 1.2 × 36 px and the margins.
    expect(texts[0]!.box.h).toBeCloseTo(1.2 * 36 + 14.4, 6);
  });
});

describe("tables: LibreOffice's rows (R1, the harness's cellRows rule)", () => {
  // Carlito's metrics: 2,500 of 2,048 units of line, 1,950 above the baseline and 550 below.
  const carlito: FaceSource = () => ({
    advance: () => 0.5,
    lineHeight: 2500 / 2048,
    ascent: 1950 / 2048,
    descent: 550 / 2048,
  });
  const MM = 360; // EMU per 1/100 mm
  const autogrow = (text = 'Title', fit = '<a:spAutoFit/>') =>
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${IN}" cy="${IN / 2}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square">${fit}</a:bodyPr><a:lstStyle/>${text ? para(run(text)) : '<a:p/>'}</p:txBody></p:sp>`;
  const tableOf = (shapes: string) => {
    const scene = parseDeck(buildDeck({ slides: [{ shapes }] }), { fontFace: carlito });
    return scene.slides[0]!.elements.find((e): e is TableElement => e.kind === 'table')!;
  };
  const one = (pPr?: string) =>
    table({
      cols: [4 * IN],
      rows: [{ h: 0, cells: [tc('one line', { tcPr: ' anchor="ctr"', ...(pPr ? { pPr } : {}) })] }],
    });

  it("sizes a line at the face's ascent and descent at a 600 dpi reference device", () => {
    // 18 pt is 635/100 mm, 150 px at 600 dpi: ascent 143 px and descent 40 px, 183 px together, converted back
    // once: 774.7, 775/100 mm, the larger (the probe's 18 pt rows; converted apart, 605 + 169 = 774).
    expect(loLineHeight(18, carlito('', false, false), 'font')).toBe(775);
    expect(loAscent(18, carlito('', false, false), 'font')).toBe(605);
    // 10 pt Carlito Bold (its vertical metrics are Carlito's): 83 px, 79 and 22 px, 101 px together, 427.6:
    // 428/100 mm a line, as the 1000 Years chart's eleven row rules show (334 + 93 = 427 converted apart).
    expect(loLineHeight(10, carlito('Calibri', true, false), 'font')).toBe(428);
    expect(loAscent(10, carlito('Calibri', true, false), 'font')).toBe(334);
    // 9 pt: 75 px, 71 and 20 px: 301 + 85 = 386 converted apart, the larger (their 91 px converted: 385).
    expect(loLineHeight(9, carlito('', false, false), 'font')).toBe(386);
    // Font-independent: 1.2 × 635, rounded (the probe's 14 pt lines: 1.2 × 494 = 592.8 is 593, and its 9 pt
    // ones 1.2 × 318 = 381.6 is 382); the ascent is the font height.
    expect(loLineHeight(18, undefined, 'independent')).toBe(762);
    expect(loLineHeight(14, undefined, 'independent')).toBe(593);
    expect(loLineHeight(9, undefined, 'independent')).toBe(382);
    expect(loAscent(18, carlito('', false, false), 'independent')).toBe(635);
    const t = tableOf(one());
    expect(t.lo?.lines).toBe('font');
    // The line, LibreOffice's extra 1/100 mm, and the two margins of 127/100 mm.
    expect(t.lo?.rows).toEqual([(775 + 1 + 254) * MM]);
    // ordo's own row: 1.2207 × 36 px and the margins.
    expect(t.rows[0]! / 6350).toBeCloseTo((2500 / 2048) * 36 + 14.4, 6);
  });

  it('uses font-independent spacing after a text shape that grows to its text, on the same slide', () => {
    expect(tableOf(autogrow() + one()).lo?.rows).toEqual([(762 + 1 + 254) * MM]);
    expect(tableOf(autogrow() + one()).lo?.lines).toBe('independent');
    // Not after one without text, without its own a:spAutoFit, or when the shape comes after the table.
    expect(tableOf(autogrow('') + one()).lo?.lines).toBe('font');
    expect(tableOf(autogrow('Title', '<a:normAutofit/>') + one()).lo?.lines).toBe('font');
    expect(tableOf(one() + autogrow()).lo?.lines).toBe('font');
  });

  it('scales a line by its proportional spacing, truncated, and keeps exact spacing', () => {
    const pct = tableOf(one('<a:pPr><a:lnSpc><a:spcPct val="107000"/></a:lnSpc></a:pPr>'));
    expect(pct.lo?.rows).toEqual([(Math.trunc(775 * 1.07) + 255) * MM]);
    const pts = tableOf(one('<a:pPr><a:lnSpc><a:spcPts val="2000"/></a:lnSpc></a:pPr>'));
    expect(pts.lo?.rows).toEqual([(706 + 255) * MM]); // 20 pt is 705.6/100 mm
  });

  it("draws the table with LibreOffice's rows under loCompat: text into the margins and at the face's ascent", () => {
    const shapes =
      autogrow() +
      table({
        cols: [4 * IN],
        rows: [{ h: 0, cells: [tc('a\nb\nc\nd\ne', { tcPr: ' anchor="ctr"' })] }],
      });
    const ordo = convert(shapes, { fontFace: carlito });
    const lo = convert(shapes, { fontFace: carlito, loCompat: true });
    const ours = ordo.texts.find((t) => t.origin?.role === 'cell')!;
    const theirs = lo.texts.find((t) => t.origin?.role === 'cell')!;
    // Five lines of 762/100 mm, the extra 1/100 mm and the margins.
    expect(theirs.box.h).toBeCloseTo(((5 * 762 + 255) * MM) / 6350, 6);
    expect(ours.box.h).toBeCloseTo(5 * (2500 / 2048) * 36 + 14.4, 6);
    // The drawn text is taller than LibreOffice's row by the difference, centred into both margins, and
    // moved up to where LibreOffice puts the baselines; the box's text area is as tall as the text.
    const ins = theirs.style.insets!;
    expect(ins.t + ins.b).toBeCloseTo(theirs.box.h - 5 * (2500 / 2048) * 36, 1);
    expect(ins.t).toBeLessThan(ins.b);
    // ordo's own drawing keeps the cell's margins.
    for (const [k, v] of Object.entries({ l: 14.4, t: 7.2, r: 14.4, b: 7.2 }))
      expect(ours.style.insets![k as 'l']).toBeCloseTo(v, 9);
  });

  it('starts a drawn block taller than its cell at the top margin, and centres one with room (dense-c C2)', () => {
    // 16 pt Calibri after a text shape that grows to its text (font-independent rows): LibreOffice measures the
    // line 1.2 × 564 = 677/100 mm and draws it 690 (127 + 36 px at 600 dpi), so a row grown to it holds 678 of
    // inner height. The drawn line starts at the top margin, not centred 6/100 mm above it: Moral Character's
    // 120 single-line cells, and the Depression deck's 145 lines (offset = max(0, (inner - drawn) / 2)). Rows
    // stored taller give the line room, and it is centred there, as before.
    const row = (h: number) => ({ h, cells: [tc('one line', { tcPr: ' anchor="ctr"', rPr: 'sz="1600"' })] });
    const t = tableOf(
      autogrow() +
        table({ cols: [4 * IN], rows: [row(0), row((690 + 254 + 200) * MM), row((690 + 254 + 400) * MM)] }),
    );
    expect(t.lo?.lines).toBe('independent');
    expect(t.lo?.rows).toEqual([(677 + 1 + 254) * MM, (690 + 254 + 200) * MM, (690 + 254 + 400) * MM]);
    const [full, room, more] = t.lo!.lift;
    // With room the drawn line is centred: where it sits from the cell's centre does not depend on the room.
    expect(more).toBe(room);
    // Full: from the top margin, less the 1/100 mm LibreOffice starts an overflowing block above it (the cell
    // probe, `loBlockTop`): 5/100 mm lower than centred, so ordo's line (centred in its cell) is lifted 5 less.
    expect(full).toBe(room! - 5 * MM);
  });

  it('puts the whole height of a merge from the first row on its last row, as LayoutTableHeight does', () => {
    // One line of 18 pt Carlito and three, each with the extra 1/100 mm and the margins.
    const one = 775 + 1 + 254;
    const three = 3 * 775 + 1 + 254;
    const merged = (start: number) =>
      tableOf(
        table({
          cols: [2 * IN, 2 * IN],
          rows: [0, 1, 2].map((r) => ({
            h: 0,
            cells: [
              tc(`row ${r}`),
              r === start
                ? tc('a\nb\nc', { attrs: 'rowSpan="2"' })
                : r === start + 1
                  ? tc('', { attrs: 'vMerge="1"' })
                  : tc('d'),
            ],
          })),
        }),
      );
    // From the first row the subtraction loop ends at once: row 1 takes the merge's whole height.
    const top = merged(0);
    expect(top.lo?.rows).toEqual([one, three, one].map((v) => v * MM));
    // From the second row it is checked less the rows before its last, the way ordo's rows take it.
    const low = merged(1);
    expect(low.lo?.rows).toEqual([one, one, three - one].map((v) => v * MM));
    // ordo's own rows give a merge from the first row only its shortfall over the rows it spans.
    const line = (2500 / 2048) * 36;
    const px = top.rows.map((h) => h / 6350);
    expect(px[0]).toBeCloseTo(line + 14.4, 6);
    expect(px[0]! + px[1]!).toBeCloseTo(3 * line + 14.4, 6);
  });

  it('widens a column to its minimum and puts a merge from the first column on its last, as LayoutTableWidth does', () => {
    const wide = ' marL="182880" marR="182880"'; // 508/100 mm each: a minimum of 1,116/100 mm
    const tight = ' marL="0" marR="0"'; // a minimum of 1 mm
    const narrow = 300 * MM; // 3 mm
    const first = table({
      cols: [IN, narrow, IN],
      rows: [
        {
          h: 0,
          cells: [
            tc('a', { attrs: 'gridSpan="2"', tcPr: wide }),
            tc('', { attrs: 'hMerge="1"' }),
            tc('b', { tcPr: tight }),
          ],
        },
        { h: 0, cells: [tc('c', { tcPr: tight }), tc('', { tcPr: tight }), tc('d', { tcPr: tight })] },
      ],
    });
    // Its own cells need 1 mm, less than 3 mm; the merge from the first column puts its whole minimum on
    // the narrow column, nothing subtracted. ordo's own columns are the grid's.
    const t = tableOf(first);
    expect(t.lo?.cols).toEqual([IN, 1116 * MM, IN]);
    expect(t.cols).toEqual([IN, narrow, IN]);
    // The table grows to the right: under loCompat the third column starts that much further.
    expect(t.lo!.xf[0]).toBeCloseTo(2 * IN + 1116 * MM, 6);
    expect(t.lo!.xf[4]).toBe(t.xf[4]);
    const cellB = (lo: boolean) =>
      convert(first, { fontFace: carlito, loCompat: lo }).texts.find((o) => o.text === 'b')!.box;
    expect(cellB(true).x).toBeCloseTo((2 * IN + 1116 * MM) / 6350, 6);
    expect(cellB(false).x).toBeCloseTo((2 * IN + narrow) / 6350, 6);

    // From the second column: a cell with the default margins widens the narrow column to 608/100 mm
    // first, and the merge needs only its minimum less that column of the last one.
    const second = tableOf(
      table({
        cols: [IN, narrow, narrow],
        rows: [
          {
            h: 0,
            cells: [
              tc('a', { tcPr: tight }),
              tc('b', { attrs: 'gridSpan="2"', tcPr: wide }),
              tc('', { attrs: 'hMerge="1"' }),
            ],
          },
          { h: 0, cells: [tc('c', { tcPr: tight }), tc(''), tc('d', { tcPr: tight })] },
        ],
      }),
    );
    expect(second.lo?.cols).toEqual([IN, 608 * MM, (1116 - 608) * MM]);
  });
});

describe('tables: what stays residual', () => {
  it('counts drawn cells: a merge is one cell, the cells it covers none', () => {
    // 12 × 13 = 156 grid cells, more than a slide may have objects, but each of the first six rows is one
    // merge of thirteen: 84 drawn, read and measured, and with the background the slide's 85 objects fit.
    const rows = Array.from({ length: 12 }, (_, r) => ({
      h: IN / 16,
      cells: Array.from({ length: 13 }, (_, c) =>
        r < 6 && c === 0
          ? tc('x', { attrs: 'gridSpan="13"' })
          : r < 6
            ? tc('', { attrs: 'hMerge="1"' })
            : tc('x'),
      ),
    }));
    const { s, texts } = convert(table({ cols: Array(13).fill(IN / 2), rows }));
    expect(s.classification.class).toBe('native');
    expect(texts).toHaveLength(84);
  });

  it('cuts a table past 256 rows and notes it', () => {
    const rows = Array.from({ length: 300 }, (_, r) => ({ h: 12_700, cells: [tc(`r${r}`)] }));
    const scene = parseDeck(buildDeck({ slides: [{ shapes: table({ cols: [IN], rows }) }] }), {
      fontFace: HALF_EM,
    });
    const t = scene.slides[0]!.elements[0] as TableElement;
    expect(t.kind).toBe('table');
    expect(t.rows).toHaveLength(TABLE_LIMITS.rows);
    expect(t.storedRows).toHaveLength(TABLE_LIMITS.rows);
    expect(t.cells).toHaveLength(TABLE_LIMITS.rows);
    expect(t.cells[255]!.text.paras[0]!.runs[0]!.text).toBe('r255');
    expect(scene.slides[0]!.notes).toContain(
      'a table of 300 rows and 1 columns is cut to its first 256 rows and 1 columns',
    );
  });

  it(`cuts a table past 64 columns or ${TABLE_LIMITS.grid} slots to its first ones`, () => {
    // 65 rows of 64 columns: 4,160 slots, so the first 64 rows (4,096) are read.
    const rows = Array.from({ length: 65 }, () => ({
      h: 12_700,
      cells: [tc('x', { attrs: 'gridSpan="70"' })],
    }));
    const scene = parseDeck(
      buildDeck({ slides: [{ shapes: table({ cols: Array(70).fill(IN / 8), rows }) }] }),
    );
    const t = scene.slides[0]!.elements[0] as TableElement;
    expect(t.cols).toHaveLength(64);
    expect(t.rows).toHaveLength(64);
    expect(t.cells).toHaveLength(64);
    expect(t.cells.every((c) => c.cols === 64)).toBe(true);
    expect(scene.slides[0]!.notes).toContain(
      'a table of 65 rows and 70 columns is cut to its first 64 rows and 64 columns',
    );
  });

  it('keeps the bounds of the stored table (TABLE_LIMITS of @ordo/domain)', () => {
    expect(TABLE_LIMITS).toEqual({
      rows: DOMAIN_LIMITS.rows,
      cols: DOMAIN_LIMITS.cols,
      grid: DOMAIN_LIMITS.grid,
      cellText: DOMAIN_LIMITS.cellText,
      tableText: DOMAIN_LIMITS.tableText,
    });
  });

  it('draws a dense table natively while the slide stays within its object budget', () => {
    // 90 cells and no style: 90 text objects and the background, so no fixed cell count sends it to the art.
    const rows = Array.from({ length: 10 }, () => ({
      h: IN / 8,
      cells: Array.from({ length: 9 }, () => tc('x')),
    }));
    const { s, texts } = convert(table({ cols: Array(9).fill(IN / 2), rows }));
    expect(s.classification.class).toBe('native');
    expect(s.classification.reasons.filter((r) => r.startsWith('art:'))).toEqual([]);
    expect(texts).toHaveLength(90);
  });

  it('sends the same table to the art once its objects pass the slide budget behind budgetArt (budget:table)', () => {
    // M9 (`decor-conv`): a table is one object of the slide's budget (`ShapeObject.table`); the M6 art
    // stays for the harness's A/B only.
    // A fill of its own in every cell: the grid draws one object per fill (gridObjects), so the 90 cells
    // are 90 fill objects and 90 text objects.
    const rows = Array.from({ length: 10 }, (_, r) => ({
      h: IN / 8,
      cells: Array.from({ length: 9 }, (_, c) =>
        tcWith('x', solid((0x100000 + r * 9 + c).toString(16).toUpperCase())),
      ),
    }));
    const { s, texts, rects } = convert(table({ cols: Array(9).fill(IN / 2), rows }), { budgetArt: true });
    expect(s.classification.class).toBe('hybrid');
    expect(s.classification.reasons).toContain('art:budget:table');
    expect(texts).toHaveLength(0);
    expect(rects).toHaveLength(0);
    expect(s.notes).toContain("a table of 180 objects passes the slide's budget: LibreOffice draws it");
    // Read in full, its cells' text is the art's (search and labels).
    expect(s.art?.text).toContain('x');
  });

  it('reads and measures a table of more cells than a slide may have objects (M9: no cell cap)', () => {
    // 12 × 13 = 156 drawn cells: M6 left it to LibreOffice unmeasured; the table object is one object.
    const rows = Array.from({ length: 12 }, () => ({
      h: IN / 16,
      cells: Array.from({ length: 13 }, () => tc('x')),
    }));
    let faces = 0;
    const counting: FaceSource = (...args) => {
      faces++;
      return HALF_EM(...args);
    };
    const scene = parseDeck(
      buildDeck({ slides: [{ shapes: table({ cols: Array(13).fill(IN / 2), rows }) }] }),
      {
        fontFace: counting,
      },
    );
    const t = scene.slides[0]!.elements[0] as TableElement;
    expect(t.kind).toBe('table');
    expect(t.cells).toHaveLength(156);
    expect(t.cells.every((c) => c.text.paras[0]!.runs[0]!.text === 'x')).toBe(true);
    expect(faces).toBeGreaterThan(0);
  });

  it('leaves a table with vertical cell text to LibreOffice', () => {
    const { s } = convert(
      table({ cols: [IN], rows: [{ h: IN, cells: [tc('v', { tcPr: ' vert="vert"' })] }] }),
    );
    expect(s.classification.reasons).toContain('art:table');
    expect(s.notes).toContain('a table with vertical cell text is drawn by LibreOffice (M8)');
  });

  // Rule V (sub-wave 1c): LibreOffice 24.2 draws `eaVert` table cells exactly as `horz` ones (probe deck A:
  // the same glyph positions within 0.1 pt, none turned), so such a table is the table object, the cell's
  // `vert` kept for a later vertical text engine. The other kinds stay LibreOffice's art (owner question
  // Q1c-5): vert and vert270 are LibreOffice's vertical writing; wordArtVert, wordArtVertRtl and mongolianVert,
  // drawn horizontally too, are in no measured deck.
  /** The Korean bulletin's vertical cells: a narrow first column, '1년차' over a rowSpan of 4, centred. */
  const eaVertTable = (vert: string) =>
    table({
      cols: [IN / 2, 2 * IN],
      rows: [
        {
          h: IN / 4,
          cells: [tc('1년차', { tcPr: ` vert="${vert}" anchor="ctr"`, attrs: 'rowSpan="4"' }), tc('2019')],
        },
        { h: IN / 4, cells: [tc('', { attrs: 'vMerge="1"' }), tc('2020')] },
        { h: IN / 4, cells: [tc('', { attrs: 'vMerge="1"' }), tc('2021')] },
        { h: IN / 4, cells: [tc('', { attrs: 'vMerge="1"' }), tc('2022')] },
      ],
    });

  it('reads a table with East Asian vertical cells (eaVert) as the table object, the cell keeping its vert', () => {
    const deck = () => buildDeck({ slides: [{ shapes: eaVertTable('eaVert') }] });
    const scene = parseDeck(deck(), { fontFace: HALF_EM });
    const t = scene.slides[0]!.elements[0] as TableElement;
    expect(t.kind).toBe('table');
    expect(t.support).toBe('native');
    expect(t.cells.map((c) => [c.row, c.col, c.rows, c.vert])).toEqual([
      [0, 0, 4, 'eaVert'],
      [0, 1, 1, undefined],
      [1, 1, 1, undefined],
      [2, 1, 1, undefined],
      [3, 1, 1, undefined],
    ]);
    expect(scene.slides[0]!.notes).not.toContain(
      'a table with vertical cell text is drawn by LibreOffice (M8)',
    );
    // Stored as the table object on every hub: no art, nothing left to LibreOffice.
    const s = convertDeck(deck(), { fontFace: HALF_EM }).slides[0]!;
    expect(s.classification.class).toBe('native');
    expect(s.classification.reasons.filter((r) => r.startsWith('art:'))).toEqual([]);
    expect(s.slide.objects.filter((o) => o.type === 'shape' && o.table)).toHaveLength(1);
    // A horz cell says nothing.
    const horz = parseDeck(buildDeck({ slides: [{ shapes: eaVertTable('horz') }] }), { fontFace: HALF_EM });
    expect((horz.slides[0]!.elements[0] as TableElement).cells.every((c) => c.vert === undefined)).toBe(true);
  });

  it('leaves the other vertical kinds to LibreOffice: vert, vert270, wordArtVert, wordArtVertRtl, mongolianVert', () => {
    for (const vert of ['vert', 'vert270', 'wordArtVert', 'wordArtVertRtl', 'mongolianVert']) {
      const scene = parseDeck(buildDeck({ slides: [{ shapes: eaVertTable(vert) }] }), { fontFace: HALF_EM });
      const e = scene.slides[0]!.elements[0]!;
      expect(e, vert).toMatchObject({ kind: 'residual', what: 'table', support: 'residual' });
      expect(e.reasons, vert).toContain('vert');
      expect(scene.slides[0]!.notes, vert).toContain(
        'a table with vertical cell text is drawn by LibreOffice (M8)',
      );
    }
  });

  it("without the table object (the kill switch) keeps M6's cell cap: a table of more cells than a slide may have objects is LibreOffice's", () => {
    expect(MAX_TABLE_CELLS).toBe(MAX_SLIDE_OBJECTS);
    const rows = Array.from({ length: 12 }, () => ({
      h: IN / 16,
      cells: Array.from({ length: 13 }, () => tc('x')),
    }));
    const { s, texts } = convert(table({ cols: Array(13).fill(IN / 2), rows }));
    expect(texts).toHaveLength(0);
    expect(s.classification.class).toBe('hybrid');
    expect(s.classification.reasons).toContain('art:budget:table');
    expect(s.notes).toContain(
      `a table of 156 cells passes the slide's budget of ${MAX_SLIDE_OBJECTS} objects: LibreOffice draws it`,
    );
  });

  it('sends the largest tables to the art when the slide would pass its object budget behind budgetArt', () => {
    // Every cell its own fill: no two join or share an object, so each table is a fill and a text per cell.
    const cell = (r: number, c: number) =>
      tcWith('x', solid((r * 16 + c + 1).toString(16).padStart(2, '0').repeat(3)));
    const big = (id: number, y: number, cols: number) =>
      tableFrame({
        id,
        x: IN,
        y,
        cols: Array(cols).fill(IN / 2),
        rows: Array.from({ length: 10 }, (_, r) => ({
          h: IN / 8,
          cells: Array.from({ length: cols }, (_, c) => cell(r, c)),
        })),
      });
    const { s, texts, rects } = convert(big(7, 0, 5) + big(8, 2 * IN, 6), { budgetArt: true });
    // 100 and 120 objects: the larger table goes to the art and the slide keeps 100 under the budget.
    expect(s.classification.class).toBe('hybrid');
    expect(s.classification.reasons).toContain('art:budget:table');
    expect(texts).toHaveLength(50);
    expect(rects).toHaveLength(50);
    expect(s.notes).toContain("a table of 120 objects passes the slide's budget: LibreOffice draws it");
    // The art's text holds the table's cells (search and labels).
    expect(s.art?.text).toContain('x');
  });
});

describe("LibreOffice's built-in table styles", () => {
  it('has all 74, each as an a:tblStyle element with its id', () => {
    expect(PREDEFINED_TABLE_STYLE_IDS).toHaveLength(74);
    for (const id of PREDEFINED_TABLE_STYLE_IDS) {
      const s = predefinedTableStyle(id)!;
      expect(s.name).toBe('a:tblStyle');
      expect(s.attrs.styleId).toBe(id);
      expect(child(s, 'a:wholeTbl')).toBeDefined();
    }
    expect(predefinedTableStyle('{00000000-0000-0000-0000-000000000000}')).toBeUndefined();
    expect(predefinedTableStyle('{5c22544a-7ee6-4342-b048-85bdc9fd1c3a}')).toBe(
      predefinedTableStyle('{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'),
    );
  });

  it('writes bold heads and 1 pt lines, as PowerPoint defines the styles', () => {
    const light2 = predefinedTableStyle('{7E9639D4-E3E2-4D34-9284-5A2195B3D0D7}')!;
    expect(path(light2, 'a:firstRow', 'a:tcTxStyle')?.attrs.b).toBe('on');
    expect(path(light2, 'a:band1H', 'a:tcStyle', 'a:tcBdr', 'a:top', 'a:ln')?.attrs.w).toBe('12700');
    // The two "No Style" styles have no bold parts.
    const plain = predefinedTableStyle('{2D5ABB26-0587-4C30-8999-92F81FD0307C}')!;
    expect(path(plain, 'a:firstRow', 'a:tcTxStyle')).toBeUndefined();
    // Themed Style 2 - Accent 1 has a table background.
    expect(
      path(predefinedTableStyle('{D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7}'), 'a:tblBg', 'a:fill'),
    ).toBeDefined();
  });
});

describe('tables: shape text is unchanged', () => {
  it('still reads a shape with text the way it did', () => {
    const { texts } = convert(sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, txBody: body(para(run('hi'))) }));
    expect(texts.map((t) => t.text)).toEqual(['hi']);
    // A shape's own text (M4's origin), not a table cell's.
    expect(texts[0]!.origin).toEqual({ src: 'pptx', role: 'text', shapeId: 2 });
  });
});

describe('asLibreOffice', () => {
  const style = (valign: 'top' | 'middle' | 'bottom', t: number, b: number) =>
    ({ valign, insets: { l: 0, t, r: 0, b } }) as unknown as TextObject['style'];
  // A centred text's top is (h + t - b - text) / 2: it moves by half the change of t - b.
  const top = (s: TextObject['style']) => (s.insets!.t - s.insets!.b) / 2;

  it('lifts centred text by the whole lift in a cell with no top margin (marT="0")', () => {
    const lifted = asLibreOffice(style('middle', 0, 0), 0, 1.5);
    expect(top(lifted) - top(style('middle', 0, 0))).toBeCloseTo(-1.5, 9);
    expect(lifted.insets!.t).toBeGreaterThanOrEqual(0);
    expect(lifted.insets!.b).toBeGreaterThanOrEqual(0);
  });

  it('keeps centred text centred under a spill wider than one margin', () => {
    const s = asLibreOffice(style('middle', 0, 4), 6, 0);
    expect(top(s)).toBeCloseTo(top(style('middle', 0, 4)), 9);
  });

  it('moves centred text with margins as before', () => {
    expect(asLibreOffice(style('middle', 7.2, 7.2), 2, 1).insets).toEqual({ l: 0, t: 5.2, r: 0, b: 7.2 });
  });

  // r2b-diag/dense-c 910492b, the same rule found on the Flesh and Spirit chart (its 84 cells with marT="0").
  it('lifts centred text by its whole lift when the top margin is smaller than it, either way', () => {
    const lr = (valign: 'top' | 'middle' | 'bottom', t: number, b: number) =>
      ({ valign, insets: { l: 1, t, r: 1, b } }) as unknown as TextObject['style'];
    // No top or bottom margin: a 1 px lift moves the centre 1 px up (margins 0 and 2), not 0.5 px (0 and 1).
    expect(asLibreOffice(lr('middle', 0, 0), 0, 1).insets).toEqual({ l: 1, t: 0, r: 1, b: 2 });
    expect(asLibreOffice(lr('middle', 0, 0), 0, -1).insets).toEqual({ l: 1, t: 2, r: 1, b: 0 });
    // Within the margins as before: the spill shared, the lift from top to bottom.
    expect(asLibreOffice(lr('middle', 5, 5), 2, 1).insets).toEqual({ l: 1, t: 3, r: 1, b: 5 });
    expect(asLibreOffice(lr('top', 5, 5), 2, 1).insets).toEqual({ l: 1, t: 4, r: 1, b: 4 });
  });
});

import { parsePathData, type Rgba, type ShapeObject, Slide, type TextObject } from '@ordo/domain';
import * as prev from '@ordo/domain/schemas.prev.test-util.ts';
import { CMD_MOVE, GEOM_LIMITS } from '@ordo/renderer/geom/ops.ts';
import { storedGeometry } from '@ordo/renderer/geom/stored.ts';
import { describe, expect, it } from 'vitest';
import { MAX_SLIDE_OBJECTS } from './classify.ts';
import { MAX_PATH_CHARS } from './geom.ts';
import { convertDeck, parseDeck } from './index.ts';
import type { Line, TableCell, TableElement, TableLine } from './ir.ts';
import type { FaceSource } from './metrics.ts';
import {
  GRID_LINES_PER_PATH,
  GRID_RECTS_PER_PATH,
  gridObjects,
  loAscent,
  loLineHeight,
  MAX_TABLE_CELLS,
  MAX_TABLE_GRID,
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

/** Convert one slide; it must be an ordinary ordo slide. */
function convert(
  shapes: string,
  opts: { styles?: string; fontFace?: FaceSource; deck?: Partial<DeckSpec>; loCompat?: boolean } = {},
) {
  let parts = buildDeck({ slides: [{ shapes }], ...opts.deck });
  if (opts.styles !== undefined) parts = withTableStyles(parts, opts.styles);
  const out = convertDeck(parts, {
    fontFace: opts.fontFace ?? HALF_EM,
    ...(opts.loCompat ? { loCompat: true } : {}),
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

  it('notes diagonal lines, which are not drawn, and rates the table approx', () => {
    const shapes = table({
      cols: [IN],
      rows: [{ h: IN / 2, cells: [tcWith('a', ln('lnTlToBr', 'FF0000', 12_700))] }],
    });
    const { s, lines } = convert(shapes);
    expect(lines).toHaveLength(0);
    expect(s.notes).toContain('diagonal lines of table cells are not drawn');
    const scene = parseDeck(buildDeck({ slides: [{ shapes }] }));
    const t = scene.slides[0]!.elements[0] as TableElement;
    expect(t.support).toBe('approx');
    expect(t.reasons).toContain('tableDiagonal');
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
    // An older build strips the geometry and draws the table's outline in the line.
    const old = (prev.Slide.parse(s.slide) as Slide).objects.find((x) => x.id === o.id) as ShapeObject;
    expect(old).toMatchObject({ shape: 'rect', box: o.box, stroke: o.stroke });
    expect(old.fill).toBeUndefined();
    expect('geom' in old).toBe(false);
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
    // An older build draws each as its box: the header over the bands, the second band over the first.
    const old = (prev.Slide.parse(s.slide) as Slide).objects.filter((o) => o.type === 'shape');
    expect(old.slice(1).map((o) => 'geom' in o)).toEqual([false, false, false]);
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
    // 18 pt is 635/100 mm, 150 px at 600 dpi: ascent 143 px and descent 40 px, 605 and 169/100 mm.
    expect(loLineHeight(18, carlito('', false, false), 'font')).toBe(774);
    expect(loAscent(18, carlito('', false, false), 'font')).toBe(605);
    // Font-independent: 1.2 × 635, truncated; the ascent is the font height.
    expect(loLineHeight(18, undefined, 'independent')).toBe(762);
    expect(loAscent(18, carlito('', false, false), 'independent')).toBe(635);
    const t = tableOf(one());
    expect(t.lo?.lines).toBe('font');
    // The line, LibreOffice's extra 1/100 mm, and the two margins of 127/100 mm.
    expect(t.lo?.rows).toEqual([(774 + 1 + 254) * MM]);
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
    expect(pct.lo?.rows).toEqual([(Math.trunc(774 * 1.07) + 255) * MM]);
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

  it('puts the whole height of a merge from the first row on its last row, as LayoutTableHeight does', () => {
    // One line of 18 pt Carlito and three, each with the extra 1/100 mm and the margins.
    const one = 774 + 1 + 254;
    const three = 3 * 774 + 1 + 254;
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

  it(`reads no table of more than ${MAX_TABLE_GRID} grid cells`, () => {
    const rows = Array.from({ length: 65 }, () => ({
      h: 12_700,
      cells: [tc('x', { attrs: `gridSpan="64"` })],
    }));
    const { s, texts } = convert(table({ cols: Array(64).fill(IN / 8), rows }));
    expect(texts).toHaveLength(0);
    expect(s.notes.some((n) => n.startsWith(`a table of ${65 * 64} grid cells`))).toBe(true);
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

  it('sends the same table to the art once its objects pass the slide budget (budget:table)', () => {
    // A fill of its own in every cell: the grid draws one object per fill (gridObjects), so the 90 cells
    // are 90 fill objects and 90 text objects.
    const rows = Array.from({ length: 10 }, (_, r) => ({
      h: IN / 8,
      cells: Array.from({ length: 9 }, (_, c) =>
        tcWith('x', solid((0x100000 + r * 9 + c).toString(16).toUpperCase())),
      ),
    }));
    const { s, texts, rects } = convert(table({ cols: Array(9).fill(IN / 2), rows }));
    expect(s.classification.class).toBe('hybrid');
    expect(s.classification.reasons).toContain('art:budget:table');
    expect(texts).toHaveLength(0);
    expect(rects).toHaveLength(0);
    expect(s.notes).toContain("a table of 180 objects passes the slide's budget: LibreOffice draws it");
    // Read in full, its cells' text is the art's (search and labels).
    expect(s.art?.text).toContain('x');
  });

  it('leaves a table of more cells than a slide may have objects to LibreOffice, unmeasured', () => {
    expect(MAX_TABLE_CELLS).toBe(MAX_SLIDE_OBJECTS);
    // 12 × 13 = 156 drawn cells: each is an object, so the table could never be drawn natively.
    const rows = Array.from({ length: 12 }, () => ({
      h: IN / 16,
      cells: Array.from({ length: 13 }, () => tc('x')),
    }));
    let faces = 0;
    const counting: FaceSource = (...args) => {
      faces++;
      return HALF_EM(...args);
    };
    const { s, texts } = convert(table({ cols: Array(13).fill(IN / 2), rows }), { fontFace: counting });
    expect(texts).toHaveLength(0);
    expect(faces).toBe(0);
    expect(s.classification.class).toBe('hybrid');
    expect(s.classification.reasons).toContain('art:budget:table');
    expect(s.notes).toContain(
      `a table of 156 cells passes the slide's budget of ${MAX_SLIDE_OBJECTS} objects: LibreOffice draws it`,
    );
  });

  it('leaves a table with vertical cell text to LibreOffice', () => {
    const { s } = convert(
      table({ cols: [IN], rows: [{ h: IN, cells: [tc('v', { tcPr: ' vert="vert"' })] }] }),
    );
    expect(s.classification.reasons).toContain('art:table');
    expect(s.notes).toContain('a table with vertical cell text is drawn by LibreOffice (M8)');
  });

  it('sends the largest tables to the art when the slide would pass its object budget', () => {
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
    const { s, texts, rects } = convert(big(7, 0, 5) + big(8, 2 * IN, 6));
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

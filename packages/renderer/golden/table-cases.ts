import {
  LOOK_MAIN,
  type Rgba,
  type ShapeObject,
  type Slide,
  type SlideObject,
  type TableCell,
  type TableData,
  type TextStyle,
} from '@ordo/domain';
import { clampShapeObject } from '../src/shape.ts';
import { rasterSlide } from '../src/raster.ts';
import { layoutTable, legacyGroup } from '../src/table/index.ts';
import { currentFontEnv } from '../src/text/fonts.ts';
import { measurerFor } from '../src/text/measure.ts';
import { fillColor } from '../src/text2d.ts';
import type { GoldenCase } from './areas.ts';

/**
 * Golden cases of the table object (design/27 M9 tables, `ShapeObject.table`), drawn through `rasterSlide` as
 * the asset worker draws a slide:
 * - 'table-basic': a service bulletin: a bold centred header row on a dark fill, banded rows, a 3 px outer
 *   border over 1 px inner lines, a right-aligned time column, a cell whose text wraps and grows its row,
 *   middle and bottom anchors, a bold run, an italic coloured run and numbered paragraphs.
 * - 'table-merge': merged cells (a row span whose text grows its last row, a column span, a 2 × 2 block),
 *   diagonal lines, dashed lines, a linear and a radial gradient cell fill, fixed rows that overflow, and a
 *   small table turned 8° at half opacity.
 * - 'table-rtl': a right-to-left table (column 0 on the right) of Hebrew and Arabic readings with their
 *   English, paragraphs right to left.
 * - 'table-korean': Korean cells (Hangul in 'Golden KR', Unifont) wrapping in narrow columns and growing
 *   their rows, mixed with Latin and numbers.
 * - 'table-vs-group': 'table-basic' drawn as its M6 group (`legacyGroup`: grid shapes and one text box per
 *   cell), compared with table-basic's PNG (page.ts SAME_AS): the object draws what the group drew.
 */

const W = 960;
const H = 540;
const SCALE = W / 1920;

const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
const WHITE = rgba(255, 255, 255);
const NAVY = rgba(20, 40, 90);
const INK = rgba(30, 30, 40);
const PALE = rgba(232, 238, 250);
const SKY = rgba(200, 220, 245);
const GOLD = rgba(190, 130, 20);
const GREY = rgba(120, 130, 150);
const BG = rgba(245, 243, 238);

function base(over: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: 'Golden',
    fontWeight: 400,
    fontStyle: 'normal',
    fontSizePx: 30,
    color: INK,
    align: 'left',
    valign: 'top',
    lineHeight: 1.2,
    letterSpacing: 0,
    transform: 'none',
    padding: 0,
    lineModel: 'office',
    insets: { l: 14, t: 7, r: 14, b: 7 },
    ...over,
  };
}

function table(
  id: string,
  x: number,
  y: number,
  t: TableData,
  extra: Partial<ShapeObject> = {},
): ShapeObject {
  return {
    id,
    type: 'shape',
    box: {
      x,
      y,
      w: t.cols.reduce((s, v) => s + v, 0),
      h: t.rows.reduce((s, v) => s + v, 0),
      rotation: 0,
    },
    shape: 'rect',
    opacity: 1,
    radius: 0,
    table: t,
    origin: { src: 'pptx', role: 'table' },
    ...extra,
  };
}

/** Every row and column edge of an R × C grid in line `inner`, the outer border in line `outer`. */
function edges(R: number, C: number, outer: number, inner: number): Pick<TableData, 'h' | 'v'> {
  const h: [number, number, number, number][] = [];
  const v: [number, number, number, number][] = [];
  for (let k = 0; k <= R; k++) h.push([k, 0, C, k === 0 || k === R ? outer : inner]);
  for (let k = 0; k <= C; k++) v.push([k, 0, R, k === 0 || k === C ? outer : inner]);
  return { h, v };
}

function draw(ctx: OffscreenCanvasRenderingContext2D, objects: SlideObject[]): void {
  fillColor(ctx, BG, W, H);
  const slide: Slide = { id: 'table', objects } as Slide;
  rasterSlide(ctx, slide, LOOK_MAIN, SCALE, () => undefined, { isSong: false });
}

/** The bulletin of 'table-basic' (and of 'table-vs-group'). */
function bulletin(): ShapeObject {
  const cells: TableCell[] = [
    { text: 'Time', style: 0, fill: 0 },
    { text: 'Order of worship', style: 0, fill: 0 },
    { text: 'Leader', style: 0, fill: 0 },
    { text: '10:00', style: 1, fill: 1 },
    { text: 'Call to worship and opening hymn: How Great Thou Art', runs: [[0, 15, 0]], fill: 1 },
    { text: 'Worship team', style: 2, fill: 1 },
    { text: '10:15', style: 1 },
    {
      text: 'Prayers of the people\nOffering\nAnnouncements',
      paras: [
        { bullet: { auto: 'arabicPeriod' }, indentPx: 40, firstLinePx: -40 },
        { bullet: { auto: 'arabicPeriod' }, indentPx: 40, firstLinePx: -40 },
        { bullet: { auto: 'arabicPeriod' }, indentPx: 40, firstLinePx: -40 },
      ],
    },
    { text: 'Elders', style: 3 },
    { text: '10:40', style: 1, fill: 1 },
    { text: 'Sermon: The Good Shepherd (John 10:1-18)', runs: [[8, 25, 1]], fill: 1 },
    { text: 'Pastor Kim', style: 2, fill: 1 },
    { text: '11:20', style: 1 },
    { text: 'Benediction and sending song', style: 4 },
    { text: 'All', style: 3 },
  ];
  return table('bulletin', 120, 110, {
    cols: [200, 1000, 420],
    rows: [80, 80, 80, 80, 80],
    cells,
    base: base(),
    styles: [
      { fontWeight: 700, color: WHITE, align: 'center', valign: 'middle', fontSizePx: 34 },
      { align: 'right', valign: 'middle', fontWeight: 700 },
      { valign: 'middle', align: 'center' },
      { valign: 'bottom', align: 'center' },
      { fontSizePx: 26, valign: 'middle', color: NAVY },
    ],
    runStyles: [{ fontWeight: 700 }, { fontStyle: 'italic', color: GOLD }],
    fills: [{ color: NAVY }, { color: PALE }],
    lineStyles: [
      { width: 3, color: NAVY },
      { width: 1, color: GREY },
    ],
    ...edges(5, 3, 0, 1),
  });
}

function merges(): SlideObject[] {
  const cells: TableCell[] = [
    { text: 'Week', style: 0, fill: 0 },
    { text: 'Readings', style: 0, fill: 0, colSpan: 2 },
    { text: 'Notes', style: 0, fill: 0 },
    {
      text: 'Advent: a season of waiting, of hope and of preparation for the coming of the Lord',
      rowSpan: 3,
      fill: 2,
    },
    { text: 'Isaiah 2:1-5' },
    { text: 'Romans 13:11-14' },
    { text: '', diag: { down: 1, up: 1 } },
    { text: 'Isaiah 11:1-10' },
    {
      text: 'A block of four cells merged into one, centred in it',
      colSpan: 2,
      rowSpan: 2,
      style: 1,
      fill: 3,
    },
    { text: 'Isaiah 35:1-10' },
    { text: 'Matthew 11:2-11', style: 2 },
  ];
  const big = table('merges', 80, 80, {
    cols: [260, 360, 360, 280],
    rows: [70, 70, 70, 70],
    cells,
    base: base({ fontSizePx: 28 }),
    styles: [
      { fontWeight: 700, color: WHITE, align: 'center', valign: 'middle' },
      { align: 'center', valign: 'middle', fontWeight: 700, color: NAVY },
      { color: GOLD, fontStyle: 'italic' },
    ],
    fills: [
      { color: NAVY },
      { color: PALE },
      {
        color: SKY,
        gradient: {
          kind: 'linear',
          angle: 90,
          stops: [
            { at: 0, color: SKY },
            { at: 1, color: WHITE },
          ],
        },
      },
      {
        color: PALE,
        gradient: {
          kind: 'radial',
          stops: [
            { at: 0, color: WHITE },
            { at: 1, color: SKY },
          ],
        },
      },
    ],
    lineStyles: [
      { width: 4, color: NAVY },
      { width: 2, color: GREY, dash: 'dash' },
    ],
    ...edges(4, 4, 0, 1),
  });
  const fixed = table('fixed', 1400, 160, {
    cols: [240, 240],
    rows: [60, 60],
    cells: [
      { text: 'Fixed rows: this text is taller than its row and overflows', style: 0 },
      { text: 'Top', fill: 0 },
      { text: 'Bottom', style: 1, fill: 0 },
      { text: 'Two lines\nof text', style: 1 },
    ],
    base: base({ fontSizePx: 24 }),
    styles: [{ valign: 'middle' }, { valign: 'bottom', align: 'right' }],
    fills: [{ color: PALE }],
    lineStyles: [{ width: 2, color: NAVY }],
    ...edges(2, 2, 0, 0),
    rowRule: 'fixed',
  });
  const turned = table(
    'turned',
    1260,
    560,
    {
      cols: [260, 260],
      rows: [70, 70, 70],
      cells: [
        { text: 'Turned 8°', style: 0, fill: 0, colSpan: 2 },
        { text: 'Half opacity', fill: 1 },
        { text: 'Grid and text', fill: 1 },
        { text: 'Line ends meet' },
        { text: 'at the corners' },
      ],
      base: base({ fontSizePx: 28 }),
      styles: [{ fontWeight: 700, color: WHITE, align: 'center', valign: 'middle' }],
      fills: [{ color: NAVY }, { color: SKY }],
      lineStyles: [{ width: 6, color: GOLD }],
      ...edges(3, 2, 0, 0),
      background: 1,
    },
    { box: { x: 1260, y: 560, w: 520, h: 210, rotation: 8 }, opacity: 0.5 },
  );
  return [big, fixed, turned];
}

function rtl(): ShapeObject {
  const he = { direction: 'rtl' as const, align: 'right' as const };
  const cells: TableCell[] = [
    { text: 'שבוע', style: 0, fill: 0 },
    { text: 'קריאה', style: 0, fill: 0 },
    { text: 'Reading', style: 3, fill: 0 },
    { text: '1', style: 2 },
    { text: 'בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ', style: 1, paras: [{ rtl: true }] },
    { text: 'In the beginning God created the heaven and the earth.' },
    { text: '2', style: 2, fill: 1 },
    { text: 'فِي ٱلْبَدْءِ كَانَ ٱلْكَلِمَةُ، وَٱلْكَلِمَةُ كَانَ عِنْدَ ٱللهِ', style: 1, paras: [{ rtl: true }], fill: 1 },
    { text: 'In the beginning was the Word, and the Word was with God.', fill: 1 },
  ];
  return table('rtl', 140, 160, {
    cols: [160, 860, 620],
    rows: [80, 90, 90],
    cells,
    base: base({ fontSizePx: 32 }),
    styles: [
      { ...he, fontWeight: 700, color: WHITE, align: 'center', valign: 'middle' },
      { ...he, fontSizePx: 36 },
      { align: 'center', valign: 'middle', fontWeight: 700 },
      { fontWeight: 700, color: WHITE, align: 'center', valign: 'middle' },
    ],
    fills: [{ color: NAVY }, { color: PALE }],
    lineStyles: [
      { width: 3, color: NAVY },
      { width: 1, color: GREY },
    ],
    ...edges(3, 3, 0, 1),
    rtl: true,
  });
}

function korean(): ShapeObject {
  const ko = { lang: 'ko-KR', fallbackFonts: ['Golden KR'] };
  const cells: TableCell[] = [
    { text: '순서', style: 0, fill: 0 },
    { text: '내용', style: 0, fill: 0 },
    { text: '인도', style: 0, fill: 0 },
    { text: '①', style: 1 },
    { text: '예배로의 부름과 찬송: 주 하나님 지으신 모든 세계 (79장)', style: 2 },
    { text: '인도자', style: 1 },
    { text: '②', style: 1, fill: 1 },
    { text: '성경 봉독: 요한복음 10장 1절에서 18절, 선한 목자 이야기를 함께 읽습니다', style: 2, fill: 1 },
    { text: '다같이', style: 1, fill: 1 },
    { text: '③', style: 1 },
    { text: 'Sermon 설교 — 선한 목자 (The Good Shepherd)', style: 2 },
    { text: '김 목사', style: 1 },
  ];
  return table('korean', 300, 140, {
    cols: [140, 760, 300],
    rows: [76, 76, 76, 76],
    cells,
    base: base({ fontSizePx: 34, ...ko }),
    styles: [
      { ...ko, fontWeight: 700, color: WHITE, align: 'center', valign: 'middle' },
      { ...ko, align: 'center', valign: 'middle' },
      { ...ko },
    ],
    fills: [{ color: NAVY }, { color: PALE }],
    lineStyles: [
      { width: 3, color: NAVY },
      { width: 1, color: GREY },
    ],
    ...edges(4, 3, 0, 1),
  });
}

export const TABLE_CASES: Readonly<Record<string, GoldenCase>> = {
  'table-basic': (ctx) => draw(ctx, [bulletin()]),
  'table-merge': (ctx) => draw(ctx, merges()),
  'table-rtl': (ctx) => draw(ctx, [rtl()]),
  'table-korean': (ctx) => draw(ctx, [korean()]),
  'table-vs-group': (ctx) => {
    // The bulletin as the M6 group of its layout (as drawn now, with this page's fonts).
    const o = clampShapeObject(bulletin());
    const l = layoutTable(measurerFor(ctx), o, currentFontEnv())!;
    draw(ctx, legacyGroup(o, l));
  },
};

import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import type {
  ChartData,
  DecorData,
  ImageObject,
  ShapeObject,
  Slide,
  TableCell,
  TableData,
  TextObject,
} from './schemas.ts';

/*
 * A slide that uses every design/27 M9 stored field (tables, charts, decorations, 3-D, WordArt warps, vertical
 * text, anchorCtr, vector pictures, wide adjust values, missing elements), each object with the legacy values
 * beside it that an older build draws (design/27 §3.2), at the sizes the worship corpus has: for the schema,
 * clamp, sanitize and reader tests here, in @ordo/renderer and in @ordo/importers.
 */

const white = { r: 255, g: 255, b: 255, a: 1 };
const navy = { r: 20, g: 40, b: 90, a: 1 };
const gold = { r: 240, g: 190, b: 40, a: 1 };
const grey = { r: 200, g: 200, b: 200, a: 1 };

/** A 5 × 4 order of service with a header row, a merged cell, a Korean cell and a numbered list. */
export function m9Table(): TableData {
  const cells: TableCell[] = [
    { text: 'Time', style: 0, fill: 1 },
    { text: 'Part', style: 0, fill: 1, colSpan: 2 },
    { text: 'Leader', style: 0, fill: 1 },
    { text: '10:00', fill: 2 },
    {
      text: 'Call to worship\nOpening hymn',
      runs: [[0, 4, 0]],
      paras: [{ bullet: { auto: 'arabicPeriod' }, indentPx: 30, firstLinePx: -30 }, null],
    },
    { text: 'Psalm 23', rowSpan: 2 },
    { text: 'Pastor Kim', diag: { down: 1 } },
    { text: '10:15', fill: 2 },
    { text: '찬양과 경배', style: 1 },
    { text: 'Worship team' },
    { text: '10:40', fill: 2 },
    { text: 'Sermon: The Good Shepherd', runs: [[8, 25, 1]], colSpan: 2 },
    { text: 'Pastor Kim' },
    { text: '11:20', fill: 2 },
    { text: 'Benediction', colSpan: 3 },
  ];
  return {
    cols: [180, 420, 420, 300],
    rows: [70, 90, 90, 90, 70],
    cells,
    base: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Calibri', fontSizePx: 32, color: navy, lineModel: 'office' },
    styles: [
      { fontWeight: 700, color: white, align: 'center', valign: 'middle' },
      { fontFamily: 'Malgun Gothic', lang: 'ko-KR', fallbackFonts: ['Noto Sans KR'], vert: 'horz' },
    ],
    runStyles: [{ fontWeight: 700 }, { fontStyle: 'italic', color: gold, fontFamily: 'Georgia' }],
    fills: [
      { color: white },
      {
        color: navy,
        gradient: {
          kind: 'linear',
          angle: 90,
          stops: [
            { at: 0, color: navy },
            { at: 1, color: { r: 40, g: 80, b: 160, a: 1 } },
          ],
        },
      },
      { color: grey },
    ],
    lineStyles: [
      { width: 2, color: navy },
      { width: 1, color: grey, dash: 'dash' },
    ],
    h: [
      [0, 0, 4, 0],
      [1, 0, 4, 0],
      [5, 0, 4, 0],
    ],
    v: [
      [0, 0, 5, 0],
      [4, 0, 5, 0],
    ],
    background: 0,
    rowRule: 'grow',
  };
}

/** A clustered column chart of three series over twelve weeks, with a title, axis titles and a legend. */
export function m9Chart(): ChartData {
  const weeks = [...Array(12)].map((_, i) => `Week ${i + 1}`);
  const series = ['Giving', 'Attendance', 'Visitors'].map((name, s) => ({
    name,
    values: weeks.map((_, i) => (i === 5 && s === 2 ? null : 100 + s * 40 + ((i * 37 + s * 11) % 50))),
    fill: s,
    labels: s === 0 ? { show: ['value' as const], pos: 'outEnd' as const, fmt: 0 } : undefined,
    points: s === 0 ? [[3, { fill: 3 }] as [number, { fill: number }]] : undefined,
  }));
  return {
    unit: 2,
    categories: weeks,
    groups: [
      {
        kind: 'bar',
        dir: 'col',
        grouping: 'clustered',
        gap: 150,
        overlap: -10,
        series: series.map(({ labels, points, ...rest }) => ({
          ...rest,
          ...(labels ? { labels } : {}),
          ...(points ? { points } : {}),
        })),
      },
    ],
    axes: [
      { dim: 'x', kind: 'cat', pos: 'b', line: 0, text: 0 },
      {
        dim: 'y',
        kind: 'val',
        pos: 'l',
        grid: 1,
        text: 0,
        min: 0,
        majorTick: 'out',
        title: { text: 'People', style: 0 },
      },
    ],
    title: {
      text: 'Our church in 2026',
      runs: [{ start: 0, end: 10, fontWeight: 700 }],
      style: 1,
    },
    legend: { pos: 'b', text: 0 },
    area: { fill: 0 },
    blanks: 'gap',
    fills: [{ color: white }, { color: gold }, { color: navy }, { color: { r: 200, g: 30, b: 30, a: 1 } }],
    lines: [
      { width: 1.5, color: grey },
      { width: 1, color: grey, dash: 'sysDash' },
    ],
    texts: [
      { fontFamily: 'Calibri', fontSizePx: 24, color: navy, fallbackFonts: ['Carlito'] },
      { fontFamily: 'Calibri Light', fontSizePx: 36, color: navy, fontWeight: 300 },
    ],
    fmts: ['General'],
    lang: 'en-US',
  };
}

/** A border of 40 ornaments in two looks, one with a shadow, the second look on a gradient frame. */
export function m9Decor(): DecorData {
  const parts: DecorData['parts'] = [];
  for (let i = 0; i < 40; i++) {
    const x = i * 48;
    parts.push({
      d: `M ${x} 0 C ${x + 10} 30 ${x + 30} 30 ${x + 40} 0 L ${x + 20} 40 Z`,
      p: i % 2,
      s: 1,
      ...(i % 2 ? { frame: [x, 0, 40, 40, 0] as [number, number, number, number, number] } : {}),
    });
  }
  parts.push({ d: 'M 0 44 L 1920 44', p: 1, fill: 'none', stroke: true });
  return {
    w: 1920,
    h: 48,
    paints: [
      { fill: gold, shadow: { dx: 2, dy: 2, blur: 4, color: { r: 0, g: 0, b: 0, a: 0.4 } } },
      {
        gradient: {
          kind: 'linear',
          angle: 0,
          stops: [
            { at: 0, color: gold },
            { at: 1, color: navy },
          ],
        },
        stroke: { width: 2, color: navy },
        dash: 'dot',
      },
    ],
    parts,
  };
}

const look3d = {
  bevel: { prst: 'circle', w: 12, h: 12 },
  depth: 18,
  contour: { width: 2, color: navy },
  side: gold,
  material: 'plastic',
  light: { rig: 'threePt', dir: 't' },
  camera: { prst: 'isometricOffAxis1Right' },
} as const;

/** The slide: what the M9 converter writes for each field, legacy values included. */
export function m9Slide(): Slide {
  const table: ShapeObject = {
    id: 'table',
    type: 'shape',
    box: { x: 120, y: 160, w: 1320, h: 410, rotation: 0 },
    // Legacy: the table's background as a rect.
    shape: 'rect',
    fill: white,
    opacity: 1,
    radius: 0,
    table: m9Table(),
    origin: { src: 'pptx', shapeId: 4, role: 'table', group: 2 },
  };
  const chart: ShapeObject = {
    id: 'chart',
    type: 'shape',
    box: { x: 1460, y: 160, w: 400, h: 410, rotation: 0 },
    // Legacy: the chart area.
    shape: 'rect',
    fill: white,
    opacity: 1,
    radius: 0,
    chart: m9Chart(),
    origin: { src: 'pptx', shapeId: 5, role: 'chart' },
  };
  const decor: ShapeObject = {
    id: 'decor',
    type: 'shape',
    box: { x: 0, y: 1032, w: 1920, h: 48, rotation: 0 },
    // Legacy: a line without a stroke, which draws nothing.
    shape: 'line',
    opacity: 1,
    radius: 0,
    decor: m9Decor(),
    locked: true,
    origin: { src: 'pptx', shapeId: 40, role: 'decor', group: 9 },
  };
  const pie: ShapeObject = {
    id: 'pie',
    type: 'shape',
    box: { x: 120, y: 640, w: 300, h: 300, rotation: 30 },
    shape: 'ellipse',
    fill: gold,
    opacity: 1,
    radius: 0,
    // 270°: adj2 is clamped to ±1e7 for an older build, the whole angle is in adjWide.
    geom: { preset: 'pie', adj: [['adj2', 10_000_000]], adjWide: [['adj2', 16_200_000]] },
    look3d,
    origin: { src: 'pptx', shapeId: 7, role: 'shape' },
  };
  const photo: ImageObject = {
    id: 'emf',
    type: 'image',
    box: { x: 460, y: 640, w: 400, h: 300, rotation: 0 },
    mediaId: 'vector-media',
    fit: 'stretch',
    opacity: 1,
    radius: 0,
    vectorFonts: ['Arial', 'Symbol'],
    look3d: { bevel: { prst: 'softRound', w: 8, h: 8 }, grow: 4 },
    origin: { src: 'pptx', shapeId: 8, role: 'picture' },
  };
  const title: TextObject = {
    id: 'title',
    type: 'text',
    box: { x: 120, y: 20, w: 1680, h: 130, rotation: 0 },
    text: 'He is risen!',
    // Legacy for an envelope warp: one box-filling line, middle, no wrap, zero insets.
    style: {
      ...DEFAULT_LYRIC_STYLE,
      fontFamily: 'Impact',
      fontSizePx: 102,
      color: gold,
      valign: 'middle',
      wrap: false,
      insets: { l: 0, t: 0, r: 0, b: 0 },
    },
    opacity: 1,
    runs: [{ start: 6, end: 12, color: { r: 200, g: 30, b: 30, a: 1 } }],
    warp: { preset: 'textArchUp', adj: [['adj', 10_800_000]] },
    look3d: { ...look3d, flat: true },
    origin: { src: 'pptx', shapeId: 2, ph: 'title', role: 'title' },
  };
  const vertical: TextObject = {
    id: 'vertical',
    type: 'text',
    // The quarter-turned box an older build draws horizontal text in.
    box: { x: 1500, y: 700, w: 300, h: 100, rotation: 90 },
    text: '主は私の羊飼い',
    style: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Yu Mincho', fontSizePx: 40, lang: 'ja-JP' },
    opacity: 1,
    writing: { upright: 'cjk' },
    origin: { src: 'pptx', shapeId: 9, role: 'text' },
  };
  const centred: TextObject = {
    id: 'centred',
    type: 'text',
    box: { x: 900, y: 640, w: 560, h: 300, rotation: 0 },
    text: 'The Lord is my shepherd\nI shall not want',
    style: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Calibri', fontSizePx: 36, align: 'left' },
    opacity: 1,
    paras: [{ align: 'left' }, { align: 'left' }],
    centerBlock: true,
    origin: { src: 'pptx', shapeId: 10, ph: 'body', role: 'body' },
  };
  return {
    id: 'm9',
    objects: [decor, table, chart, pie, photo, title, vertical, centred],
    lyricObjectId: 'centred',
    pptx: {
      fileId: 'f'.repeat(64),
      index: 3,
      shown: 3,
      class: 'hybrid',
      version: 2,
      notes: ['a surface chart is not drawn', 'an embedded object is not drawn'],
      artText: 'Attendance by region',
      missing: ['chart:surface', 'ole'],
    },
  };
}

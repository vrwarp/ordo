import type { ShapeObject, Slide, SlideObject, TableCell, TableData, TextStyle } from '@ordo/domain';
import { clampShapeObject } from '../../src/shape.ts';
import { layoutTable, legacyGroup } from '../../src/table/index.ts';
import { LEGACY_FONT_ENV } from '../../src/text/fonts.ts';
import { testMeasurer } from '../../src/text/test-util.ts';
import type { BenchCase } from './index.ts';

/*
 * Raster bench slides of the table object (design/27 M9 tables, tables-object.md §4.9): the corpus's largest
 * table kinds, each drawn as the M9 object and as the M6 group of shapes and text boxes it replaces
 * (`legacyGroup`, laid out with a fixed-width measurer: the same drawing work, rows within a line of the
 * object's), so their raster times compare directly:
 * - a 96-cell service bulletin (32 rows × 3 columns, banded, a header row);
 * - a template's master grid of 640 empty cells (20 × 32, thin lines);
 * - a dense Bible chart of 13,782 characters at 8 pt (8 × 6 cells, one of 5,745 characters).
 * Every job draws a fresh copy of the slide, so its table is clamped and laid out from the renderer's cell
 * cache (warm after the first job, as on an output that drew the slide before); the first job lays out cold.
 */

const NAVY = { r: 20, g: 40, b: 90, a: 1 };
const INK = { r: 30, g: 30, b: 40, a: 1 };
const PALE = { r: 232, g: 238, b: 250, a: 1 };
const GREY = { r: 140, g: 150, b: 165, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

function base(size: number): TextStyle {
  return {
    fontFamily: 'Bench',
    fontWeight: 400,
    fontStyle: 'normal',
    fontSizePx: size,
    color: INK,
    align: 'left',
    valign: 'top',
    lineHeight: 1.2,
    letterSpacing: 0,
    transform: 'none',
    padding: 0,
    lineModel: 'office',
    insets: { l: 10, t: 4, r: 10, b: 4 },
  };
}

function grid(R: number, C: number): Pick<TableData, 'h' | 'v'> {
  return {
    h: [...Array(R + 1)].map(
      (_, k) => [k, 0, C, k === 0 || k === R ? 0 : 1] as [number, number, number, number],
    ),
    v: [...Array(C + 1)].map(
      (_, k) => [k, 0, R, k === 0 || k === C ? 0 : 1] as [number, number, number, number],
    ),
  };
}

function shape(id: string, box: ShapeObject['box'], table: TableData): ShapeObject {
  return {
    id,
    type: 'shape',
    box,
    shape: 'rect',
    opacity: 1,
    radius: 0,
    table,
    origin: { src: 'pptx', role: 'table' },
  };
}

const backdrop: SlideObject = {
  id: 'bg',
  type: 'shape',
  box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
  shape: 'rect',
  fill: { r: 250, g: 248, b: 242, a: 1 },
  opacity: 1,
  radius: 0,
};

const EVENTS = [
  'Prelude',
  'Call to worship',
  'Hymn 23',
  'Prayer',
  'Scripture reading',
  'Choir anthem',
  'Sermon',
  'Offering',
];
const LEADERS = [
  'Organist',
  'Pastor Kim',
  'All',
  'Elder Park',
  'Deacon Lee',
  'Choir',
  'Ushers',
  'Worship team',
];

/** The 96-cell bulletin. */
export function bulletin(): ShapeObject {
  const R = 32;
  const cells: TableCell[] = [];
  for (let r = 0; r < R; r++) {
    const head = r === 0;
    cells.push({
      text: head ? 'Time' : `${9 + Math.floor(r / 4)}:${String((r % 4) * 15).padStart(2, '0')}`,
      ...(head ? { style: 0, fill: 0 } : r % 2 ? { fill: 1 } : {}),
    });
    cells.push({
      text: head ? 'Order of worship' : `${EVENTS[r % EVENTS.length]} ${r}`,
      ...(head ? { style: 0, fill: 0 } : r % 2 ? { fill: 1 } : {}),
    });
    cells.push({
      text: head ? 'Leader' : LEADERS[r % LEADERS.length]!,
      ...(head ? { style: 0, fill: 0 } : r % 2 ? { fill: 1, style: 1 } : { style: 1 }),
    });
  }
  return shape(
    'bulletin',
    { x: 160, y: 40, w: 1600, h: 1000, rotation: 0 },
    {
      cols: [260, 900, 440],
      rows: Array(R).fill(31),
      cells,
      base: base(20),
      styles: [{ fontWeight: 700, color: WHITE, align: 'center' }, { align: 'center' }],
      fills: [{ color: NAVY }, { color: PALE }],
      lineStyles: [
        { width: 2, color: NAVY },
        { width: 1, color: GREY },
      ],
      ...grid(R, 3),
    },
  );
}

/** The 640-cell master grid. */
export function masterGrid(): ShapeObject {
  return shape(
    'grid',
    { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
    {
      cols: Array(32).fill(60),
      rows: Array(20).fill(54),
      cells: [...Array(640)].map(() => ({})),
      base: base(18),
      lineStyles: [
        { width: 1, color: GREY },
        { width: 1, color: GREY },
      ],
      ...grid(20, 32),
    },
  );
}

/**
 * Words of a dense chart, deterministic: made of syllables, so a chart of another `vocab` seed has words no
 * other chart has (a first draw, its widths not measured yet), and some references.
 */
function words(n: number, seed: number, vocab: number): string {
  const syllables = [
    'ra',
    'ko',
    'mi',
    'tes',
    'lan',
    'do',
    'vi',
    'shu',
    'el',
    'nor',
    'ga',
    'pe',
    'zi',
    'tho',
    'bra',
    'qu',
  ];
  let s = '';
  let x = seed * 7919 + vocab * 104_729;
  const next = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
  while (s.length < n) {
    let w = '';
    const k = 1 + (next() % 3);
    for (let j = 0; j < k; j++) w += syllables[next() % syllables.length];
    s +=
      next() % 7 === 0 ? `${w} ${1 + (next() % 50)}:${1 + (next() % 30)} ` : `${vocab ? `${w}${vocab}` : w} `;
  }
  const out = s.slice(0, n);
  return out.endsWith(' ') ? `${out.slice(0, -1)}.` : out;
}

/** The 13,782-character chart; another `vocab` gives words no other chart has. */
export function chart(vocab = 0): ShapeObject {
  const R = 8;
  const C = 6;
  const cells: TableCell[] = [];
  // 47 cells of 171 characters and one of 5,745: the corpus's 13,782.
  for (let i = 0; i < R * C; i++)
    cells.push({ text: words(i === 9 ? 5_745 : 171, i + 1, vocab), ...(i < C ? { style: 0, fill: 0 } : {}) });
  return shape(
    'chart',
    { x: 40, y: 30, w: 1840, h: 1020, rotation: 0 },
    {
      cols: Array(C).fill(300),
      rows: Array(R).fill(40),
      cells,
      base: base(10.67),
      styles: [{ fontWeight: 700, color: WHITE }],
      fills: [{ color: NAVY }],
      lineStyles: [
        { width: 1, color: NAVY },
        { width: 0.75, color: GREY },
      ],
      ...grid(R, C),
    },
  );
}

/** The M6 group of a table: its grid shapes and text boxes, laid out with a fixed-width measurer. */
function group(o: ShapeObject): SlideObject[] {
  const c = clampShapeObject(o);
  const l = layoutTable(testMeasurer({ em: 0.55 }), c, LEGACY_FONT_ENV)!;
  return legacyGroup(c, l);
}

const slide = (id: string, objects: SlideObject[]): Slide => ({ id, objects }) as Slide;

export const TABLE_BENCH_CASES: readonly BenchCase[] = [
  ['table: 96-cell bulletin (M9 object)', slide('t1', [backdrop, bulletin()])],
  ['table: 96-cell bulletin (M6 group)', slide('t1g', [backdrop, ...group(bulletin())])],
  ['table: 640-cell master grid (M9 object)', slide('t2', [backdrop, masterGrid()])],
  ['table: 640-cell master grid (M6 group)', slide('t2g', [backdrop, ...group(masterGrid())])],
  ['table: 13,782-character chart (M9 object)', slide('t3', [backdrop, chart()])],
  ['table: 13,782-character chart (M6 group)', slide('t3g', [backdrop, ...group(chart())])],
];

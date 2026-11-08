import { describe, expect, it } from 'vitest';
import { tableCellRows, tableText } from './m9-readers.ts';
import { m9Table } from './m9.test-util.ts';
import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import {
  type Rgba,
  type ShapeObject,
  TABLE_LIMITS,
  type TableCell,
  TableData,
  type TextRun,
} from './schemas.ts';
import {
  cellRich,
  cellStyleOf,
  cellTextStyle,
  deleteCol,
  deleteRow,
  gcTable,
  insertCol,
  insertRow,
  placeCells,
  setCell,
  setCellFill,
} from './table.ts';

/*
 * The table object's model (design/27 M9, tables-object.md §6 domain tests): placement, cell views, palettes,
 * and the row, column, text and fill ops, with a property test of 10,000 random ops.
 */

const red: Rgba = { r: 200, g: 30, b: 30, a: 1 };
const base = { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Calibri', fontSizePx: 24, lineModel: 'office' as const };

function shape(table: TableData, h = 0): ShapeObject {
  const sum = table.rows.reduce((s, x) => s + x, 0);
  return {
    id: 't',
    type: 'shape',
    box: { x: 100, y: 100, w: table.cols.reduce((s, x) => s + x, 0), h: h || sum, rotation: 0 },
    shape: 'rect',
    opacity: 1,
    radius: 0,
    table,
    origin: { src: 'pptx', role: 'table' },
  };
}

/** A grid of R × C single cells named by their slot ('r0c0'), with a line under every row. */
function grid(R: number, C: number): TableData {
  const cells: TableCell[] = [];
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) cells.push({ text: `r${r}c${c}` });
  return {
    cols: Array(C).fill(100),
    rows: Array(R).fill(40),
    cells,
    base,
    lineStyles: [{ width: 1, color: red }],
    h: [...Array(R + 1)].map((_, k) => [k, 0, C, 0] as [number, number, number, number]),
  };
}

const t$ = (o: ShapeObject) => o.table!;
const texts = (t: TableData) => t.cells.map((c) => c.text ?? '');

describe('placement', () => {
  it('places cells row-major and skips covered slots', () => {
    const t: TableData = {
      ...grid(3, 3),
      cells: [
        { text: 'a', rowSpan: 2 },
        { text: 'b', colSpan: 2 },
        { text: 'c' },
        { text: 'd' },
        { text: 'e' },
        { text: 'f' },
        { text: 'g' },
      ],
    };
    const p = placeCells(t);
    expect(p.anchors).toEqual([
      { row: 0, col: 0, rows: 2, cols: 1 },
      { row: 0, col: 1, rows: 1, cols: 2 },
      { row: 1, col: 1, rows: 1, cols: 1 },
      { row: 1, col: 2, rows: 1, cols: 1 },
      { row: 2, col: 0, rows: 1, cols: 1 },
      { row: 2, col: 1, rows: 1, cols: 1 },
      { row: 2, col: 2, rows: 1, cols: 1 },
    ]);
    expect([...p.slots]).toEqual([0, 1, 1, 0, 2, 3, 4, 5, 6]);
    // The readers' placement agrees.
    expect(tableCellRows(t)).toEqual(p.anchors.map((a) => a?.row ?? -1));
  });

  it('cuts a span that would cover a placed cell, or pass the edge, and drops cells past the grid', () => {
    const t: TableData = {
      ...grid(2, 3),
      cells: [{ rowSpan: 2 }, { colSpan: 5 }, { rowSpan: 9, colSpan: 9 }, {}, {}, {}],
    };
    const p = placeCells(t);
    expect(p.anchors).toEqual([
      { row: 0, col: 0, rows: 2, cols: 1 },
      { row: 0, col: 1, rows: 1, cols: 2 },
      { row: 1, col: 1, rows: 1, cols: 2 },
      undefined,
      undefined,
      undefined,
    ]);
    // A span of the row below cut where an earlier cell covers it.
    const cut = placeCells({ ...grid(2, 2), cells: [{}, { rowSpan: 2 }, { colSpan: 2 }] });
    expect(cut.anchors[2]).toEqual({ row: 1, col: 0, rows: 1, cols: 1 });
  });

  it('agrees with the readers on random tables, never throwing on malformed ones', () => {
    const rnd = rng(7);
    for (let n = 0; n < 300; n++) {
      const R = 1 + Math.floor(rnd() * 6);
      const C = 1 + Math.floor(rnd() * 6);
      const cells = [...Array(Math.floor(rnd() * R * C * 1.3))].map(() => ({
        colSpan: rnd() < 0.2 ? Math.floor(rnd() * 5) : undefined,
        rowSpan: rnd() < 0.2 ? Math.floor(rnd() * 5) - 1 : undefined,
      }));
      const t = { cols: Array(C).fill(1), rows: Array(R).fill(1), cells } as unknown as TableData;
      expect(tableCellRows(t)).toEqual(placeCells(t).anchors.map((a) => a?.row ?? -1));
    }
    expect(placeCells({ rows: 'x', cols: null, cells: 7 } as never).slots.length).toBe(0);
  });
});

describe('cell views', () => {
  it('draws a cell in the base style with its style entry over it, never shrinking', () => {
    const t = m9Table();
    const header = cellRich(t, 0)!;
    expect(header.text).toBe('Time');
    expect(header.style).toMatchObject({ fontFamily: 'Calibri', fontWeight: 700, align: 'center' });
    expect(header.style.valign).toBe('middle');
    expect(
      cellTextStyle({ ...base, autofit: 'shrink', fitScale: { font: 0.5, spacing: 1 } }, undefined),
    ).not.toHaveProperty('autofit');
    // Justify is the base's alignment with justification on; another alignment turns it off.
    expect(cellTextStyle(base, { align: 'justify' })).toMatchObject({ align: 'left', justify: true });
    expect(cellTextStyle({ ...base, justify: true }, { align: 'right' })).not.toHaveProperty('justify');
    // Runs expanded from the run palette.
    expect(cellRich(t, 4)!.runs).toEqual([{ start: 0, end: 4, fontWeight: 700 }]);
    expect(cellRich(t, 99)).toBeUndefined();
  });

  it('cellStyleOf inverts cellTextStyle and keeps the vertical writing', () => {
    const s = { fontWeight: 300, color: red, align: 'justify' as const, insets: { l: 1, t: 2, r: 3, b: 4 } };
    expect(cellStyleOf(base, cellTextStyle(base, s))).toEqual(s);
    expect(cellStyleOf(base, cellTextStyle(base, {}), 'eaVert')).toEqual({ vert: 'eaVert' });
    expect(cellStyleOf(base, base)).toEqual({});
  });
});

describe('cell text', () => {
  it('setCell round-trips runs through the run palette', () => {
    const o = shape(m9Table());
    const view = cellRich(t$(o), 9)!;
    const runs: TextRun[] = [
      { start: 0, end: 7, fontStyle: 'italic', color: red },
      { start: 8, end: 12, fontWeight: 700 },
    ];
    const next = setCell(o, 9, { ...view, text: 'Worship team!', runs });
    const t = t$(next);
    expect(cellRich(t, 9)).toEqual({ ...view, text: 'Worship team!', runs });
    // Bold already had an entry: it is shared; italic red is new.
    expect(t.cells[9]!.runs).toEqual([
      [0, 7, 2],
      [8, 12, 0],
    ]);
    expect(t.runStyles).toHaveLength(3);
    // The other cells are the same objects (the renderer lays out only what changed).
    expect(t.cells[8]).toBe(t$(o).cells[8]);
    expect(TableData.safeParse(t).success).toBe(true);
  });

  it('writes a style change as the difference from the base, and keeps fill and spans', () => {
    const o = shape(m9Table());
    const view = cellRich(t$(o), 11)!;
    const next = t$(setCell(o, 11, { ...view, style: { ...view.style, fontSizePx: 40, color: red } }));
    const c = next.cells[11]!;
    expect(next.styles![c.style!]).toEqual({ fontSizePx: 40, color: red });
    expect(c.colSpan).toBe(2);
    expect(c.runs).toEqual([[8, 25, 1]]);
  });

  it('refuses text past the cell bound and the table bound', () => {
    const o = shape(m9Table());
    const view = cellRich(t$(o), 0)!;
    expect(setCell(o, 0, { ...view, text: 'x'.repeat(TABLE_LIMITS.cellText + 1) })).toBe(o);
    const big = shape({ ...grid(1, 8), cells: [...Array(8)].map(() => ({ text: 'y'.repeat(8_000) })) });
    expect(setCell(big, 0, { ...cellRich(t$(big), 0)!, text: 'z'.repeat(9_000) })).toBe(big);
    expect(setCell(big, 0, { ...cellRich(t$(big), 0)!, text: 'z'.repeat(4_000) })).not.toBe(big);
    expect(setCell(o, 99, view)).toBe(o);
  });

  it('gc removes unused palette entries', () => {
    const t = m9Table();
    // Nothing unused: the same table.
    expect(gcTable(t)).toBe(t);
    const extra: TableData = {
      ...t,
      styles: [{ fontWeight: 300 }, ...t.styles!],
      fills: [...t.fills!, { color: red }],
      cells: t.cells.map((c) => ({ ...c, style: c.style === undefined ? undefined : c.style + 1 })),
    };
    const g = gcTable(extra);
    expect(g.styles).toEqual(t.styles);
    expect(g.fills).toEqual(t.fills);
    expect(g.cells.map((c) => c.style)).toEqual(t.cells.map((c) => c.style));
    expect(cellRich(g, 8)!.style).toEqual(cellRich(t, 8)!.style);
  });
});

describe('fills', () => {
  it('setCellFill fills cells, clears them and drops the fills no cell uses', () => {
    const o = shape(grid(2, 2));
    const filled = setCellFill(o, [0, 3], red);
    expect(t$(filled).fills).toEqual([{ color: red }]);
    expect(t$(filled).cells.map((c) => c.fill)).toEqual([0, undefined, undefined, 0]);
    const cleared = setCellFill(filled, [0, 3], null);
    expect(t$(cleared)).not.toHaveProperty('fills');
    expect(setCellFill(o, [7], red)).toBe(o);
  });
});

describe('rows and columns', () => {
  it('insertRow inside a rowSpan extends the span and copies the row', () => {
    const t: TableData = {
      ...grid(3, 2),
      cells: [{ text: 'a', rowSpan: 2, fill: 0 }, { text: 'b', style: 0 }, { text: 'c' }, { text: 'd' }, {}],
      styles: [{ fontWeight: 700 }],
      fills: [{ color: red }],
    };
    const o = shape(t);
    const out = insertRow(o, 1, 0);
    const n = t$(out);
    expect(n.rows).toEqual([40, 40, 40, 40]);
    expect(n.cells[0]!.rowSpan).toBe(3);
    // The new row's free column takes the style of row 0's cell there, with no text.
    expect(n.cells[1]).toEqual({ text: 'b', style: 0 });
    expect(n.cells[2]).toEqual({ style: 0 });
    expect(texts(n)).toEqual(['a', 'b', '', 'c', 'd', '']);
    expect(out.box.h).toBe(o.box.h + 40);
    // Lines: every row boundary still has one, and none inside the merge.
    expect(n.h).toEqual([
      [0, 0, 2, 0],
      [1, 1, 2, 0],
      [2, 1, 2, 0],
      [3, 0, 2, 0],
      [4, 0, 2, 0],
    ]);
    valid(n);
  });

  it('inserting at the top or bottom keeps the borders borders', () => {
    const t: TableData = {
      ...grid(2, 1),
      lineStyles: [
        { width: 3, color: red },
        { width: 1, color: red },
      ],
      h: [
        [0, 0, 1, 0],
        [1, 0, 1, 1],
        [2, 0, 1, 0],
      ],
    };
    expect(t$(insertRow(shape(t), 0, 0)).h!.map((e) => e[3])).toEqual([0, 1, 1, 0]);
    expect(t$(insertRow(shape(t), 2, 1)).h!.map((e) => e[3])).toEqual([0, 1, 1, 0]);
    expect(t$(deleteRow(shape(t), 0)).h!.map((e) => e[3])).toEqual([0, 0]);
  });

  it('deleteCol shrinks spans and re-indexes edges', () => {
    const t: TableData = {
      ...grid(2, 3),
      cells: [{ text: 'wide', colSpan: 3 }, { text: 'x' }, { text: 'y' }, { text: 'z' }],
      v: [
        [0, 0, 2, 0],
        [1, 1, 2, 0],
        [2, 1, 2, 0],
        [3, 0, 2, 0],
      ],
    };
    const n = t$(deleteCol(shape(t), 1));
    expect(n.cells).toEqual([{ text: 'wide', colSpan: 2 }, { text: 'x' }, { text: 'z' }]);
    expect(n.v).toEqual([
      [0, 0, 2, 0],
      [1, 1, 2, 0],
      [2, 0, 2, 0],
    ]);
    // The table keeps its width.
    expect(n.cols.reduce((s, x) => s + x, 0)).toBeCloseTo(300, 9);
    valid(n);
  });

  it('insertCol keeps the table width', () => {
    const o = shape({ ...grid(2, 2), cols: [100, 300] });
    const n = t$(insertCol(o, 2, 0));
    expect(n.cols.reduce((s, x) => s + x, 0)).toBeCloseTo(400, 9);
    expect(n.cols.map((w) => Math.round(w * 100) / 100)).toEqual([80, 240, 80]);
    expect(texts(n)).toEqual(['r0c0', 'r0c1', '', 'r1c0', 'r1c1', '']);
    expect(insertCol(o, 0, 1).box).toEqual(o.box);
    valid(n);
  });

  it('refuses a 257th row, a grid past 4,096 slots, the last row or column and bad indices', () => {
    const tall = shape({ ...grid(1, 1), rows: Array(256).fill(4), cells: [] });
    expect(insertRow(tall, 0, 0)).toBe(tall);
    const wide = shape(grid(64, 64));
    expect(insertRow(wide, 0, 0)).toBe(wide);
    const one = shape(grid(1, 1));
    expect(deleteRow(one, 0)).toBe(one);
    expect(deleteCol(one, 0)).toBe(one);
    const o = shape(grid(2, 2));
    for (const [at, from] of [
      [-1, 0],
      [3, 0],
      [0, 2],
      [0.5, 0],
    ] as const) {
      expect(insertRow(o, at, from)).toBe(o);
      expect(insertCol(o, at, from)).toBe(o);
    }
    expect(deleteRow(o, 2)).toBe(o);
    expect(deleteCol(o, Number.NaN)).toBe(o);
  });

  it('tableText still reads the edited table row by row', () => {
    const o = insertRow(shape(grid(2, 2)), 1, 0);
    const edited = setCell(o, 2, { ...cellRich(t$(o), 2)!, text: 'new' });
    expect(tableText(t$(edited))).toBe('r0c0\tr0c1\nnew\nr1c0\tr1c1');
  });
});

// ── Property test ──────────────────────────────────────────────────────────────────────────────────────

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What is wrong with a table, or '' when nothing is: every slot covered once, spans as stored, edges in range
 * and outside merges, every palette entry used and every index naming one, runs sorted inside their text.
 */
function problems(t: TableData): string {
  if (!TableData.safeParse(t).success) return 'schema';
  const p = placeCells(t);
  const { R, C } = p;
  if (R !== t.rows.length || C !== t.cols.length) return 'grid';
  for (const s of p.slots) if (s < 0) return 'uncovered slot';
  // Interior edges of merges: h at row edge k over column c, v at column edge k beside row r.
  const hIn = new Uint8Array((R + 1) * C);
  const vIn = new Uint8Array((C + 1) * R);
  for (let i = 0; i < t.cells.length; i++) {
    const c = t.cells[i]!;
    const a = p.anchors[i];
    if (!a) return `cell ${i} past the grid`;
    if (a.rows !== (c.rowSpan ?? 1) || a.cols !== (c.colSpan ?? 1)) return `cell ${i} span cut`;
    if (c.colSpan === 1 || c.rowSpan === 1) return `cell ${i} stores a span of 1`;
    for (let k = a.row + 1; k < a.row + a.rows; k++) hIn.fill(1, k * C + a.col, k * C + a.col + a.cols);
    for (let k = a.col + 1; k < a.col + a.cols; k++) vIn.fill(1, k * R + a.row, k * R + a.row + a.rows);
    const len = c.text?.length ?? 0;
    if (len > TABLE_LIMITS.cellText) return `cell ${i} text`;
    let at = 0;
    for (const [s, e, k] of c.runs ?? []) {
      if (s < at || e <= s || e > len || k >= (t.runStyles?.length ?? 0)) return `cell ${i} run`;
      at = e;
    }
    if (c.style !== undefined && c.style >= (t.styles?.length ?? 0)) return `cell ${i} style`;
    if (c.fill !== undefined && c.fill >= (t.fills?.length ?? 0)) return `cell ${i} fill`;
  }
  const lines = t.lineStyles?.length ?? 0;
  for (const [list, edges, along, inner] of [
    [t.h, R, C, hIn],
    [t.v, C, R, vIn],
  ] as const)
    for (const [k, from, to, l] of list ?? []) {
      if (k > edges || from >= to || to > along || l >= lines) return 'edge out of range';
      for (let x = from; x < to; x++) if (inner[k * along + x]) return 'edge inside a merge';
    }
  if (gcTable(t) !== t) return 'unused palette entry';
  return '';
}

function valid(t: TableData): void {
  expect(problems(t)).toBe('');
}

/** A random table that covers its grid, with merges, styles, fills and lines. */
function randomTable(rnd: () => number): TableData {
  const R = 1 + Math.floor(rnd() * 6);
  const C = 1 + Math.floor(rnd() * 6);
  const covered = new Uint8Array(R * C);
  const cells: TableCell[] = [];
  for (let s = 0; s < R * C; s++) {
    if (covered[s]) continue;
    const row = Math.floor(s / C);
    const col = s % C;
    let cols = 1;
    while (rnd() < 0.25 && col + cols < C && !covered[s + cols]) cols++;
    const rows = rnd() < 0.2 && row + 1 < R ? 2 : 1;
    for (let r = 0; r < rows; r++) covered.fill(1, (row + r) * C + col, (row + r) * C + col + cols);
    const c: TableCell = { text: `${row}.${col}` };
    if (cols > 1) c.colSpan = cols;
    if (rows > 1) c.rowSpan = rows;
    if (rnd() < 0.3) c.fill = 0;
    if (rnd() < 0.3) c.style = 0;
    if (rnd() < 0.3) c.runs = [[0, 1, 0]];
    cells.push(c);
  }
  const t: TableData = {
    cols: [...Array(C)].map(() => 50 + Math.floor(rnd() * 100)),
    rows: [...Array(R)].map(() => 20 + Math.floor(rnd() * 40)),
    cells,
    base,
    styles: [{ fontWeight: 700 }],
    runStyles: [{ fontStyle: 'italic' }],
    fills: [{ color: red }],
    lineStyles: [{ width: 1, color: red }],
    h: [...Array(R + 1)].map((_, k) => [k, 0, C, 0] as [number, number, number, number]),
    v: [
      [0, 0, R, 0],
      [C, 0, R, 0],
    ],
  };
  // One op normalises the lines (none inside a merge) and the palettes.
  return t$(deleteRow(insertRow(shape(t), 0, 0), 0));
}

describe('property: random table ops', () => {
  it('10,000 random table ops keep placement, spans, edges, palettes and runs valid', () => {
    const rnd = rng(20261108);
    let ops = 0;
    const done = [0, 0, 0, 0, 0, 0];
    const colors: (Rgba | null)[] = [red, null, { r: 0, g: 90, b: 0, a: 1 }, { r: 0, g: 0, b: 120, a: 0.5 }];
    while (ops < 10_000) {
      let o = shape(randomTable(rnd));
      valid(t$(o));
      for (let k = 0; k < 100 && ops < 10_000; k++, ops++) {
        const t = t$(o);
        const R = t.rows.length;
        const C = t.cols.length;
        const pick = (n: number) => Math.floor(rnd() * (n + 2)) - 1; // sometimes out of range
        const sum = t.cols.reduce((s, x) => s + x, 0);
        let next: ShapeObject;
        const op = Math.floor(rnd() * 6);
        if (op === 0) next = insertRow(o, pick(R + 1), pick(R));
        else if (op === 1) next = deleteRow(o, pick(R));
        else if (op === 2) next = insertCol(o, pick(C + 1), pick(C));
        else if (op === 3) next = deleteCol(o, pick(C));
        else if (op === 4) {
          const cells = [...Array(1 + Math.floor(rnd() * 3))].map(() => pick(t.cells.length));
          next = setCellFill(o, cells, colors[Math.floor(rnd() * colors.length)]!);
        } else {
          const i = pick(t.cells.length);
          const view = cellRich(t, i);
          const text = rnd() < 0.2 ? '' : 'word '.repeat(1 + Math.floor(rnd() * 4)).trim();
          const runs: TextRun[] = [];
          for (let s = 0; s < text.length; s += 3)
            if (rnd() < 0.4)
              runs.push({ start: s, end: Math.min(text.length, s + 2), fontWeight: rnd() < 0.5 ? 700 : 300 });
          next = view
            ? setCell(o, i, {
                ...view,
                text,
                runs,
                style: { ...view.style, fontSizePx: rnd() < 0.3 ? 30 : view.style.fontSizePx },
              })
            : setCell(o, i, { text, style: base });
        }
        if (next !== o) {
          done[op]!++;
          const why = problems(t$(next));
          if (why) expect.fail(`op ${op} after ${ops} ops: ${why}`);
          if ((op === 2 || op === 3) && Math.abs(next.table!.cols.reduce((s, x) => s + x, 0) - sum) > 1e-6)
            expect.fail(`op ${op} changed the table's width`);
        }
        o = next;
      }
    }
    expect(ops).toBe(10_000);
    // Every kind of op ran many times (the others were refused: indices out of range, the last row or column).
    for (const n of done) expect(n).toBeGreaterThan(300);
  });
});

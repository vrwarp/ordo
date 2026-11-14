import { canonicalJson, Palette, paletteIndex } from './palette.ts';
import {
  type CellStyle,
  type Rgba,
  type ShapeObject,
  TABLE_LIMITS,
  type TableCell,
  type TableData,
  type TableFill,
  type TableRun,
  type TableRunStyle,
  type TextPara,
  type TextRun,
  type TextStyle,
} from './schemas.ts';

/*
 * The table object's model (design/27 M9, `ShapeObject.table`): where its cells sit, the text box each cell
 * is drawn and edited as, and the edits the operator's table panel makes. Pure, shared by the renderer (which
 * lays the table out and draws it), the editor and the hub, and tested once here.
 *
 * Placement is implicit, as in OOXML and HTML: walking the grid row-major, each cell takes the next slot no
 * earlier cell covers; a span is cut where it would reach a covered slot or the grid's edge; cells past the
 * grid are dropped (`placeCells`, O(grid); `m9-readers.ts` `tableCellRows` follows the same rule).
 *
 * A cell is drawn and edited as a rich text body (`cellRich`): the table's `base` style with its style entry
 * over it (`cellTextStyle`), its runs expanded from the run palette, its paragraph styles as stored. An edit
 * writes such a body back (`setCell`), compacted into the palettes: the style's differences from `base` to
 * `styles`, each run's formatting to `runStyles`. Every op leaves no palette entry unused (`gcTable`).
 *
 * The row and column ops (`insertRow`, `deleteRow`, `insertCol`, `deleteCol`) work on the grid made explicit:
 * every slot covered by exactly one cell (an uncovered slot of a malformed table becomes an empty cell, cells
 * past the grid go), the edges as one line index per edge and slot. Spans that cross the inserted or deleted
 * row or column grow or shrink; no edge is kept inside a merged cell; the result is written back row-major,
 * which places each cell where it was. A table keeps its width (columns are rescaled to their old sum, which
 * the renderer maps to `box.w`); a row adds or removes its height to `box.h`. An op past `TABLE_LIMITS`, at the
 * last row or column, or with an index out of range returns the object unchanged.
 *
 * Not built here (M9 decision 4): the legacy table group and its digest (`tableShadows`), so neither is
 * 'Rebuild table from cells'.
 */

/** Where a cell sits: its first row and column and how many it covers. */
export type CellAnchor = { row: number; col: number; rows: number; cols: number };

export type TablePlacement = {
  /** Rows and columns of the grid (the stored ones, within `TABLE_LIMITS`). */
  R: number;
  C: number;
  /** Per cell in `cells` order: where it sits, or undefined for a cell past the grid. */
  anchors: (CellAnchor | undefined)[];
  /** Per slot (row × C + column): the index of the cell that covers it, or -1. */
  slots: Int32Array;
};

const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const span = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 1 ? v : 1);

/** Where each cell of a table sits (see the module header). Never throws; O(grid + cells). */
export function placeCells(t: Pick<TableData, 'rows' | 'cols' | 'cells'>): TablePlacement {
  const R = Math.min(arr(t.rows).length, TABLE_LIMITS.rows);
  const C = Math.min(arr(t.cols).length, TABLE_LIMITS.cols);
  const cells = arr(t.cells);
  const anchors: (CellAnchor | undefined)[] = new Array(cells.length).fill(undefined);
  const slots = new Int32Array(R * C).fill(-1);
  let at = 0;
  for (let i = 0; i < cells.length; i++) {
    while (at < slots.length && slots[at]! >= 0) at++;
    if (at >= slots.length) break;
    const row = Math.floor(at / C);
    const col = at % C;
    const c = cells[i];
    let cols = Math.min(span(isObj(c) ? c.colSpan : 1), C - col);
    for (let k = 1; k < cols; k++)
      if (slots[at + k]! >= 0) {
        cols = k;
        break;
      }
    let rows = Math.min(span(isObj(c) ? c.rowSpan : 1), R - row);
    for (let r = 1; r < rows; r++) {
      let free = true;
      for (let k = 0; k < cols && free; k++) if (slots[(row + r) * C + col + k]! >= 0) free = false;
      if (!free) {
        rows = r;
        break;
      }
    }
    for (let r = 0; r < rows; r++) slots.fill(i, (row + r) * C + col, (row + r) * C + col + cols);
    anchors[i] = { row, col, rows, cols };
  }
  return { R, C, anchors, slots };
}

// ── Cell views ──────────────────────────────────────────────────────────────────────────────────────────

/** The text style keys a cell style sets over `base` as they are (the others are mapped: `align`). */
const PLAIN_KEYS = [
  'fontFamily',
  'fontWeight',
  'fontSizePx',
  'color',
  'insets',
  'lang',
  'fallbackFonts',
  'fontStyle',
  'valign',
  'direction',
] as const satisfies readonly (keyof CellStyle & keyof TextStyle)[];

/**
 * The text box style a cell is drawn in: `base` with the cell style's fields over it. A cell never shrinks
 * its text (its row grows instead), so the style has no autofit; a cell aligned 'justify' is left aligned and
 * justified, one aligned otherwise is not justified.
 */
export function cellTextStyle(base: TextStyle, s: CellStyle | undefined): TextStyle {
  const out: TextStyle = { ...base };
  delete out.autofit;
  delete out.fitScale;
  if (!s) return out;
  const w = out as Record<string, unknown>;
  for (const k of PLAIN_KEYS) if (s[k] !== undefined) w[k] = s[k];
  if (s.align !== undefined) {
    out.align = s.align === 'justify' ? 'left' : s.align;
    if (s.align === 'justify') out.justify = true;
    else delete out.justify;
  }
  return out;
}

/** The cell style that makes `style` over `base` (`cellTextStyle`'s inverse), keeping `vert` as given. */
export function cellStyleOf(base: TextStyle, style: TextStyle, vert?: CellStyle['vert']): CellStyle {
  const out: CellStyle = {};
  const w = out as Record<string, unknown>;
  for (const k of PLAIN_KEYS)
    if (style[k] !== undefined && canonicalJson(style[k]) !== canonicalJson(base[k])) w[k] = style[k];
  const align = (s: TextStyle) => (s.justify ? 'justify' : s.align);
  if (align(style) !== align(base)) out.align = align(style);
  if (vert !== undefined && vert !== 'horz') out.vert = vert;
  return out;
}

/** A cell's text as a rich text body: its text, its style, its runs and its paragraph styles. */
export type CellRich = {
  text: string;
  style: TextStyle;
  runs?: TextRun[];
  paras?: (TextPara | null)[];
};

/** The style entry of a cell, or undefined (the base alone) when it names none that exists. */
export function cellStyleEntry(t: TableData, c: TableCell | undefined): CellStyle | undefined {
  const styles = arr(t.styles) as CellStyle[];
  const i = paletteIndex(c?.style, styles.length);
  return i === undefined ? undefined : styles[i];
}

/**
 * The runs of a cell expanded from the run palette (each run's formatting over its range), in order; a run
 * naming no run style that exists is left out (its text takes the cell's style).
 */
export function cellRuns(t: TableData, c: TableCell | undefined): TextRun[] {
  const styles = arr(t.runStyles) as TableRunStyle[];
  const out: TextRun[] = [];
  for (const r of arr(c?.runs)) {
    if (!Array.isArray(r) || r.length !== 3) continue;
    const [start, end, s] = r as unknown[];
    const i = paletteIndex(s, styles.length);
    if (i === undefined || typeof start !== 'number' || typeof end !== 'number') continue;
    out.push({ ...styles[i]!, start, end });
  }
  return out;
}

/** Cell `i` as a rich text body (`cellTextStyle`, `cellRuns`), or undefined when there is no such cell. */
export function cellRich(t: TableData, i: number): CellRich | undefined {
  const c = arr(t.cells)[i] as TableCell | undefined;
  if (!isObj(c)) return undefined;
  const out: CellRich = {
    text: typeof c.text === 'string' ? c.text : '',
    style: cellTextStyle(t.base, cellStyleEntry(t, c)),
  };
  if (Array.isArray(c.runs)) out.runs = cellRuns(t, c);
  if (Array.isArray(c.paras)) out.paras = c.paras;
  return out;
}

// ── Palettes ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The table without palette entries no cell, edge or background uses, the indices renumbered. Returns `t`
 * itself when every entry is used. A palette left empty is removed.
 */
export function gcTable(t: TableData): TableData {
  const used = {
    styles: new Set<number>(),
    runStyles: new Set<number>(),
    fills: new Set<number>(),
    lineStyles: new Set<number>(),
  };
  const nStyles = arr(t.styles).length;
  const nRuns = arr(t.runStyles).length;
  const nFills = arr(t.fills).length;
  const nLines = arr(t.lineStyles).length;
  const mark = (set: Set<number>, i: unknown, n: number) => {
    const k = paletteIndex(i, n);
    if (k !== undefined) set.add(k);
  };
  for (const c of t.cells) {
    mark(used.styles, c.style, nStyles);
    mark(used.fills, c.fill, nFills);
    for (const r of c.runs ?? []) mark(used.runStyles, r[2], nRuns);
    mark(used.lineStyles, c.diag?.down, nLines);
    mark(used.lineStyles, c.diag?.up, nLines);
  }
  mark(used.fills, t.background, nFills);
  for (const e of t.h ?? []) mark(used.lineStyles, e[3], nLines);
  for (const e of t.v ?? []) mark(used.lineStyles, e[3], nLines);
  if (
    used.styles.size === nStyles &&
    used.runStyles.size === nRuns &&
    used.fills.size === nFills &&
    used.lineStyles.size === nLines
  )
    return t;
  const remap = (set: Set<number>, n: number): Int32Array => {
    const m = new Int32Array(n).fill(-1);
    let k = 0;
    for (let i = 0; i < n; i++) if (set.has(i)) m[i] = k++;
    return m;
  };
  const ms = remap(used.styles, nStyles);
  const mr = remap(used.runStyles, nRuns);
  const mf = remap(used.fills, nFills);
  const ml = remap(used.lineStyles, nLines);
  const keep = <T>(list: T[] | undefined, set: Set<number>): T[] | undefined => {
    const out = (list ?? []).filter((_, i) => set.has(i));
    return out.length ? out : undefined;
  };
  const at = (m: Int32Array, i: number | undefined) => {
    const k = i === undefined ? -1 : (m[i] ?? -1);
    return k >= 0 ? k : undefined;
  };
  const cells = t.cells.map((c) => {
    const style = at(ms, paletteIndex(c.style, nStyles));
    const fill = at(mf, paletteIndex(c.fill, nFills));
    const out: TableCell = { ...c };
    put(out, 'style', style);
    put(out, 'fill', fill);
    if (c.runs) {
      const runs: TableRun[] = [];
      for (const r of c.runs) {
        const s = at(mr, paletteIndex(r[2], nRuns));
        if (s !== undefined) runs.push([r[0], r[1], s]);
      }
      put(out, 'runs', runs.length ? runs : undefined);
    }
    if (c.diag) {
      const down = at(ml, paletteIndex(c.diag.down, nLines));
      const up = at(ml, paletteIndex(c.diag.up, nLines));
      put(
        out,
        'diag',
        down === undefined && up === undefined
          ? undefined
          : { ...(down !== undefined ? { down } : {}), ...(up !== undefined ? { up } : {}) },
      );
    }
    return out;
  });
  const edges = (list: TableData['h']) => {
    if (!list) return undefined;
    const out: [number, number, number, number][] = [];
    for (const e of list) {
      const l = at(ml, paletteIndex(e[3], nLines));
      if (l !== undefined) out.push([e[0], e[1], e[2], l]);
    }
    return out.length ? out : undefined;
  };
  const out: TableData = { ...t, cells };
  put(out, 'styles', keep(t.styles, used.styles));
  put(out, 'runStyles', keep(t.runStyles, used.runStyles));
  put(out, 'fills', keep(t.fills, used.fills));
  put(out, 'lineStyles', keep(t.lineStyles, used.lineStyles));
  put(out, 'background', at(mf, paletteIndex(t.background, nFills)));
  put(out, 'h', edges(t.h));
  put(out, 'v', edges(t.v));
  return out;
}

/** Sets `o[k]` to `v`, or removes the key when `v` is undefined. */
function put<T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined): void {
  if (v === undefined) delete o[k];
  else o[k] = v;
}

// ── Cell text and fills ────────────────────────────────────────────────────────────────────────────────

/** The table of a shape, when it has one. */
function tableOf(o: ShapeObject): TableData | undefined {
  return isObj(o.table) && Array.isArray(o.table.cells) ? o.table : undefined;
}

/** The text characters, runs and paragraph styles of a table's cells, summed (`TABLE_LIMITS`' table bounds). */
function totals(t: TableData, except = -1): { chars: number; runs: number; paras: number } {
  let chars = 0;
  let runs = 0;
  let paras = 0;
  t.cells.forEach((c, i) => {
    if (i === except) return;
    chars += c.text?.length ?? 0;
    runs += c.runs?.length ?? 0;
    paras += c.paras?.length ?? 0;
  });
  return { chars, runs, paras };
}

/** A run's formatting without its range and without unset fields: its run palette entry. */
function runStyleOf(r: TextRun): TableRunStyle {
  const { start: _s, end: _e, ...rest } = r;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) out[k] = v;
  return out as TableRunStyle;
}

/**
 * Cell `i` with `next` as its text (an edit of `cellRich`'s body: typing, a format range, paragraph styles):
 * its style compacted into the cell style palette, its runs into the run palette, then unused entries removed.
 * The cell keeps its fill, spans, diagonals and vertical writing. Unchanged (the same object) when there is no
 * such cell, or the text, runs or paragraph styles would pass the cell's or the table's bounds, or a palette is
 * full.
 */
export function setCell(o: ShapeObject, i: number, next: CellRich): ShapeObject {
  const t = tableOf(o);
  const cell = t?.cells[i];
  if (!t || !cell || typeof next?.text !== 'string') return o;
  const text = next.text;
  const runsIn = Array.isArray(next.runs) ? next.runs : [];
  const paras = Array.isArray(next.paras) ? next.paras : undefined;
  const rest = totals(t, i);
  if (
    text.length > TABLE_LIMITS.cellText ||
    rest.chars + text.length > TABLE_LIMITS.tableText ||
    runsIn.length > TABLE_LIMITS.cellRuns ||
    rest.runs + runsIn.length > TABLE_LIMITS.tableRuns ||
    (paras?.length ?? 0) > TABLE_LIMITS.cellParas ||
    rest.paras + (paras?.length ?? 0) > TABLE_LIMITS.tableParas
  )
    return o;
  const old = cellStyleEntry(t, cell);
  const style = cellStyleOf(t.base, next.style ?? t.base, old?.vert);
  const styles = seeded<CellStyle>(t.styles, TABLE_LIMITS.cellStyles);
  const runStyles = seeded<TableRunStyle>(t.runStyles, TABLE_LIMITS.runStyles);
  let styleIx: number | undefined;
  if (Object.keys(style).length) {
    styleIx = styles.add(style);
    if (styleIx === undefined) return o;
  }
  const runs: TableRun[] = [];
  let at = 0;
  for (const r of runsIn) {
    if (!isObj(r) || !Number.isInteger(r.start) || !Number.isInteger(r.end)) continue;
    if (r.start < at || r.start >= text.length || r.end <= r.start) continue;
    const end = Math.min(r.end, text.length);
    at = end;
    const s = runStyleOf(r);
    if (!Object.keys(s).length) continue;
    const k = runStyles.add(s);
    if (k === undefined) return o;
    runs.push([r.start, end, k]);
  }
  const c: TableCell = { ...cell };
  put(c, 'text', text || undefined);
  put(c, 'runs', runs.length ? runs : undefined);
  put(c, 'paras', paras?.length ? paras : undefined);
  put(c, 'style', styleIx);
  const cells = t.cells.slice();
  cells[i] = c;
  const table: TableData = { ...t, cells };
  put(table, 'styles', styles.size ? styles.entries : undefined);
  put(table, 'runStyles', runStyles.size ? runStyles.entries : undefined);
  return { ...o, table: gcTable(table) };
}

/**
 * A palette holding a stored palette's entries at their own indices, so cells naming them stay valid: a
 * stored duplicate keeps its place (a new equal value finds the first of them).
 */
function seeded<T>(list: T[] | undefined, max: number): Palette<T> {
  const p = new Palette<T>(max);
  for (const v of list ?? []) {
    const before = p.size;
    const k = p.add(v);
    if (k === undefined || k < before) p.entries.push(v);
  }
  return p;
}

/**
 * The cells `cells` (indices) filled with `color`, or with no fill (null); then unused fills removed.
 * Unchanged when the fill palette is full or no index names a cell.
 */
export function setCellFill(o: ShapeObject, cells: readonly number[], color: Rgba | null): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const which = cells.filter((i) => Number.isInteger(i) && i >= 0 && i < t.cells.length);
  if (!which.length) return o;
  const fills = seeded<TableFill>(t.fills, TABLE_LIMITS.fills);
  let fill: number | undefined;
  if (color) {
    fill = fills.add({ color });
    if (fill === undefined) return o;
  }
  const out = t.cells.slice();
  for (const i of which) {
    const c: TableCell = { ...out[i]! };
    put(c, 'fill', fill);
    out[i] = c;
  }
  const table: TableData = { ...t, cells: out };
  put(table, 'fills', fills.size ? fills.entries : undefined);
  return { ...o, table: gcTable(table) };
}

// ── Rows and columns ────────────────────────────────────────────────────────────────────────────────────

/** A cell of the explicit grid: where it sits and what it holds. */
type GridCell = CellAnchor & { cell: TableCell; orig: CellAnchor | undefined };

/**
 * A table's grid made explicit: every slot covered by one cell, and one line index (or -1) per edge and
 * slot: `h[k × C + c]` the line of row edge k over column c, `v[k × R + r]` that of column edge k beside row r.
 */
type Grid = { R: number; C: number; cells: GridCell[]; h: Int16Array; v: Int16Array };

function decode(t: TableData): Grid {
  const p = placeCells(t);
  const { R, C } = p;
  const cells: GridCell[] = [];
  t.cells.forEach((cell, i) => {
    const a = p.anchors[i];
    if (a) cells.push({ ...a, cell, orig: a });
  });
  for (let s = 0; s < p.slots.length; s++)
    if (p.slots[s]! < 0) {
      const a = { row: Math.floor(s / C), col: s % C, rows: 1, cols: 1 };
      cells.push({ ...a, cell: {}, orig: undefined });
    }
  const lines = arr(t.lineStyles).length;
  const fillEdges = (out: Int16Array, list: TableData['h'], edgesN: number, along: number) => {
    for (const e of list ?? []) {
      const [k, from, to, l] = e;
      if (paletteIndex(l, lines) === undefined || k > edgesN) continue;
      for (let x = Math.max(0, from); x < Math.min(to, along); x++) out[k * along + x] = l;
    }
  };
  const h = new Int16Array((R + 1) * C).fill(-1);
  const v = new Int16Array((C + 1) * R).fill(-1);
  fillEdges(h, t.h, R, C);
  fillEdges(v, t.v, C, R);
  return { R, C, cells, h, v };
}

/** The grid with rows and columns swapped (a column op is the row op of the transposed grid). */
function transpose(g: Grid): Grid {
  return {
    R: g.C,
    C: g.R,
    cells: g.cells.map((c) => ({
      ...c,
      row: c.col,
      col: c.row,
      rows: c.cols,
      cols: c.rows,
      orig: c.orig && { row: c.orig.col, col: c.orig.row, rows: c.orig.cols, cols: c.orig.rows },
    })),
    h: g.v,
    v: g.h,
  };
}

/** Edge runs of one direction: equal neighbouring lines joined, in edge then position order. */
function runsOf(lines: Int16Array, edgesN: number, along: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let k = 0; k <= edgesN; k++) {
    let x = 0;
    while (x < along) {
      const l = lines[k * along + x]!;
      if (l < 0) {
        x++;
        continue;
      }
      let y = x + 1;
      while (y < along && lines[k * along + y] === l) y++;
      out.push([k, x, y, l]);
      x = y;
    }
  }
  return out;
}

/** The table a grid describes: cells row-major (each placed where it sits), edges as runs, none inside a merge. */
function encode(g: Grid, t: TableData): TableData {
  const { R, C, h, v } = g;
  for (const c of g.cells) {
    for (let k = c.row + 1; k < c.row + c.rows; k++) h.fill(-1, k * C + c.col, k * C + c.col + c.cols);
    for (let k = c.col + 1; k < c.col + c.cols; k++) v.fill(-1, k * R + c.row, k * R + c.row + c.rows);
  }
  const sorted = g.cells.slice().sort((a, b) => a.row - b.row || a.col - b.col);
  const cells = sorted.map((c) => {
    if (c.orig && c.orig.rows === c.rows && c.orig.cols === c.cols) {
      const stored = span(c.cell.rowSpan) === c.rows && span(c.cell.colSpan) === c.cols;
      if (stored) return c.cell;
    }
    const out: TableCell = { ...c.cell };
    put(out, 'colSpan', c.cols > 1 ? c.cols : undefined);
    put(out, 'rowSpan', c.rows > 1 ? c.rows : undefined);
    return out;
  });
  const out: TableData = { ...t, cells };
  const hs = runsOf(h, R, C);
  const vs = runsOf(v, C, R);
  put(out, 'h', hs.length ? hs : undefined);
  put(out, 'v', vs.length ? vs : undefined);
  return out;
}

/** A copy of a cell's look for a new row or column: its style and fill, no text, spans or diagonals. */
function lookOf(c: TableCell | undefined): TableCell {
  const out: TableCell = {};
  if (c?.style !== undefined) out.style = c.style;
  if (c?.fill !== undefined) out.fill = c.fill;
  return out;
}

/** The grid with a row inserted at `at` that copies row `from` (see `insertRow`). */
function gridInsertRow(g: Grid, at: number, from: number): Grid {
  const { R, C } = g;
  // The cell covering each column of row `from`, before anything moves.
  const fromCells: (TableCell | undefined)[] = new Array(C).fill(undefined);
  for (const c of g.cells)
    if (c.row <= from && from < c.row + c.rows)
      for (let k = c.col; k < c.col + c.cols; k++) fromCells[k] = c.cell;
  const covered = new Uint8Array(C);
  const cells: GridCell[] = g.cells.map((c) => {
    if (c.row >= at) return { ...c, row: c.row + 1 };
    if (c.row + c.rows > at) {
      covered.fill(1, c.col, c.col + c.cols);
      return { ...c, rows: c.rows + 1 };
    }
    return c;
  });
  for (let k = 0; k < C; k++)
    if (!covered[k])
      cells.push({ row: at, col: k, rows: 1, cols: 1, cell: lookOf(fromCells[k]), orig: undefined });
  // Horizontal edges: the new row's two boundaries take the line of the boundary it was inserted at, and the
  // table's top or bottom border stays a border.
  const h = new Int16Array((R + 2) * C);
  const oldEdge = (k: number) => g.h.subarray(k * C, k * C + C);
  const inner = R >= 2 ? Math.min(Math.max(at, 1), R - 1) : at;
  for (let k = 0; k <= R + 1; k++) {
    let src: number;
    if (at === 0) src = k === 0 ? 0 : k === 1 ? inner : k - 1;
    else if (at === R) src = k <= R - 1 ? k : k === R ? inner : R;
    else src = k <= at ? k : k - 1;
    h.set(oldEdge(src), k * C);
  }
  // Vertical edges: the new row has row `from`'s.
  const v = new Int16Array((C + 1) * (R + 1));
  for (let k = 0; k <= C; k++)
    for (let r = 0; r <= R; r++) {
      const src = r < at ? r : r === at ? from : r - 1;
      v[k * (R + 1) + r] = g.v[k * R + src]!;
    }
  return { R: R + 1, C, cells, h, v };
}

/** The grid without row `r` (see `deleteRow`). */
function gridDeleteRow(g: Grid, r: number): Grid {
  const { R, C } = g;
  const cells: GridCell[] = [];
  for (const c of g.cells) {
    if (c.row <= r && r < c.row + c.rows) {
      if (c.rows > 1) cells.push({ ...c, rows: c.rows - 1 });
    } else cells.push(c.row > r ? { ...c, row: c.row - 1 } : c);
  }
  // The edge that goes: the deleted row's bottom, but for the last row its top, so the borders stay.
  const drop = r === 0 ? 1 : r === R - 1 ? R - 1 : r + 1;
  const h = new Int16Array(R * C);
  for (let k = 0, j = 0; k <= R; k++) {
    if (k === drop) continue;
    h.set(g.h.subarray(k * C, k * C + C), j * C);
    j++;
  }
  const v = new Int16Array((C + 1) * (R - 1));
  for (let k = 0; k <= C; k++)
    for (let q = 0, j = 0; q < R; q++) {
      if (q === r) continue;
      v[k * (R - 1) + j] = g.v[k * R + q]!;
      j++;
    }
  return { R: R - 1, C, cells, h, v };
}

/** Σ of a list of non-negative lengths (non-finite ones count 0). */
function sum(list: readonly number[]): number {
  let s = 0;
  for (const x of list) if (Number.isFinite(x) && x > 0) s += x;
  return s;
}

/** The box height a row adds or removes: its stored height at the table's row scale. */
function rowPx(o: ShapeObject, t: TableData, h: number): number {
  const total = sum(t.rows);
  const k = total > 0 ? o.box.h / total : 1;
  return Number.isFinite(h * k) ? h * k : 0;
}

/** Columns rescaled to keep their old sum (the table's width), when both sums are positive. */
function keepWidth(cols: number[], oldSum: number): number[] {
  const s = sum(cols);
  if (!(s > 0) || !(oldSum > 0)) return cols;
  return cols.map((w) => (w * oldSum) / s);
}

/**
 * A row inserted at `at` (0 .. rows: before row `at`), copying row `from`: its height, the style and fill of
 * the cell over each of its columns (no text) and its vertical lines; a span across `at` grows over it. The
 * box grows by the row's height. Unchanged past `TABLE_LIMITS` or with an index out of range.
 */
export function insertRow(o: ShapeObject, at: number, from: number): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const R = Math.min(t.rows.length, TABLE_LIMITS.rows);
  const C = Math.min(t.cols.length, TABLE_LIMITS.cols);
  if (!Number.isInteger(at) || !Number.isInteger(from) || at < 0 || at > R || from < 0 || from >= R) return o;
  if (R + 1 > TABLE_LIMITS.rows || (R + 1) * C > TABLE_LIMITS.grid) return o;
  const g = gridInsertRow(decode(t), at, from);
  if (g.cells.length > TABLE_LIMITS.grid) return o;
  const rows = t.rows.slice(0, R);
  const h = rows[from] ?? 0;
  rows.splice(at, 0, h);
  const table = gcTable({ ...encode(g, t), rows, cols: t.cols.slice(0, C) });
  return { ...o, box: { ...o.box, h: o.box.h + rowPx(o, t, h) }, table };
}

/**
 * Row `r` deleted: its single-row cells go, spans over it shrink, the line below it goes (above it, for the
 * last row) and the box shrinks by its height. Unchanged for the only row or an index out of range.
 */
export function deleteRow(o: ShapeObject, r: number): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const R = Math.min(t.rows.length, TABLE_LIMITS.rows);
  const C = Math.min(t.cols.length, TABLE_LIMITS.cols);
  if (!Number.isInteger(r) || r < 0 || r >= R || R <= 1) return o;
  const g = gridDeleteRow(decode(t), r);
  const rows = t.rows.slice(0, R);
  const [h] = rows.splice(r, 1);
  const table = gcTable({ ...encode(g, t), rows, cols: t.cols.slice(0, C) });
  const box = { ...o.box, h: Math.max(0, o.box.h - rowPx(o, t, h ?? 0)) };
  return { ...o, box, table };
}

/**
 * A column inserted at `at` (0 .. columns: before column `at`), copying column `from` (its width, its cells'
 * styles and fills, its horizontal lines); the columns are rescaled to the table's width. Unchanged past
 * `TABLE_LIMITS` or with an index out of range.
 */
export function insertCol(o: ShapeObject, at: number, from: number): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const R = Math.min(t.rows.length, TABLE_LIMITS.rows);
  const C = Math.min(t.cols.length, TABLE_LIMITS.cols);
  if (!Number.isInteger(at) || !Number.isInteger(from) || at < 0 || at > C || from < 0 || from >= C) return o;
  if (C + 1 > TABLE_LIMITS.cols || R * (C + 1) > TABLE_LIMITS.grid) return o;
  const g = transpose(gridInsertRow(transpose(decode(t)), at, from));
  if (g.cells.length > TABLE_LIMITS.grid) return o;
  const cols = t.cols.slice(0, C);
  cols.splice(at, 0, cols[from] ?? 0);
  const table = gcTable({ ...encode(g, t), rows: t.rows.slice(0, R), cols: keepWidth(cols, sum(t.cols)) });
  return { ...o, table };
}

/**
 * Column `c` deleted: its single-column cells go, spans over it shrink, the line right of it goes (left of
 * it, for the last column); the other columns are rescaled to the table's width. Unchanged for the only
 * column or an index out of range.
 */
export function deleteCol(o: ShapeObject, c: number): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const R = Math.min(t.rows.length, TABLE_LIMITS.rows);
  const C = Math.min(t.cols.length, TABLE_LIMITS.cols);
  if (!Number.isInteger(c) || c < 0 || c >= C || C <= 1) return o;
  const g = transpose(gridDeleteRow(transpose(decode(t)), c));
  const cols = t.cols.slice(0, C);
  cols.splice(c, 1);
  const table = gcTable({ ...encode(g, t), rows: t.rows.slice(0, R), cols: keepWidth(cols, sum(t.cols)) });
  return { ...o, table };
}

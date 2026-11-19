import {
  type CellAnchor,
  cellBodyOf,
  cellStyleEntry,
  cellTextObject,
  gcTable,
  insertCol,
  insertRow,
  newId,
  placeCells,
  type ShapeObject,
  setCell,
  TABLE_LIMITS,
  type TableCell,
  type TableData,
  type TableFill,
  type TableLineStyle,
  type TextStyle,
  type Theme,
} from '@ordo/domain';

/*
 * Pure table creation, range selection, merge/split, borders, divider resize, distribution, row/column
 * reordering, starter styling (header row & alternating row bands), and spreadsheet TSV/HTML paste ops.
 *
 * Every op enforces `TABLE_LIMITS`, compacts unused palette entries via `gcTable`, and returns the input
 * object unchanged when the op is invalid or a no-op.
 */

/** An inclusive 0-based rectangular grid range (`r0 <= r1`, `c0 <= c1`). */
export type TableRange = {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
};

export type BorderTarget = 'all' | 'outer' | 'inner' | 'none' | 'top' | 'bottom' | 'left' | 'right';

export type NewTableOptions = {
  rows?: number;
  cols?: number;
  headerRow?: boolean;
  bandedRows?: boolean;
  cells?: readonly (readonly string[])[];
};

const DEFAULT_BORDER: TableLineStyle = {
  width: 1.5,
  color: { r: 148, g: 163, b: 184, a: 0.35 },
};

const HEADER_FILL: TableFill = {
  color: { r: 30, g: 58, b: 95, a: 0.92 },
};

const BAND_EVEN_FILL: TableFill = {
  color: { r: 15, g: 23, b: 42, a: 0.72 },
};

const BAND_ODD_FILL: TableFill = {
  color: { r: 30, g: 41, b: 59, a: 0.86 },
};

const MIN_COL_PX = 48;
const MIN_ROW_PX = 32;
const MAX_LENGTH = 100_000;

function tableOf(o: ShapeObject): TableData | undefined {
  return o.table && Array.isArray(o.table.cells) ? o.table : undefined;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sumPos(list: readonly number[]): number {
  let s = 0;
  for (const x of list) if (Number.isFinite(x) && x > 0) s += x;
  return s;
}

function put<T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined): void {
  if (v === undefined) delete o[k];
  else o[k] = v;
}

/** Find or append a palette entry, returning its index or undefined when the palette is full. */
function addPalette<T>(entries: T[], value: T, max: number): number | undefined {
  const key = JSON.stringify(value);
  const existing = entries.findIndex((e) => JSON.stringify(e) === key);
  if (existing >= 0) return existing;
  if (entries.length >= max) return undefined;
  entries.push(value);
  return entries.length - 1;
}

// ── Grid & edge helpers ────────────────────────────────────────────────────────────────────────────────

type GridCell = CellAnchor & { cell: TableCell };
type ExplicitGrid = { R: number; C: number; cells: GridCell[]; h: Int16Array; v: Int16Array };

function decodeGrid(t: TableData): ExplicitGrid {
  const p = placeCells(t);
  const { R, C } = p;
  const cells: GridCell[] = [];
  t.cells.forEach((cell, i) => {
    const a = p.anchors[i];
    if (a) cells.push({ ...a, cell });
  });
  for (let s = 0; s < p.slots.length; s++) {
    if (p.slots[s]! < 0) {
      cells.push({ row: Math.floor(s / C), col: s % C, rows: 1, cols: 1, cell: {} });
    }
  }
  const nLines = t.lineStyles?.length ?? 0;
  const h = new Int16Array((R + 1) * C).fill(-1);
  const v = new Int16Array((C + 1) * R).fill(-1);
  const fill = (out: Int16Array, list: TableData['h'], edgesN: number, along: number) => {
    for (const e of list ?? []) {
      const [k, from, to, l] = e;
      if (!Number.isInteger(l) || l < 0 || l >= nLines || k < 0 || k > edgesN) continue;
      for (let x = Math.max(0, from); x < Math.min(to, along); x++) out[k * along + x] = l;
    }
  };
  fill(h, t.h, R, C);
  fill(v, t.v, C, R);
  return { R, C, cells, h, v };
}

function encodeRuns(lines: Int16Array, edgesN: number, along: number): [number, number, number, number][] {
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

function encodeGrid(g: ExplicitGrid, t: TableData): TableData {
  const { R, C, h, v } = g;
  for (const c of g.cells) {
    for (let k = c.row + 1; k < c.row + c.rows; k++) h.fill(-1, k * C + c.col, k * C + c.col + c.cols);
    for (let k = c.col + 1; k < c.col + c.cols; k++) v.fill(-1, k * R + c.row, k * R + c.row + c.rows);
  }
  const sorted = g.cells.slice().sort((a, b) => a.row - b.row || a.col - b.col);
  const cells = sorted.map((c) => {
    const out: TableCell = { ...c.cell };
    put(out, 'colSpan', c.cols > 1 ? c.cols : undefined);
    put(out, 'rowSpan', c.rows > 1 ? c.rows : undefined);
    return out;
  });
  const out: TableData = { ...t, cells };
  const hs = encodeRuns(h, R, C);
  const vs = encodeRuns(v, C, R);
  put(out, 'h', hs.length ? hs : undefined);
  put(out, 'v', vs.length ? vs : undefined);
  return out;
}

// ── Selection & range helpers ──────────────────────────────────────────────────────────────────────────

/** Normalize a range and expand it so it never partially slices any merged cell. */
export function normalizeRange(t: Pick<TableData, 'rows' | 'cols' | 'cells'>, raw: TableRange): TableRange {
  const p = placeCells(t);
  if (!p.R || !p.C) return { r0: 0, c0: 0, r1: 0, c1: 0 };
  let r0 = Math.max(0, Math.min(p.R - 1, Math.min(raw.r0, raw.r1)));
  let r1 = Math.max(0, Math.min(p.R - 1, Math.max(raw.r0, raw.r1)));
  let c0 = Math.max(0, Math.min(p.C - 1, Math.min(raw.c0, raw.c1)));
  let c1 = Math.max(0, Math.min(p.C - 1, Math.max(raw.c0, raw.c1)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of p.anchors) {
      if (!a) continue;
      const ar1 = a.row + a.rows - 1;
      const ac1 = a.col + a.cols - 1;
      if (ar1 < r0 || a.row > r1 || ac1 < c0 || a.col > c1) continue;
      if (a.row < r0) {
        r0 = a.row;
        changed = true;
      }
      if (ar1 > r1) {
        r1 = ar1;
        changed = true;
      }
      if (a.col < c0) {
        c0 = a.col;
        changed = true;
      }
      if (ac1 > c1) {
        c1 = ac1;
        changed = true;
      }
    }
  }
  return { r0, c0, r1, c1 };
}

/** The minimal valid rectangular range covering cell `a` (and optionally cell `b`). */
export function rangeOfCells(
  t: Pick<TableData, 'rows' | 'cols' | 'cells'>,
  a: number,
  b?: number,
): TableRange | undefined {
  const { anchors } = placeCells(t);
  const aa = anchors[a];
  if (!aa) return undefined;
  const ab = b === undefined ? aa : (anchors[b] ?? aa);
  return normalizeRange(t, {
    r0: Math.min(aa.row, ab.row),
    c0: Math.min(aa.col, ab.col),
    r1: Math.max(aa.row + aa.rows - 1, ab.row + ab.rows - 1),
    c1: Math.max(aa.col + aa.cols - 1, ab.col + ab.cols - 1),
  });
}

/** Every distinct cell index whose anchor lies inside `range`, in cell order. */
export function cellsInRange(t: Pick<TableData, 'rows' | 'cols' | 'cells'>, range: TableRange): number[] {
  const p = placeCells(t);
  const out: number[] = [];
  p.anchors.forEach((a, i) => {
    if (!a) return;
    if (a.row + a.rows - 1 < range.r0 || a.row > range.r1) return;
    if (a.col + a.cols - 1 < range.c0 || a.col > range.c1) return;
    out.push(i);
  });
  return out;
}

/** Active cell indices for an editor selection: explicit range, single cell, or whole table. */
export function targetCellIndices(
  t: Pick<TableData, 'rows' | 'cols' | 'cells'>,
  cell: number | undefined,
  range?: TableRange,
): number[] {
  if (range) {
    const inRange = cellsInRange(t, normalizeRange(t, range));
    if (inRange.length) return inRange;
  }
  if (cell !== undefined && cell >= 0 && cell < t.cells.length) return [cell];
  return t.cells.map((_, i) => i);
}

/** Human-readable scope pill label for a table, single cell, row, column, or multi-cell range. */
export function rangeScopeLabel(
  t: Pick<TableData, 'rows' | 'cols' | 'cells'>,
  cell: number | undefined,
  range?: TableRange,
): string {
  const p = placeCells(t);
  if (range) {
    const norm = normalizeRange(t, range);
    const cells = cellsInRange(t, norm);
    if (cells.length === 1) {
      const a = p.anchors[cells[0]!];
      return a ? `Row ${a.row + 1}, column ${a.col + 1}` : 'Cell';
    }
    if (cells.length > 1) {
      const fullCols = norm.c0 === 0 && norm.c1 === p.C - 1;
      const fullRows = norm.r0 === 0 && norm.r1 === p.R - 1;
      if (fullCols && fullRows) return `Table (${cells.length} cells)`;
      if (fullCols && norm.r0 === norm.r1) return `Row ${norm.r0 + 1} (${cells.length} cells)`;
      if (fullCols) return `Rows ${norm.r0 + 1}–${norm.r1 + 1} (${cells.length} cells)`;
      if (fullRows && norm.c0 === norm.c1) return `Column ${norm.c0 + 1} (${cells.length} cells)`;
      if (fullRows) return `Columns ${norm.c0 + 1}–${norm.c1 + 1} (${cells.length} cells)`;
      const rPart = norm.r0 === norm.r1 ? `Row ${norm.r0 + 1}` : `Rows ${norm.r0 + 1}–${norm.r1 + 1}`;
      const cPart = norm.c0 === norm.c1 ? `col ${norm.c0 + 1}` : `col ${norm.c0 + 1}–${norm.c1 + 1}`;
      return `${rPart}, ${cPart} (${cells.length} cells)`;
    }
  }
  if (cell !== undefined) {
    const a = p.anchors[cell];
    return a ? `Row ${a.row + 1}, column ${a.col + 1}` : 'Cell';
  }
  return 'Table';
}

// ── Table creation ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Create a new native table shape (`rowRule: 'grow'`, design/15 "Table editing"), centered on the 1920×1080
 * slide with theme-aware text defaults, optional header row, optional alternating row bands, and optional
 * initial cell matrix (e.g. from pasting TSV/Sheets).
 */
export function newTable(theme: Theme, opts: NewTableOptions = {}): ShapeObject {
  const matrix = opts.cells;
  const rawR = matrix ? Math.max(1, matrix.length) : (opts.rows ?? 4);
  const rawC = matrix ? Math.max(1, ...matrix.map((r) => r.length)) : (opts.cols ?? 4);
  let R = Math.max(1, Math.min(TABLE_LIMITS.rows, Math.round(rawR)));
  const C = Math.max(1, Math.min(TABLE_LIMITS.cols, Math.round(rawC)));
  if (R * C > TABLE_LIMITS.grid) R = Math.max(1, Math.floor(TABLE_LIMITS.grid / C));

  const headerRow = opts.headerRow ?? true;
  const bandedRows = opts.bandedRows ?? true;

  const w = Math.min(1560, Math.max(600, C * 260));
  const colW = Math.round(w / C);
  const cols = Array.from({ length: C }, () => colW);
  const headerH = 76;
  const bodyH = 68;
  const rows = Array.from({ length: R }, (_, r) => (r === 0 && headerRow ? headerH : bodyH));
  const h = Math.min(
    820,
    rows.reduce((a, b) => a + b, 0),
  );

  const base: TextStyle = {
    ...theme.textBoxDefaults,
    fontSizePx: Math.min(32, Math.max(20, Math.round((theme.textBoxDefaults.fontSizePx || 36) * 0.65))),
    fontWeight: 400,
    align: 'left',
    valign: 'middle',
    insets: { l: 16, t: 10, r: 16, b: 10 },
  };
  delete base.autofit;
  delete base.fitScale;

  const fills: TableFill[] = [];
  const styles: NonNullable<TableData['styles']> = [];
  const headerFillIx = headerRow ? addPalette(fills, HEADER_FILL, TABLE_LIMITS.fills) : undefined;
  const evenFillIx = bandedRows ? addPalette(fills, BAND_EVEN_FILL, TABLE_LIMITS.fills) : undefined;
  const oddFillIx = bandedRows ? addPalette(fills, BAND_ODD_FILL, TABLE_LIMITS.fills) : undefined;
  const headerStyleIx = headerRow
    ? addPalette(
        styles,
        { fontWeight: 700, color: { r: 248, g: 250, b: 252, a: 1 } },
        TABLE_LIMITS.cellStyles,
      )
    : undefined;

  const cells: TableCell[] = [];
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const cell: TableCell = {};
      const text = matrix?.[r]?.[c];
      if (text) cell.text = text.slice(0, TABLE_LIMITS.cellText);
      if (r === 0 && headerRow) {
        if (headerFillIx !== undefined) cell.fill = headerFillIx;
        if (headerStyleIx !== undefined) cell.style = headerStyleIx;
      } else if (bandedRows) {
        const bodyIndex = headerRow ? r - 1 : r;
        const fx = bodyIndex % 2 === 0 ? evenFillIx : oddFillIx;
        if (fx !== undefined) cell.fill = fx;
      }
      cells.push(cell);
    }
  }

  const hEdges: [number, number, number, number][] = [];
  for (let k = 0; k <= R; k++) hEdges.push([k, 0, C, 0]);
  const vEdges: [number, number, number, number][] = [];
  for (let k = 0; k <= C; k++) vEdges.push([k, 0, R, 0]);

  const table: TableData = gcTable({
    cols,
    rows,
    cells,
    base,
    rowRule: 'grow',
    ...(fills.length ? { fills } : {}),
    ...(styles.length ? { styles } : {}),
    lineStyles: [DEFAULT_BORDER],
    h: hEdges,
    v: vEdges,
  });

  const x = Math.round((1920 - w) / 2);
  const y = Math.round((1080 - h) / 2);

  return {
    id: newId(),
    type: 'shape',
    shape: 'rect',
    box: { x, y, w, h, rotation: 0 },
    opacity: 1,
    radius: 0,
    table,
  };
}

// ── Cell fills (solid + gradient) & multi-cell styling ────────────────────────────────────────────────

/**
 * Fill `cells` with a solid or gradient `TableFill`, or clear their fill (`null`), running `gcTable`.
 * Returns `o` unchanged when every target cell already has that fill or the fill palette is full.
 */
export function setCellsPaint(o: ShapeObject, cells: readonly number[], fill: TableFill | null): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const which = cells.filter((i) => Number.isInteger(i) && i >= 0 && i < t.cells.length);
  if (!which.length) return o;
  const already = which.every((i) => {
    const k = t.cells[i]?.fill;
    const cur = k === undefined ? undefined : t.fills?.[k];
    if (!fill) return !cur;
    return !!cur && sameJson(cur, fill);
  });
  if (already) return o;
  const fills = (t.fills ?? []).slice();
  let fillIx: number | undefined;
  if (fill) {
    fillIx = addPalette(fills, fill, TABLE_LIMITS.fills);
    if (fillIx === undefined) return o;
  }
  const nextCells = t.cells.slice();
  for (const i of which) {
    const c: TableCell = { ...nextCells[i]! };
    put(c, 'fill', fillIx);
    nextCells[i] = c;
  }
  const table: TableData = { ...t, cells: nextCells };
  put(table, 'fills', fills.length ? fills : undefined);
  return { ...o, table: gcTable(table) };
}

/** Apply a `TextStyle` transform to every cell in `cells` (e.g. align, valign, insets, bold, font, size). */
export function setCellsStyle(
  o: ShapeObject,
  cells: readonly number[],
  fn: (s: TextStyle) => TextStyle,
): ShapeObject {
  const t = tableOf(o);
  if (!t || !cells.length) return o;
  let cur = o;
  for (const i of cells) {
    const view = cellTextObject(cur, i);
    if (!view) continue;
    const nextStyle = fn(view.style);
    if (nextStyle === view.style) continue;
    cur = setCell(cur, i, cellBodyOf({ ...view, style: nextStyle }));
  }
  return cur;
}

// ── Merge & Split cells ────────────────────────────────────────────────────────────────────────────────

/** Whether `range` covers at least two distinct cells that can be merged into one spanned cell. */
export function canMergeCells(
  t: Pick<TableData, 'rows' | 'cols' | 'cells'>,
  range: TableRange | undefined,
): boolean {
  if (!range) return false;
  const norm = normalizeRange(t, range);
  return cellsInRange(t, norm).length >= 2;
}

/** Merge every cell in `range` into a single spanned cell at the top-left corner of the normalized range. */
export function mergeCells(o: ShapeObject, range: TableRange): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const norm = normalizeRange(t, range);
  const indices = cellsInRange(t, norm);
  if (indices.length < 2) return o;
  const g = decodeGrid(t);
  const topLeftIdx = indices[0]!;
  const nonEmptyTexts: string[] = [];
  for (const i of indices) {
    const txt = t.cells[i]?.text;
    if (txt && txt.trim().length > 0) nonEmptyTexts.push(txt);
  }
  const baseCell = t.cells[topLeftIdx]!;
  const mergedCell: TableCell = { ...baseCell };
  if (nonEmptyTexts.length > 1) {
    const combined = nonEmptyTexts.join('\n').slice(0, TABLE_LIMITS.cellText);
    mergedCell.text = combined;
    delete mergedCell.runs;
    delete mergedCell.paras;
  } else if (nonEmptyTexts.length === 1 && !(baseCell.text && baseCell.text.trim().length > 0)) {
    const srcIdx = indices.find((i) => (t.cells[i]?.text ?? '').trim().length > 0)!;
    const src = t.cells[srcIdx]!;
    put(mergedCell, 'text', src.text);
    put(mergedCell, 'runs', src.runs);
    put(mergedCell, 'paras', src.paras);
  }

  const nextCells: GridCell[] = [];
  for (const gc of g.cells) {
    if (gc.row >= norm.r0 && gc.row <= norm.r1 && gc.col >= norm.c0 && gc.col <= norm.c1) continue;
    nextCells.push(gc);
  }
  nextCells.push({
    row: norm.r0,
    col: norm.c0,
    rows: norm.r1 - norm.r0 + 1,
    cols: norm.c1 - norm.c0 + 1,
    cell: mergedCell,
  });

  const nextTable = gcTable(encodeGrid({ ...g, cells: nextCells }, t));
  return { ...o, table: nextTable };
}

/** Whether cell `cell` is merged (`colSpan > 1 || rowSpan > 1`) and can be split. */
export function canSplitCell(
  t: Pick<TableData, 'rows' | 'cols' | 'cells'>,
  cell: number | undefined,
): boolean {
  if (cell === undefined) return false;
  const a = placeCells(t).anchors[cell];
  return !!a && (a.rows > 1 || a.cols > 1);
}

/** Split a merged cell back into 1×1 cells, preserving style/fill and restoring interior grid borders. */
export function splitCell(o: ShapeObject, cell: number): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const p = placeCells(t);
  const a = p.anchors[cell];
  if (!a || (a.rows <= 1 && a.cols <= 1)) return o;
  const g = decodeGrid(t);
  const lineIdx = t.lineStyles?.length ? 0 : -1;

  const look: TableCell = {};
  const orig = t.cells[cell]!;
  if (orig.style !== undefined) look.style = orig.style;
  if (orig.fill !== undefined) look.fill = orig.fill;

  const nextCells: GridCell[] = [];
  for (const gc of g.cells) {
    if (gc.row === a.row && gc.col === a.col) {
      const topLeft: TableCell = { ...gc.cell };
      delete topLeft.colSpan;
      delete topLeft.rowSpan;
      nextCells.push({ row: a.row, col: a.col, rows: 1, cols: 1, cell: topLeft });
      for (let r = a.row; r < a.row + a.rows; r++) {
        for (let c = a.col; c < a.col + a.cols; c++) {
          if (r === a.row && c === a.col) continue;
          nextCells.push({ row: r, col: c, rows: 1, cols: 1, cell: { ...look } });
        }
      }
    } else {
      nextCells.push(gc);
    }
  }
  if (nextCells.length > TABLE_LIMITS.grid) return o;

  if (lineIdx >= 0) {
    for (let k = a.row + 1; k < a.row + a.rows; k++) {
      g.h.fill(lineIdx, k * g.C + a.col, k * g.C + a.col + a.cols);
    }
    for (let k = a.col + 1; k < a.col + a.cols; k++) {
      g.v.fill(lineIdx, k * g.R + a.row, k * g.R + a.row + a.rows);
    }
  }

  return { ...o, table: gcTable(encodeGrid({ ...g, cells: nextCells }, t)) };
}

// ── Borders Matrix ─────────────────────────────────────────────────────────────────────────────────────

/** Read the dominant border style touching `range` (or `DEFAULT_BORDER` if none is set). */
export function inspectBorders(t: TableData, range?: TableRange): TableLineStyle {
  const g = decodeGrid(t);
  if (!g.R || !g.C || !t.lineStyles?.length) return DEFAULT_BORDER;
  const r = range ? normalizeRange(t, range) : { r0: 0, c0: 0, r1: g.R - 1, c1: g.C - 1 };
  const counts = new Map<number, number>();
  const bump = (idx: number) => {
    if (idx >= 0 && idx < t.lineStyles!.length) counts.set(idx, (counts.get(idx) ?? 0) + 1);
  };
  for (let k = r.r0; k <= r.r1 + 1; k++) {
    for (let c = r.c0; c <= r.c1; c++) bump(g.h[k * g.C + c]!);
  }
  for (let k = r.c0; k <= r.c1 + 1; k++) {
    for (let row = r.r0; row <= r.r1; row++) bump(g.v[k * g.R + row]!);
  }
  let best = -1;
  let bestCount = 0;
  for (const [idx, count] of counts) {
    if (count > bestCount) {
      best = idx;
      bestCount = count;
    }
  }
  return best >= 0 ? t.lineStyles[best]! : DEFAULT_BORDER;
}

/**
 * Apply `style` (or clear with `null` / `target === 'none'`) to the targeted borders of `range`.
 * Preserves merged-cell interior suppression and compacts `lineStyles` via `gcTable`.
 */
export function setTableBorders(
  o: ShapeObject,
  range: TableRange | undefined,
  target: BorderTarget,
  style: TableLineStyle | null,
): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const g = decodeGrid(t);
  if (!g.R || !g.C) return o;
  const r = range ? normalizeRange(t, range) : { r0: 0, c0: 0, r1: g.R - 1, c1: g.C - 1 };

  const lineStyles = (t.lineStyles ?? []).slice();
  let lineIdx = -1;
  if (target !== 'none' && style !== null) {
    const idx = addPalette(lineStyles, style, TABLE_LIMITS.lineStyles);
    if (idx === undefined) return o;
    lineIdx = idx;
  }

  const setH = (edge: number) => {
    for (let c = r.c0; c <= r.c1; c++) g.h[edge * g.C + c] = lineIdx;
  };
  const setV = (edge: number) => {
    for (let row = r.r0; row <= r.r1; row++) g.v[edge * g.R + row] = lineIdx;
  };

  switch (target) {
    case 'none':
    case 'all':
      for (let k = r.r0; k <= r.r1 + 1; k++) setH(k);
      for (let k = r.c0; k <= r.c1 + 1; k++) setV(k);
      break;
    case 'outer':
      setH(r.r0);
      setH(r.r1 + 1);
      setV(r.c0);
      setV(r.c1 + 1);
      break;
    case 'inner':
      for (let k = r.r0 + 1; k <= r.r1; k++) setH(k);
      for (let k = r.c0 + 1; k <= r.c1; k++) setV(k);
      break;
    case 'top':
      setH(r.r0);
      break;
    case 'bottom':
      setH(r.r1 + 1);
      break;
    case 'left':
      setV(r.c0);
      break;
    case 'right':
      setV(r.c1 + 1);
      break;
  }

  const withLines: TableData = { ...t };
  put(withLines, 'lineStyles', lineStyles.length ? lineStyles : undefined);
  const encoded = gcTable(encodeGrid(g, withLines));
  if (sameJson(encoded, t)) return o;
  return { ...o, table: encoded };
}

// ── Divider resizing & Distribution ────────────────────────────────────────────────────────────────────

/**
 * Drag internal column divider `edgeIndex` (1 .. C-1) by `deltaPx` slide pixels.
 * Redistributes width between adjacent columns `edgeIndex - 1` and `edgeIndex`, keeping `box.w` fixed.
 */
export function resizeColDivider(
  o: ShapeObject,
  edgeIndex: number,
  deltaPx: number,
  minColPx = MIN_COL_PX,
): ShapeObject {
  const t = tableOf(o);
  if (!t || !Number.isFinite(deltaPx) || Math.abs(deltaPx) < 1e-4) return o;
  const C = Math.min(t.cols.length, TABLE_LIMITS.cols);
  if (!Number.isInteger(edgeIndex) || edgeIndex <= 0 || edgeIndex >= C) return o;
  const total = sumPos(t.cols.slice(0, C));
  if (!(total > 0) || !(o.box.w > 0)) return o;
  const pxToStored = total / o.box.w;
  const dStored = (t.rtl ? -deltaPx : deltaPx) * pxToStored;
  const minStored = minColPx * pxToStored;
  const left = t.cols[edgeIndex - 1]!;
  const right = t.cols[edgeIndex]!;
  const pair = left + right;
  const clampedMin = Math.min(minStored, pair / 2);
  const nextLeft = Math.max(clampedMin, Math.min(pair - clampedMin, left + dStored));
  const nextRight = pair - nextLeft;
  if (Math.abs(nextLeft - left) < 1e-4) return o;
  const cols = t.cols.slice();
  cols[edgeIndex - 1] = nextLeft;
  cols[edgeIndex] = nextRight;
  return { ...o, table: { ...t, cols } };
}

/**
 * Drag internal row divider `edgeIndex` (1 .. R) by `deltaPx` slide pixels.
 * Resizes row `edgeIndex - 1` and updates `box.h` accordingly.
 */
export function resizeRowDivider(
  o: ShapeObject,
  edgeIndex: number,
  deltaPx: number,
  minRowPx = MIN_ROW_PX,
): ShapeObject {
  const t = tableOf(o);
  if (!t || !Number.isFinite(deltaPx) || Math.abs(deltaPx) < 1e-4) return o;
  const R = Math.min(t.rows.length, TABLE_LIMITS.rows);
  if (!Number.isInteger(edgeIndex) || edgeIndex <= 0 || edgeIndex > R) return o;
  const total = sumPos(t.rows.slice(0, R));
  if (!(total > 0) || !(o.box.h > 0)) return o;
  const pxToStored = total / o.box.h;
  const rowIdx = edgeIndex - 1;
  const oldStored = t.rows[rowIdx]!;
  const minStored = minRowPx * pxToStored;
  const nextStored = Math.max(minStored, Math.min(MAX_LENGTH, oldStored + deltaPx * pxToStored));
  if (Math.abs(nextStored - oldStored) < 1e-4) return o;
  const rows = t.rows.slice();
  rows[rowIdx] = nextStored;
  const addedPx = (nextStored - oldStored) / pxToStored;
  const nextBoxH = Math.max(minRowPx, Math.min(MAX_LENGTH, o.box.h + addedPx));
  return { ...o, box: { ...o.box, h: nextBoxH }, table: { ...t, rows } };
}

/** Equalize column widths across `range.c0..range.c1` (or all columns if range spans < 2 columns). */
export function distributeCols(o: ShapeObject, range?: TableRange): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const C = Math.min(t.cols.length, TABLE_LIMITS.cols);
  if (C < 2) return o;
  const c0 = range && range.c1 > range.c0 ? Math.max(0, range.c0) : 0;
  const c1 = range && range.c1 > range.c0 ? Math.min(C - 1, range.c1) : C - 1;
  const count = c1 - c0 + 1;
  if (count < 2) return o;
  const cols = t.cols.slice();
  const spanSum = sumPos(cols.slice(c0, c1 + 1));
  if (!(spanSum > 0)) return o;
  const each = spanSum / count;
  let changed = false;
  for (let c = c0; c <= c1; c++) {
    if (Math.abs(cols[c]! - each) > 1e-3) changed = true;
    cols[c] = each;
  }
  return changed ? { ...o, table: { ...t, cols } } : o;
}

/** Equalize row heights across `range.r0..range.r1` (or all rows if range spans < 2 rows). */
export function distributeRows(o: ShapeObject, range?: TableRange): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const R = Math.min(t.rows.length, TABLE_LIMITS.rows);
  if (R < 2) return o;
  const r0 = range && range.r1 > range.r0 ? Math.max(0, range.r0) : 0;
  const r1 = range && range.r1 > range.r0 ? Math.min(R - 1, range.r1) : R - 1;
  const count = r1 - r0 + 1;
  if (count < 2) return o;
  const rows = t.rows.slice();
  const spanSum = sumPos(rows.slice(r0, r1 + 1));
  if (!(spanSum > 0)) return o;
  const each = spanSum / count;
  let changed = false;
  for (let r = r0; r <= r1; r++) {
    if (Math.abs(rows[r]! - each) > 1e-3) changed = true;
    rows[r] = each;
  }
  return changed ? { ...o, table: { ...t, rows } } : o;
}

// ── Row & Column Reordering ────────────────────────────────────────────────────────────────────────────

function crossesRowBoundary(t: Pick<TableData, 'rows' | 'cols' | 'cells'>, r: number): boolean {
  const { anchors } = placeCells(t);
  return anchors.some((a) => a && a.rows > 1 && a.row <= r && r < a.row + a.rows);
}

function crossesColBoundary(t: Pick<TableData, 'rows' | 'cols' | 'cells'>, c: number): boolean {
  const { anchors } = placeCells(t);
  return anchors.some((a) => a && a.cols > 1 && a.col <= c && c < a.col + a.cols);
}

export function canMoveRow(t: Pick<TableData, 'rows' | 'cols' | 'cells'>, from: number, to: number): boolean {
  const R = Math.min(t.rows.length, TABLE_LIMITS.rows);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= R || to < 0 || to >= R)
    return false;
  if (from === to) return false;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let r = lo; r <= hi; r++) if (crossesRowBoundary(t, r)) return false;
  return true;
}

export function moveRow(o: ShapeObject, from: number, to: number): ShapeObject {
  const t = tableOf(o);
  if (!t || !canMoveRow(t, from, to)) return o;
  const g = decodeGrid(t);
  const mapRow = (r: number): number => {
    if (r === from) return to;
    if (from < to) return r > from && r <= to ? r - 1 : r;
    return r >= to && r < from ? r + 1 : r;
  };
  const cells = g.cells.map((c) => ({ ...c, row: mapRow(c.row) }));
  const v = new Int16Array((g.C + 1) * g.R).fill(-1);
  for (let k = 0; k <= g.C; k++) {
    for (let r = 0; r < g.R; r++) {
      v[k * g.R + mapRow(r)] = g.v[k * g.R + r]!;
    }
  }
  const rows = t.rows.slice(0, g.R);
  const [movedH] = rows.splice(from, 1);
  rows.splice(to, 0, movedH!);
  return { ...o, table: gcTable({ ...encodeGrid({ ...g, cells, v }, t), rows }) };
}

export function canMoveCol(t: Pick<TableData, 'rows' | 'cols' | 'cells'>, from: number, to: number): boolean {
  const C = Math.min(t.cols.length, TABLE_LIMITS.cols);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= C || to < 0 || to >= C)
    return false;
  if (from === to) return false;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let c = lo; c <= hi; c++) if (crossesColBoundary(t, c)) return false;
  return true;
}

export function moveCol(o: ShapeObject, from: number, to: number): ShapeObject {
  const t = tableOf(o);
  if (!t || !canMoveCol(t, from, to)) return o;
  const g = decodeGrid(t);
  const mapCol = (c: number): number => {
    if (c === from) return to;
    if (from < to) return c > from && c <= to ? c - 1 : c;
    return c >= to && c < from ? c + 1 : c;
  };
  const cells = g.cells.map((c) => ({ ...c, col: mapCol(c.col) }));
  const h = new Int16Array((g.R + 1) * g.C).fill(-1);
  for (let k = 0; k <= g.R; k++) {
    for (let c = 0; c < g.C; c++) {
      h[k * g.C + mapCol(c)] = g.h[k * g.C + c]!;
    }
  }
  const cols = t.cols.slice(0, g.C);
  const [movedW] = cols.splice(from, 1);
  cols.splice(to, 0, movedW!);
  return { ...o, table: gcTable({ ...encodeGrid({ ...g, cells, h }, t), cols }) };
}

// ── Header row & Alternating row bands ─────────────────────────────────────────────────────────────────

/** Detect whether row 0 is currently styled as a header row (distinct fill or bold weight). */
export function hasHeaderRow(t: TableData): boolean {
  const p = placeCells(t);
  if (!p.R || !p.C) return false;
  const row0 = cellsInRange(t, { r0: 0, c0: 0, r1: 0, c1: p.C - 1 });
  if (!row0.length) return false;
  const allBold = row0.every((i) => {
    const st = cellStyleEntry(t, t.cells[i]);
    return (st?.fontWeight ?? t.base.fontWeight ?? 400) >= 600;
  });
  if (allBold) return true;
  if (p.R < 2) return false;
  const f0 = t.cells[row0[0]!]?.fill;
  const row1 = cellsInRange(t, { r0: 1, c0: 0, r1: 1, c1: p.C - 1 });
  const f1 = row1.length ? t.cells[row1[0]!]?.fill : undefined;
  if (f0 === undefined || f0 === f1) return false;
  if (p.R >= 3) {
    const row2 = cellsInRange(t, { r0: 2, c0: 0, r1: 2, c1: p.C - 1 });
    const f2 = row2.length ? t.cells[row2[0]!]?.fill : undefined;
    if (f0 === f2) return false;
  }
  return row0.every((i) => t.cells[i]?.fill === f0);
}

/** Detect whether body rows have alternating row band fills. */
export function hasBandedRows(t: TableData): boolean {
  const p = placeCells(t);
  const startRow = hasHeaderRow(t) ? 1 : 0;
  if (p.R - startRow < 2) return false;
  const firstFillOf = (r: number) => {
    const k = p.slots[r * p.C]!;
    return k >= 0 ? t.cells[k]?.fill : undefined;
  };
  const a = firstFillOf(startRow);
  const b = firstFillOf(startRow + 1);
  if (a === b) return false;
  for (let r = startRow; r < p.R; r++) {
    const want = (r - startRow) % 2 === 0 ? a : b;
    if (firstFillOf(r) !== want) return false;
  }
  return true;
}

/** Toggle header row styling (bold + accent header fill) on row 0. */
export function toggleHeaderRow(o: ShapeObject, on: boolean): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const p = placeCells(t);
  if (!p.R || !p.C) return o;
  const wasBanded = hasBandedRows(t);
  const row0 = cellsInRange(t, { r0: 0, c0: 0, r1: 0, c1: p.C - 1 });
  let cur = setCellsStyle(o, row0, (s) => ({ ...s, fontWeight: on ? 700 : 400 }));
  cur = setCellsPaint(cur, row0, on ? HEADER_FILL : null);
  if (wasBanded) cur = toggleBandedRows(cur, true);
  return cur;
}

/** Toggle alternating row bands across body rows (preserving header row when active). */
export function toggleBandedRows(o: ShapeObject, on: boolean): ShapeObject {
  const t = tableOf(o);
  if (!t) return o;
  const p = placeCells(t);
  const startRow = hasHeaderRow(t) ? 1 : 0;
  if (startRow >= p.R) return o;
  let cur = o;
  for (let r = startRow; r < p.R; r++) {
    const rowCells = cellsInRange(cur.table!, { r0: r, c0: 0, r1: r, c1: p.C - 1 });
    const fill = on ? ((r - startRow) % 2 === 0 ? BAND_EVEN_FILL : BAND_ODD_FILL) : null;
    cur = setCellsPaint(cur, rowCells, fill);
  }
  return cur;
}

// ── Spreadsheet TSV / HTML Table Clipboard Paste ──────────────────────────────────────────────────────

/**
 * Parse multi-cell tabular clipboard data from Google Sheets, Excel, or HTML `<table>`.
 * Returns `null` for plain single-cell text (no `<table>` and no tabs), so ordinary text paste is unaffected.
 */
export function parseTableClipboard(html: string, plain: string): string[][] | null {
  if (html && /<table[\s>]/i.test(html) && typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const table = doc.querySelector('table');
      if (table) {
        const rows: string[][] = [];
        for (const tr of Array.from(table.querySelectorAll('tr'))) {
          const cells = Array.from(tr.querySelectorAll('th, td')).map((el) =>
            (el.textContent ?? '').replace(/\r\n?/g, '\n').trim(),
          );
          if (cells.length) rows.push(cells);
        }
        if (rows.length > 1 || (rows.length === 1 && rows[0]!.length > 1)) return rows;
      }
    } catch {
      // Fall back to plain TSV parsing below.
    }
  }
  if (!plain?.includes('\t')) return null;
  const lines = plain.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const rows = lines.map((line) => line.split('\t'));
  if (rows.length === 0) return null;
  const maxCols = Math.max(...rows.map((r) => r.length));
  if (rows.length === 1 && maxCols <= 1) return null;
  return rows;
}

/**
 * Paste a 2D string matrix into table `o` starting at `startCell`, auto-appending rows/columns (within
 * `TABLE_LIMITS`) if the pasted matrix extends past the current grid.
 */
export function pasteMatrixIntoTable(
  o: ShapeObject,
  startCell: number,
  matrix: readonly (readonly string[])[],
): { object: ShapeObject; range: TableRange; rowsAdded: number; colsAdded: number } | null {
  const t0 = tableOf(o);
  if (!t0 || !matrix.length) return null;
  const p0 = placeCells(t0);
  const start = p0.anchors[startCell] ?? { row: 0, col: 0, rows: 1, cols: 1 };
  const matRows = matrix.length;
  const matCols = Math.max(...matrix.map((r) => r.length));
  if (matCols <= 0) return null;

  let cur = o;
  let rowsAdded = 0;
  let colsAdded = 0;

  // Auto-append rows if needed (within TABLE_LIMITS).
  const needR = Math.min(TABLE_LIMITS.rows, start.row + matRows);
  while (cur.table && cur.table.rows.length < needR) {
    const R = cur.table.rows.length;
    const next = insertRow(cur, R, R - 1);
    if (next === cur) break;
    cur = next;
    rowsAdded++;
  }

  // Auto-append columns if needed (within TABLE_LIMITS).
  const needC = Math.min(TABLE_LIMITS.cols, start.col + matCols);
  while (cur.table && cur.table.cols.length < needC) {
    const C = cur.table.cols.length;
    const next = insertCol(cur, C, C - 1);
    if (next === cur) break;
    cur = next;
    colsAdded++;
  }

  const p = placeCells(cur.table!);
  const endRow = Math.min(p.R - 1, start.row + matRows - 1);
  const endCol = Math.min(p.C - 1, start.col + matCols - 1);
  const seen = new Set<number>();

  for (let dr = 0; dr <= endRow - start.row; dr++) {
    const rowData = matrix[dr];
    if (!rowData) continue;
    for (let dc = 0; dc <= endCol - start.col; dc++) {
      if (dc >= rowData.length) continue;
      const cellIdx = p.slots[(start.row + dr) * p.C + (start.col + dc)]!;
      if (cellIdx < 0 || seen.has(cellIdx)) continue;
      seen.add(cellIdx);
      const view = cellTextObject(cur, cellIdx);
      if (!view) continue;
      const nextText = (rowData[dc] ?? '').slice(0, TABLE_LIMITS.cellText);
      cur = setCell(cur, cellIdx, { text: nextText, style: view.style });
    }
  }

  return {
    object: cur,
    range: normalizeRange(cur.table!, { r0: start.row, c0: start.col, r1: endRow, c1: endCol }),
    rowsAdded,
    colsAdded,
  };
}

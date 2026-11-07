/**
 * Tables (design/27 §15 M6 "Tables", §11 "Mapping"; design/20 "Tables"): an `a:tbl` in a `p:graphicFrame`
 * becomes one editable `TextObject` per cell over locked grid shapes, all in one group.
 *
 * Reading (`readTable`):
 * - **Grid.** Column widths from `a:tblGrid`, rows from `a:tr h`. One `a:tc` per grid column; `gridSpan`
 *   and `rowSpan` merge, the cells they cover (`hMerge`, `vMerge`) are not drawn. Spans are cut at the
 *   grid. A table of more than `MAX_TABLE_CELLS` drawn cells (a merge once) stays residual (LibreOffice
 *   draws it into the art), and so does one with vertical cell text (until M8, as other vertical text);
 *   one of more than `MAX_TABLE_GRID` grid cells is not read.
 * - **Style.** `a:tableStyleId` names a style of `ppt/tableStyles.xml`, else one of PowerPoint's built-in
 *   styles (`tablestyles.ts`, LibreOffice's table); `a:tblPr/a:tableStyle` is an inline one. Its parts apply
 *   to a cell in `CT_TableStyle` order, a later part overriding what an earlier one set: whole table, row
 *   bands (`bandRow`: band1H for the first body row, then alternating; not the first or last row when those
 *   are on), column bands (`bandCol`, likewise), last column, first column, last row, first row (each when
 *   its `a:tblPr` flag is on), then the corner cells. A part's fill (`a:fill`, `a:fillRef`) colours the
 *   cell; its text style (`a:tcTxStyle`: `b`, `i`, a colour, `a:font` or `a:fontRef` typefaces) sits in the
 *   cell text's chain after the cell's own list style and before the presentation's `defaultTextStyle`.
 * - **Lines.** Each part's lines apply to the edges of its region (`left`, `right`, `top`, `bottom`: the
 *   region's outline; `insideH`, `insideV`: the edges inside it); the whole table's outline is the table's.
 *   A cell's own `a:lnL`/`a:lnR`/`a:lnT`/`a:lnB` override them property by property (width, fill, dash, as
 *   LibreOffice merges them). Where two cells give a shared edge different lines the wider wins, the upper
 *   or left one on a tie, and a line beats none (LibreOffice's `TableLayouter` rule). Edges inside a merge
 *   have no line. Diagonal lines (`a:lnTlToBr`, `a:lnBlToTr`, `tl2br`, `tr2bl`) are not drawn (noted;
 *   the table is approx).
 * - **Cells.** The fill is the style's, else the cell's own (`a:tcPr` fill, `a:noFill` included); the
 *   table's own fill (`a:tblPr`), else the style's `a:tblBg`, is behind every cell. Text through the usual
 *   chain (`text.ts`), with the cell's margins as insets (`marL`, `marR` 91,440 and `marT`, `marB` 45,720
 *   EMU by default), its `anchor`, wrapped, and shrinking to fit when the drawing finds it overflows.
 * - **Rows grow** (design/27 §15 M6): a row is as tall as its stored `h` or as its tallest cell's text plus
 *   the cell's margins, as LibreOffice and PowerPoint draw it, whichever is more; a merge's extra height
 *   goes to its last row, and an empty cell is one line of its end mark. Text is measured in the office
 *   line model (design/27 §6 step 7) with the advances and pair kerning of the faces the fonts would draw
 *   it with (`ParseOptions.fontFace`: the run's family, its metric substitute, the script fallbacks, ordo's
 *   default face), breaking as the renderer does (`Measure`). A family with no face is measured with
 *   conservative estimated widths (noted). For the fidelity harness's LibreOffice policy the rows are also
 *   sized as LibreOffice 24.2 sizes them (`TableElement.lo`, `LoLines`, `loSizePt`).
 *
 * Emission (`emitTable`): locked `ShapeObject`s with role 'grid' (the background as one rect; the cell
 * fills, neighbouring cells of a row with the same fill as one rect, one object per fill; the lines, joined
 * while they look the same and each stretched over the lines it meets so corners close, one object per look,
 * by direction too when there are several: `gridObjects`), then each cell as a `TextObject` with role
 * 'cell' (an empty cell as an empty one, to type into). All of them share the table's `origin.group`. The
 * fills and lines are geometries of sub-paths (`ShapeGeom.paths`: a fill's rects, a look's open lines,
 * stroked with flat caps as separate line objects were), so a chart table of 60 cells costs the slide's
 * object budget its cells and a few grid objects, not one per run. Fills are solid (a gradient's first
 * stop), lines solid (dashes noted). An older build, which strips `geom`, draws a fill's object as the
 * bounding box of its runs and a line look as the table's outline in that line, the cells' text over them.
 * With `TableEmitCtx.lo` (the harness only) the rows, the cells' sizes and the text's placement are
 * LibreOffice's (`TableElement.lo`).
 *
 * Bounded: at most `MAX_TABLE_GRID` grid cells are read and `MAX_TABLE_CELLS` cells measured,
 * `MAX_GRID_SCAN` children of the grid and the table are looked at, `MAX_STYLE_SCAN` styles of
 * `ppt/tableStyles.xml`; deck strings only reach notes cleaned.
 */
import type { Rgba as OrdoRgba, ShapeGeom, ShapeObject, SlideObject, TextObject } from '@ordo/domain';
import { DEFAULT_FONT } from '@ordo/domain/defaults.ts';
import { GEOM_LIMITS } from '@ordo/renderer/geom/ops.ts';
import { type ColorCtx, colorIn, readFill, styleFill } from './color.ts';
import type { SlideCtx } from './context.ts';
import { scriptClasses, scriptFallbacks, substituteOf } from './fontmap.ts';
import { apply, boxPx, lenPx, multiply, ptPx } from './frame.ts';
import { MAX_PATH_CHARS } from './geom.ts';
import type {
  Affine,
  ElementBase,
  Emu,
  Fill,
  Frame,
  Line,
  Para,
  ResidualElement,
  RunStyle,
  TableCell,
  TableElement,
  TableLine,
  TextBody,
} from './ir.ts';
import { clean, type Log } from './log.ts';
import type { FaceMetrics, FaceSource } from './metrics.ts';
import type { RichText } from './richtext.ts';
import { predefinedTableStyle } from './tablestyles.ts';
import { readTextBody } from './text.ts';
import { styleLine, typefaceName } from './theme.ts';
import { child, num, path, textOf, type XNode } from './xml.ts';

/**
 * Cells a table drawn natively may have (design/27 §15 M6), counted as drawn: a merge is one cell, the
 * cells it covers none. A table with more stays residual; the slide's object and text budgets
 * (`classify.ts` `fitTables`, the 64 KB of text) decide the rest.
 */
export const MAX_TABLE_CELLS = 60;
/**
 * Grid cells (rows × columns, covered ones included) a table is read with at most; a larger one stays
 * residual.
 */
export const MAX_TABLE_GRID = 4_096;
/** Children of `a:tblGrid` and of `a:tbl` (and of one `a:tr`) looked at. */
const MAX_GRID_SCAN = 1_000;
/** `a:tblStyle` elements of `ppt/tableStyles.xml` indexed. */
const MAX_STYLE_SCAN = 1_000;
/** A cell's default margins in EMU (`a:tcPr` marL, marR, marT, marB). */
export const CELL_MARGINS = { l: 91_440, r: 91_440, t: 45_720, b: 45_720 } as const;
/** A border line's width when its `a:ln` sets none: 1 pt. */
const DEFAULT_LINE = 12_700;
/** Bound of EMU lengths (a slide side, design/27 §12). */
const MAX_EMU = 51_206_400;
/** Single line spacing of the office line model: 1.2 × the font size. */
const SINGLE_LINE = 1.2;
/** Raised and lowered runs are drawn at this share of their size (design/27 §6 step 7). */
const SHIFTED_SIZE = 0.58;
/** Logical coordinates are bounded by the schema (`coord`). */
const MAX_COORD = 100_000;
/** EMU per 1/100 mm, LibreOffice's unit. */
const EMU_PER_MM100 = 360;
const mm100Emu = (v: number) => Math.round(v / EMU_PER_MM100);

const on = (v: string | undefined) => v === '1' || v === 'true';
const clamp = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : Math.min(hi, Math.max(lo, 0));
const emu = (v: string | undefined, dflt: number) => clamp(num(v) ?? dflt, 0, MAX_EMU);

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the walk knows when it reaches a table. */
export interface TableReadOptions {
  /**
   * A text shape that grows to its text (its own `a:spAutoFit`, with text) comes before the table on the
   * slide: LibreOffice then sizes the table's rows with font-independent line spacing (`LoLines`).
   */
  afterAutogrow?: boolean;
}

/** A cell as read, before its geometry is final. */
interface Anchor {
  row: number;
  col: number;
  rows: number;
  cols: number;
  tc: XNode | undefined;
}

/**
 * A table from its graphic frame: a `TableElement`, or a `ResidualElement` ('table') when it is too large
 * or holds what ordo does not draw. `place(cx, cy)` is the affine of a box of that size at the frame's
 * position (the walk's group mapping applied).
 */
export function readTable(
  ctx: SlideCtx,
  frame: XNode,
  base: ElementBase,
  place: (cx: number, cy: number) => Affine,
  opts: TableReadOptions = {},
): TableElement | ResidualElement {
  const residual = (why: string, reason = 'table'): ResidualElement => {
    ctx.log(why);
    return { ...base, kind: 'residual', what: 'table', support: 'residual', reasons: [reason] };
  };
  const tbl = path(frame, 'a:graphic', 'a:graphicData', 'a:tbl');
  if (!tbl) return residual('a table without its grid is drawn by LibreOffice');
  const cols: number[] = [];
  const grid = child(tbl, 'a:tblGrid')?.children ?? [];
  for (let i = 0; i < grid.length && i < MAX_GRID_SCAN; i++)
    if (grid[i]!.name === 'a:gridCol') cols.push(emu(grid[i]!.attrs.w, 0));
  const trs: XNode[] = [];
  for (let i = 0; i < tbl.children.length && i < MAX_GRID_SCAN; i++)
    if (tbl.children[i]!.name === 'a:tr') trs.push(tbl.children[i]!);
  const N = cols.length;
  const M = trs.length;
  if (!N || !M) return residual('a table without rows or columns is drawn by LibreOffice');
  if (N * M > MAX_TABLE_GRID)
    return residual(`a table of ${N * M} grid cells (more than ${MAX_TABLE_GRID}) is drawn by LibreOffice`);

  // Cells: one a:tc per grid column; a merge covers the cells its spans reach.
  const cover: (number | undefined)[][] = Array.from({ length: M }, () => new Array(N).fill(undefined));
  const anchors: Anchor[] = [];
  for (let r = 0; r < M; r++) {
    let c = 0;
    const tcs = trs[r]!.children;
    for (let i = 0; i < tcs.length && i < MAX_GRID_SCAN && c < N; i++) {
      const tc = tcs[i]!;
      if (tc.name !== 'a:tc') continue;
      const col = c++;
      if (on(tc.attrs.hMerge) || on(tc.attrs.vMerge) || cover[r]![col] !== undefined) continue;
      const cs = clamp(Math.floor(num(tc.attrs.gridSpan) ?? 1), 1, N - col);
      const rs = clamp(Math.floor(num(tc.attrs.rowSpan) ?? 1), 1, M - r);
      const k = anchors.length;
      anchors.push({ row: r, col, rows: rs, cols: cs, tc });
      for (let y = r; y < r + rs; y++) for (let x = col; x < col + cs; x++) cover[y]![x] ??= k;
    }
  }
  // Grid cells no a:tc names (a short row) are empty cells of their own.
  for (let r = 0; r < M; r++)
    for (let c = 0; c < N; c++)
      if (cover[r]![c] === undefined) {
        cover[r]![c] = anchors.length;
        anchors.push({ row: r, col: c, rows: 1, cols: 1, tc: undefined });
      }
  if (anchors.length > MAX_TABLE_CELLS)
    return residual(
      `a table of ${anchors.length} cells (more than ${MAX_TABLE_CELLS}) is drawn by LibreOffice`,
    );

  const tcPrOf = (a: Anchor) => child(a.tc, 'a:tcPr');
  for (const a of anchors) {
    const vert = tcPrOf(a)?.attrs.vert;
    if (vert !== undefined && vert !== 'horz')
      return residual('a table with vertical cell text is drawn by LibreOffice (M8)', 'vert');
  }

  const tblPr = child(tbl, 'a:tblPr');
  const flags = {
    firstRow: on(tblPr?.attrs.firstRow),
    lastRow: on(tblPr?.attrs.lastRow),
    firstCol: on(tblPr?.attrs.firstCol),
    lastCol: on(tblPr?.attrs.lastCol),
    bandRow: on(tblPr?.attrs.bandRow),
    bandCol: on(tblPr?.attrs.bandCol),
  };
  const style = tableStyleOf(ctx, tblPr);
  const part = (name: string) => child(style, `a:${name}`);
  const parts = (a: Anchor) => partsOf(a, M, N, flags).map(part);

  // Lines: the style's parts by region, then the cells' own.
  const lines = new EdgeLines(M, N);
  let diagonal = false;
  const regions = partRegions(M, N, flags);
  for (const [name, r0, r1, c0, c1] of regions) {
    const p = part(name);
    const bdr = path(p, 'a:tcStyle', 'a:tcBdr');
    if (!bdr) continue;
    for (const side of bdr.children) {
      const s = strokeOf(ctx, side);
      if (!s) continue;
      const kind = side.name.slice(2);
      if (kind === 'tl2br' || kind === 'tr2bl') diagonal ||= visible(s);
      else lines.region(kind, s, r0, r1, c0, c1);
    }
  }
  for (const a of anchors) {
    const pr = tcPrOf(a);
    if (!pr) continue;
    for (const [name, side] of [
      ['a:lnL', 'left'],
      ['a:lnR', 'right'],
      ['a:lnT', 'top'],
      ['a:lnB', 'bottom'],
    ] as const) {
      const ln = child(pr, name);
      if (ln) lines.cell(a, side, readStroke(ln, ctx.color));
    }
    for (const d of ['a:lnTlToBr', 'a:lnBlToTr']) {
      const ln = child(pr, d);
      if (ln) diagonal ||= visible(readStroke(ln, ctx.color));
    }
  }
  const tableLines = lines.resolve(cover);
  if (diagonal) ctx.log('diagonal lines of table cells are not drawn');

  // Fills and text.
  const background = readFill(tblPr, ctx.color) ?? styleBackground(ctx, child(style, 'a:tblBg'));
  const measure = new Measure(ctx.frame, ctx.fontFace);
  const cells: TableCell[] = [];
  for (const a of anchors) {
    const ps = parts(a);
    let fill: Fill | undefined;
    for (const p of ps) fill = partFill(ctx, p) ?? fill;
    const pr = tcPrOf(a);
    fill = readFill(pr, ctx.color) ?? fill;
    if (fill?.kind === 'picture' || fill?.kind === 'group') {
      ctx.log('a table cell filled with a picture is drawn without it');
      fill = { kind: 'none' };
    }
    cells.push({
      row: a.row,
      col: a.col,
      rows: a.rows,
      cols: a.cols,
      fill: fill ?? { kind: 'none' },
      text: cellText(ctx, base, a.tc, pr, textStyleOf(ctx, ps)),
    });
  }

  // Rows grow to their text: LibreOffice's way first (`loRows`, with the deck's own line spacing), then
  // ordo's, the lines spaced by their font's line height as LibreOffice draws them and PowerPoint sizes
  // rows. An empty cell is one line of its end mark.
  const stored = trs.map((tr) => emu(tr.attrs.h, 0));
  const widthOf = (c: TableCell) => {
    let w = 0;
    for (let x = c.col; x < c.col + c.cols; x++) w += cols[x]!;
    return w;
  };
  const textWidth = (c: TableCell) =>
    lenPx(ctx.frame, Math.max(0, widthOf(c) - c.text.insets.l - c.text.insets.r));
  const loLines: LoLines = opts.afterAutogrow ? 'independent' : 'font';
  const lo = cells.map((c) => measure.loLayout(c.text, textWidth(c), loLines));
  // LibreOffice's row: the text and its extra 1/100 mm (`Cell::getMinimumHeight`), then the margins.
  const loTall = lo.map(
    (l, i) =>
      (l.height + 1 + mm100Emu(cells[i]!.text.insets.t) + mm100Emu(cells[i]!.text.insets.b)) * EMU_PER_MM100,
  );
  for (const c of cells) measure.spaceByFont(c.text);
  const drawn = cells.map((c) => measure.layout(c.text, textWidth(c)));
  const withInsets = (b: Block, i: number) =>
    b.height / ctx.frame.s + cells[i]!.text.insets.t + cells[i]!.text.insets.b;
  const tall = drawn.map(withInsets);
  // As the harness's LibreOffice policy draws the cells: at LibreOffice's sizes (`loSizePt`).
  const loDrawn = cells.map((c) => measure.layout(c.text, textWidth(c), loSizePt));
  const loTallDrawn = loDrawn.map(withInsets);
  const rows = growRows(stored, cells, tall);
  const loRows = growRows(stored, cells, loTall);
  if (measure.missing.size)
    ctx.log(
      `table text measured with estimated widths (no font for ${[...measure.missing]
        .slice(0, 3)
        .map((f) => clean(f, 60))
        .join(', ')})`,
    );

  const W = cols.reduce((s, w) => s + w, 0);
  const H = rows.reduce((s, h) => s + h, 0);
  const loH = loRows.reduce((s, h) => s + h, 0);
  // Where LibreOffice's row is shorter than the text as drawn, the text runs into the cell's margins; and
  // its lines sit at the face's ascent, where ordo's office model puts them a size below the line's top.
  const spill = cells.map((c, i) => {
    let h = 0;
    for (let y = c.row; y < c.row + c.rows; y++) h += loRows[y]!;
    return Math.max(0, Math.round(loTallDrawn[i]! - h));
  });
  const lift = cells.map((c, i) => {
    const ours = loDrawn[i]!;
    const theirs = lo[i]!.drawn;
    const n = Math.min(ours.baselines.length, theirs.baselines.length);
    if (!n) return 0;
    const at = (h: number) => (c.text.anchor === 'top' ? 0 : c.text.anchor === 'bottom' ? h : h / 2);
    let d = 0;
    for (let k = 0; k < n; k++)
      d +=
        (ours.baselines[k]! - at(ours.height)) / ctx.frame.s -
        (theirs.baselines[k]! - at(theirs.height)) * EMU_PER_MM100;
    return Math.round(d / n);
  });
  const gridded = gridObjects(cells, tableLines);
  const objects =
    (background && paints(background) ? 1 : 0) + gridded.fills.length + gridded.lines.length + cells.length;
  return {
    ...base,
    kind: 'table',
    xf: place(W, H),
    cols,
    rows,
    ...(background && paints(background) ? { background } : {}),
    cells,
    lines: tableLines,
    objects,
    ...(diagonal ? { support: 'approx' as const, reasons: ['tableDiagonal'] } : {}),
    ...(loRows.some((h, r) => h !== rows[r]) ||
    spill.some((v) => v > 0) ||
    lift.some((v) => v !== 0) ||
    cells.some((c) =>
      c.text.paras.some((p) => p.runs.some((r) => loSizePt(r.style.sizePt) !== r.style.sizePt)),
    )
      ? { lo: { rows: loRows, xf: place(W, loH), spill, lift, lines: loLines } }
      : {}),
  };
}

/**
 * Row heights from the stored ones (`a:tr h`) and each cell's need (`tall`, EMU, margins included): a row
 * is as tall as its tallest single-row cell; a merge's extra height goes to its last row.
 */
function growRows(stored: readonly Emu[], cells: readonly TableCell[], tall: readonly number[]): Emu[] {
  const rows = [...stored];
  cells.forEach((c, i) => {
    if (c.rows === 1) rows[c.row] = Math.max(rows[c.row]!, tall[i]!);
  });
  cells.forEach((c, i) => {
    if (c.rows === 1) return;
    let h = 0;
    for (let y = c.row; y < c.row + c.rows; y++) h += rows[y]!;
    if (tall[i]! > h) rows[c.row + c.rows - 1]! += tall[i]! - h;
  });
  return rows.map((h) => clamp(h, 0, MAX_EMU));
}

/** Whether a fill paints anything (picture and group fills of cells are left out when read). */
function paints(f: Fill): boolean {
  return f.kind === 'solid' || f.kind === 'gradient' || f.kind === 'pattern';
}

/** A rect of cells of one fill (`fillRuns`). */
export interface FillRun {
  row: number;
  col: number;
  rows: number;
  cols: number;
  fill: Fill;
}

/** The cells' fills as rects: neighbours of a row with the same fill join; merges keep their own. */
export function fillRuns(cells: readonly TableCell[]): FillRun[] {
  const out: FillRun[] = [];
  let key = '';
  for (const c of cells) {
    if (!paints(c.fill)) {
      key = '';
      continue;
    }
    const k = JSON.stringify(c.fill);
    const last = out[out.length - 1];
    if (
      last &&
      c.rows === 1 &&
      last.rows === 1 &&
      last.row === c.row &&
      last.col + last.cols === c.col &&
      k === key
    )
      last.cols += c.cols;
    else out.push({ row: c.row, col: c.col, rows: c.rows, cols: c.cols, fill: c.fill });
    key = k;
  }
  return out;
}

// ── Grid objects ────────────────────────────────────────────────────────────────────────────────────────

/** Largest grid coordinate written (box-space px): far past any slide, so a sub-path stays within its bound. */
const GRID_COORD = 999_999;
/** Characters a written grid coordinate takes at most: a sign, six digits, the point and three decimals. */
const GRID_COORD_CHARS = 11;

/** A grid coordinate as written: at most three decimals, within ±`GRID_COORD`, never `-0`. */
function gridNum(v: number): string {
  const r = Number((Number.isFinite(v) ? Math.min(GRID_COORD, Math.max(-GRID_COORD, v)) : 0).toFixed(3)) + 0;
  return String(r);
}
/**
 * Sub-paths one stored path holds, so it stays within `ShapeGeom`'s 4,096 points and 40,000 characters
 * whatever its coordinates: a line (`M x y L x y`, and the space before the next) is 2 points and at most
 * 8 + 4 coordinates' characters, a rect (`M x y L x y L x y L x y Z`) 5 points and 18 + 8.
 */
export const GRID_LINES_PER_PATH = Math.min(
  Math.floor(GEOM_LIMITS.points / 2),
  Math.floor(MAX_PATH_CHARS / (8 + 4 * GRID_COORD_CHARS)),
);
export const GRID_RECTS_PER_PATH = Math.min(
  Math.floor(GEOM_LIMITS.points / 5),
  Math.floor(MAX_PATH_CHARS / (18 + 8 * GRID_COORD_CHARS)),
);

/**
 * One grid object of a table: the runs it draws, as its stored paths (`ShapeGeom.paths`, at most
 * `GEOM_LIMITS.paths`), each holding sub-paths of runs; `cont` marks a path that goes on with the one
 * before it (one path cut in pieces, drawn as the one it was cut from).
 */
export interface GridObject<T> {
  paths: { runs: T[]; cont: boolean }[];
}

/**
 * Layers of runs as grid objects: each layer is one path chain cut every `per` runs, objects hold at most
 * `GEOM_LIMITS.paths` paths and a chain past that goes on in the next object (its first piece then starts
 * the object's chain).
 */
function packGrid<T>(layers: readonly T[][], per: number): GridObject<T>[] {
  const out: GridObject<T>[] = [];
  let cur: GridObject<T> | undefined;
  for (const layer of layers)
    for (let i = 0; i < layer.length; i += per) {
      if (!cur || cur.paths.length >= GEOM_LIMITS.paths) out.push((cur = { paths: [] }));
      cur.paths.push({ runs: layer.slice(i, i + per), cont: i > 0 && cur.paths.length > 0 });
    }
  return out;
}

/**
 * A table's locked grid objects (M6 fidelity round 2, `emitTable`; `readTable` counts them for the slide's
 * object budget):
 * - **Fills**: the cells' fill runs (`fillRuns`) of one fill as one object of rect sub-paths, filled
 *   together (one even-odd fill: runs of one fill that overlap, as spans of a malformed table can, go in a
 *   path of their own so neither cuts the other out). Ordered by the area of the runs' bounding box (in
 *   grid cells), largest first: an older build draws each as that box, the smaller ones over it.
 * - **Lines**: the line runs of one look (width, fill and dash) as one object of open sub-paths, stroked
 *   together; when the table's lines have more than one look, also by direction, horizontal ones first, so
 *   every vertical line is still drawn over the horizontal ones it crosses, as when each run was an object
 *   of its own. Ordered as their first run comes.
 * Each object holds at most `GEOM_LIMITS.paths` paths of `GRID_RECTS_PER_PATH` rects or
 * `GRID_LINES_PER_PATH` lines; a group past that goes on in another object.
 */
export function gridObjects(
  cells: readonly TableCell[],
  lines: readonly TableLine[],
): { fills: (GridObject<FillRun> & { fill: Fill })[]; lines: (GridObject<TableLine> & { line: Line })[] } {
  const fillGroups = new Map<string, { fill: Fill; layers: FillRun[][]; box: number[] }>();
  for (const run of fillRuns(cells)) {
    const k = JSON.stringify(run.fill);
    let g = fillGroups.get(k);
    if (!g)
      fillGroups.set(k, (g = { fill: run.fill, layers: [], box: [run.row, run.col, run.row, run.col] }));
    const b = g.box;
    b[0] = Math.min(b[0]!, run.row);
    b[1] = Math.min(b[1]!, run.col);
    b[2] = Math.max(b[2]!, run.row + run.rows);
    b[3] = Math.max(b[3]!, run.col + run.cols);
    const apart = (o: FillRun) =>
      o.row >= run.row + run.rows ||
      run.row >= o.row + o.rows ||
      o.col >= run.col + run.cols ||
      run.col >= o.col + o.cols;
    let layer = g.layers.find((l) => l.every(apart));
    if (!layer) g.layers.push((layer = []));
    layer.push(run);
  }
  const area = (b: number[]) => (b[2]! - b[0]!) * (b[3]! - b[1]!);
  const fills = [...fillGroups.values()]
    .sort((p, q) => area(q.box) - area(p.box))
    .flatMap((g) => packGrid(g.layers, GRID_RECTS_PER_PATH).map((o) => ({ ...o, fill: g.fill })));

  const looks = new Set(lines.map((l) => JSON.stringify(l.line)));
  const byDir = looks.size > 1;
  const lineGroups = new Map<string, { line: Line; runs: TableLine[] }>();
  for (const l of lines) {
    const k = `${byDir ? l.dir : ''}${JSON.stringify(l.line)}`;
    let g = lineGroups.get(k);
    if (!g) lineGroups.set(k, (g = { line: l.line, runs: [] }));
    g.runs.push(l);
  }
  // Horizontal runs come first in `lines` (`EdgeLines.resolve`), so by direction the horizontal groups do.
  const lineObjects = [...lineGroups.values()].flatMap((g) =>
    packGrid([g.runs], GRID_LINES_PER_PATH).map((o) => ({ ...o, line: g.line })),
  );
  return { fills, lines: lineObjects };
}

// ── Styles ──────────────────────────────────────────────────────────────────────────────────────────────

/** The `a:tblStyle` elements of a `ppt/tableStyles.xml` by id (upper case), indexed once per deck. */
const styleLists = new WeakMap<XNode, Map<string, XNode>>();

/** The table's style: inline, else by id from the deck's style list, else a built-in one. */
function tableStyleOf(ctx: SlideCtx, tblPr: XNode | undefined): XNode | undefined {
  const inline = child(tblPr, 'a:tableStyle');
  if (inline) return inline;
  const id = textOf(child(tblPr, 'a:tableStyleId')).trim().slice(0, 64).toUpperCase();
  if (!id) return undefined;
  return deckStyles(ctx)?.get(id) ?? predefinedTableStyle(id);
}

function deckStyles(ctx: SlideCtx): Map<string, XNode> | undefined {
  const rel = ctx.pkg.relOfType(ctx.deck.presentationPart, 'tableStyles');
  if (!rel || rel.external) return undefined;
  let root: XNode | undefined;
  try {
    root = ctx.pkg.xml(rel.target);
  } catch {
    return undefined; // a style list that cannot be read is no list: built-in styles still apply
  }
  if (!root) return undefined;
  let byId = styleLists.get(root);
  if (byId) return byId;
  byId = new Map();
  const list = root.children;
  for (let i = 0; i < list.length && i < MAX_STYLE_SCAN; i++) {
    const s = list[i]!;
    const id = s.name === 'a:tblStyle' ? s.attrs.styleId?.trim().slice(0, 64).toUpperCase() : undefined;
    if (id && !byId.has(id)) byId.set(id, s);
  }
  styleLists.set(root, byId);
  return byId;
}

type Flags = Record<'firstRow' | 'lastRow' | 'firstCol' | 'lastCol' | 'bandRow' | 'bandCol', boolean>;

/** The style parts of a cell in the order they apply (`CT_TableStyle` order: later ones override). */
function partsOf(a: Anchor, M: number, N: number, f: Flags): string[] {
  const top = a.row === 0;
  const bottom = a.row + a.rows === M;
  const left = a.col === 0;
  const right = a.col + a.cols === N;
  const headRow = (f.firstRow && top) || (f.lastRow && bottom);
  const headCol = (f.firstCol && left) || (f.lastCol && right);
  const out = ['wholeTbl'];
  if (f.bandRow && !headRow) out.push((a.row - (f.firstRow ? 1 : 0)) % 2 === 0 ? 'band1H' : 'band2H');
  if (f.bandCol && !headRow && !headCol)
    out.push((a.col - (f.firstCol ? 1 : 0)) % 2 === 0 ? 'band1V' : 'band2V');
  if (f.lastCol && right) out.push('lastCol');
  if (f.firstCol && left) out.push('firstCol');
  if (f.lastRow && bottom) out.push('lastRow');
  if (f.firstRow && top) out.push('firstRow');
  if (f.lastRow && f.lastCol && bottom && right) out.push('seCell');
  if (f.lastRow && f.firstCol && bottom && left) out.push('swCell');
  if (f.firstRow && f.lastCol && top && right) out.push('neCell');
  if (f.firstRow && f.firstCol && top && left) out.push('nwCell');
  return out;
}

/** Each part's region [row0, row1) × [col0, col1), in the order the parts apply. */
function partRegions(M: number, N: number, f: Flags): [string, number, number, number, number][] {
  const out: [string, number, number, number, number][] = [['wholeTbl', 0, M, 0, N]];
  const r0 = f.firstRow ? 1 : 0;
  const r1 = M - (f.lastRow ? 1 : 0);
  const c0 = f.firstCol ? 1 : 0;
  const c1 = N - (f.lastCol ? 1 : 0);
  if (f.bandRow) for (let r = r0; r < r1; r++) out.push([(r - r0) % 2 ? 'band2H' : 'band1H', r, r + 1, 0, N]);
  if (f.bandCol)
    for (let c = c0; c < c1; c++) out.push([(c - c0) % 2 ? 'band2V' : 'band1V', r0, r1, c, c + 1]);
  if (f.lastCol) out.push(['lastCol', 0, M, N - 1, N]);
  if (f.firstCol) out.push(['firstCol', 0, M, 0, 1]);
  if (f.lastRow) out.push(['lastRow', M - 1, M, 0, N]);
  if (f.firstRow) out.push(['firstRow', 0, 1, 0, N]);
  if (f.lastRow && f.lastCol) out.push(['seCell', M - 1, M, N - 1, N]);
  if (f.lastRow && f.firstCol) out.push(['swCell', M - 1, M, 0, 1]);
  if (f.firstRow && f.lastCol) out.push(['neCell', 0, 1, N - 1, N]);
  if (f.firstRow && f.firstCol) out.push(['nwCell', 0, 1, 0, 1]);
  return out;
}

/** A part's cell fill: `a:tcStyle/a:fill`, else its `a:fillRef` into the theme; undefined when it sets none. */
function partFill(ctx: SlideCtx, p: XNode | undefined): Fill | undefined {
  const st = child(p, 'a:tcStyle');
  if (!st) return undefined;
  const fill = child(st, 'a:fill');
  if (fill) return readFill(fill, ctx.color);
  const ref = child(st, 'a:fillRef');
  return ref ? styleFill(ctx.theme, ref, ctx.color) : undefined;
}

function styleBackground(ctx: SlideCtx, bg: XNode | undefined): Fill | undefined {
  const fill = child(bg, 'a:fill');
  if (fill) return readFill(fill, ctx.color);
  const ref = child(bg, 'a:fillRef');
  return ref ? styleFill(ctx.theme, ref, ctx.color) : undefined;
}

/**
 * The cell's text style from its parts (`a:tcTxStyle`), as an `a:pPr` whose `a:defRPr` the text chain reads
 * (`readTextBody`'s `styled`): bold, italic, colour and typefaces, each from the last part that sets it.
 */
function textStyleOf(ctx: SlideCtx, parts: (XNode | undefined)[]): XNode | undefined {
  let bold: boolean | undefined;
  let italic: boolean | undefined;
  let color: OrdoRgba | undefined;
  const faces: Partial<Record<'latin' | 'ea' | 'cs', string>> = {};
  for (const p of parts) {
    const tx = child(p, 'a:tcTxStyle');
    if (!tx) continue;
    if (tx.attrs.b === 'on') bold = true;
    else if (tx.attrs.b === 'off') bold = false;
    if (tx.attrs.i === 'on') italic = true;
    else if (tx.attrs.i === 'off') italic = false;
    const ref = child(tx, 'a:fontRef');
    color = colorIn(tx, ctx.color) ?? colorIn(ref, ctx.color) ?? color;
    const set = ref?.attrs.idx === 'major' ? 'mj' : ref?.attrs.idx === 'minor' ? 'mn' : undefined;
    if (set) {
      faces.latin = `+${set}-lt`;
      faces.ea = `+${set}-ea`;
      faces.cs = `+${set}-cs`;
    }
    const font = child(tx, 'a:font');
    for (const k of ['latin', 'ea', 'cs'] as const) {
      const t = typefaceName(child(font, `a:${k}`)?.attrs.typeface);
      if (t) faces[k] = t;
    }
  }
  const attrs: Record<string, string> = {};
  if (bold !== undefined) attrs.b = bold ? '1' : '0';
  if (italic !== undefined) attrs.i = italic ? '1' : '0';
  const kids: XNode[] = [];
  if (color) kids.push(el('a:solidFill', {}, [el('a:srgbClr', { val: hex(color) }, alphaOf(color))]));
  for (const k of ['latin', 'ea', 'cs'] as const)
    if (faces[k]) kids.push(el(`a:${k}`, { typeface: faces[k]! }));
  if (!kids.length && !Object.keys(attrs).length) return undefined;
  return el('a:pPr', {}, [el('a:defRPr', attrs, kids)]);
}

function el(name: string, attrs: Record<string, string>, children: XNode[] = []): XNode {
  return { name, attrs: Object.assign(Object.create(null), attrs), children, text: '' };
}

function hex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function alphaOf(c: { a: number }): XNode[] {
  return c.a < 1 ? [el('a:alpha', { val: String(Math.round(clamp(c.a, 0, 1) * 100_000)) })] : [];
}

const ANCHOR: Readonly<Record<string, TextBody['anchor']>> = Object.assign(Object.create(null), {
  t: 'top',
  ctr: 'middle',
  b: 'bottom',
  just: 'top',
  dist: 'top',
});

/** A cell's text body: the text chain with the style's text, the cell's margins and anchor, shrinking. */
function cellText(
  ctx: SlideCtx,
  base: ElementBase,
  tc: XNode | undefined,
  tcPr: XNode | undefined,
  styled: XNode | undefined,
): TextBody {
  const own = child(tc, 'a:txBody');
  // The cell's body as a shape's, so the text chain reads its list style and paragraphs.
  const txBody = el('p:txBody', {}, own?.children.length ? own.children : [el('a:p', {})]);
  const body = readTextBody(ctx, { own: el('p:sp', {}, [txBody]), from: base.from }, styled) ?? {
    paras: [],
    insets: { ...CELL_MARGINS },
    anchor: 'top',
    wrap: true,
    autofit: { kind: 'none' },
  };
  return {
    paras: body.paras,
    insets: {
      l: emu(tcPr?.attrs.marL, CELL_MARGINS.l),
      t: emu(tcPr?.attrs.marT, CELL_MARGINS.t),
      r: emu(tcPr?.attrs.marR, CELL_MARGINS.r),
      b: emu(tcPr?.attrs.marB, CELL_MARGINS.b),
    },
    anchor: ANCHOR[tcPr?.attrs.anchor ?? 't'] ?? 'top',
    wrap: true,
    autofit: { kind: 'shrink', fontScale: 1, lnSpcReduction: 0, own: true },
  };
}

// ── Lines ───────────────────────────────────────────────────────────────────────────────────────────────

/** A line as an `a:ln` sets it: only what it writes, merged property by property. */
interface Stroke {
  width?: number;
  fill?: Fill;
  dash?: string;
}

function readStroke(ln: XNode, color: ColorCtx): Stroke {
  const out: Stroke = {};
  if (ln.attrs.w !== undefined) out.width = emu(ln.attrs.w, DEFAULT_LINE);
  const fill = readFill(ln, color);
  if (fill) out.fill = fill;
  const dash = child(ln, 'a:prstDash')?.attrs.val;
  if (dash) out.dash = dash.slice(0, 20);
  return out;
}

/** A style part's line (`a:ln`, or `a:lnRef` into the theme's lines with its colour), or undefined. */
function strokeOf(ctx: SlideCtx, side: XNode): Stroke | undefined {
  const ln = child(side, 'a:ln');
  if (ln) return readStroke(ln, ctx.color);
  const ref = styleLine(ctx.theme, child(side, 'a:lnRef'), ctx.color);
  return ref ? readStroke(ref.ln, ref.ctx) : undefined;
}

const merge = (a: Stroke | undefined, b: Stroke | undefined): Stroke | undefined =>
  !b ? a : !a ? b : { ...a, ...b };

/** The line a stroke draws, or undefined when it draws none (no fill, `a:noFill`, zero width). */
function lineOf(s: Stroke | undefined): Line | undefined {
  if (!s?.fill || !paints(s.fill)) return undefined;
  const width = s.width ?? DEFAULT_LINE;
  if (!(width > 0)) return undefined;
  return { width, fill: s.fill, ...(s.dash && s.dash !== 'solid' ? { dash: s.dash } : {}) };
}

const visible = (s: Stroke) => lineOf(s) !== undefined;

/** The strokes of a grid's edges: `h[i][c]` along row edge i under column c, `v[j][r]` along column edge j. */
class EdgeLines {
  readonly h: (Stroke | undefined)[][];
  readonly v: (Stroke | undefined)[][];
  /** The cells' own strokes: `[upper or left cell's, lower or right cell's]` per edge. */
  readonly hc: [Stroke | undefined, Stroke | undefined][][];
  readonly vc: [Stroke | undefined, Stroke | undefined][][];
  constructor(
    readonly M: number,
    readonly N: number,
  ) {
    const grid = <T>(a: number, b: number, f: () => T) =>
      Array.from({ length: a }, () => Array.from({ length: b }, f));
    this.h = grid(M + 1, N, () => undefined);
    this.v = grid(N + 1, M, () => undefined);
    this.hc = grid(M + 1, N, () => [undefined, undefined]);
    this.vc = grid(N + 1, M, () => [undefined, undefined]);
  }

  /** A style part's line on its region [r0, r1) × [c0, c1). */
  region(kind: string, s: Stroke, r0: number, r1: number, c0: number, c1: number): void {
    const hs = (i: number) => {
      for (let c = c0; c < c1; c++) this.h[i]![c] = merge(this.h[i]![c], s);
    };
    const vs = (j: number) => {
      for (let r = r0; r < r1; r++) this.v[j]![r] = merge(this.v[j]![r], s);
    };
    if (kind === 'top') hs(r0);
    else if (kind === 'bottom') hs(r1);
    else if (kind === 'left') vs(c0);
    else if (kind === 'right') vs(c1);
    else if (kind === 'insideH') for (let i = r0 + 1; i < r1; i++) hs(i);
    else if (kind === 'insideV') for (let j = c0 + 1; j < c1; j++) vs(j);
  }

  /** A cell's own line on one side of its (merged) box. */
  cell(a: Anchor, side: 'left' | 'right' | 'top' | 'bottom', s: Stroke): void {
    if (side === 'top' || side === 'bottom') {
      const i = side === 'top' ? a.row : a.row + a.rows;
      const at = side === 'top' ? 1 : 0;
      for (let c = a.col; c < a.col + a.cols; c++) this.hc[i]![c]![at] = merge(this.hc[i]![c]![at], s);
    } else {
      const j = side === 'left' ? a.col : a.col + a.cols;
      const at = side === 'left' ? 1 : 0;
      for (let r = a.row; r < a.row + a.rows; r++) this.vc[j]![r]![at] = merge(this.vc[j]![r]![at], s);
    }
  }

  /** The lines drawn: inside merges none; elsewhere the cells' and the style's (see the module header). */
  resolve(cover: readonly (number | undefined)[][]): TableLine[] {
    const pick = (
      style: Stroke | undefined,
      own: [Stroke | undefined, Stroke | undefined],
      sides: boolean[],
    ) => {
      if (!own[0] && !own[1]) return lineOf(style);
      // Each side's version, the upper or left one first; the wider wins, a tie keeps the first.
      let best: Line | undefined;
      let bestW = -1;
      for (let k = 0; k < 2; k++) {
        if (!sides[k]) continue;
        const l = lineOf(merge(style, own[k]));
        const w = l ? l.width : 0;
        if (w > bestW) {
          best = l;
          bestW = w;
        }
      }
      return best;
    };
    const out: TableLine[] = [];
    const join = (dir: 'h' | 'v', at: number, list: (Line | undefined)[]) => {
      let start = 0;
      let key = '';
      for (let k = 0; k <= list.length; k++) {
        const l = list[k];
        const kk = l ? JSON.stringify(l) : '';
        if (k === list.length || kk !== key) {
          if (key) out.push({ dir, at, from: start, to: k, line: list[start]! });
          start = k;
          key = kk;
        }
      }
    };
    for (let i = 0; i <= this.M; i++) {
      const row: (Line | undefined)[] = [];
      for (let c = 0; c < this.N; c++) {
        const above = i > 0 ? cover[i - 1]![c] : undefined;
        const below = i < this.M ? cover[i]![c] : undefined;
        if (above !== undefined && above === below)
          row.push(undefined); // inside a merge
        else row.push(pick(this.h[i]![c], this.hc[i]![c]!, [above !== undefined, below !== undefined]));
      }
      join('h', i, row);
    }
    for (let j = 0; j <= this.N; j++) {
      const col: (Line | undefined)[] = [];
      for (let r = 0; r < this.M; r++) {
        const left = j > 0 ? cover[r]![j - 1] : undefined;
        const right = j < this.N ? cover[r]![j] : undefined;
        if (left !== undefined && left === right) col.push(undefined);
        else col.push(pick(this.v[j]![r], this.vc[j]![r]!, [left !== undefined, right !== undefined]));
      }
      join('v', j, col);
    }
    return out;
  }
}

// ── Measuring text ──────────────────────────────────────────────────────────────────────────────────────

/**
 * How LibreOffice 24.2 spaces a cell's lines when it sizes a table's rows (`Cell::getMinimumHeight`, the
 * draw outliner's `GetTextHeight`; measured with the table probe deck,
 * `tools/pptx-fidelity/src/table-probe.ts`):
 * - 'independent': font-independent line spacing, 1.2 × the font height in 1/100 mm, truncated
 *   (`ImplCalculateFontIndependentLineSpacing`). The draw outliner is left in this mode by a text shape
 *   that grew to its text (its own `a:spAutoFit`, with text) earlier on the same slide, and the table's
 *   rows are measured in it: any face, any size.
 * - 'font': the face's ascent and descent at the reference device (600 dpi: the font's pixel height
 *   rounded, then each of ascent and descent rounded, and each back to 1/100 mm rounded): Carlito
 *   1.215-1.229 × the size, Liberation Sans 1.11-1.13. Otherwise.
 * Either way the cell's text is drawn with the face's own line height (the second), so text in a row
 * measured 'independent' runs into the cell's margins.
 */
export type LoLines = 'independent' | 'font';

/**
 * One laid-out line: its largest unshifted size (px and pt), the face that size draws in, and whether it
 * draws anything.
 */
interface LaidLine {
  px: number;
  pt: number;
  face: FaceMetrics | undefined;
  glyphs: boolean;
}

/** A text block: its height and its lines' baselines from its top (lines with text only). */
export interface Block {
  height: number;
  baselines: number[];
}

/** A paragraph's lines (`Measure.lines`). */
interface LaidPara {
  lines: LaidLine[];
  /** The paragraph's main size (its first unshifted run, else its first run, else its end mark). */
  F: number;
  Fpt: number;
  mainFace: FaceMetrics | undefined;
  /** An a:br ends it: one more line, as tall as the end mark. */
  trailingBreak: boolean;
  endFace: FaceMetrics | undefined;
}

/** 1/100 mm per point. */
const MM100_PER_PT = 2540 / 72;
/** LibreOffice's reference device for text layout, in dots per inch (sd `RefDevMode::Dpi600`). */
const LO_REF_DPI = 600;

/** A size or length in points as LibreOffice stores it: 1/100 mm, rounded. */
const mm100 = (pt: number) => Math.round(pt * MM100_PER_PT);

/**
 * The size LibreOffice lays text out at: the font's height at its 600 dpi reference device, in whole pixels
 * (1/100 mm, then pixels, rounded). Its line widths are the kerned advances at this size: 14 pt is 117 px,
 * 0.27 % wider than 14 pt, and 9.5 pt is 79 px, 0.17 % narrower (measured: a 14 pt header of 901.2 pt of
 * advances, 899.2 kerned, is 901.5 pt wide in LibreOffice and wraps in a 916 pt cell where ordo's would not).
 */
export function loSizePt(pt: number): number {
  if (!(pt > 0) || !Number.isFinite(pt)) return pt;
  return (Math.round((mm100(pt) * LO_REF_DPI) / 2540) * 72) / LO_REF_DPI;
}

/** A line's ascent (its baseline below its top) of a face at a size, LibreOffice's way (1/100 mm). */
export function loAscent(pt: number, face: FaceMetrics | undefined, lines: LoLines): number {
  const h = mm100(pt);
  if (lines === 'independent' || face?.ascent === undefined || face.descent === undefined) return h;
  const px = Math.round((h * LO_REF_DPI) / 2540);
  return Math.round((Math.round(px * face.ascent) * 2540) / LO_REF_DPI);
}

/** A line of a face at a size, LibreOffice's way (1/100 mm). */
export function loLineHeight(pt: number, face: FaceMetrics | undefined, lines: LoLines): number {
  const h = mm100(pt);
  if (lines === 'independent' || face?.ascent === undefined || face.descent === undefined)
    return Math.trunc((h * 120) / 100);
  const px = Math.round((h * LO_REF_DPI) / 2540);
  const back = (v: number) => Math.round((v * 2540) / LO_REF_DPI);
  return back(Math.round(px * face.ascent)) + back(Math.round(px * face.descent));
}

/**
 * Text heights in logical px, in the office line model (design/27 §6 step 7), from the faces' advances and
 * pair kerning. `missing` collects the families measured with estimated widths.
 *
 * Lines break as the renderer breaks them (`@ordo/renderer` text/lines.ts): greedily after spaces, around
 * East Asian characters and at hard breaks, a word that does not fit going to the next line, cut between
 * characters only when it is wider than a whole line. A word is measured as the renderer measures one piece
 * of it: advances plus the face's pair kerning between characters of one run (so a word that fits once
 * kerned is not cut; kerning across a space or a style change is lost on both sides alike).
 */
export class Measure {
  readonly missing = new Set<string>();
  private readonly chains = new Map<string, FaceMetrics[]>();

  constructor(
    private readonly frame: Frame,
    private readonly faces: FaceSource | undefined,
  ) {}

  /** The faces tried for a family, nearest first: its own, its metric substitute, `extra`, ordo's default. */
  private chain(family: string, bold: boolean, italic: boolean, extra: readonly string[]): FaceMetrics[] {
    const key = `${family}|${bold}|${italic}|${extra.join(',')}`;
    let c = this.chains.get(key);
    if (c) return c;
    c = [];
    const names: string[] = [];
    for (const n of [family, substituteOf(family), ...extra, DEFAULT_FONT])
      if (n && !names.some((m) => m.toLowerCase() === n.toLowerCase())) names.push(n);
    for (const n of names) {
      const f =
        this.faces?.(n, bold, italic) ??
        (bold || italic ? (this.faces?.(n, false, false) ?? undefined) : undefined);
      if (f) c.push(f);
    }
    if (!c.length) this.missing.add(family);
    this.chains.set(key, c);
    return c;
  }

  /** The face a style's main script draws in (the first of its chain), for line heights. */
  private faceOf(s: RunStyle, cls: 'latin' | 'ea' | 'cs' = 'latin'): FaceMetrics | undefined {
    return this.chain(familyOf(s, cls), s.bold, s.italic, [])[0];
  }

  /**
   * Space each paragraph's lines by the line height of its main run's face (`FaceMetrics.lineHeight`:
   * Carlito's is 1.22 of the size where the office model's single spacing is 1.2): a proportional spacing
   * (single included) is scaled by it, so the drawing spaces the cell's lines as LibreOffice draws them and
   * PowerPoint sizes them (measured: LibreOffice 24.2 draws a cell's lines of Liberation Sans 1.115 apart
   * and Carlito's 1.22; PowerPoint's new rows of 18 pt Calibri are 29.2 pt tall, 22 pt and the margins).
   * Exact spacing stays.
   */
  spaceByFont(body: TextBody): void {
    body.paras = body.paras.map((p) => {
      const ls = p.lineSpacing;
      if (ls && 'pts' in ls) return p;
      const main = p.runs.find((r) => r.kind !== 'break' && r.text.length && r.style.baseline === 0);
      const s = main?.style ?? p.end;
      const cls = main ? (scriptClasses(main.text).find((c) => c !== 'latin') ?? 'latin') : 'latin';
      let line: number | undefined;
      for (const f of this.chain(familyOf(s, cls), s.bold, s.italic, []))
        if (f.lineHeight !== undefined) {
          line = f.lineHeight;
          break;
        }
      if (line === undefined || Math.abs(line - SINGLE_LINE) < 1e-6) return p;
      return { ...p, lineSpacing: { pct: clamp((ls?.pct ?? 1) * (line / SINGLE_LINE), 0, 13.2) } };
    });
  }

  /** A code point's advance in em and the face it comes from (none: estimated) through the chain. */
  private glyph(
    cp: number,
    family: string,
    bold: boolean,
    italic: boolean,
    extra: readonly string[],
  ): { w: number; face: FaceMetrics | undefined } {
    for (const f of this.chain(family, bold, italic, extra)) {
      const a = f.advance(cp);
      if (a !== undefined && Number.isFinite(a) && a >= 0) return { w: a, face: f };
    }
    return { w: estimate(cp) * (bold ? 1.07 : 1), face: undefined };
  }

  /** The height a body's text takes laid out `widthPx` wide (without the body's top and bottom insets). */
  height(body: TextBody, widthPx: number): number {
    let h = 0;
    const last = body.paras.length - 1;
    body.paras.forEach((p, i) => {
      h += this.paraHeight(p, widthPx, i === 0, i === last);
    });
    return h;
  }

  /**
   * A body's text laid out `widthPx` wide as LibreOffice 24.2 sizes and draws it in a table cell (1/100
   * mm; the lines break as `height` breaks them): `height` the row's text height in `mode`, without the
   * insets and LibreOffice's extra 1/100 mm; `drawn` the block as drawn, with the face's own line heights
   * whatever `mode` (see `LoLines`), and its baselines (lines with text only, from the block's top). Call
   * it before `spaceByFont`, with the deck's own spacing.
   */
  loLayout(body: TextBody, widthPx: number, mode: LoLines): { height: number; drawn: Block } {
    let h = 0;
    const drawn: Block = { height: 0, baselines: [] };
    const last = body.paras.length - 1;
    body.paras.forEach((p, i) => {
      const laid = this.lines(p, widthPx, loSizePt);
      const ls = p.lineSpacing;
      const pct = ls && 'pct' in ls ? Math.trunc(ls.pct * 100 + 1e-6) : 100;
      // A line's height and ascent: exact spacing sets the height, a proportion scales it (truncated);
      // what is added goes above the baseline, and a proportion under 100 % keeps the ascent within 80 % of
      // the line (editeng `ImpEditEngine::CreateLines`).
      const line = (pt: number, face: FaceMetrics | undefined, m: LoLines) => {
        const natural = loLineHeight(pt, face, m);
        const asc = loAscent(pt, face, m);
        if (ls && 'pts' in ls) {
          const height = mm100(ls.pts);
          return { height, ascent: Math.max(0, asc + height - natural) };
        }
        if (pct === 100) return { height: natural, ascent: asc };
        const height = Math.trunc((natural * pct) / 100);
        if (pct < 100) return { height, ascent: Math.min(asc, Math.trunc((height * 4) / 5)) };
        return { height, ascent: asc + height - natural };
      };
      const gap = (s: Para['spaceBefore']) =>
        s === undefined ? 0 : 'pts' in s ? mm100(s.pts) : Math.round(s.pct * mm100(largestPt(p)));
      if (i > 0) {
        h += gap(p.spaceBefore);
        drawn.height += gap(p.spaceBefore);
      }
      for (const l of laid.lines) {
        const [pt, face] = l.pt > laid.Fpt ? [l.pt, l.face] : [laid.Fpt, laid.mainFace];
        h += line(pt, face, mode).height;
        const d = line(pt, face, 'font');
        if (l.glyphs) drawn.baselines.push(drawn.height + d.ascent);
        drawn.height += d.height;
      }
      if (laid.trailingBreak) {
        h += line(p.end.sizePt, laid.endFace, mode).height;
        drawn.height += line(p.end.sizePt, laid.endFace, 'font').height;
      }
      if (i < last) {
        h += gap(p.spaceAfter);
        drawn.height += gap(p.spaceAfter);
      }
    });
    return { height: h, drawn };
  }

  /**
   * The block a body's text draws `widthPx` wide in ordo's office line model (logical px: the renderer's
   * `officeLine`), and its baselines (lines with text only, from the block's top). After `spaceByFont`.
   * `drawn` maps the runs' sizes to the sizes they are drawn at (`lines`).
   */
  layout(body: TextBody, widthPx: number, drawn: (pt: number) => number = (pt) => pt): Block {
    const raw = (pt: number) => ptPx(this.frame, pt);
    const px = (pt: number) => ptPx(this.frame, drawn(pt));
    const out: Block = { height: 0, baselines: [] };
    const last = body.paras.length - 1;
    body.paras.forEach((p, i) => {
      const laid = this.lines(p, widthPx, drawn);
      const ls = p.lineSpacing;
      const line = (F: number) => {
        const natural = SINGLE_LINE * F;
        if (ls && 'pts' in ls) return { height: raw(ls.pts), ascent: F + raw(ls.pts) - natural };
        const k = ls?.pct ?? 1;
        if (!(k > 0) || Math.abs(k - 1) < 1e-9) return { height: natural, ascent: F };
        const height = natural * k;
        return { height, ascent: k < 1 ? Math.min(F, 0.8 * height) : F + height - natural };
      };
      const gap = (s: Para['spaceBefore']) =>
        s === undefined ? 0 : 'pts' in s ? raw(s.pts) : s.pct * px(largestPt(p));
      if (i > 0) out.height += gap(p.spaceBefore);
      for (const l of laid.lines) {
        const d = line(Math.max(laid.F, l.px));
        if (l.glyphs) out.baselines.push(out.height + d.ascent);
        out.height += d.height;
      }
      if (laid.trailingBreak) out.height += ls && 'pts' in ls ? raw(ls.pts) : SINGLE_LINE * px(p.end.sizePt);
      if (i < last) out.height += gap(p.spaceAfter);
    });
    return out;
  }

  private paraHeight(p: Para, widthPx: number, first: boolean, last: boolean): number {
    const px = (pt: number) => ptPx(this.frame, pt);
    const laid = this.lines(p, widthPx);
    const ls = p.lineSpacing;
    const pitch = (size: number) => (ls && 'pts' in ls ? px(ls.pts) : SINGLE_LINE * size * (ls?.pct ?? 1));
    let h = 0;
    for (const l of laid.lines) h += pitch(Math.max(laid.F, l.px));
    // A trailing a:br adds a line as tall as the end mark, single spaced (exact spacing applies).
    if (laid.trailingBreak) h += ls && 'pts' in ls ? px(ls.pts) : SINGLE_LINE * px(p.end.sizePt);
    const gap = (s: Para['spaceBefore']) =>
      s === undefined ? 0 : 'pts' in s ? px(s.pts) : s.pct * px(largestPt(p));
    if (!first) h += gap(p.spaceBefore);
    if (!last) h += gap(p.spaceAfter);
    return h;
  }

  /**
   * A paragraph's lines laid out `widthPx` wide (see the class comment). `drawn` maps a run's size to the
   * size it is drawn at (`loSizePt` for LibreOffice's layout): widths and `px` sizes follow it, `pt` stays
   * the deck's size.
   */
  private lines(p: Para, widthPx: number, drawn: (pt: number) => number = (pt) => pt): LaidPara {
    const px = (pt: number) => ptPx(this.frame, drawn(pt));
    // The characters with their widths, sizes and whether they raise the line.
    const chars: {
      w: number;
      size: number;
      pt: number;
      face: FaceMetrics | undefined;
      grow: boolean;
      space: boolean;
      wide: boolean;
      hard: boolean;
    }[] = [];
    const runs = p.runs;
    let text = '';
    for (const r of runs) text += r.kind === 'break' ? '\n' : r.text;
    const classes = scriptClasses(text);
    const fallbacks = scriptFallbacks(text, runs.find((r) => r.style.lang)?.style.lang);
    let at = 0;
    for (const r of runs) {
      if (r.kind === 'break') {
        chars.push({
          w: 0,
          size: px(r.style.sizePt),
          pt: r.style.sizePt,
          face: undefined,
          grow: false,
          space: false,
          wide: false,
          hard: true,
        });
        at += 1;
        continue;
      }
      const s = r.style;
      const shifted = s.baseline !== 0;
      const size = px(s.sizePt) * (shifted ? SHIFTED_SIZE : 1);
      const spacing = px(s.spacingPt);
      const t = s.caps === 'none' ? r.text : r.text.toUpperCase();
      let prev: { cp: number; face: FaceMetrics | undefined; space: boolean; wide: boolean } | undefined;
      for (let i = 0; i < t.length; i++) {
        const code = t.codePointAt(i)!;
        const unit = code > 0xffff ? 2 : 1;
        const cls = classes[Math.min(at + i, classes.length - 1)] ?? 'latin';
        const family = familyOf(s, cls);
        const cp = code === 0x09 ? 0x20 : code;
        const g = this.glyph(cp, family, s.bold, s.italic, fallbacks);
        const space = cp === 0x20;
        const wide = cls === 'ea';
        let w = g.w * size + spacing;
        // Pair kerning inside one piece of one run: not across a break opportunity, not between faces.
        if (prev?.face && prev.face === g.face && !(prev.space && !space) && !prev.wide && !wide) {
          const k = g.face.kern?.(prev.cp, cp) ?? 0;
          if (Number.isFinite(k)) w += k * size;
        }
        chars.push({
          w,
          size: px(s.sizePt),
          pt: s.sizePt,
          face: g.face ?? this.faceOf(s, cls),
          grow: !shifted,
          space,
          wide,
          hard: false,
        });
        prev = { cp, face: g.face, space, wide };
        if (unit === 2) i++;
      }
      at += r.text.length;
    }
    const textRuns = runs.filter((r) => r.kind !== 'break' && r.text.length);
    const main = textRuns.find((r) => r.style.baseline === 0) ?? textRuns[0];
    const mainStyle = main ? main.style : p.end;
    const mainCls = main ? (scriptClasses(main.text).find((c) => c !== 'latin') ?? 'latin') : 'latin';

    // Greedy lines: break after spaces, around East Asian characters, at a hard break.
    const lines: LaidLine[] = [];
    const firstAvail = widthPx - lenPx(this.frame, p.marL + p.indent);
    const avail = widthPx - lenPx(this.frame, p.marL);
    let start = 0;
    let width = 0;
    let bp = -1; // a break opportunity: the line may end before chars[bp]
    let widthAtBp = 0;
    const close = (end: number) => {
      let best: LaidLine = { px: 0, pt: 0, face: undefined, glyphs: false };
      let glyphs = false;
      for (let k = start; k < end; k++) {
        const c = chars[k]!;
        if (!c.space && !c.hard) glyphs = true;
        if (c.grow && c.size > best.px) best = { px: c.size, pt: c.pt, face: c.face, glyphs: false };
      }
      lines.push({ ...best, glyphs });
    };
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k]!;
      if (ch.hard) {
        close(k);
        start = k + 1;
        width = 0;
        bp = -1;
        continue;
      }
      const room = lines.length ? avail : firstAvail;
      if (!ch.space && k > start) {
        const prev = chars[k - 1]!;
        if (prev.space || prev.wide || ch.wide) {
          bp = k;
          widthAtBp = width;
        }
      }
      if (!ch.space && width + ch.w > room + 0.01 && k > start) {
        if (bp > start) {
          close(bp);
          width -= widthAtBp;
          start = bp;
        } else {
          close(k);
          width = 0;
          start = k;
        }
        bp = -1;
      }
      width += ch.w;
    }
    const empty = !textRuns.length;
    if (empty) lines.length = 0;
    if (start < chars.length || empty || !lines.length) close(chars.length);
    return {
      lines,
      F: px(mainStyle.sizePt),
      Fpt: mainStyle.sizePt,
      mainFace: this.faceOf(mainStyle, mainCls),
      trailingBreak: !empty && runs[runs.length - 1]?.kind === 'break',
      endFace: this.faceOf(p.end),
    };
  }
}

/** The family a run draws a character of a script class in (its Latin one when it names none other). */
function familyOf(s: RunStyle, cls: 'latin' | 'ea' | 'cs'): string {
  return (cls === 'ea' ? s.ea : cls === 'cs' ? s.cs : undefined) ?? s.latin ?? 'Calibri';
}

/** A paragraph's largest run size in points (its end mark's when empty), for a percentage gap. */
function largestPt(p: Para): number {
  let pt = 0;
  for (const r of p.runs) if (r.kind !== 'break') pt = Math.max(pt, r.style.sizePt);
  return pt || p.end.sizePt;
}

/**
 * A conservative advance in em when no face is known: a little wider than Arial and Calibri, so a row is
 * never shorter than its text drawn with a real face; East Asian characters a full em.
 */
function estimate(cp: number): number {
  if (cp === 0x20 || cp === 0xa0) return 0.28;
  if ((cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff))
    return 1;
  if ((cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x20000) return 1;
  const ch = String.fromCodePoint(cp);
  if ('iljtfrI.,:;!|\'"()[]'.includes(ch)) return 0.33;
  if ('mwMW@%'.includes(ch)) return 0.9;
  if (/[A-Z0-9]/.test(ch)) return 0.68;
  return 0.58;
}

// ── Emission ────────────────────────────────────────────────────────────────────────────────────────────

/** What emitting a table needs of the slide's emission (`emit.ts`). */
export interface TableEmitCtx {
  frame: Frame;
  newId: () => string;
  log: Log;
  /** A cell's text as rich text (the slide's budget and the harness's LibreOffice policies applied). */
  cellText: (body: TextBody) => RichText | undefined;
  /** The legacy solid colour of a fill (`emit.ts` `legacyColor`). */
  color: (fill: Fill) => OrdoRgba | undefined;
  /** The harness's LibreOffice policy (`EmitOptions.loCompat`): LibreOffice's rows (`TableElement.lo`). */
  lo?: boolean;
}

type Box = { x: number; y: number; w: number; h: number; rotation: number };

const bound = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : Math.min(hi, Math.max(lo, 0));

function clampBox(b: Box): Box {
  return {
    x: bound(b.x, -MAX_COORD, MAX_COORD),
    y: bound(b.y, -MAX_COORD, MAX_COORD),
    w: bound(b.w, 0, MAX_COORD),
    h: bound(b.h, 0, MAX_COORD),
    rotation: bound(b.rotation, -36_000, 36_000),
  };
}

/**
 * A table's objects, appended to `out`: background, fills and lines (locked, role 'grid'; `gridObjects`),
 * then one text object per cell (role 'cell'). Returns the text objects (the slide's text budget counts
 * them). A table the classification made residual emits nothing: LibreOffice draws it into the art.
 */
export function emitTable(ctx: TableEmitCtx, e: TableElement, out: SlideObject[]): TextObject[] {
  if (e.support === 'residual') {
    ctx.log('table drawn by LibreOffice as a picture');
    return [];
  }
  const f = ctx.frame;
  const lo = ctx.lo ? e.lo : undefined;
  const rowsOf = lo?.rows ?? e.rows;
  const xf = lo?.xf ?? e.xf;
  const W = e.cols.reduce((s, w) => s + w, 0);
  const H = rowsOf.reduce((s, h) => s + h, 0);
  if (!(W > 0) || !(H > 0)) return [];
  const xs = [0];
  for (const w of e.cols) xs.push(xs[xs.length - 1]! + w);
  const ys = [0];
  for (const h of rowsOf) ys.push(ys[ys.length - 1]! + h);
  const rect = (r0: number, r1: number, c0: number, c1: number): Box =>
    clampBox(
      boxPx(
        f,
        multiply(xf, [(xs[c1]! - xs[c0]!) / W, 0, 0, (ys[r1]! - ys[r0]!) / H, xs[c0]! / W, ys[r0]! / H]),
      ),
    );
  const origin = (role: string) => ({
    src: 'pptx',
    ...(Number.isInteger(e.shapeId) && e.shapeId > 0 ? { shapeId: Math.min(2_147_483_647, e.shapeId) } : {}),
    role,
    ...(e.group !== undefined ? { group: Math.min(100_000, Math.max(0, e.group)) } : {}),
  });
  const gridShape = (box: Box, kind: ShapeObject['shape'], fill: OrdoRgba | undefined): ShapeObject => ({
    id: ctx.newId(),
    type: 'shape',
    box,
    shape: kind,
    ...(fill ? { fill } : {}),
    opacity: 1,
    radius: 0,
    origin: origin('grid'),
    locked: true,
  });

  // The grid objects' sub-paths are in the table box's own space: unturned, from its top left corner.
  const table = rect(0, rowsOf.length, 0, e.cols.length);
  const turn = (table.rotation * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const tcx = table.x + table.w / 2;
  const tcy = table.y + table.h / 2;
  /** Grid point (column edge, row edge) in slide px. */
  const page = (c: number, r: number): [number, number] => {
    const [x, y] = apply(xf, xs[c]! / W, ys[r]! / H);
    return [f.x0 + x * f.s, f.y0 + y * f.s];
  };
  /** A slide px point in the table box's space. */
  const inTable = (p: readonly [number, number]): [number, number] => {
    const dx = p[0] - tcx;
    const dy = p[1] - tcy;
    return [dx * cos + dy * sin + table.w / 2, -dx * sin + dy * cos + table.h / 2];
  };
  const grid = gridObjects(e.cells, e.lines);

  let gradients = false;
  const colorOf = (fill: Fill) => {
    if (fill.kind === 'gradient' || fill.kind === 'pattern') gradients = true;
    return ctx.color(fill);
  };
  if (e.background) {
    const c = colorOf(e.background);
    if (c) out.push(gridShape(table, 'rect', c));
  }
  // Fills: one object per fill, its runs as rects in the box of their bounds (turned as the table is).
  for (const g of grid.fills) {
    const c = colorOf(g.fill);
    if (!c) continue;
    const quads = g.paths.map((p) =>
      p.runs.map((run) =>
        [
          page(run.col, run.row),
          page(run.col + run.cols, run.row),
          page(run.col + run.cols, run.row + run.rows),
          page(run.col, run.row + run.rows),
        ].map(inTable),
      ),
    );
    let u0 = Number.POSITIVE_INFINITY;
    let v0 = Number.POSITIVE_INFINITY;
    let u1 = Number.NEGATIVE_INFINITY;
    let v1 = Number.NEGATIVE_INFINITY;
    for (const path of quads)
      for (const q of path)
        for (const [u, v] of q) {
          u0 = Math.min(u0, u);
          v0 = Math.min(v0, v);
          u1 = Math.max(u1, u);
          v1 = Math.max(v1, v);
        }
    if (!(u1 >= u0 && v1 >= v0)) continue;
    const cu = (u0 + u1) / 2 - table.w / 2;
    const cv = (v0 + v1) / 2 - table.h / 2;
    const box = clampBox({
      x: tcx + cu * cos - cv * sin - (u1 - u0) / 2,
      y: tcy + cu * sin + cv * cos - (v1 - v0) / 2,
      w: u1 - u0,
      h: v1 - v0,
      rotation: table.rotation,
    });
    const at = ([u, v]: [number, number]) => `${gridNum(u - u0)} ${gridNum(v - v0)}`;
    const paths: NonNullable<ShapeGeom['paths']> = g.paths.map((p, k) => ({
      d: quads[k]!.map((q) => `M ${at(q[0]!)} L ${at(q[1]!)} L ${at(q[2]!)} L ${at(q[3]!)} Z`).join(' '),
      w: box.w,
      h: box.h,
      stroke: false,
      ...(p.cont ? { cont: true } : {}),
    }));
    out.push({ ...gridShape(box, 'rect', c), geom: { paths } });
  }
  if (gradients) ctx.log('table cells filled with a gradient or pattern are drawn in one colour (M6)');

  // Lines: one object per look, each run an open sub-path stretched at its ends by half the widest line
  // it meets there, so corners close. Its legacy shape is the table's outline in that line.
  let dashed = false;
  for (const g of grid.lines) {
    const color = ctx.color(g.line.fill);
    if (!color) continue;
    if (g.line.dash) dashed = true;
    const segment = (l: TableLine) => {
      /** The widest line of the other direction through edge `k` of this one. */
      const across = (k: number) => {
        let w = 0;
        for (const o of e.lines)
          if (o.dir !== l.dir && o.at === k && o.from <= l.at && l.at <= o.to) w = Math.max(w, o.line.width);
        return w;
      };
      const a = l.dir === 'h' ? page(l.from, l.at) : page(l.at, l.from);
      const b = l.dir === 'h' ? page(l.to, l.at) : page(l.at, l.to);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 0) {
        const ux = (b[0] - a[0]) / len;
        const uy = (b[1] - a[1]) / len;
        const e0 = lenPx(f, across(l.from)) / 2;
        const e1 = lenPx(f, across(l.to)) / 2;
        a[0] -= ux * e0;
        a[1] -= uy * e0;
        b[0] += ux * e1;
        b[1] += uy * e1;
      }
      const [u0, v0] = inTable(a);
      const [u1, v1] = inTable(b);
      return `M ${gridNum(u0)} ${gridNum(v0)} L ${gridNum(u1)} ${gridNum(v1)}`;
    };
    const paths: NonNullable<ShapeGeom['paths']> = g.paths.map((p) => ({
      d: p.runs.map(segment).join(' '),
      w: table.w,
      h: table.h,
      fill: 'none',
      ...(p.cont ? { cont: true } : {}),
    }));
    out.push({
      ...gridShape(table, 'rect', undefined),
      stroke: { width: bound(Math.max(lenPx(f, g.line.width), 0.5), 0, 500), color },
      geom: { paths },
    });
  }
  if (dashed) ctx.log('dashed table lines are drawn solid (M6)');

  const texts: TextObject[] = [];
  e.cells.forEach((c, i) => {
    const box = rect(c.row, c.row + c.rows, c.col, c.col + c.cols);
    const body = lo ? atLoSizes(c.text) : c.text;
    const rich = ctx.cellText(body) ?? emptyText(ctx, body);
    if (!rich) return;
    const o: TextObject = {
      id: ctx.newId(),
      type: 'text',
      box,
      text: rich.text,
      style: lo
        ? asLibreOffice(rich.style, lenPx(f, lo.spill[i] ?? 0), lenPx(f, lo.lift[i] ?? 0))
        : rich.style,
      opacity: 1,
      ...(rich.runs ? { runs: rich.runs } : {}),
      ...(rich.paras ? { paras: rich.paras } : {}),
      origin: origin('cell'),
    };
    out.push(o);
    texts.push(o);
  });
  return texts;
}

/** A cell's text at the sizes LibreOffice lays it out at (`loSizePt`), end marks included. */
function atLoSizes(body: TextBody): TextBody {
  const at = (s: RunStyle): RunStyle => ({ ...s, sizePt: loSizePt(s.sizePt) });
  return {
    ...body,
    paras: body.paras.map((p) => ({
      ...p,
      end: at(p.end),
      runs: p.runs.map((r) => ({ ...r, style: at(r.style) })),
    })),
  };
}

/**
 * A cell's style as LibreOffice draws its text (`TableElement.lo`): let `spill` px into its top and bottom
 * margins where the row is shorter than the text (centred text into both alike, top-anchored text into the
 * bottom one, bottom-anchored into the top one), then moved `lift` px up (down when negative). The box is
 * unchanged; margins stay at least 0, and what does not fit shrinks.
 */
function asLibreOffice(style: TextObject['style'], spill: number, lift: number): TextObject['style'] {
  const ins = style.insets;
  if (!ins || (!(spill > 0) && !lift)) return style;
  let { t, b } = ins;
  if (spill > 0) {
    if (style.valign === 'middle') {
      t -= spill / 2;
      b -= spill / 2;
    } else if (style.valign === 'bottom') t -= spill;
    else b -= spill;
  }
  t -= lift;
  b += lift;
  return { ...style, insets: { ...ins, t: Math.max(0, t), b: Math.max(0, b) } };
}

/**
 * An empty cell's text object, to type into: the box style of its end mark (the same fields a cell with a
 * character in that style gets), no text.
 */
function emptyText(ctx: TableEmitCtx, body: TextBody): RichText | undefined {
  const p = body.paras[0];
  if (!p) return undefined;
  const probe = ctx.cellText({
    ...body,
    paras: [{ ...p, runs: [{ kind: 'text', text: 'x', style: p.end }] }],
  });
  return probe ? { text: '', style: probe.style } : undefined;
}

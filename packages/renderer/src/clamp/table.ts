import {
  type CellStyle,
  TABLE_LIMITS,
  type TableCell,
  type TableData,
  type TableFill,
  type TableLineStyle,
  type TableRun,
  type TableRunStyle,
  type TextPara,
} from '@ordo/domain';
import {
  CLAMP,
  FontBudget,
  clampColor,
  clampFamily,
  clampGradient,
  clampLang,
  clampParas,
  clampRuns,
  clampStyle,
  num,
} from '../clamp.ts';

/*
 * `ShapeObject.table` for drawing (design/27 M9 tables, design/25 "validate at entry, clamp at use"): whatever
 * reaches the drawer is treated as hostile, and the result is always drawable in time and memory linear in
 * the table's bounds. Written by hand, as the rest of the render clamp, so a slide sent to the asset worker
 * again is clamped in a fraction of a millisecond whatever its table holds.
 *
 * - Shape: `cols`, `rows` and `cells` arrays and a `base` style, else no table (the shape's legacy rect is
 *   drawn); columns ≤ 64 and rows ≤ 256, each within 0 .. 100,000 logical px; rows past 4,096 grid slots are
 *   cut (the first ones kept); columns that sum to 0 leave no table.
 * - Palettes keep their indices: a malformed entry becomes an empty one (a cell style of the base's, a run of
 *   the cell's style, a transparent fill or line), so the entries after it still mean what they meant. An
 *   index that names no entry falls back: the base style, no fill, no line, no run.
 * - Text: each cell ≤ 10,000 characters and the table ≤ 60,000 (later cells are emptied); runs sorted, inside
 *   their text, not overlapping (the `clampRuns` rules), ≤ 2,000 a cell and 8,000 a table; paragraph styles
 *   ≤ 1,000 a cell and 8,000 a table.
 * - Fonts: one `FontBudget` for the whole table (16 families, 64 size scales, the base family first), so a
 *   table makes no more font lookups than one text box.
 * - Edges: integers in range of the clamped grid, `from < to`, ≤ 8,192 each way; widths ≤ `maxEffectPx`.
 * A table that is valid comes out equal to what went in, apart from the bounds above (`TextStyle` defaults
 * as `clampStyle` writes them).
 */

/** The stored model's bound on coordinates and lengths (logical px). */
const MAX_COORD = 100_000;

const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const NO_COLOR = { r: 0, g: 0, b: 0, a: 0 } as const;
const ALIGNS = ['left', 'center', 'right', 'justify'] as const;
const VALIGNS = ['top', 'middle', 'bottom'] as const;
const DIRECTIONS = ['auto', 'ltr', 'rtl'] as const;
const VERTS = ['horz', 'vert', 'vert270', 'eaVert'] as const;
const DASHES = [
  'solid',
  'dot',
  'dash',
  'dashDot',
  'longDash',
  'longDashDot',
  'longDashDotDot',
  'sysDot',
  'sysDash',
  'sysDashDot',
  'sysDashDotDot',
] as const;

function pick<T extends string>(v: unknown, list: readonly T[], dflt: T): T {
  return list.includes(v as T) ? (v as T) : dflt;
}

/** A list of at most `max` entries, each made by `f` (a malformed entry included, so indices hold). */
function palette<T>(v: unknown, max: number, f: (x: unknown) => T): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = new Array(Math.min(v.length, max));
  for (let i = 0; i < out.length; i++) out[i] = f(v[i]);
  return out;
}

function cellStyle(v: unknown, budget: FontBudget): CellStyle {
  if (!isObj(v)) return {};
  const s = v as Partial<CellStyle>;
  const out: CellStyle = {};
  if (s.fontFamily !== undefined) {
    const f = budget.family(s.fontFamily);
    if (f) out.fontFamily = f;
  }
  if (s.fontWeight !== undefined) out.fontWeight = Math.round(num(s.fontWeight, 1, 1000, 400));
  if (s.fontSizePx !== undefined) out.fontSizePx = num(s.fontSizePx, CLAMP.minFontPx, CLAMP.maxFontPx, 24);
  if (s.color !== undefined) out.color = clampColor(s.color);
  if (isObj(s.insets)) {
    const side = (x: unknown) => num(x, 0, CLAMP.maxPadding, 0);
    out.insets = { l: side(s.insets.l), t: side(s.insets.t), r: side(s.insets.r), b: side(s.insets.b) };
  }
  if (s.lang !== undefined) out.lang = clampLang(s.lang);
  if (Array.isArray(s.fallbackFonts))
    out.fallbackFonts = s.fallbackFonts
      .slice(0, CLAMP.maxFallbackFonts)
      .map(clampFamily)
      .filter((f) => f !== '');
  if (s.fontStyle !== undefined) out.fontStyle = s.fontStyle === 'italic' ? 'italic' : 'normal';
  if (s.align !== undefined) out.align = pick(s.align, ALIGNS, 'left');
  if (s.valign !== undefined) out.valign = pick(s.valign, VALIGNS, 'top');
  if (s.direction !== undefined) out.direction = pick(s.direction, DIRECTIONS, 'auto');
  if (s.vert !== undefined) out.vert = pick(s.vert, VERTS, 'horz');
  return out;
}

function runStyle(v: unknown, fontSizePx: number, budget: FontBudget): TableRunStyle {
  if (!isObj(v)) return {};
  const [run] = clampRuns([{ ...v, start: 0, end: 1 }], 1, fontSizePx, budget);
  if (!run) return {};
  const { start: _s, end: _e, ...rest } = run;
  return rest;
}

function fill(v: unknown): TableFill {
  if (!isObj(v)) return { color: NO_COLOR };
  const out: TableFill = { color: clampColor(v.color, NO_COLOR) };
  const g = v.gradient === undefined ? undefined : clampGradient(v.gradient);
  if (g) out.gradient = g;
  return out;
}

function lineStyle(v: unknown): TableLineStyle {
  if (!isObj(v)) return { width: 0, color: NO_COLOR };
  const out: TableLineStyle = {
    width: num(v.width, 0, CLAMP.maxEffectPx, 1),
    color: clampColor(v.color, NO_COLOR),
  };
  if (v.dash !== undefined) out.dash = pick(v.dash, DASHES, 'solid');
  return out;
}

/** Edge segments of one direction within `edges` edge indices and `along` positions. */
function edgeList(
  v: unknown,
  edges: number,
  along: number,
  lines: number,
): [number, number, number, number][] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < v.length && out.length < TABLE_LIMITS.edges; i++) {
    const e = v[i];
    if (!Array.isArray(e) || e.length !== 4) continue;
    const at = int(e[0], 0, edges);
    const from = int(e[1], 0, TABLE_LIMITS.rows);
    const to = int(e[2], 0, TABLE_LIMITS.rows);
    const line = int(e[3], 0, lines - 1);
    if (at === undefined || from === undefined || to === undefined || line === undefined) continue;
    const end = Math.min(to, along);
    if (from >= end) continue;
    out.push([at, from, end, line]);
  }
  return out;
}

/** Running totals of the table's text, runs and paragraph styles, against `TABLE_LIMITS`' table bounds. */
type Totals = { chars: number; runs: number; paras: number };

function cell(
  v: unknown,
  t: Totals,
  pal: { styles: number; runStyles: number; fills: number; lines: number },
  budget: FontBudget,
): TableCell {
  if (!isObj(v)) return {};
  const c = v as Partial<TableCell>;
  const out: TableCell = {};
  const room = Math.max(0, Math.min(TABLE_LIMITS.cellText, TABLE_LIMITS.tableText - t.chars));
  const text = typeof c.text === 'string' ? (c.text.length > room ? c.text.slice(0, room) : c.text) : '';
  t.chars += text.length;
  if (typeof c.text === 'string' && (text || c.text === '')) out.text = text;
  if (Array.isArray(c.runs) && text) {
    const max = Math.min(TABLE_LIMITS.cellRuns, TABLE_LIMITS.tableRuns - t.runs);
    const runs: TableRun[] = [];
    let at = 0;
    for (let i = 0; i < c.runs.length && runs.length < max; i++) {
      const r = c.runs[i];
      if (!Array.isArray(r) || r.length !== 3) continue;
      const start = int(r[0], 0, TABLE_LIMITS.cellText);
      const end = int(r[1], 0, TABLE_LIMITS.cellText);
      const style = int(r[2], 0, pal.runStyles - 1);
      if (start === undefined || end === undefined || style === undefined) continue;
      if (start < at || start >= text.length || end <= start) continue;
      const cut = Math.min(end, text.length);
      runs.push([start, cut, style]);
      at = cut;
    }
    t.runs += runs.length;
    out.runs = runs;
  }
  if (Array.isArray(c.paras)) {
    const room = Math.max(0, Math.min(TABLE_LIMITS.cellParas, TABLE_LIMITS.tableParas - t.paras));
    const paras: (TextPara | null)[] = clampParas(c.paras.slice(0, room), text, budget);
    t.paras += paras.length;
    out.paras = paras;
  }
  const style = int(c.style, 0, pal.styles - 1);
  if (style !== undefined) out.style = style;
  const f = int(c.fill, 0, pal.fills - 1);
  if (f !== undefined) out.fill = f;
  const colSpan = int(c.colSpan, 1, TABLE_LIMITS.cols);
  if (colSpan !== undefined) out.colSpan = colSpan;
  const rowSpan = int(c.rowSpan, 1, TABLE_LIMITS.rows);
  if (rowSpan !== undefined) out.rowSpan = rowSpan;
  if (isObj(c.diag)) {
    const down = int(c.diag.down, 0, pal.lines - 1);
    const up = int(c.diag.up, 0, pal.lines - 1);
    if (down !== undefined || up !== undefined)
      out.diag = { ...(down !== undefined ? { down } : {}), ...(up !== undefined ? { up } : {}) };
  }
  return out;
}

/** `ShapeObject.table` made drawable (see the header), or undefined: the shape draws its legacy fields. */
export function clampTable(v: unknown): TableData | undefined {
  if (!isObj(v)) return undefined;
  const raw = v as Partial<TableData> & Record<string, unknown>;
  if (!Array.isArray(raw.cols) || !Array.isArray(raw.rows) || !Array.isArray(raw.cells) || !isObj(raw.base))
    return undefined;
  const cols = raw.cols.slice(0, TABLE_LIMITS.cols).map((w) => num(w, 0, MAX_COORD, 0));
  if (!cols.length || !(cols.reduce((s, w) => s + w, 0) > 0)) return undefined;
  const maxRows = Math.max(1, Math.min(TABLE_LIMITS.rows, Math.floor(TABLE_LIMITS.grid / cols.length)));
  const rows = raw.rows.slice(0, maxRows).map((h) => num(h, 0, MAX_COORD, 0));
  if (!rows.length) return undefined;
  const base = clampStyle(raw.base);
  const budget = new FontBudget();
  budget.family(base.fontFamily);
  const styles = palette(raw.styles, TABLE_LIMITS.cellStyles, (s) => cellStyle(s, budget));
  const runStyles = palette(raw.runStyles, TABLE_LIMITS.runStyles, (s) =>
    runStyle(s, base.fontSizePx, budget),
  );
  const fills = palette(raw.fills, TABLE_LIMITS.fills, fill);
  const lineStyles = palette(raw.lineStyles, TABLE_LIMITS.lineStyles, lineStyle);
  const pal = {
    styles: styles?.length ?? 0,
    runStyles: runStyles?.length ?? 0,
    fills: fills?.length ?? 0,
    lines: lineStyles?.length ?? 0,
  };
  const totals: Totals = { chars: 0, runs: 0, paras: 0 };
  const n = Math.min(raw.cells.length, TABLE_LIMITS.grid);
  const cells: TableCell[] = new Array(n);
  for (let i = 0; i < n; i++) cells[i] = cell(raw.cells[i], totals, pal, budget);
  const out: TableData = { cols, rows, cells, base };
  if (styles) out.styles = styles;
  if (runStyles) out.runStyles = runStyles;
  if (fills) out.fills = fills;
  if (lineStyles) out.lineStyles = lineStyles;
  const h = edgeList(raw.h, rows.length, cols.length, pal.lines);
  if (h) out.h = h;
  const ve = edgeList(raw.v, cols.length, rows.length, pal.lines);
  if (ve) out.v = ve;
  const background = int(raw.background, 0, pal.fills - 1);
  if (background !== undefined) out.background = background;
  if (raw.rtl === true) out.rtl = true;
  if (raw.rowRule !== undefined) out.rowRule = raw.rowRule === 'fixed' ? 'fixed' : 'grow';
  return out;
}

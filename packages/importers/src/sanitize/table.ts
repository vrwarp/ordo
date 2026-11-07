import {
  type CellStyle,
  TABLE_LIMITS,
  type TableCell,
  type TableData,
  type TableFill,
  type TableLineStyle,
  type TableRun,
  type TableRunStyle,
  type TextRun,
} from '@ordo/domain';
import {
  type FontBudget,
  IMPORT_LIMITS,
  clampColor,
  clampStyle,
  clipText,
  cutParas,
  cutRuns,
  finite,
  fontBudget,
  sanitizeGradient,
} from '../sanitize.ts';

/*
 * `ShapeObject.table` of an imported shape (design/27 M9) within the schema's bounds. Each cell's text is cut
 * to 10,000 characters with its runs and paragraph styles, as a text object's is, and the table's text to
 * 60,000 (later cells are emptied); runs stay inside their text, sorted, not overlapping and naming a run
 * style that exists; counts, numbers and palette indices are bounded. Enums are left to the schema's .catch.
 * One `FontBudget` serves the whole table, so it names no more families than one text box may.
 */

const COORD = 100_000;

const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;

/** A palette index below `n` (the palette's actual length), else undefined. */
const index = (v: unknown, n: number) => int(v, 0, n - 1);

function family(f: unknown, budget: FontBudget): string {
  return typeof f === 'string' ? budget.family(clipText(f, IMPORT_LIMITS.fontFamily)) : '';
}

function cellStyle(s: CellStyle, budget: FontBudget): CellStyle {
  const out: CellStyle = { ...s };
  if (s.fontFamily !== undefined) {
    const f = family(s.fontFamily, budget);
    if (f) out.fontFamily = f;
    else delete out.fontFamily;
  }
  if (s.fontWeight !== undefined) out.fontWeight = Math.round(finite(s.fontWeight, 400, 1, 1000));
  if (s.fontSizePx !== undefined)
    out.fontSizePx = finite(s.fontSizePx, 32, IMPORT_LIMITS.fontSizeMin, IMPORT_LIMITS.fontSizeMax);
  if (s.color) out.color = clampColor(s.color);
  if (s.insets) {
    const side = (v: unknown) => finite(v, 0, 0, 500);
    out.insets = { l: side(s.insets.l), t: side(s.insets.t), r: side(s.insets.r), b: side(s.insets.b) };
  }
  if (s.lang !== undefined) out.lang = clipText(s.lang, 35);
  if (s.fallbackFonts !== undefined)
    out.fallbackFonts = (Array.isArray(s.fallbackFonts) ? s.fallbackFonts : [])
      .slice(0, IMPORT_LIMITS.fallbackFonts)
      .map((f) => clipText(f, IMPORT_LIMITS.fontFamily))
      .filter((f) => f.trim() !== '');
  return out;
}

/** A run style bounded as a text run is (`cutRuns`, with the table's font budget). */
function runStyle(s: TableRunStyle, fontSizePx: number, budget: FontBudget): TableRunStyle {
  const [run] = cutRuns([{ ...s, start: 0, end: 1 } as TextRun], 1, fontSizePx, budget);
  if (!run) return {};
  const { start: _s, end: _e, ...rest } = run;
  return rest;
}

/**
 * A cell's runs over a text of `len` units: sorted, not overlapping, each starting before `len` (its end cut
 * to it) and naming one of `styles` run styles; at most `max`.
 */
function cellRuns(runs: unknown, len: number, styles: number, max: number): TableRun[] {
  const out: TableRun[] = [];
  if (!Array.isArray(runs)) return out;
  let at = 0;
  for (const r of runs) {
    if (out.length >= max) break;
    if (!Array.isArray(r) || r.length !== 3) continue;
    const [start, end, style] = r as unknown[];
    if (!Number.isInteger(start) || !Number.isInteger(end) || index(style, styles) === undefined) continue;
    const s = start as number;
    const e = end as number;
    if (s < at || s >= len || e <= s) continue;
    const cut = Math.min(e, len);
    out.push([s, cut, style as number]);
    at = cut;
  }
  return out;
}

function fill(f: TableFill): TableFill {
  const out: TableFill = { ...f, color: clampColor(f.color) };
  if (f.gradient) {
    const g = sanitizeGradient(f.gradient);
    if (g) out.gradient = g;
    else delete out.gradient;
  }
  return out;
}

function lineStyle(l: TableLineStyle): TableLineStyle {
  return { ...l, width: finite(l.width, 1, 0, 500), color: clampColor(l.color) };
}

/** Edge segments [edge, from, to, line] of integers in range with from < to; at most `TABLE_LIMITS.edges`. */
function edges(list: unknown, lines: number): [number, number, number, number][] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: [number, number, number, number][] = [];
  for (const e of list) {
    if (out.length >= TABLE_LIMITS.edges) break;
    if (!Array.isArray(e) || e.length !== 4) continue;
    const [at, from, to, line] = e.map((v) => int(v, 0, TABLE_LIMITS.rows));
    if (at === undefined || from === undefined || to === undefined || from >= to) continue;
    if (line === undefined || line >= lines) continue;
    out.push([at, from, to, line]);
  }
  return out;
}

export function sanitizeTable(t: TableData): TableData | undefined {
  if (!t || typeof t !== 'object' || !Array.isArray(t.cols) || !Array.isArray(t.rows)) return undefined;
  const cols = t.cols.slice(0, TABLE_LIMITS.cols).map((w) => finite(w, 0, 0, COORD));
  const rows = t.rows.slice(0, TABLE_LIMITS.rows).map((h) => finite(h, 0, 0, COORD));
  if (!cols.length || !rows.length || !t.base || typeof t.base !== 'object') return undefined;
  const base = clampStyle(t.base);
  const budget = fontBudget();
  const out: TableData = { ...t, cols, rows, base };
  const list = <T, U>(v: T[] | undefined, max: number, f: (x: T) => U): U[] | undefined =>
    Array.isArray(v)
      ? v
          .filter((x) => x && typeof x === 'object')
          .slice(0, max)
          .map(f)
      : undefined;
  const styles = list(t.styles, TABLE_LIMITS.cellStyles, (s) => cellStyle(s, budget));
  const runStyles = list(t.runStyles, TABLE_LIMITS.runStyles, (s) => runStyle(s, base.fontSizePx, budget));
  const fills = list(t.fills, TABLE_LIMITS.fills, fill);
  const lineStyles = list(t.lineStyles, TABLE_LIMITS.lineStyles, lineStyle);
  const put = <K extends keyof TableData>(k: K, v: TableData[K] | undefined) => {
    if (v === undefined) delete out[k];
    else out[k] = v;
  };
  put('styles', styles);
  put('runStyles', runStyles);
  put('fills', fills);
  put('lineStyles', lineStyles);
  put('h', edges(t.h, lineStyles?.length ?? 0));
  put('v', edges(t.v, lineStyles?.length ?? 0));
  put('background', index(t.background, fills?.length ?? 0));
  if (t.rtl !== undefined && typeof t.rtl !== 'boolean') delete out.rtl;
  // Cells: the text cut per cell and per table, runs and paras with it.
  const cells: TableCell[] = [];
  let chars = 0;
  let runs = 0;
  let paras = 0;
  for (const c of Array.isArray(t.cells) ? t.cells : []) {
    if (cells.length >= TABLE_LIMITS.grid) break;
    if (!c || typeof c !== 'object') {
      cells.push({});
      continue;
    }
    const cell: TableCell = { ...c };
    const room = Math.max(0, Math.min(TABLE_LIMITS.cellText, TABLE_LIMITS.tableText - chars));
    const text = clipText(c.text, room);
    chars += text.length;
    if (text) {
      cell.text = text;
      const r = cellRuns(
        c.runs,
        text.length,
        runStyles?.length ?? 0,
        Math.min(TABLE_LIMITS.cellRuns, TABLE_LIMITS.tableRuns - runs),
      );
      runs += r.length;
      if (r.length) cell.runs = r;
      else delete cell.runs;
      if (Array.isArray(c.paras)) {
        const room = Math.min(TABLE_LIMITS.cellParas, TABLE_LIMITS.tableParas - paras);
        const p = cutParas(c.paras.slice(0, room), text, budget);
        paras += p.length;
        if (p.length) cell.paras = p;
        else delete cell.paras;
      } else delete cell.paras;
    } else {
      delete cell.text;
      delete cell.runs;
      delete cell.paras;
    }
    const keep = <K extends 'style' | 'fill'>(k: K, n: number) => {
      const i = index(c[k], n);
      if (i === undefined) delete cell[k];
      else cell[k] = i;
    };
    keep('style', styles?.length ?? 0);
    keep('fill', fills?.length ?? 0);
    const span = (k: 'colSpan' | 'rowSpan', max: number) => {
      if (c[k] === undefined) return;
      const v = int(c[k], 1, max);
      if (v === undefined) delete cell[k];
      else cell[k] = v;
    };
    span('colSpan', TABLE_LIMITS.cols);
    span('rowSpan', TABLE_LIMITS.rows);
    if (c.diag !== undefined) {
      const n = lineStyles?.length ?? 0;
      const down = c.diag && typeof c.diag === 'object' ? index(c.diag.down, n) : undefined;
      const up = c.diag && typeof c.diag === 'object' ? index(c.diag.up, n) : undefined;
      if (down === undefined && up === undefined) delete cell.diag;
      else cell.diag = { ...(down !== undefined ? { down } : {}), ...(up !== undefined ? { up } : {}) };
    }
    cells.push(cell);
  }
  out.cells = cells;
  return out;
}

import type { Box, ShapeObject, TextObject } from '@ordo/domain';
import { CLAMP, num } from '../clamp.ts';
import { insetsOf } from '../text/lines.ts';
import { clampTextObject, layoutRich } from '../text/rich.ts';
import type { FontEnv, Measurer, RichLayout } from '../text/types.ts';
import { type TableModel, cellIsVertical, cellStyleIndex, cellText, tableModelOf } from './model.ts';

/*
 * A table's layout (design/27 M9 tables, tables-object.md §4.5), in table-local logical px: from the table
 * box's top-left corner, unrotated (`drawTable` places it as `placeBox` places a shape).
 *
 * Row rule (LibreOffice's `TableLayouter` and PowerPoint's growth): column c is `cols[c] × box.w / Σcols`
 * wide (column 0 on the right when `rtl`); row r is at least `rows[r] × box.h / Σrows` tall; a cell needs its
 * text's height, laid out by the rich text engine at the cell's width less its left and right insets, plus
 * its top and bottom insets (an empty cell one line of its style's size); a row grows to the largest need of
 * its single-row cells, then each merged cell's need beyond its rows goes to its last row. `rowRule: 'fixed'`
 * keeps the rows as stored. Cells never shrink their text: text taller than a fixed row overflows it, upwards
 * and downwards as its anchor says, as LibreOffice draws it. A cell asking for vertical text is laid out
 * horizontally for now (the vertical text engine takes cells over in M9 wave 3) and grows its row as any.
 *
 * Cost: each cell is laid out once for its content and width, whatever table or slide it is in, and kept in a
 * bounded cache by that content (its text, its runs and paragraph styles, a digest of its resolved style and
 * of the run palette, and its width): editing one cell lays out that cell only, the 640 empty cells of a
 * master grid are one layout. A table's layout is memoised by identity, and whole tables by their content and
 * box size (a slide sent to a worker again is a new object that lays out nothing and builds no cell key). `prepareTableLayout` lays a table's cells out in slices of a few milliseconds before
 * the synchronous draw (the asset worker's lanes, design/27 §13's 50 ms task).
 */

export type TableCellLayout = {
  /** The cell's index in `TableData.cells`. */
  index: number;
  row: number;
  col: number;
  rows: number;
  cols: number;
  /** The cell's rect, table-local logical px. */
  box: Box;
  /** The clamped text object the cell is drawn as, laid out at (0, 0) with its text anchored at the top. */
  text: TextObject;
  layout: RichLayout;
  /** How far down the laid text moves within the cell for its vertical anchor (negative: it overflows up). */
  dy: number;
  /** The laid text's height (its lines), without the insets. */
  textHeight: number;
};

export type TableLayout = {
  model: TableModel;
  /** The x of each column edge (C + 1), table-local: increasing, or decreasing from the right when `rtl`. */
  colX: Float64Array;
  /** The y of each row edge (R + 1), rows grown. */
  rowY: Float64Array;
  /** The drawn width (box.w) and height (≥ box.h when text grows rows). */
  width: number;
  height: number;
  /** The placed cells, in cell order. */
  cells: TableCellLayout[];
  /** Per stored cell: its index in `cells`, or -1 (a cell past the grid). */
  cellAt: Int32Array;
};

// ── The cell layout cache ───────────────────────────────────────────────────────────────────────────────

/** Cells kept laid out, and the characters of their keys (each key holds its cell's text). */
export const CELL_CACHE = { entries: 8_192, chars: 4_000_000 } as const;

const views = new Map<string, TextObject>();
let cachedChars = 0;

/** Empties the cell layout cache and the whole-table one (tests and benches). */
export function clearTableCache(): void {
  views.clear();
  cachedChars = 0;
  tables.clear();
  tableChars = 0;
}

/** Cells in the layout cache. */
export function tableCacheSize(): number {
  return views.size;
}

/** The cell view for `key`, made by `make` once and kept (least recently used out first). */
function cachedView(key: string, make: () => TextObject): TextObject {
  const hit = views.get(key);
  if (hit) {
    views.delete(key);
    views.set(key, hit);
    return hit;
  }
  const v = make();
  views.set(key, v);
  cachedChars += key.length;
  while (views.size > CELL_CACHE.entries || cachedChars > CELL_CACHE.chars) {
    const oldest = views.keys().next();
    if (oldest.done) break;
    views.delete(oldest.value);
    cachedChars -= oldest.value.length;
  }
  return v;
}

/** Cell `i` laid out at width `w` (logical px), its text at the top: the cached view, its layout and height. */
function laidCell(
  meas: Measurer,
  env: FontEnv,
  m: TableModel,
  i: number,
  w: number,
): { text: TextObject; layout: RichLayout; height: number } {
  const c = m.t.cells[i]!;
  const si = cellStyleIndex(m, i);
  const key = `${w}\u0001${m.styleKeys[si]}\u0001${c.runs ? m.runKey + JSON.stringify(c.runs) : ''}\u0001${
    c.paras ? JSON.stringify(c.paras) : ''
  }\u0001${c.text ?? ''}`;
  const text = cachedView(key, () => {
    const raw = cellText(m, i, { x: 0, y: 0, w, h: 0, rotation: 0 })!;
    return clampTextObject({ ...raw, id: 'cell', style: { ...raw.style, valign: 'top' } });
  });
  const layout = layoutRich(meas, text, env);
  const first = layout.lines[0];
  const last = layout.lines[layout.lines.length - 1];
  const height = first && last ? last.top + last.height - first.top : 0;
  return { text, layout, height };
}

// ── Geometry ────────────────────────────────────────────────────────────────────────────────────────────

/** Column widths at the box width, their left edges (LTR) and the minimum row heights at the box height. */
function grid(
  o: ShapeObject,
  m: TableModel,
): { colW: Float64Array; left: Float64Array; rowMin: Float64Array } {
  const { R, C } = m.placement;
  const t = m.t;
  let sumC = 0;
  for (let c = 0; c < C; c++) sumC += t.cols[c]!;
  let sumR = 0;
  for (let r = 0; r < R; r++) sumR += t.rows[r]!;
  const sx = sumC > 0 ? o.box.w / sumC : 0;
  const sy = sumR > 0 ? o.box.h / sumR : 0;
  const colW = new Float64Array(C);
  const left = new Float64Array(C + 1);
  for (let c = 0; c < C; c++) {
    colW[c] = t.cols[c]! * sx;
    left[c + 1] = left[c]! + colW[c]!;
  }
  const rowMin = new Float64Array(R);
  for (let r = 0; r < R; r++) rowMin[r] = t.rows[r]! * sy;
  return { colW, left, rowMin };
}

type Laid = { m: Measurer; env: FontEnv; generation: number; l: TableLayout };

const layouts = new WeakMap<ShapeObject, Laid>();

/** Whole tables laid out, by their content and box size, and the characters of their keys. */
export const TABLE_CACHE = { entries: 32, chars: 2_000_000 } as const;

const tables = new Map<string, Laid>();
let tableChars = 0;

/**
 * The layout already made of a table equal to `o`'s (by identity, else by its content and box size: a slide
 * sent to a worker again is a new object) for this measurer and font generation, or undefined. Returns the key
 * a new layout is kept under.
 */
function laidBefore(meas: Measurer, o: ShapeObject, env: FontEnv): { l?: TableLayout; key: string } {
  const valid = (x: Laid | undefined) =>
    x && x.m === meas && x.env === env && x.generation === env.generation ? x.l : undefined;
  const hit = valid(layouts.get(o));
  if (hit) return { l: hit, key: '' };
  const key = `${o.box.w}\u0001${o.box.h}\u0001${JSON.stringify(o.table)}`;
  const same = tables.get(key);
  const l = valid(same);
  if (l && same) {
    tables.delete(key);
    tables.set(key, same);
    layouts.set(o, same);
  }
  return { l, key };
}

function keepLaid(o: ShapeObject, key: string, laid: Laid): void {
  layouts.set(o, laid);
  if (!key || key.length > TABLE_CACHE.chars) return;
  const old = tables.get(key);
  if (old) tables.delete(key);
  else tableChars += key.length;
  tables.set(key, laid);
  while (tables.size > TABLE_CACHE.entries || tableChars > TABLE_CACHE.chars) {
    const oldest = tables.keys().next();
    if (oldest.done) break;
    tables.delete(oldest.value);
    tableChars -= oldest.value.length;
  }
}

/**
 * Lay out a clamped table shape (`clampShapeObject` output) in table-local logical px (see the header).
 * Pure for the same object (or an equal one of the same box size), measurer and font generation, and
 * memoised: by identity, then by content (a bounded cache of whole tables), then cell by cell. Undefined
 * without a table, or for one whose grid is empty.
 */
export function layoutTable(meas: Measurer, o: ShapeObject, env: FontEnv): TableLayout | undefined {
  const t = o.table;
  if (!t) return undefined;
  const before = laidBefore(meas, o, env);
  if (before.l) return before.l;
  const m = tableModelOf(t);
  const { R, C, anchors } = m.placement;
  if (!R || !C) return undefined;
  const { left, rowMin } = grid(o, m);
  const W = left[C]!;
  const cells: TableCellLayout[] = [];
  const cellAt = new Int32Array(t.cells.length).fill(-1);
  const need = new Float64Array(t.cells.length);
  for (let i = 0; i < t.cells.length; i++) {
    const a = anchors[i];
    if (!a) continue;
    const w = left[a.col + a.cols]! - left[a.col]!;
    const laid = laidCell(meas, env, m, i, w);
    const ins = insetsOf(laid.text.style);
    need[i] = laid.height + ins.t + ins.b;
    cellAt[i] = cells.length;
    cells.push({
      index: i,
      ...a,
      box: { x: 0, y: 0, w, h: 0, rotation: 0 },
      text: laid.text,
      layout: laid.layout,
      dy: 0,
      textHeight: laid.height,
    });
  }
  const rowH = Float64Array.from(rowMin);
  if (t.rowRule !== 'fixed') {
    for (const c of cells) if (c.rows === 1 && need[c.index]! > rowH[c.row]!) rowH[c.row] = need[c.index]!;
    const merged = cells.filter((c) => c.rows > 1).sort((p, q) => p.row + p.rows - (q.row + q.rows));
    for (const c of merged) {
      let have = 0;
      for (let r = c.row; r < c.row + c.rows; r++) have += rowH[r]!;
      const extra = need[c.index]! - have;
      if (extra > 0) rowH[c.row + c.rows - 1]! += extra;
    }
  }
  const rowY = new Float64Array(R + 1);
  for (let r = 0; r < R; r++) rowY[r + 1] = rowY[r]! + rowH[r]!;
  const colX = new Float64Array(C + 1);
  for (let k = 0; k <= C; k++) colX[k] = t.rtl ? W - left[k]! : left[k]!;
  for (const c of cells) {
    const x = t.rtl ? W - left[c.col + c.cols]! : left[c.col]!;
    const y = rowY[c.row]!;
    const h = rowY[c.row + c.rows]! - y;
    c.box = { x, y, w: c.box.w, h, rotation: 0 };
    // As `layoutBox` anchors a box's text in its inner height (lines.ts), from the top inset the layout has.
    const ins = insetsOf(c.text.style);
    const innerH = Math.max(1, h - ins.t - ins.b);
    const valign = m.styles[cellStyleIndex(m, c.index)]!.valign;
    c.dy = valign === 'top' ? 0 : valign === 'bottom' ? innerH - c.textHeight : (innerH - c.textHeight) / 2;
  }
  const l: TableLayout = { model: m, colX, rowY, width: W, height: rowY[R]!, cells, cellAt };
  keepLaid(o, before.key, { m: meas, env, generation: env.generation, l });
  return l;
}

/**
 * One stroke of a table's lines: the segments of one line style (of one direction too, when the table has
 * more than one style), as `[ax, ay, bx, by]` quadruples in table-local px, each stretched at its ends by half
 * the widest line of the other direction through that grid vertex, so corners close.
 */
export type TableStroke = { line: number; segs: number[] };

const strokes = new WeakMap<TableLayout, TableStroke[]>();

/**
 * The lines a laid-out table draws, in drawing order (the M6 group's: one stroke per line style, per style and
 * direction, horizontal first, when there is more than one style), memoised per layout. A stored edge inside a
 * merged cell is not drawn (a merged cell has no lines inside it, as the converter and the table ops write
 * it). Linear in the stored edges' lengths: a per-vertex array of the widest line each way, where M6 compared
 * every pair of lines.
 */
export function tableStrokes(l: TableLayout): TableStroke[] {
  const hit = strokes.get(l);
  if (hit) return hit;
  const t = l.model.t;
  const styles = t.lineStyles ?? [];
  const R = l.rowY.length - 1;
  const C = l.colX.length - 1;
  // Edge slots inside merged cells.
  const hIn = new Uint8Array((R + 1) * C);
  const vIn = new Uint8Array((C + 1) * R);
  for (const c of l.cells) {
    for (let k = c.row + 1; k < c.row + c.rows; k++) hIn.fill(1, k * C + c.col, k * C + c.col + c.cols);
    for (let k = c.col + 1; k < c.col + c.cols; k++) vIn.fill(1, k * R + c.row, k * R + c.row + c.rows);
  }
  type Edge = [number, number, number, number];
  const visible = (list: readonly Edge[] | undefined, edgesN: number, along: number, inner: Uint8Array) => {
    const out: Edge[] = [];
    for (const [k, from, to, li] of list ?? []) {
      if (k > edgesN || !styles[li]) continue;
      let x = Math.max(0, from);
      const end = Math.min(to, along);
      while (x < end) {
        while (x < end && inner[k * along + x]) x++;
        let y = x;
        while (y < end && !inner[k * along + y]) y++;
        if (y > x) out.push([k, x, y, li]);
        x = y;
      }
    }
    return out;
  };
  const h = visible(t.h, R, C, hIn);
  const v = visible(t.v, C, R, vIn);
  const width = (li: number) => num(styles[li]?.width, 0, CLAMP.maxEffectPx, 0);
  // The widest line of each direction through each grid vertex (a segment covers both its end vertices).
  const vW = new Float32Array((C + 1) * (R + 1));
  const hW = new Float32Array((R + 1) * (C + 1));
  for (const [k, from, to, li] of v)
    for (let r = from; r <= to; r++) if (width(li) > vW[k * (R + 1) + r]!) vW[k * (R + 1) + r] = width(li);
  for (const [k, from, to, li] of h)
    for (let c = from; c <= to; c++) if (width(li) > hW[k * (C + 1) + c]!) hW[k * (C + 1) + c] = width(li);
  const used = new Set<number>();
  for (const e of h) used.add(e[3]);
  for (const e of v) used.add(e[3]);
  const byDir = used.size > 1;
  const out: TableStroke[] = [];
  const byKey = new Map<string, TableStroke>();
  for (const [dir, list] of [
    ['h', h],
    ['v', v],
  ] as const)
    for (const [k, from, to, li] of list) {
      const key = `${byDir ? dir : ''}${li}`;
      let s = byKey.get(key);
      if (!s) {
        s = { line: li, segs: [] };
        byKey.set(key, s);
        out.push(s);
      }
      let ax: number;
      let ay: number;
      let bx: number;
      let by: number;
      let e0: number;
      let e1: number;
      if (dir === 'h') {
        ay = by = l.rowY[k]!;
        ax = l.colX[from]!;
        bx = l.colX[to]!;
        e0 = vW[from * (R + 1) + k]! / 2;
        e1 = vW[to * (R + 1) + k]! / 2;
      } else {
        ax = bx = l.colX[k]!;
        ay = l.rowY[from]!;
        by = l.rowY[to]!;
        e0 = hW[from * (C + 1) + k]! / 2;
        e1 = hW[to * (C + 1) + k]! / 2;
      }
      const len = Math.hypot(bx - ax, by - ay);
      if (len > 0) {
        const ux = (bx - ax) / len;
        const uy = (by - ay) / len;
        ax -= ux * e0;
        ay -= uy * e0;
        bx += ux * e1;
        by += uy * e1;
      }
      s.segs.push(ax, ay, bx, by);
    }
  strokes.set(l, out);
  return out;
}

const progress = new WeakMap<ShapeObject, { generation: number; next: number }>();

/**
 * Lay out the cells of a clamped table shape that are not laid out yet, for about `budgetMs` at most (a cell
 * once started is finished): true once every cell is, after which `layoutTable` lays out none. Called again
 * for the same object, it goes on where it stopped.
 */
export function prepareTableLayout(
  meas: Measurer,
  o: ShapeObject,
  env: FontEnv,
  budgetMs = 8,
  now: () => number = () => performance.now(),
): boolean {
  const t = o.table;
  if (!t) return true;
  if (laidBefore(meas, o, env).l) return true;
  const m = tableModelOf(t);
  const { anchors } = m.placement;
  const { left } = grid(o, m);
  const at = progress.get(o);
  let i = at && at.generation === env.generation ? at.next : 0;
  const t0 = now();
  for (; i < t.cells.length; i++) {
    const a = anchors[i];
    if (!a) continue;
    laidCell(meas, env, m, i, left[a.col + a.cols]! - left[a.col]!);
    if (now() - t0 >= budgetMs && i + 1 < t.cells.length) {
      progress.set(o, { generation: env.generation, next: i + 1 });
      return false;
    }
  }
  progress.delete(o);
  layoutTable(meas, o, env);
  return true;
}

/** Whether a table has cells asking for vertical text (drawn horizontally until wave 3). */
export function tableHasVertical(o: ShapeObject): boolean {
  if (!o.table) return false;
  const m = tableModelOf(o.table);
  for (let i = 0; i < o.table.cells.length; i++) if (cellIsVertical(m, i)) return true;
  return false;
}

import type { Box, ShapeGeom, ShapeObject, SlideObject, TextObject } from '@ordo/domain';
import { GEOM_LIMITS } from '../geom/ops.ts';
import { cellStyleIndex } from './model.ts';
import { type TableLayout, tableStrokes } from './layout.ts';

/*
 * A table as the M6 group of shapes and text boxes (design/27 §15 M6 tables), made from its layout: what
 * ordo drew for a table before M9. Not stored (M9 decision 4: no legacy group is written next to a table
 * object); it is the reference the `table-vs-group` golden and the table bench compare the object with:
 * - the background as a rect over the drawn table;
 * - each solid fill as one shape of rect sub-paths (neighbours of a row joined), fills by their bounding box,
 *   largest first; a gradient fill in its first colour, as M6 drew it;
 * - each line style as one shape of open sub-paths stretched at their ends by half the widest line across,
 *   per direction (horizontal first) when the table has more than one style; at least 0.5 px wide;
 * - one rich text box per cell at its grown rows, turned with the table (its text fits the rows, so the
 *   group's shrink-to-fit would change nothing: it is left out).
 * Diagonals are left out, as M6 had none.
 */

/** A coordinate as the M6 group wrote it: at most three decimals, never -0. */
function n(v: number): string {
  return String(Number((Number.isFinite(v) ? v : 0).toFixed(3)) + 0);
}

/** Sub-paths of `per` items each, at most `GEOM_LIMITS.paths` paths an object. */
function chunks<T>(items: T[], per: number): T[][][] {
  const out: T[][][] = [];
  for (let i = 0; i < items.length; i += per * GEOM_LIMITS.paths) {
    const obj: T[][] = [];
    for (let j = i; j < Math.min(items.length, i + per * GEOM_LIMITS.paths); j += per)
      obj.push(items.slice(j, Math.min(j + per, i + per * GEOM_LIMITS.paths, items.length)));
    out.push(obj);
  }
  return out;
}

const RECTS_PER_PATH = Math.min(Math.floor(GEOM_LIMITS.points / 5), 360);
const LINES_PER_PATH = Math.min(Math.floor(GEOM_LIMITS.points / 2), 760);

/** The M6 group of a clamped table shape laid out as `l` (see the header). */
export function legacyGroup(o: ShapeObject, l: TableLayout): SlideObject[] {
  const t = l.model.t;
  const out: SlideObject[] = [];
  let id = 0;
  const box: Box = { x: o.box.x, y: o.box.y, w: l.width, h: l.height, rotation: o.box.rotation };
  const origin = (role: string) => ({
    src: 'pptx',
    role,
    ...(o.origin?.group !== undefined ? { group: o.origin.group } : {}),
  });
  const shape = (extra: Partial<ShapeObject>): ShapeObject => ({
    id: `${o.id}-g${id++}`,
    type: 'shape',
    box,
    shape: 'rect',
    opacity: 1,
    radius: 0,
    origin: origin('grid'),
    locked: true,
    ...extra,
  });
  const fills = t.fills ?? [];
  const bg = t.background === undefined ? undefined : fills[t.background];
  if (bg) out.push(shape({ fill: bg.color }));
  // Fills: as drawTable groups them.
  type Group = { fill: number; rects: [number, number, number, number][]; area: number; first: number };
  const groups = new Map<number, Group & { b: number[] }>();
  let last: { fill: number; row: number; colEnd: number; rect: [number, number, number, number] } | undefined;
  for (const c of l.cells) {
    const k = t.cells[c.index]!.fill;
    if (k === undefined || !fills[k]) {
      last = undefined;
      continue;
    }
    let g = groups.get(k);
    if (!g)
      groups.set(
        k,
        (g = { fill: k, rects: [], area: 0, first: groups.size, b: [c.row, c.col, c.row, c.col] }),
      );
    g.b = [
      Math.min(g.b[0]!, c.row),
      Math.min(g.b[1]!, c.col),
      Math.max(g.b[2]!, c.row + c.rows),
      Math.max(g.b[3]!, c.col + c.cols),
    ];
    const rect: [number, number, number, number] = [c.box.x, c.box.y, c.box.w, c.box.h];
    if (last && last.fill === k && c.rows === 1 && last.row === c.row && last.colEnd === c.col) {
      const p = last.rect;
      const x0 = Math.min(p[0], rect[0]);
      p[2] = Math.max(p[0] + p[2], rect[0] + rect[2]) - x0;
      p[0] = x0;
      last.colEnd = c.col + c.cols;
      continue;
    }
    g.rects.push(rect);
    last = c.rows === 1 ? { fill: k, row: c.row, colEnd: c.col + c.cols, rect } : undefined;
  }
  for (const g of groups.values()) g.area = (g.b[2]! - g.b[0]!) * (g.b[3]! - g.b[1]!);
  for (const g of [...groups.values()].sort((p, q) => q.area - p.area || p.first - q.first)) {
    const color = fills[g.fill]!.color;
    for (const obj of chunks(g.rects, RECTS_PER_PATH)) {
      const paths: NonNullable<ShapeGeom['paths']> = obj.map((rects, k) => ({
        d: rects
          .map(
            ([x, y, w, h]) =>
              `M ${n(x)} ${n(y)} L ${n(x + w)} ${n(y)} L ${n(x + w)} ${n(y + h)} L ${n(x)} ${n(y + h)} Z`,
          )
          .join(' '),
        w: box.w,
        h: box.h,
        stroke: false,
        ...(k > 0 ? { cont: true } : {}),
      }));
      out.push(shape({ fill: color, geom: { paths } }));
    }
  }
  // Lines.
  const styles = t.lineStyles ?? [];
  for (const stroke of tableStrokes(l)) {
    const s = styles[stroke.line];
    if (!s || !(s.color.a > 0)) continue;
    const segs: string[] = [];
    const q = stroke.segs;
    for (let i = 0; i < q.length; i += 4)
      segs.push(`M ${n(q[i]!)} ${n(q[i + 1]!)} L ${n(q[i + 2]!)} ${n(q[i + 3]!)}`);
    for (const obj of chunks(segs, LINES_PER_PATH)) {
      const paths: NonNullable<ShapeGeom['paths']> = obj.map((list, k) => ({
        d: list.join(' '),
        w: box.w,
        h: box.h,
        fill: 'none',
        ...(k > 0 ? { cont: true } : {}),
      }));
      out.push(shape({ stroke: { width: Math.max(s.width, 0.5), color: s.color }, geom: { paths } }));
    }
  }
  // Cell text.
  const cx = o.box.x + o.box.w / 2;
  const cy = o.box.y + o.box.h / 2;
  const a = ((o.box.rotation || 0) * Math.PI) / 180;
  for (const c of l.cells) {
    const tc = t.cells[c.index]!;
    if (!tc.text) continue;
    // The cell's centre on the slide, turned with the table about the table box's centre.
    const ux = o.box.x + c.box.x + c.box.w / 2 - cx;
    const uy = o.box.y + c.box.y + c.box.h / 2 - cy;
    const px = cx + ux * Math.cos(a) - uy * Math.sin(a);
    const py = cy + ux * Math.sin(a) + uy * Math.cos(a);
    const cell: TextObject = {
      id: `${o.id}-c${c.index}`,
      type: 'text',
      box: { x: px - c.box.w / 2, y: py - c.box.h / 2, w: c.box.w, h: c.box.h, rotation: o.box.rotation },
      text: c.text.text,
      style: l.model.styles[cellStyleIndex(l.model, c.index)]!,
      opacity: 1,
      origin: origin('cell'),
    };
    if (c.text.runs) cell.runs = c.text.runs;
    if (c.text.paras) cell.paras = c.text.paras;
    out.push(cell);
  }
  return out;
}

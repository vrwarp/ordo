import { type ShapeObject, type TableFill, type TableLineStyle, rgbaCss } from '@ordo/domain';
import { CLAMP, num } from '../clamp.ts';
import type { Ctx2D } from '../ctx.ts';
import type { GeomSpacePaint, GeomStyle } from '../geom/draw.ts';
import { DASH_PATTERNS } from '../geom/outline.ts';
import { gradientStyle } from '../geom/paint.ts';
import { currentFontEnv } from '../text/fonts.ts';
import { measurerFor } from '../text/measure.ts';
import { paintRich } from '../text/paint.ts';
import { type TableLayout, layoutTable, tableStrokes } from './layout.ts';

/*
 * Drawing a table (design/27 M9 tables, tables-object.md §4.5), in M6's order, so a table drawn as one object
 * matches the M6 group of shapes and text boxes wherever their rows agree (golden `table-vs-group`):
 * 1. the background (`TableData.background`) over the drawn table (its grown height);
 * 2. cell fills: the cells of one solid fill as one path of rects (neighbours of a row as one rect, M6's fill
 *    runs), fills in order of their cells' bounding box, largest first; a gradient fill per cell over the
 *    cell's box (the M6 group drew it in its first colour);
 * 3. lines (`tableStrokes`): one stroke per line style (per style and direction, horizontal first, when the
 *    table has more than one), each segment stretched at its ends by half the widest line of the other
 *    direction through that grid vertex, so corners close; none inside a merged cell; at least 0.5 px wide (a
 *    0 width is a hairline), dashed by the shape dash patterns, flat caps;
 * 4. diagonals (a:lnTlToBr, a:lnBlToTr);
 * 5. each cell's text through the rich engine's painter, at its cell's corner moved by its anchor.
 * The table is turned about its box's centre and drawn at its opacity; flips do not apply to tables.
 */

type Rect = [x: number, y: number, w: number, h: number];

function isSpacePaint(v: GeomStyle | GeomSpacePaint): v is GeomSpacePaint {
  return typeof v === 'object' && v !== null && 'transform' in v && 'style' in v;
}

/** Fills a rect (table-local px) with a table fill: its gradient over the rect, else its colour. */
function fillRect(ctx: Ctx2D, f: TableFill, r: Rect): void {
  const [x, y, w, h] = r;
  if (!(w > 0 && h > 0)) return;
  if (!f.gradient) {
    if (f.color.a <= 0) return;
    ctx.fillStyle = rgbaCss(f.color);
    ctx.fillRect(x, y, w, h);
    return;
  }
  const g = gradientStyle(ctx, f.gradient, w, h, 0);
  ctx.save();
  ctx.translate(x, y);
  if (isSpacePaint(g)) {
    // A paint in its own space (an elliptical radial gradient as a circle): the rect mapped into it.
    const [a, b, c, d, e, f2] = g.transform;
    if (b === 0 && c === 0 && a !== 0 && d !== 0) {
      ctx.transform(a, b, c, d, e, f2);
      ctx.fillStyle = g.style;
      ctx.fillRect(-e / a, -f2 / d, w / a, h / d);
    }
  } else {
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

/** Background and cell fills (steps 1 and 2 of the header). */
function drawFills(ctx: Ctx2D, l: TableLayout): void {
  const t = l.model.t;
  const fills = t.fills ?? [];
  const bg = t.background === undefined ? undefined : fills[t.background];
  if (bg) fillRect(ctx, bg, [0, 0, l.width, l.height]);
  type Group = { fill: TableFill; rects: Rect[]; box: [number, number, number, number]; first: number };
  const groups = new Map<number, Group>();
  let last: { fill: number; row: number; colEnd: number; rect: Rect } | undefined;
  for (const c of l.cells) {
    const k = t.cells[c.index]!.fill;
    const f = k === undefined ? undefined : fills[k];
    if (k === undefined || !f) {
      last = undefined;
      continue;
    }
    let g = groups.get(k);
    if (!g)
      groups.set(k, (g = { fill: f, rects: [], box: [c.row, c.col, c.row, c.col], first: groups.size }));
    const b = g.box;
    b[0] = Math.min(b[0], c.row);
    b[1] = Math.min(b[1], c.col);
    b[2] = Math.max(b[2], c.row + c.rows);
    b[3] = Math.max(b[3], c.col + c.cols);
    const rect: Rect = [c.box.x, c.box.y, c.box.w, c.box.h];
    // A neighbour in the row with the same solid fill joins the rect before it (M6's fill runs).
    if (
      !f.gradient &&
      last &&
      last.fill === k &&
      c.rows === 1 &&
      last.row === c.row &&
      last.colEnd === c.col
    ) {
      const p = last.rect;
      const x0 = Math.min(p[0], rect[0]);
      const x1 = Math.max(p[0] + p[2], rect[0] + rect[2]);
      p[0] = x0;
      p[2] = x1 - x0;
      last.colEnd = c.col + c.cols;
      continue;
    }
    g.rects.push(rect);
    last = c.rows === 1 ? { fill: k, row: c.row, colEnd: c.col + c.cols, rect } : undefined;
  }
  const area = (b: [number, number, number, number]) => (b[2] - b[0]) * (b[3] - b[1]);
  const order = [...groups.values()].sort((p, q) => area(q.box) - area(p.box) || p.first - q.first);
  for (const g of order) {
    if (g.fill.gradient) {
      for (const r of g.rects) fillRect(ctx, g.fill, r);
      continue;
    }
    if (g.fill.color.a <= 0) continue;
    ctx.beginPath();
    for (const r of g.rects) ctx.rect(r[0], r[1], r[2], r[3]);
    ctx.fillStyle = rgbaCss(g.fill.color);
    ctx.fill();
  }
}

/** The width a line is stroked at (logical px): at least 0.5, as the M6 group drew a hairline. */
function strokeWidth(s: TableLineStyle): number {
  return Math.max(num(s.width, 0, CLAMP.maxEffectPx, 0), 0.5);
}

function setLine(ctx: Ctx2D, s: TableLineStyle): boolean {
  if (!(s.color.a > 0)) return false;
  const w = strokeWidth(s);
  ctx.lineWidth = w;
  ctx.strokeStyle = rgbaCss(s.color);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  // The preset dash scaled by the width (never thinner than `CLAMP.minDashedStrokePx`, which 0.5 is).
  const pattern = DASH_PATTERNS[s.dash ?? 'solid'] ?? [];
  ctx.setLineDash(pattern.map((v) => v * w));
  return true;
}

/** Lines and diagonals (steps 3 and 4 of the header). */
function drawLines(ctx: Ctx2D, l: TableLayout): void {
  const t = l.model.t;
  const styles = t.lineStyles ?? [];
  for (const stroke of tableStrokes(l)) {
    const s = styles[stroke.line];
    if (!s || !setLine(ctx, s)) continue;
    const q = stroke.segs;
    ctx.beginPath();
    for (let i = 0; i < q.length; i += 4) {
      ctx.moveTo(q[i]!, q[i + 1]!);
      ctx.lineTo(q[i + 2]!, q[i + 3]!);
    }
    ctx.stroke();
  }
  for (const c of l.cells) {
    const diag = t.cells[c.index]!.diag;
    if (!diag) continue;
    const { x, y, w, h: ch } = c.box;
    for (const [li, x0, y0, x1, y1] of [
      [diag.down, x, y, x + w, y + ch],
      [diag.up, x, y + ch, x + w, y],
    ] as const) {
      const s = li === undefined ? undefined : styles[li];
      if (!s || !setLine(ctx, s)) continue;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

/**
 * Draw a clamped table shape at `scale` device px per logical px (see the header). Returns its layout, or
 * undefined when it has no drawable table (the caller draws the shape's legacy rect).
 */
export function drawTable(
  ctx: Ctx2D,
  o: ShapeObject,
  scale: number,
  env = currentFontEnv(),
): TableLayout | undefined {
  const l = layoutTable(measurerFor(ctx), o, env);
  if (!l) return undefined;
  const opacity = num(o.opacity, 0, 1, 1);
  if (opacity <= 0) return l;
  const s = num(scale, 0.01, 8, 1);
  const box = o.box;
  ctx.save();
  if (box.rotation) {
    const cx = (box.x + box.w / 2) * s;
    const cy = (box.y + box.h / 2) * s;
    ctx.translate(cx, cy);
    ctx.rotate((box.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  ctx.save();
  ctx.translate(box.x * s, box.y * s);
  ctx.scale(s, s);
  ctx.globalAlpha *= opacity;
  drawFills(ctx, l);
  drawLines(ctx, l);
  ctx.restore();
  // Cell text at the device scale (text effects are sized in device px), from each cell's corner.
  for (const c of l.cells) {
    if (!c.text.text) continue;
    ctx.save();
    ctx.translate((box.x + c.box.x) * s, (box.y + c.box.y + c.dy) * s);
    paintRich(ctx, opacity === 1 ? c.text : { ...c.text, opacity }, c.layout, s, env);
    ctx.restore();
  }
  ctx.restore();
  return l;
}

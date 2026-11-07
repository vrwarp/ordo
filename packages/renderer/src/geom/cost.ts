import type { ArrowEnd, LineCap, LineDash, LineJoin, Rgba, ShapeGeom } from '@ordo/domain';
import type { GeomArrow } from './ends.ts';
import { CLOSED_TOLERANCE, CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD } from './ops.ts';
import { hasShapeExtras, type Outline, outlineOf } from './outline.ts';
import type { GeomPath } from './path.ts';

/*
 * What a shape costs to draw (design/27 §12 "drawing cost", §13). The counts of §12 (4,096 points a path, 8
 * paths, 64k points a slide) do not bound the time Canvas spends: a scan converter walks every edge on every
 * row it spans, with partial coverage across the pixels a slanted edge crosses within a row, and re-sorts the
 * edges active on a row where they cross. One custom geometry whose edges zigzag across its box stays inside
 * every count and takes seconds to fill at 4K, on the output's asset worker and on the editor's main thread;
 * so does a small one stroked wide (every vertex's join and every open sub-path's caps are edges as long as
 * the line is wide), one of many short open sub-paths with arrowheads (each marker its own fill), and a dashed
 * outline of a thin line (every dash a sub-path of its own).
 *
 * The estimate, in units of about one logical px of edge (logical px, box space; the same at any device scale,
 * about half the work at 1080p than at 4K):
 * - a fill, per filled unit (a path, the pieces of a `cont` chain joined, as they are filled together): its
 *   edges' length along their longer axis (max(|dx|, |dy|); the control polygon of a curve, which bounds the
 *   curve; an edge with dy = 0 is skipped by a scan converter and costs nothing), the work rows and partial
 *   coverage take, times (1 + A / GEOM_COST.peakScale), A the most edges active at once (those crossing one
 *   of GEOM_COST.bands bands of the unit's height, counted as a difference array): what crossing and
 *   converging edges add (`unitCost`);
 * - an outline, per stroked path (`strokeCost`): what Canvas fills for it, rated the same way. Each segment
 *   (each leg of a curve's control polygon) gives two offset edges; each vertex a join (inner: two edges of
 *   half the width to the vertex and back; outer: a miter's two edges, up to the limit, a round join's arc, a
 *   bevel's edge), each active within the reach of its vertex; each open sub-path two caps (flat: the width,
 *   round: a half circle, square: three sides); bands about a line width tall. A dashed outline adds its
 *   dashes' caps and `GEOM_COST.dash` a dash; arrowheads are fills of their own, `GEOM_COST.marker` each
 *   besides their edges and `GEOM_COST.markerArea` a logical px² of their area;
 * - a shape (`drawCost`): its fills and outlines, again for a shadow (its layer redraws the shape), a glow's
 *   silhouette (the fill, its outline stroked round as wide as the glow, the outlines widened by it) and a
 *   soft edge's mask (the fill, its outline stroked round twice the edge wide); a picture's mask its fill;
 * - a stored path's points (`GEOM_COST.point` each, charged with the slide's): parsing them when the geometry
 *   is first built at a size, rating them, and tracing them into Canvas on every draw, whatever their edges
 *   cost to fill (about 0.25 µs a point at 4K: 64k points take about 16 ms before a pixel is filled).
 * Measured in a dedicated worker on a willReadFrequently OffscreenCanvas at 3840 x 2160 (Chromium 153), one
 * unit costs at most about GEOM_COST.nsPerUnit ns at 4K over the arrangements tried (the raster bench's
 * bounded geometry slides draw the hostile ones at the budget): zigzags across the box, the same in a band,
 * cross-hatches, spikes converging on the centre; clouds of points stroked 400 px wide with each join;
 * thousands of short open sub-paths with round and square caps and with arrowheads; thin dashed outlines; a
 * wide dashed spiral.
 * The outline terms are upper bounds: Chromium strokes most of those arrangements 5 to 500 times faster than
 * their estimate (its stroker drops what the joins hide, and joins at one vertex do not re-sort the edges),
 * and the closest, thin dashes and arrowheads, at about 0.7 to 0.2 of it. Edges side by side that never
 * cross (a comb, a row of small stars, a thick outline of a dense traced path) cost far less than their
 * estimate, so a geometry of many such edges per row is sent to LibreOffice sooner than it need be.
 *
 * Budgets (`GEOM_COST`): a stored geometry whose fill is past `geometry` is not drawn natively (the converter
 * sends it to the art as `custGeom:complex`; the renderer draws the legacy shape), and a slide's shapes are
 * drawn while their estimates and stored points (`objectCost` plus `point` a point) stay within `slide`, and
 * the points within `slidePoints`; past them the converter sends the rest to the art and the renderer draws
 * them as legacy shapes (`slidePlan`). A slide at the budget draws its geometry in at most about 38 ms at 4K,
 * with the clear and the copy out (about 11 ms) within design/27 §13's 50 ms for an asset-worker task, cold
 * (geometry not yet built, nothing cached). The converter fills 0.98 of it (rounding of stored coordinates).
 */

export const GEOM_COST = {
  /** Bands of a filled unit's height in which the edges active at once are counted. */
  bands: 64,
  /** Bands of an outline's height at most (one about a line width tall, at least `bands`). */
  strokeBands: 2_048,
  /** Edges active at once at which the second term of the estimate equals the first. */
  peakScale: 64,
  /** One dash besides its edges: its sub-path, cut by the dasher and stroked on its own (flat caps). */
  dash: 24,
  /** One dash with round or square caps (a dot of curves, or of a square's sides, each). */
  dashCapped: 64,
  /** One arrowhead besides its edges: its own fill. */
  marker: 40,
  /** A logical px² of an arrowhead's area: its fill's spans. */
  markerArea: 0.06,
  /** The fill estimate of one stored geometry at most (its legacy shape is drawn past it). */
  geometry: 1_300_000,
  /** Estimates of one slide's shapes, with their stored points, at most (about 38 ms at 4K, cold). */
  slide: 1_300_000,
  /** Points of one slide's stored paths at most (§12: 64k). */
  slidePoints: 65_536,
  /** One stored point: parsed, rated and traced into Canvas (about 0.25 µs at 4K). */
  point: 10,
  /** The most a unit was measured to cost at 4K (ns), over the arrangements tried. */
  nsPerUnit: 29,
} as const;

/** Coordinate pairs each command takes. */
function pairsOf(op: number): number {
  return op === CMD_MOVE || op === CMD_LINE ? 1 : op === CMD_QUAD ? 2 : op === CMD_CUBIC ? 3 : 0;
}

/** Points of a path as the render clamp counts them (`PATH_DATA_LIMITS`): each coordinate pair, and each close. */
export function clampPoints(cmds: readonly number[], pts: readonly number[]): number {
  let n = pts.length / 2;
  for (const op of cmds) if (op === CMD_CLOSE) n++;
  return n;
}

/** The parts of a unit's estimate. */
export interface UnitCost {
  /** Logical px: max(|dx|, |dy|) of every edge with dy ≠ 0. */
  readonly length: number;
  /** The most edges crossing one band of the unit's height (of GEOM_COST.bands). */
  readonly peak: number;
  /** length × (1 + peak / GEOM_COST.peakScale). */
  readonly est: number;
}

const finiteScale = (k: number) => (Number.isFinite(k) ? Math.abs(k) : 0);
const finiteEst = (v: number) => (Number.isFinite(v) && v >= 0 ? v : Number.POSITIVE_INFINITY);

/**
 * The drawing estimate of one filled unit: `cmds` and `pts` as a GeomPath holds them, scaled by kx, ky to
 * logical px. Sub-paths are closed for the count (a fill closes them). Never throws; non-finite input
 * counts as 0.
 */
export function unitCost(cmds: readonly number[], pts: readonly number[], kx = 1, ky = 1): UnitCost {
  const sx = finiteScale(kx);
  const sy = finiteScale(ky);
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 1; i < pts.length; i += 2) {
    const y = pts[i]! * sy;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!(y1 > y0) || !Number.isFinite(y1 - y0)) return { length: 0, peak: 0, est: 0 };
  const B = GEOM_COST.bands;
  const band = (y1 - y0) / B;
  const diff = new Int32Array(B + 1);
  let length = 0;
  const edge = (ax: number, ay: number, bx: number, by: number) => {
    const dy = Math.abs(by - ay);
    if (!(dy > 0)) return;
    const dx = Math.abs(bx - ax);
    length += Math.max(dx, dy);
    const lo = Math.min(B - 1, Math.max(0, Math.floor((Math.min(ay, by) - y0) / band)));
    const hi = Math.min(B - 1, Math.max(0, Math.floor((Math.max(ay, by) - y0) / band)));
    diff[lo]!++;
    diff[hi + 1]!--;
  };
  let at = 0;
  let cx = 0;
  let cy = 0;
  let mx = 0;
  let my = 0;
  let open = false;
  for (const op of cmds) {
    if (op === CMD_MOVE) {
      if (open) edge(cx, cy, mx, my);
      if (at + 1 >= pts.length) break;
      cx = mx = pts[at]! * sx;
      cy = my = pts[at + 1]! * sy;
      at += 2;
      open = true;
      continue;
    }
    if (op === CMD_CLOSE) {
      if (open) edge(cx, cy, mx, my);
      cx = mx;
      cy = my;
      continue;
    }
    const n = pairsOf(op);
    for (let j = 0; j < n && at + 1 < pts.length; j++, at += 2) {
      const x = pts[at]! * sx;
      const y = pts[at + 1]! * sy;
      edge(cx, cy, x, y);
      cx = x;
      cy = y;
    }
  }
  if (open) edge(cx, cy, mx, my);
  let active = 0;
  let peak = 0;
  for (let b = 0; b < B; b++) {
    active += diff[b]!;
    if (active > peak) peak = active;
  }
  const est = length * (1 + peak / GEOM_COST.peakScale);
  return { length, peak, est: finiteEst(est) };
}

/** The fill estimate of a built geometry's paths in box space: the sum over its paths (each a filled unit). */
export function geomCost(paths: readonly GeomPath[], kx = 1, ky = 1): number {
  let c = 0;
  for (const p of paths) c += unitCost(p.cmds, p.pts, kx, ky).est;
  return c;
}

// ── Outlines ──────────────────────────────────────────────────────────────────────────────────────────────

/** The parts of an outline's estimate. */
export interface StrokeCost {
  /** Logical px of the outline's edges (max(|dx|, |dy|)), its dashes' caps included. */
  readonly length: number;
  /** The most edges active at once in one band (bands about a line width tall). */
  readonly peak: number;
  /** Dashes drawn. */
  readonly dashes: number;
  /** Arrowheads drawn (each its own fill). */
  readonly markers: number;
  /** length × (1 + peak / peakScale) + dashes × GEOM_COST.dash + the arrowheads'. */
  readonly est: number;
}

/** Dashes counted per path at most (the estimate is past every budget long before). */
const MAX_DASHES = 1e9;

/** The logical area of a 1920 x 1080 slide. */
const SLIDE_AREA = 1920 * 1080;
/** σ of a stack blur of radius r, over r (effects.ts STACK_BLUR_SIGMA). */
const BLUR_SIGMA = 1 / Math.sqrt(6);

/** An arrowhead's own fill: its edges, the fill, and its area (cut to a slide's). */
function markerCost(a: GeomArrow | undefined): number {
  if (!a) return 0;
  const w = Number.isFinite(a.width) ? Math.abs(a.width) : 0;
  const l = Number.isFinite(a.length) ? Math.abs(a.length) : 0;
  const edges = 2 * (w + l) + (a.kind === 'arrow' ? 4 * a.line : 0);
  return (
    edges * (1 + 4 / GEOM_COST.peakScale) +
    GEOM_COST.marker +
    GEOM_COST.markerArea * Math.min(w * l, SLIDE_AREA)
  );
}

/**
 * The drawing estimate of stroking one path with `o` (box units; `cmds`, `pts` as a GeomPath holds them):
 * the outline Canvas fills for it (see the header), its dashes and its arrowheads. A sub-path ending within
 * `tolerance` of its start gets no arrowheads (`withEnds`), but caps all the same (Canvas strokes it open).
 * Never throws; non-finite input is past every budget.
 */
export function strokeCost(
  cmds: readonly number[],
  pts: readonly number[],
  o: Outline,
  tolerance = 0,
): StrokeCost {
  const none = { length: 0, peak: 0, dashes: 0, markers: 0, est: 0 };
  const lw = o.width;
  if (!(lw > 0) || !pts.length) return none;
  if (!Number.isFinite(lw)) return { ...none, est: Number.POSITIVE_INFINITY };
  const half = lw / 2;
  const limit = Math.max(1, Number.isFinite(o.miterLimit) ? o.miterLimit : 1);
  const joinReach = o.join === 'miter' ? limit * half : half;
  const capReach = o.cap === 'square' ? half * Math.SQRT2 : half;
  const reach = Math.max(joinReach, capReach);
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 1; i < pts.length; i += 2) {
    const y = pts[i]!;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return { ...none, est: Number.POSITIVE_INFINITY };
  const Y0 = y0 - reach;
  const H = y1 + reach - Y0;
  const B = Math.min(GEOM_COST.strokeBands, Math.max(GEOM_COST.bands, Math.ceil(H / lw)));
  const band = H / B;
  const diff = new Float64Array(B + 1);
  const span = (lo: number, hi: number, n: number) => {
    const a = Math.min(B - 1, Math.max(0, Math.floor((lo - Y0) / band)));
    const b = Math.min(B - 1, Math.max(0, Math.floor((hi - Y0) / band)));
    diff[a]! += n;
    diff[b + 1]! -= n;
  };
  // The dash: its period, the share of it drawn and its dashes per period.
  let period = 0;
  let on = 0;
  let perPeriod = 0;
  if (o.dash?.length) {
    for (let i = 0; i < o.dash.length; i++) {
      const v = Math.max(0, Number.isFinite(o.dash[i]!) ? o.dash[i]! : 0);
      period += v;
      // Canvas repeats an odd list twice over.
      if (i % 2 === 0) {
        on += v;
        perPeriod++;
      }
    }
    if (o.dash.length % 2) {
      period *= 2;
      on = period / 2;
      perPeriod = o.dash.length;
    }
    if (!(period > 0)) period = 0;
  }
  const dashed = period > 0;
  const onShare = dashed ? Math.min(1, on / period) : 1;
  const capLength = o.cap === 'round' ? Math.PI * half : o.cap === 'square' ? 2 * lw : lw;
  const capEdges = o.cap === 'butt' ? 1 : 2;
  const ends = o.ends;
  const arrows = (ends?.head ? 1 : 0) + (ends?.tail ? 1 : 0);
  let length = 0;
  let dashes = 0;
  let markers = 0;
  let markerEst = 0;
  /** Of the sub-path being walked: its start, the point reached, the first and last leg's direction. */
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  let fdx = 0;
  let fdy = 0;
  let pdx = 0;
  let pdy = 0;
  let pcurve = 0;
  let legs = 0;
  let segments = 0;
  let sub = 0;
  let started = false;
  let curve = 0;
  let open = false;
  /** A join at a vertex at height `y` between legs (ax, ay) and (bx, by). */
  const join = (y: number, ax: number, ay: number, bx: number, by: number, inCurve: boolean) => {
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
    const turn = Math.acos(cos);
    if (!(turn > 1e-3)) return;
    if (inCurve) {
      // The offset curves sweep round the turn on both sides.
      length += turn * lw;
      span(y - half, y + half, 2);
      return;
    }
    // Inner: to the vertex and back.
    length += lw;
    let r = half;
    if (o.join === 'round') length += turn * half;
    else if (o.join === 'miter' && 1 / Math.cos(turn / 2) <= limit) {
      length += lw * Math.tan(turn / 2);
      r = half / Math.cos(turn / 2);
    } else length += lw * Math.sin(turn / 2);
    span(y - r, y + r, 4);
  };
  const cap = (y: number) => {
    length += capLength;
    span(y - capReach, y + capReach, capEdges);
  };
  const leg = (x: number, y: number, inCurve: number) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy);
    segments++;
    if (!(len > 0)) return;
    const ady = Math.abs(dy);
    if (ady > 0) {
      length += 2 * Math.max(Math.abs(dx), ady) * onShare;
      const h = (half * Math.abs(dx)) / len;
      span(Math.min(cy, y) - h, Math.max(cy, y) + h, 2);
    }
    if (legs) join(cy, pdx, pdy, dx, dy, inCurve !== 0 && inCurve === pcurve);
    else {
      fdx = dx;
      fdy = dy;
    }
    pdx = dx;
    pdy = dy;
    pcurve = inCurve;
    legs++;
    sub += len;
    cx = x;
    cy = y;
  };
  const end = (closed: boolean) => {
    if (!started) return;
    if (closed) {
      if (legs > 1 || (legs === 1 && (cx !== sx || cy !== sy))) {
        if (cx !== sx || cy !== sy) leg(sx, sy, 0);
        if (legs > 1) join(sy, pdx, pdy, fdx, fdy, false);
      }
    } else if (legs || (segments && o.cap !== 'butt')) {
      // Open: a cap at each end (a zero-length sub-path is a dot with round and square caps).
      cap(sy);
      cap(cy);
      if (arrows && legs && (Math.abs(cx - sx) > tolerance || Math.abs(cy - sy) > tolerance)) {
        open = true;
        markers += arrows;
        markerEst += markerCost(ends?.head) + markerCost(ends?.tail);
      }
    }
    if (dashed && sub > 0) dashes += Math.ceil((sub / period) * perPeriod);
    started = false;
    legs = 0;
    segments = 0;
    sub = 0;
  };
  let at = 0;
  for (const op of cmds) {
    if (op === CMD_MOVE) {
      end(false);
      if (at + 1 >= pts.length) break;
      sx = cx = pts[at]!;
      sy = cy = pts[at + 1]!;
      at += 2;
      started = true;
      continue;
    }
    if (op === CMD_CLOSE) {
      end(true);
      // Canvas starts the next sub-path at the closed one's start.
      cx = sx;
      cy = sy;
      continue;
    }
    const n = pairsOf(op);
    if (!n) continue;
    if (!started) {
      started = true;
      sx = cx;
      sy = cy;
    }
    const inCurve = n > 1 ? ++curve : 0;
    for (let j = 0; j < n && at + 1 < pts.length; j++, at += 2) leg(pts[at]!, pts[at + 1]!, inCurve);
  }
  end(false);
  // Arrowheads are drawn only when the path itself is open (`drawGeom`): one sub-path open is enough.
  if (!open) {
    markers = 0;
    markerEst = 0;
  }
  if (dashed) {
    dashes = Math.min(MAX_DASHES, dashes);
    length += 2 * dashes * capLength;
  }
  let active = 0;
  let peak = 0;
  for (let b = 0; b < B; b++) {
    active += diff[b]!;
    if (active > peak) peak = active;
  }
  const dashUnit = o.cap === 'butt' ? GEOM_COST.dash : GEOM_COST.dashCapped;
  const est = length * (1 + peak / GEOM_COST.peakScale) + dashes * dashUnit + markerEst;
  return { length, peak, dashes, markers, est: finiteEst(est) };
}

// ── Shapes ────────────────────────────────────────────────────────────────────────────────────────────────

/** A geometry as drawn: its paths in box space (logical px) and its box. */
export interface DrawnGeom {
  readonly w: number;
  readonly h: number;
  readonly paths: readonly GeomPath[];
}

/** What a shape draws, for its estimate. */
export interface DrawSpec {
  /** Its paths are filled (a colour or a gradient; a picture's mask). */
  readonly fill: boolean;
  readonly outline?: Outline | undefined;
  readonly shadow?: boolean;
  /** The shadow's blur radius (logical px): its layer is drawn reduced by it. */
  readonly shadowBlur?: number;
  /** Glow radius (logical px). */
  readonly glow?: number;
  /** Soft edge radius (logical px). */
  readonly softEdge?: number;
}

/** The filled paths of a geometry as one unit (the union a silhouette or a mask fills at once). */
function unionUnit(paths: readonly GeomPath[]): { cmds: number[]; pts: number[] } {
  const cmds: number[] = [];
  const pts: number[] = [];
  for (const p of paths) {
    if (p.fill === 'none') continue;
    for (const c of p.cmds) cmds.push(c);
    for (const v of p.pts) pts.push(v);
  }
  return { cmds, pts };
}

/** A round outline of `width` without dash or ends (a silhouette's). */
function roundOutline(width: number): Outline {
  return { width, join: 'round', cap: 'round', miterLimit: 1 };
}

/**
 * The drawing estimate of a shape (see the header): its fills and outlines as `drawGeom` draws them, and the
 * passes its effects make (`effects.ts`).
 */
export function drawCost(g: DrawnGeom, spec: DrawSpec): number {
  const tolerance = CLOSED_TOLERANCE * Math.max(Math.abs(g.w) || 0, Math.abs(g.h) || 0);
  const o = spec.outline;
  let fills = 0;
  let strokes = 0;
  for (const p of g.paths) {
    if (spec.fill && p.fill !== 'none') fills += unitCost(p.cmds, p.pts).est;
    if (o && p.stroke) strokes += strokeCost(p.cmds, p.pts, o, tolerance).est;
  }
  const base = fills + strokes;
  let total = base;
  const glow = spec.glow !== undefined && spec.glow > 0 ? spec.glow : 0;
  const soft = spec.softEdge !== undefined && spec.softEdge > 0 ? spec.softEdge : 0;
  if (!glow && !soft && !spec.shadow) return finiteEst(total);
  const union = spec.fill ? unionUnit(g.paths) : undefined;
  const unionFill = union ? unitCost(union.cmds, union.pts).est : 0;
  // A silhouette: the fill with its outline stroked round `grow` wide, the outlines `widen` wider.
  const silhouette = (grow: number, widen: number, round: boolean) => {
    let c = unionFill;
    if (union && grow > 0) c += strokeCost(union.cmds, union.pts, roundOutline(grow), tolerance).est;
    if (o)
      for (const p of g.paths)
        if (p.stroke) {
          const w = o.width + widen;
          if (w > 0)
            c += strokeCost(
              p.cmds,
              p.pts,
              round ? roundOutline(w) : { width: w, join: o.join, cap: o.cap, miterLimit: o.miterLimit },
              tolerance,
            ).est;
        }
    return c;
  };
  // Each blurred layer is drawn reduced by k = σ/2 at 4K (`effects.ts` `blurLayer`, `softened`; 1 to 8): its
  // rows and widths are 1/k of the full layer's.
  const reduced = (radius: number) => Math.min(8, Math.max(1, (radius * BLUR_SIGMA * 2) / 2));
  const mask = soft ? silhouette(2 * soft, 0, false) / reduced(soft) : 0;
  if (spec.shadow) total += (base + mask) / reduced(Math.max(0, spec.shadowBlur ?? 0));
  if (glow) total += silhouette(glow, glow, true) / reduced(glow / 2);
  if (soft) total += mask;
  return finiteEst(total);
}

/** The drawing estimate of a picture's mask: its filled paths as one unit (`geomFillPath2D`, a clip). */
export function maskCost(g: DrawnGeom): number {
  const u = unionUnit(g.paths);
  return unitCost(u.cmds, u.pts).est;
}

// ── Objects and slides ────────────────────────────────────────────────────────────────────────────────────

/** The fields of a slide object the estimate reads (a `ShapeObject` or `ImageObject` as clamped). */
export interface CostedObject {
  readonly type: string;
  readonly shape?: string;
  readonly opacity?: number;
  readonly fill?: Rgba | undefined;
  readonly gradient?: unknown;
  readonly stroke?: { readonly width: number } | undefined;
  readonly geom?: ShapeGeom | undefined;
  readonly mask?: ShapeGeom | undefined;
  readonly dash?: LineDash | undefined;
  readonly lineJoin?: LineJoin | undefined;
  readonly lineCap?: LineCap | undefined;
  readonly ends?: { readonly head?: ArrowEnd | undefined; readonly tail?: ArrowEnd | undefined } | undefined;
  readonly flipH?: boolean;
  readonly flipV?: boolean;
  readonly shadow?: { readonly blur: number; readonly color: Rgba } | undefined;
  readonly glow?: { readonly radius: number; readonly color: Rgba } | undefined;
  readonly softEdge?: number | undefined;
}

/**
 * The drawing estimate of one slide object as drawn (`drawGeomShape`, `drawImageFit`), given the geometry it
 * draws at its box (`g`: a shape's stored or legacy geometry, a picture's mask; undefined: none). A shape
 * drawn by the legacy path (`hasShapeExtras` false), one that draws nothing, text and a picture without a
 * mask cost 0 here.
 */
export function objectCost(o: CostedObject, g: DrawnGeom | undefined): number {
  if (!g) return 0;
  if (o.type === 'image') return o.mask ? maskCost(g) : 0;
  if (o.type !== 'shape' || !hasShapeExtras(o)) return 0;
  const opacity = typeof o.opacity === 'number' ? o.opacity : 1;
  if (!(opacity > 0)) return 0;
  const line = o.shape === 'line' && !o.geom;
  const fill = !line && (o.gradient !== undefined || o.fill !== undefined);
  const outline = outlineOf(o);
  if (!fill && !outline) return 0;
  const glow = o.glow && o.glow.radius > 0 && o.glow.color.a > 0 ? o.glow.radius : 0;
  return drawCost(g, {
    fill,
    outline,
    shadow: !!o.shadow && o.shadow.color.a > 0,
    ...(o.shadow ? { shadowBlur: Number.isFinite(o.shadow.blur) ? o.shadow.blur : 0 } : {}),
    ...(glow ? { glow } : {}),
    ...(o.softEdge ? { softEdge: o.softEdge } : {}),
  });
}

/** What a slide object draws as past a budget: without its geometry (`geom`), its effects, or both. */
export type LegacyPart = 'geom' | 'effects' | 'both';

/**
 * An object as drawn past a budget (a shallow copy): `geom` leaves out a shape's stored geometry and the
 * outline fields that multiply its cost (dash, arrowheads, joins, caps), a picture's mask; `effects` a shape's
 * shadow, glow and soft edge. What is left is drawn as an older build draws it (a legacy rect, ellipse or
 * line with a plain outline), whose cost the geometry no longer drives.
 */
export function withoutPart<T extends object>(o: T, part: LegacyPart): T {
  const out = { ...o } as T & Record<string, unknown>;
  const type = (o as { type?: unknown }).type;
  if (part !== 'effects') {
    if (type === 'shape') {
      delete out.geom;
      delete out.dash;
      delete out.ends;
      delete out.lineJoin;
      delete out.lineCap;
    } else if (type === 'image') delete out.mask;
  }
  if (part !== 'geom' && type === 'shape') {
    delete out.shadow;
    delete out.glow;
    delete out.softEdge;
  }
  return out;
}

/** What a slide object costs as drawn (or a legacy copy of it): its estimate and its stored path points. */
export interface Rated {
  readonly est: number;
  readonly points: number;
}

/** What a rated object charges against `GEOM_COST.slide`: its estimate and `GEOM_COST.point` a stored point. */
export function charged(r: Rated): number {
  return r.est + r.points * GEOM_COST.point;
}

/**
 * A slide's drawing budgets (design/27 §12 drawing cost), the same for the converter and every drawer: in
 * z-order, each object keeps its effects while their layers' area (`area`, `effectArea`) stays within
 * `EFFECT_COST.slide`, and its geometry while what is drawn charges (`rate`, `charged`: estimates and stored
 * points) stays within `GEOM_COST.slide` and its points within `GEOM_COST.slidePoints`; past them it is drawn
 * as `withoutPart` leaves it, the geometry first, then the effects too when that is not enough. `rate(o, part)`
 * rates `o` as drawn without `part` (undefined: as it is). The legacy copies' own estimates are counted (they
 * are drawn), never refused.
 * Returns each object's part left out (undefined: drawn as it is).
 */
export function slidePlan<T>(
  objects: readonly T[],
  rate: (o: T, part?: LegacyPart) => Rated,
  area: (o: T) => number,
): (LegacyPart | undefined)[] {
  let points = 0;
  let cost = 0;
  let effects = 0;
  const out: (LegacyPart | undefined)[] = [];
  const fits = (r: Rated) =>
    points + r.points <= GEOM_COST.slidePoints && cost + charged(r) <= GEOM_COST.slide;
  for (const o of objects) {
    let part: LegacyPart | undefined;
    const a = area(o);
    if (a > 0) {
      if (effects + a > EFFECT_COST.slide) part = 'effects';
      else effects += a;
    }
    let r = rate(o, part);
    if (!fits(r)) {
      const before = part;
      part = part === 'effects' ? 'both' : 'geom';
      r = rate(o, part);
      if (!fits(r) && part === 'geom' && a > 0) {
        part = 'both';
        r = rate(o, part);
        // Its effects' area is no longer drawn.
        if (before === undefined) effects -= a;
      }
    }
    points += r.points;
    cost += charged(r);
    out.push(part);
  }
  return out;
}

// ── Effects ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A slide's shape effects (design/27 §12 drawing cost, §13): the area their layers cover, in slides of
 * 1920 x 1080, at most `EFFECT_COST.slide` (weighted: a shadow and a glow 1 each, a soft edge
 * `EFFECT_COST.softEdge`: its body is made and cut by its enlarged mask at full resolution on every raster
 * past the composite cache, about 55 ms a slide area at 4K, against 25 ms cold and a few ms warm a slide area
 * of other layers, reduced and enlarged onto the canvas). Past it the renderer draws later shapes without
 * their effects (`slidePlan`) and the converter leaves them out with a note. The worship corpus's most
 * effected slides reach 7.7 (Slidesmania templates of 8-9 large shadowed shapes; p99 7.3, p90 1.2), its most
 * soft-edged 1.0 slide area of soft edges (9.2 weighted).
 */
export const EFFECT_COST = { slide: 10, softEdge: 8 } as const;

/** What an object's effects weigh against `EFFECT_COST.slide`: their layers' area in slide areas, weighted. */
export function effectArea(o: {
  box?: { w: number; h: number };
  shadow?: { dx: number; dy: number; blur: number } | undefined;
  glow?: { radius: number } | undefined;
  softEdge?: number | undefined;
}): number {
  const weight = (o.shadow ? 1 : 0) + (o.glow ? 1 : 0) + (o.softEdge ? EFFECT_COST.softEdge : 0);
  if (!weight || !o.box) return 0;
  const fin = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.abs(v) : 0);
  const shadowReach = o.shadow
    ? 3 * fin(o.shadow.blur) * BLUR_SIGMA + Math.max(fin(o.shadow.dx), fin(o.shadow.dy))
    : 0;
  const glowReach = o.glow ? fin(o.glow.radius) / 2 + 3 * (fin(o.glow.radius) / 2) * BLUR_SIGMA : 0;
  const reach = Math.max(shadowReach, glowReach);
  // A layer is cut to the canvas and its reach (effects.ts `region`): at most about 3 x 3 slides.
  const w = Math.min(fin(o.box.w) + 2 * reach, 3 * 1920);
  const h = Math.min(fin(o.box.h) + 2 * reach, 3 * 1080);
  return ((w * h) / SLIDE_AREA) * weight;
}

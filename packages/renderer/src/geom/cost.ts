import type { ArrowEnd, LineCap, LineDash, LineJoin, Rgba, ShapeGeom } from '@ordo/domain';
import { type Bounds, CANVAS_H, CANVAS_W, canvasArea, type Placement, placedBounds } from './bounds.ts';
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
 *   bevel's edge), each active within the reach of its vertex, and `GEOM_COST.leg` a leg for the stroker;
 *   each open sub-path two caps (flat: the width, round: a half circle, square: three sides); bands about a
 *   line width tall. A dashed outline adds its
 *   dashes' caps and `GEOM_COST.dash` a dash; arrowheads are fills of their own, `GEOM_COST.marker` each
 *   besides their edges and `GEOM_COST.markerArea` a logical px² of their area;
 * - a shape (`drawCost`): its fills and outlines, again for a shadow (its layer redraws the shape), a glow's
 *   silhouette (the fill, its outline stroked round as wide as the glow, the outlines widened by it) and a
 *   soft edge's mask (the fill, its outline stroked round twice the edge wide); a picture's mask its fill;
 * - the pixels each fill paints (`spanArea` of its points, cut to the canvas when the box is placed; a
 *   logical px² of it `GEOM_COST.opaqueArea` or `area` for a colour, opaque or not, `opaqueGradientArea` or
 *   `gradientArea` for a gradient, about five times as costly a pixel: `areaWeight`) and the area each
 *   outline covers (`area`): every path is filled and stroked on its own, so a full-slide translucent
 *   gradient takes about 11.7 ms at 4K whatever its edges, and a stack of them seconds; a legacy shape (rect,
 *   ellipse, line) is rated the same way;
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
 * them as legacy shapes (`slidePlan`: without their stored geometry, and a gradient as its first stop, as an
 * older build draws them). Every object's legacy copy is counted first and never refused, and what is drawn
 * on top of it must fit, so a slide draws within the budget whenever its legacy copies do: a slide of 200
 * full-slide translucent legacy rects draws as an older build draws it (about 2 ms each at 4K); the object
 * budget bounds it. A slide at the budget draws its geometry and fills in at most about 38 ms at 4K, with the
 * clear and the copy out (about 11 ms) within design/27 §13's 50 ms for an asset-worker task, cold (geometry
 * not yet built, nothing cached). The converter fills 0.98 of it (rounding of stored coordinates).
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
  /**
   * One open arrowhead (`arrow`) besides its edges: its own stroke, about 10 µs at 4K a call (19,200 small
   * ones took 190 ms).
   */
  markerStroked: 400,
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
  /**
   * A logical px² an outline covers, or a translucent solid fill paints (each path is filled on its own; a
   * full-slide translucent fill takes about 1.8 to 2.2 ms at 4K, an opaque one about 1.2 ms).
   */
  area: 0.045,
  /** A logical px² an opaque solid fill paints (about 1.2 ms a full slide at 4K). */
  opaqueArea: 0.025,
  /**
   * A logical px² a translucent gradient paints (the shape's opacity or a stop below 1; linear and radial
   * alike, about 11.6 to 11.8 ms a full slide at 4K: a slide of 140 took 1.3 s).
   */
  gradientArea: 0.2,
  /** A logical px² an opaque gradient paints (7.2 to 8 ms a full slide at 4K). */
  opaqueGradientArea: 0.14,
  /**
   * One leg of an outline (each segment, each leg of a curve's control polygon): the stroker's own work on
   * it (normals, joins, the outline's path), about 0.4 µs at 4K whatever it covers (eight 2,400-point
   * straight lines 500 px wide took 15 to 21 ms, joins and all).
   */
  leg: 24,
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
  // An open arrowhead is stroked on its own, a filled one filled.
  const own = a.kind === 'arrow' ? GEOM_COST.markerStroked : GEOM_COST.marker;
  return edges * (1 + 4 / GEOM_COST.peakScale) + own + GEOM_COST.markerArea * Math.min(w * l, SLIDE_AREA);
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
  /** Legs stroked in all: the stroker's work a segment, whatever it draws. */
  let allLegs = 0;
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
    allLegs++;
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
  const est =
    length * (1 + peak / GEOM_COST.peakScale) + dashes * dashUnit + markerEst + allLegs * GEOM_COST.leg;
  return { length, peak, dashes, markers, est: finiteEst(est) };
}

// ── Shapes ────────────────────────────────────────────────────────────────────────────────────────────────

/** A geometry as drawn: its paths in box space (logical px) and its box. */
export interface DrawnGeom {
  readonly w: number;
  readonly h: number;
  readonly paths: readonly GeomPath[];
}

/** What a fill paints a pixel with: a colour or a gradient, opaque or not (`GEOM_COST` area weights). */
export interface FillPaint {
  readonly gradient?: boolean;
  /** Below full alpha somewhere: the shape's opacity, the colour's alpha or a stop's. */
  readonly translucent?: boolean;
}

/** What a shape draws, for its estimate. */
export interface DrawSpec {
  /** Its paths are filled (a colour or a gradient; a picture's mask). */
  readonly fill: boolean;
  /** How the fill paints (default: a translucent colour). */
  readonly paint?: FillPaint;
  /** Where the box lies on the slide: painted areas are cut to the canvas (default: at most a slide's). */
  readonly place?: Placement;
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
  // Each filled path paints what it spans on its own, at its paint's cost a pixel.
  const perPixel = areaWeight(spec.paint);
  for (const p of g.paths) {
    if (spec.fill && p.fill !== 'none')
      fills += unitCost(p.cmds, p.pts).est + spanArea(p.pts, 0, spec.place) * perPixel;
    if (o && p.stroke) strokes += outlineCost(p.cmds, p.pts, o, tolerance, spec.place);
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
    if (union && grow > 0) c += outlineCost(union.cmds, union.pts, roundOutline(grow), tolerance, spec.place);
    if (o)
      for (const p of g.paths)
        if (p.stroke) {
          const w = o.width + widen;
          if (w > 0)
            c += outlineCost(
              p.cmds,
              p.pts,
              round ? roundOutline(w) : { width: w, join: o.join, cap: o.cap, miterLimit: o.miterLimit },
              tolerance,
              spec.place,
            );
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

/** What a logical px² of a fill costs (`GEOM_COST` area weights): a colour or a gradient, opaque or not. */
export function areaWeight(paint: FillPaint | undefined): number {
  const translucent = paint?.translucent !== false;
  if (paint?.gradient) return translucent ? GEOM_COST.gradientArea : GEOM_COST.opaqueGradientArea;
  return translucent ? GEOM_COST.area : GEOM_COST.opaqueArea;
}

/**
 * The area (logical px²) the points of a path span, grown by `grow` a side, within the canvas when `place`
 * puts its box on the slide (Canvas paints nothing past the canvas), else at most a slide's: what its fill or
 * stroke can cover.
 */
export function spanArea(pts: readonly number[], grow = 0, place?: Placement): number {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i]!;
    const y = pts[i + 1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!(x1 >= x0 && y1 >= y0)) return 0;
  const g = Number.isFinite(grow) && grow > 0 ? grow : 0;
  if (place) return canvasArea(placedBounds({ x0: x0 - g, y0: y0 - g, x1: x1 + g, y1: y1 + g }, place));
  const a = (x1 - x0 + 2 * g) * (y1 - y0 + 2 * g);
  return Number.isFinite(a) ? Math.min(SLIDE_AREA, a) : SLIDE_AREA;
}

/**
 * An outline as drawn: its polygon's edges (`strokeCost`) and the area it covers, about half its edges'
 * length times its width, within the span of its points grown by the width.
 */
function outlineCost(
  cmds: readonly number[],
  pts: readonly number[],
  o: Outline,
  tolerance: number,
  place?: Placement,
): number {
  const c = strokeCost(cmds, pts, o, tolerance);
  if (!(c.est > 0)) return c.est;
  const covered = Math.min(spanArea(pts, o.width, place), ((c.length + 2 * o.width) * o.width) / 2);
  return finiteEst(c.est + covered * GEOM_COST.area);
}

// ── Objects and slides ────────────────────────────────────────────────────────────────────────────────────

/** The fields of a slide object the estimate reads (a `ShapeObject` or `ImageObject` as clamped). */
export interface CostedObject {
  readonly type: string;
  readonly box?: Placement['box'];
  readonly shape?: string;
  readonly opacity?: number;
  readonly fill?: Rgba | undefined;
  readonly gradient?: { readonly stops?: readonly { readonly color?: { readonly a?: number } }[] } | unknown;
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

/** How a shape's fill paints (`FillPaint`): its gradient or colour, below full alpha anywhere or not. */
export function fillPaintOf(o: CostedObject): FillPaint {
  const opacity = typeof o.opacity === 'number' ? o.opacity : 1;
  const g = o.gradient as { stops?: readonly { color?: { a?: number } }[] } | undefined;
  if (g !== undefined && g !== null) {
    const stops = Array.isArray(g.stops) ? g.stops : [];
    const translucent = opacity < 1 || !stops.length || stops.some((st) => !((st?.color?.a ?? 1) >= 1));
    return { gradient: true, translucent };
  }
  return { translucent: opacity < 1 || !((o.fill?.a ?? 1) >= 1) };
}

/** An object's box on the slide (`Placement`), when it has a usable one. */
function placementOf(o: CostedObject): Placement | undefined {
  const b = o.box;
  if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite)) return undefined;
  return { box: b, flipH: o.flipH === true, flipV: o.flipV === true };
}

/**
 * The drawing estimate of one slide object as drawn (`drawGeomShape`, `drawShape`, `drawImageFit`), given the
 * geometry it draws at its box (`g`: a shape's stored or legacy geometry, a picture's mask; undefined: none).
 * A shape drawn by the legacy path (`hasShapeExtras` false) is rated as its legacy geometry: its fill's
 * pixels and its outline. One that draws nothing, text and a picture without a mask cost 0 here.
 */
export function objectCost(o: CostedObject, g: DrawnGeom | undefined): number {
  if (!g) return 0;
  if (o.type === 'image') return o.mask ? maskCost(g) : 0;
  if (o.type !== 'shape') return 0;
  const opacity = typeof o.opacity === 'number' ? o.opacity : 1;
  if (!(opacity > 0)) return 0;
  const line = o.shape === 'line' && !o.geom;
  const fill = !line && (o.gradient !== undefined || o.fill !== undefined);
  const outline = outlineOf(o);
  if (!fill && !outline) return 0;
  const place = placementOf(o);
  // The legacy path draws neither effects nor the M6 outline fields (`withoutPart` 'geom' leaves none).
  if (!hasShapeExtras(o))
    return drawCost(g, { fill, outline, paint: fillPaintOf(o), ...(place ? { place } : {}) });
  const glow = o.glow && o.glow.radius > 0 && o.glow.color.a > 0 ? o.glow.radius : 0;
  return drawCost(g, {
    fill,
    outline,
    paint: fillPaintOf(o),
    ...(place ? { place } : {}),
    shadow: !!o.shadow && o.shadow.color.a > 0,
    ...(o.shadow ? { shadowBlur: Number.isFinite(o.shadow.blur) ? o.shadow.blur : 0 } : {}),
    ...(glow ? { glow } : {}),
    ...(o.softEdge ? { softEdge: o.softEdge } : {}),
  });
}

/** What a slide object draws as past a budget: without its geometry (`geom`), its effects, or both. */
export type LegacyPart = 'geom' | 'effects' | 'both';

const GEOM_FIELDS = ['geom', 'gradient', 'dash', 'ends', 'lineJoin', 'lineCap'] as const;
const EFFECT_FIELDS = ['shadow', 'glow', 'softEdge'] as const;

/** Whether leaving `part` out changes what `o` draws (`withoutPart` removes a field it has). */
export function hasPart(o: object, part: LegacyPart): boolean {
  const r = o as Record<string, unknown>;
  const type = r.type;
  if (part !== 'effects') {
    if (type === 'shape' && GEOM_FIELDS.some((k) => r[k] !== undefined)) return true;
    if (type === 'image' && r.mask !== undefined) return true;
  }
  return part !== 'geom' && type === 'shape' && EFFECT_FIELDS.some((k) => r[k] !== undefined);
}

/**
 * An object as drawn past a budget (a shallow copy): `geom` leaves out a shape's stored geometry, its gradient
 * (its `fill`, the first stop, is drawn: about five times cheaper a pixel) and the outline fields that
 * multiply its cost (dash, arrowheads, joins, caps), a picture's mask; `effects` a shape's shadow, glow and
 * soft edge. What is left is drawn as an older build draws it (a legacy rect, ellipse or line in its colour
 * with a plain outline), whose cost the geometry no longer drives.
 */
export function withoutPart<T extends object>(o: T, part: LegacyPart): T {
  const out = { ...o } as T & Record<string, unknown>;
  const type = (o as { type?: unknown }).type;
  if (part !== 'effects') {
    if (type === 'shape') for (const k of GEOM_FIELDS) delete out[k];
    else if (type === 'image') delete out.mask;
  }
  if (part !== 'geom' && type === 'shape') for (const k of EFFECT_FIELDS) delete out[k];
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
 * A slide's drawing budgets (design/27 §12 drawing cost), the same for the converter and every drawer. Every
 * object is drawn at least as its legacy copy (`withoutPart` 'both': an older build's shape, a picture
 * without its mask), which is counted first and never refused: what the slide draws in any case. Then, in
 * z-order, each object keeps its effects while their layers' area (`area`, `effectArea`) stays within
 * `EFFECT_COST.slide`, and its geometry and gradient while what that adds to its legacy copy (`rate`,
 * `charged`: estimates, painted areas and stored points) keeps the slide within `GEOM_COST.slide` and its
 * points within `GEOM_COST.slidePoints`; past them it is drawn as `withoutPart` leaves it, the geometry
 * first, then the effects too when that is not enough. So a slide draws within the budget whenever its legacy
 * copies do (the object budget bounds those), and a slide within it is drawn as it is, whatever the order.
 * `rate(o, part)` rates `o` as drawn without `part` (undefined: as it is); an object `part` would not change
 * (`hasPart`: a legacy rect) keeps it undefined.
 * Returns each object's part left out (undefined: drawn as it is).
 */
export function slidePlan<T>(
  objects: readonly T[],
  rate: (o: T, part?: LegacyPart) => Rated,
  area: (o: T) => number,
): (LegacyPart | undefined)[] {
  // Anything but a slide object (a test's stand-in) may change.
  const has = (o: T, part: LegacyPart) => typeof o !== 'object' || o === null || hasPart(o, part);
  // What every object draws at least: its legacy copy.
  const floor = objects.map((o) => (has(o, 'both') ? rate(o, 'both') : rate(o)));
  let points = 0;
  let cost = 0;
  for (const r of floor) {
    points += r.points;
    cost += charged(r);
  }
  let effects = 0;
  const out: (LegacyPart | undefined)[] = [];
  objects.forEach((o, i) => {
    const least = floor[i]!;
    // Drawn as `r` instead of its legacy copy, the slide stays within its budgets.
    const fits = (r: Rated) =>
      points + r.points - least.points <= GEOM_COST.slidePoints &&
      cost + charged(r) - charged(least) <= GEOM_COST.slide;
    const take = (r: Rated) => {
      points += r.points - least.points;
      cost += charged(r) - charged(least);
    };
    let part: LegacyPart | undefined;
    const a = area(o);
    if (a > 0) {
      if (effects + a > EFFECT_COST.slide) part = 'effects';
      else effects += a;
    }
    const r = rate(o, part);
    if (fits(r)) {
      take(r);
    } else if (part === undefined && has(o, 'geom') && fits(rate(o, 'geom'))) {
      part = 'geom';
      take(rate(o, 'geom'));
    } else {
      // Its legacy copy, counted already; its effects' area is no longer drawn.
      if (part === undefined && a > 0) effects -= a;
      part =
        has(o, 'geom') && has(o, 'effects')
          ? 'both'
          : has(o, 'geom')
            ? 'geom'
            : has(o, 'effects')
              ? 'effects'
              : undefined;
    }
    if (part === 'effects' && !has(o, 'effects')) part = undefined;
    out.push(part);
  });
  return out;
}

// ── Effects ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A slide's shape effects (design/27 §12 drawing cost, §13): the area their layers cover, in slides of
 * 1920 x 1080, at most `EFFECT_COST.slide` (weighted: a shadow and a glow 1 each, a soft edge
 * `EFFECT_COST.softEdge`: its body is made and cut by its enlarged mask at full resolution on every raster
 * past the composite cache, about 55 ms a slide area at 4K, against 25 ms cold and a few ms warm a slide area
 * of other layers, reduced and enlarged onto the canvas). Each layer is made over what the shape draws
 * (`bounds.ts` `drawnBounds`: its geometry's points, a custom geometry's past its box included, grown by its
 * outline's joins, caps and arrowheads) on the slide, grown by the effect's reach and cut to the canvas and
 * that reach (`effects.ts` `drawEffected`, `region`), and sized so here. Past it the renderer draws later
 * shapes without their effects (`slidePlan`) and the converter leaves them out with a note. The worship
 * corpus's most effected slides reach 7.7 (Slidesmania templates of 8-9 large shadowed shapes; p99 7.3, p90
 * 1.2), its most soft-edged 1.0 slide area of soft edges (9.2 weighted).
 */
export const EFFECT_COST = { slide: 10, softEdge: 8 } as const;

/** The fields of a shape `effectArea` reads. */
export interface EffectedObject {
  readonly box?: Placement['box'];
  readonly flipH?: boolean | undefined;
  readonly flipV?: boolean | undefined;
  readonly shadow?: { readonly dx: number; readonly dy: number; readonly blur: number } | undefined;
  readonly glow?: { readonly radius: number } | undefined;
  readonly softEdge?: number | undefined;
}

/**
 * What an object's effects weigh against `EFFECT_COST.slide`: their layers' area in slide areas, weighted.
 * `drawn` is what the shape draws in box space (`drawnBounds`; default: its box), placed on the slide and
 * grown and cut as the drawer grows and cuts its layers (`effects.ts` `drawEffected`; logical px, the reach's
 * 2 device px taken as 2).
 */
export function effectArea(o: EffectedObject, drawn?: Bounds): number {
  const weight = (o.shadow ? 1 : 0) + (o.glow ? 1 : 0) + (o.softEdge ? EFFECT_COST.softEdge : 0);
  if (!weight || !o.box) return 0;
  const fin = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const box = { x: fin(o.box.x), y: fin(o.box.y), w: Math.abs(fin(o.box.w)), h: Math.abs(fin(o.box.h)) };
  const b: Bounds = drawn ?? { x0: 0, y0: 0, x1: box.w, y1: box.h };
  if (![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)) return weight * MAX_LAYER_AREA;
  const content = placedBounds(b, {
    box: { ...box, rotation: fin(o.box.rotation) },
    flipH: o.flipH === true,
    flipV: o.flipV === true,
  });
  const all = { ...content };
  let cut = 2;
  if (o.shadow) {
    const reach = 3 * Math.abs(fin(o.shadow.blur)) * BLUR_SIGMA + 2;
    const dx = fin(o.shadow.dx);
    const dy = fin(o.shadow.dy);
    all.x0 = Math.min(all.x0, content.x0 + dx - reach);
    all.y0 = Math.min(all.y0, content.y0 + dy - reach);
    all.x1 = Math.max(all.x1, content.x1 + dx + reach);
    all.y1 = Math.max(all.y1, content.y1 + dy + reach);
    cut = Math.max(cut, reach + Math.max(Math.abs(dx), Math.abs(dy)));
  }
  if (o.glow) {
    const r = Math.abs(fin(o.glow.radius));
    const reach = r / 2 + 3 * (r / 2) * BLUR_SIGMA + 2;
    all.x0 = Math.min(all.x0, content.x0 - reach);
    all.y0 = Math.min(all.y0, content.y0 - reach);
    all.x1 = Math.max(all.x1, content.x1 + reach);
    all.y1 = Math.max(all.y1, content.y1 + reach);
    cut = Math.max(cut, reach);
  }
  return Math.min(MAX_LAYER_AREA, canvasArea(all, cut) / SLIDE_AREA) * weight;
}

/** A layer's area at most, in slide areas: the canvas grown by the largest reach the clamp allows (about 3 x 3). */
const MAX_LAYER_AREA = (3 * CANVAS_W * 3 * CANVAS_H) / SLIDE_AREA;

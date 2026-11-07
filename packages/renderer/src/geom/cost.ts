import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD } from './ops.ts';
import type { GeomPath } from './path.ts';

/*
 * What a stored geometry costs to draw (design/27 §12 "drawing cost", §13). The counts of §12 (4,096 points a
 * path, 8 paths, 64k points a slide) do not bound the time Canvas spends filling a path: a scan converter
 * walks every edge on every row it spans, with partial coverage across the pixels a slanted edge crosses
 * within a row, and re-sorts the edges active on a row where they cross. One custom geometry whose edges
 * zigzag across its box stays inside every count and takes seconds to fill at 4K (Chromium 153: 4,000 points
 * 1.5 s at 1920; a chain of 21,600 points 22.7 s), on the output's asset worker and on the editor's main
 * thread.
 *
 * The estimate, per filled unit (a path, the pieces of a `cont` chain joined, as they are filled together):
 * - its edges' length along their longer axis (max(|dx|, |dy|), logical px; the control polygon of a curve,
 *   which bounds the curve; an edge with dy = 0 is skipped by a scan converter and costs nothing), the work
 *   rows and partial coverage take;
 * - times (1 + A / GEOM_COST.peakScale), A the most edges active at once (those crossing one of
 *   GEOM_COST.bands bands of the unit's height, counted as a difference array): what crossing and converging
 *   edges add.
 * Measured in a dedicated worker on a willReadFrequently OffscreenCanvas at 3840 x 2160 (Chromium 153), one
 * unit costs at most about 30 ns at 4K over the arrangements tried: zigzags across the box (26-30 ns), the
 * same in a band a tenth of its height (23 ns), cross-hatches of 1,024 and 4,096 edges from the whole box down
 * to a few pixels (15-26 ns), spikes converging on the centre (6 ns), an outline with 480 holes; edges side by
 * side that never cross (a comb of 2,048 vertical teeth: 0.6 ns, a row of small stars) cost far less than
 * their estimate, so a geometry of many such edges per row is sent to LibreOffice sooner than it need be. The
 * estimate is in box space (logical px), the same at any device scale; at 1080p the work is about half.
 *
 * Budgets (`GEOM_COST`): a geometry past `geometry` is not drawn natively (the converter sends it to the art
 * as `custGeom:complex`; the renderer draws the legacy shape), and a slide's geometries are drawn while their
 * estimates, weighted by what draws them (`drawWeight`), and their points stay within `slide` and
 * `slidePoints` (the converter sends the rest to the art; the renderer draws them as legacy shapes). The
 * worship corpus's costliest geometry, a traced 8,300-point silhouette of a Slidesmania template, is 0.64M
 * (43 % of `geometry`), and its costliest slide, two of them and other decorations, 1.42M (47 % of `slide`;
 * 61,504 points). A slide at the budgets draws in at most about 90 ms at 4K, against seconds before.
 */

export const GEOM_COST = {
  /** Bands of a unit's height in which the edges active at once are counted. */
  bands: 64,
  /** Edges active at once at which the second term of the estimate equals the first. */
  peakScale: 64,
  /** Estimate of one geometry at most (about 45 ms at 4K for the costliest arrangements measured). */
  geometry: 1_500_000,
  /** Weighted estimates of one slide's geometries at most (about 90 ms at 4K). */
  slide: 3_000_000,
  /** Points of one slide's stored paths at most (§12: 64k). */
  slidePoints: 65_536,
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

/**
 * The drawing estimate of one filled unit: `cmds` and `pts` as a GeomPath holds them, scaled by kx, ky to
 * logical px. Sub-paths are closed for the count (a fill closes them). Never throws; non-finite input
 * counts as 0.
 */
export function unitCost(cmds: readonly number[], pts: readonly number[], kx = 1, ky = 1): UnitCost {
  const sx = Number.isFinite(kx) ? Math.abs(kx) : 0;
  const sy = Number.isFinite(ky) ? Math.abs(ky) : 0;
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
  return { length, peak, est: Number.isFinite(est) ? est : Infinity };
}

/** The drawing estimate of a built geometry in box space: the sum over its paths (each a filled unit). */
export function geomCost(paths: readonly GeomPath[], kx = 1, ky = 1): number {
  let c = 0;
  for (const p of paths) c += unitCost(p.cmds, p.pts, kx, ky).est;
  return c;
}

/**
 * How many times a shape's geometry is traced when it is drawn: its fill (or a picture's mask), twice more
 * for an outline (a stroke's outline has about twice the edges), and per effect the passes `effects.ts`
 * makes of it (a shadow redraws the shape once, a glow and a soft edge fill and stroke its silhouette).
 */
export function drawWeight(o: {
  stroked?: boolean;
  shadow?: boolean;
  glow?: boolean;
  softEdge?: boolean;
}): number {
  return 1 + (o.stroked ? 2 : 0) + (o.shadow ? 1 : 0) + (o.glow ? 3 : 0) + (o.softEdge ? 3 : 0);
}

// ── Effects ───────────────────────────────────────────────────────────────────────────────────────────────

/** The logical area of a 1920 x 1080 slide. */
const SLIDE_AREA = 1920 * 1080;
/** σ of a stack blur of radius r, over r (effects.ts STACK_BLUR_SIGMA). */
const BLUR_SIGMA = 1 / Math.sqrt(6);

/**
 * A slide's shape effects (design/27 §12 drawing cost, §13): the area their layers cover, in slides of
 * 1920 x 1080, at most `EFFECT_COST.slide` (weighted: a shadow and a glow 1 each, a soft edge 2, its sprite
 * of the shape's bounds made at full resolution). Past it the renderer draws later shapes without their
 * effects (`geombudget.ts`) and the converter leaves them out with a note. At 4K a slide area of layers costs
 * about 25 ms (a reduced layer enlarged onto the canvas), a soft edge about 130 ms; the worship corpus's most
 * effected slides reach 7.7 (Slidesmania templates of 8-9 large shadowed shapes; p99 7.3, p90 1.2).
 */
export const EFFECT_COST = { slide: 10 } as const;

/** What an object's effects weigh against `EFFECT_COST.slide`: their layers' area in slide areas, weighted. */
export function effectArea(o: {
  box?: { w: number; h: number };
  shadow?: { dx: number; dy: number; blur: number } | undefined;
  glow?: { radius: number } | undefined;
  softEdge?: number | undefined;
}): number {
  const weight = (o.shadow ? 1 : 0) + (o.glow ? 1 : 0) + (o.softEdge ? 2 : 0);
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

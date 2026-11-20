import type { AdjustPairs } from './eval.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD } from './ops.ts';
import { type BuiltGeom, buildGeom, COORD_LIMIT, type GeomPath } from './path.ts';
import { TEXT_WARP_GEOMS } from './textwarps.gen.ts';

/*
 * WordArt text warps, the geometry half (r2b sub-wave 2, warp-geom; design/27 §15 M9 scope, the M9 warps design): the
 * 40 preset text warps of ECMA-376's presetTextWarpDefinitions (textwarps.gen.ts, compiled from the vendored file in
 * third_party/ooxml-textwarps by tools/geom-gen) built at a box through `buildGeom`, plus what a painter needs to know
 * about a built warp. Nothing draws with it yet: the glyph painter that bends text along these shapes is part 3's
 * (warp-paint), and a text object still draws straight until then.
 *
 * - A warp is a pair of paths per text area (a top line and a bottom line, each a straight line or a curve), or, for
 *   four presets, a single path the text follows (Arch Up, Arch Down, Circle, Button). The file has no text rectangle:
 *   `r` is the whole box, so the text takes the box, and no connection sites.
 * - The drawing mode is a property of the built geometry, not of the preset's name: the design lists textSlantUp,
 *   textSlantDown and the Cascade and Fade presets as envelopes, but the geometry says otherwise (measured with this
 *   compiler and builder). textPlain, textSlantUp and textSlantDown build two parallel, equal lines at every adjust
 *   value, so they are affine; textCascadeUp and textCascadeDown are envelopes at their defaults and affine at adj >=
 *   100000, the four Fade presets envelopes at their defaults and affine at adj <= 0 (the two lines become parallel
 *   and equal). The one name-level fact is `warpFollowsPath`: an odd path count. A converter that only needs to know
 *   whether a warp follows its path asks that, and writes no table of names to modes.
 * - Every function here is pure (imports only sibling geometry modules, no DOM, no process, no network, no timers),
 *   total (a hostile name, box or adjust value gives undefined or finite numbers, never a throw: `buildGeom` bounds
 *   the box and every coordinate). Building and flattening a warp takes about 25 us
 *   once the code is warm (all 40 at 1920 x 1080 in about 1 ms), and 15-20 ms for all 40 the first time in a process (the
 *   first call alone 3-6 ms: the code's first run); a memo hit takes under a microsecond.
 *
 * Arc-length tables (`flattenWarpPath`, `arcAt`, `warpArcs`): a built path flattened to a polyline with its cumulative
 * length, so a painter can put a glyph at a fraction of the way along a line, and a memo of the arcs of a warp at a
 * box. The memo is bounded by entries (WARP_MEMO_MAX) and by points (WARP_MEMO_POINTS): an arc is up to 4,096 points of
 * 24 bytes, a warp up to six arcs, so 256 entries alone could hold about 150 MB for a hostile deck of 256 distinct huge
 * boxes; 400,000 points are about 9.6 MB, and the realistic worst (all 40 warps at 1920 x 1080) is about 12,000 points.
 *
 * Module state is literals, the generated table and one empty `Map` only, so a bundler drops this module and the table
 * from every bundle that never builds a warp (the same way it drops the 187-preset table from the phones' first load).
 */

/** How a warp maps text to its shape: one affine map, along its single path, or between two curves (an envelope). */
export type WarpMode = 'affine' | 'path' | 'envelope';

/**
 * Tolerance of the affine rule: the two lines of a pair are parallel and equal when their direction vectors differ by at
 * most this fraction of the box's larger side (a millionth: above arithmetic noise, below anything visible).
 */
export const WARP_PARALLEL_EPS = 1e-6;

/** The 40 warps (ECMA-376 ST_TextShapeType without textNoShape), sorted. The domain's TEXT_WARPS lists the same names. */
export const TEXT_WARP_NAMES: readonly string[] = [
  'textArchDown',
  'textArchDownPour',
  'textArchUp',
  'textArchUpPour',
  'textButton',
  'textButtonPour',
  'textCanDown',
  'textCanUp',
  'textCascadeDown',
  'textCascadeUp',
  'textChevron',
  'textChevronInverted',
  'textCircle',
  'textCirclePour',
  'textCurveDown',
  'textCurveUp',
  'textDeflate',
  'textDeflateBottom',
  'textDeflateInflate',
  'textDeflateInflateDeflate',
  'textDeflateTop',
  'textDoubleWave1',
  'textFadeDown',
  'textFadeLeft',
  'textFadeRight',
  'textFadeUp',
  'textInflate',
  'textInflateBottom',
  'textInflateTop',
  'textPlain',
  'textRingInside',
  'textRingOutside',
  'textSlantDown',
  'textSlantUp',
  'textStop',
  'textTriangle',
  'textTriangleInverted',
  'textWave1',
  'textWave2',
  'textWave4',
];

/** Whether `name` is one of the 40 warps (a preset shape's name is not one; neither is anything that is not a string). */
export function hasTextWarp(name: unknown): boolean {
  return typeof name === 'string' && TEXT_WARP_GEOMS.has(name);
}

/**
 * A warp built at a w x h box (the caller's units), with the shape's adjust values by name (`buildGeom`'s rules:
 * unknown names are ignored, every value is pinned by the preset's own guides); undefined for a name that is not a warp.
 */
export function textWarpGeometry(
  name: string,
  w: number,
  h: number,
  adj?: AdjustPairs,
): BuiltGeom | undefined {
  const geom = typeof name === 'string' ? TEXT_WARP_GEOMS.get(name) : undefined;
  return geom === undefined ? undefined : buildGeom(geom, w, h, adj);
}

/** The preset's own adjust value names (adj, or adj1 and adj2); undefined for a name that is not a warp. */
export function warpAdjustNames(name: string): readonly string[] | undefined {
  return typeof name === 'string' ? TEXT_WARP_GEOMS.get(name)?.a : undefined;
}

/**
 * Whether the text of this warp follows its path (Arch Up, Arch Down, Circle and Button: an odd path count) instead of
 * filling the space between a pair of lines or curves. The one fact about a warp that is a property of its name.
 */
export function warpFollowsPath(name: string): boolean {
  const geom = typeof name === 'string' ? TEXT_WARP_GEOMS.get(name) : undefined;
  return geom !== undefined && geom.p.length % 2 === 1;
}

/** A path that is one straight line: a moveTo and a lineTo. */
function straight(p: BuiltGeom['paths'][number]): boolean {
  return p.cmds.length === 2 && p.cmds[0] === CMD_MOVE && p.cmds[1] === CMD_LINE && p.pts.length >= 4;
}

/**
 * The drawing mode of a built warp, decided by its geometry: an odd path count is 'path' (the text follows the path);
 * otherwise, when every pair of paths is two straight lines whose direction vectors differ by at most
 * WARP_PARALLEL_EPS x the larger box side, 'affine' (one parallelogram map; no paths at all is affine too); else
 * 'envelope' (the text is stretched between the two curves of each pair).
 */
export function warpMode(geom: Pick<BuiltGeom, 'w' | 'h' | 'paths'>): WarpMode {
  const paths = geom.paths;
  if (paths.length % 2 === 1) return 'path';
  const tol = WARP_PARALLEL_EPS * Math.max(geom.w, geom.h);
  for (let i = 0; i + 1 < paths.length; i += 2) {
    const p = paths[i]!;
    const q = paths[i + 1]!;
    if (!straight(p) || !straight(q)) return 'envelope';
    const dx = p.pts[2]! - p.pts[0]! - (q.pts[2]! - q.pts[0]!);
    const dy = p.pts[3]! - p.pts[1]! - (q.pts[3]! - q.pts[1]!);
    if (!(Math.hypot(dx, dy) <= tol)) return 'envelope';
  }
  return 'affine';
}

/**
 * How many text areas a built warp has: its path count when odd (each path is an area), half of it when even (each pair
 * of paths is one area). Most warps have one; Deflate Inflate has two, Deflate Inflate Deflate and Button Pour three,
 * Button three (its three paths are three areas).
 */
export function warpAreas(geom: Pick<BuiltGeom, 'paths'>): number {
  const n = geom.paths.length;
  return n % 2 === 1 ? n : n / 2;
}

/** The flatness a path is flattened to, in px: a polyline's chord strays from the curve by at most this much. */
export const WARP_FLATNESS_PX = 0.02;
/** Most points of one flattened path (a built path holds at most this many points, GEOM_LIMITS.points). */
export const WARP_MAX_POINTS = 4096;
/** Most entries of the arc memo. */
export const WARP_MEMO_MAX = 256;
/** Most points of all the arc memo's entries together (about 9.6 MB at 24 bytes a point). */
export const WARP_MEMO_POINTS = 400_000;

/** Deepest subdivision of one curve: 2^12 = 4,096 segments. */
const MAX_DEPTH = 12;
/** Doublings of the tolerance tried before a curve is cut into equal parameter steps. */
const MAX_DOUBLINGS = 30;
/** Equal parameter steps of a curve once doubling the tolerance does not fit the path in WARP_MAX_POINTS. */
const FALLBACK_STEPS = 16;
/** Longest adjust value name and most adjust pairs the memo's key reads (the schema's own bounds on a warp). */
const KEY_NAME_MAX = 16;
const KEY_PAIRS_MAX = 4;

/** A path flattened to a polyline: its points, the cumulative length at each, the total and the tolerance used. */
export interface WarpArc {
  /** x y pairs. */
  readonly xy: Float64Array;
  /** Cumulative length at each point: `len[0]` is 0 and the last is `total`; it never decreases. */
  readonly len: Float64Array;
  readonly total: number;
  /**
   * The tolerance the polyline was flattened to: the requested flatness when nothing had to be coarser, a doubled one
   * when the path did not fit WARP_MAX_POINTS, Infinity when its curves were cut into equal steps instead.
   */
  readonly tol: number;
}

/** A point of an arc. */
export interface WarpPoint {
  x: number;
  y: number;
}

/** A warp built at a box, flattened: one arc per path with the geometry facts a painter asks for. */
export interface WarpArcs {
  readonly name: string;
  /** The box as buildGeom reads it (a side of NaN or below 0 is 0, one above the largest box is the largest box). */
  readonly w: number;
  readonly h: number;
  /** One arc per path of the built warp, in path order (see `warpAreaArcs` for which arcs make an area). */
  readonly arcs: readonly WarpArc[];
  readonly mode: WarpMode;
  readonly areas: number;
  /** Points of all the arcs together: what the memo bounds. */
  readonly points: number;
}

/** A coordinate as the flattening reads it: finite and within the builder's bound. */
function coord(v: number): number {
  return Number.isFinite(v) ? Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v)) : 0;
}

/** The segments of the first sub-path of a path: a line is 2 numbers (its end), a curve 6 (two controls and its end). */
interface Segments {
  readonly x0: number;
  readonly y0: number;
  readonly curve: boolean[];
  readonly xy: number[];
}

function segmentsOf(path: GeomPath): Segments | undefined {
  const { cmds, pts } = path;
  const curve: boolean[] = [];
  const xy: number[] = [];
  let at = 0;
  let started = false;
  let x0 = 0;
  let y0 = 0;
  let cx = 0;
  let cy = 0;
  const need = (n: number): boolean => at + n <= pts.length;
  for (const op of cmds) {
    if (op === CMD_MOVE) {
      if (started || !need(2)) break;
      x0 = cx = coord(pts[at]!);
      y0 = cy = coord(pts[at + 1]!);
      at += 2;
      started = true;
    } else if (op === CMD_LINE) {
      if (!need(2)) break;
      const x = coord(pts[at]!);
      const y = coord(pts[at + 1]!);
      at += 2;
      if (!started) {
        x0 = cx = x;
        y0 = cy = y;
        started = true;
      } else {
        curve.push(false);
        xy.push(x, y);
        cx = x;
        cy = y;
      }
    } else if (op === CMD_QUAD || op === CMD_CUBIC) {
      const n = op === CMD_QUAD ? 4 : 6;
      if (!need(n)) break;
      const v = [];
      for (let i = 0; i < n; i++) v.push(coord(pts[at + i]!));
      at += n;
      if (!started) {
        x0 = cx = v[0]!;
        y0 = cy = v[1]!;
        started = true;
      }
      curve.push(true);
      if (op === CMD_QUAD) {
        // A quadratic raised to the cubic with the same curve.
        const [qx, qy, ex, ey] = v as [number, number, number, number];
        xy.push(
          cx + (2 / 3) * (qx - cx),
          cy + (2 / 3) * (qy - cy),
          ex + (2 / 3) * (qx - ex),
          ey + (2 / 3) * (qy - ey),
          ex,
          ey,
        );
        cx = ex;
        cy = ey;
      } else {
        xy.push(v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!);
        cx = v[4]!;
        cy = v[5]!;
      }
    } else if (op === CMD_CLOSE) {
      if (started && (cx !== x0 || cy !== y0)) {
        curve.push(false);
        xy.push(x0, y0);
      }
      break;
    } else break;
  }
  return started ? { x0, y0, curve, xy } : undefined;
}

/** The squared distance of (px, py) from the segment (ax, ay)-(bx, by). */
function segmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = px - ax;
  const ey = py - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return ex * ex + ey * ey;
  const t = (ex * dx + ey * dy) / l2;
  if (t <= 0) return ex * ex + ey * ey;
  if (t >= 1) {
    const fx = px - bx;
    const fy = py - by;
    return fx * fx + fy * fy;
  }
  const cross = ex * dy - ey * dx;
  return (cross * cross) / l2;
}

/**
 * Appends the points of one cubic, after its start, to `out` by adaptive subdivision (de Casteljau, depth at most
 * MAX_DEPTH). A cubic is flat when 3/4 of the larger distance of its two control points from its chord is within the
 * tolerance (`flat2` is the square of tolerance / 0.75): the curve is a convex combination of its control points, so it
 * strays from the chord by at most that much. False as soon as `out` would
 * hold more than WARP_MAX_POINTS points.
 */
function flatCubic(
  out: number[],
  flat2: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  depth: number,
): boolean {
  const d2 = Math.max(segmentDistanceSq(x1, y1, x0, y0, x3, y3), segmentDistanceSq(x2, y2, x0, y0, x3, y3));
  if (depth >= MAX_DEPTH || !(d2 > flat2)) {
    if (out.length >= 2 * WARP_MAX_POINTS) return false;
    out.push(x3, y3);
    return true;
  }
  // Split at t = 1/2.
  const x01 = (x0 + x1) / 2;
  const y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2;
  const y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2;
  const y23 = (y2 + y3) / 2;
  const xa = (x01 + x12) / 2;
  const ya = (y01 + y12) / 2;
  const xb = (x12 + x23) / 2;
  const yb = (y12 + y23) / 2;
  const xm = (xa + xb) / 2;
  const ym = (ya + yb) / 2;
  return (
    flatCubic(out, flat2, x0, y0, x01, y01, xa, ya, xm, ym, depth + 1) &&
    flatCubic(out, flat2, xm, ym, xb, yb, x23, y23, x3, y3, depth + 1)
  );
}

/** Flattens the segments with adaptive subdivision at `tol`; undefined as soon as the polyline would pass WARP_MAX_POINTS. */
function flattenAdaptive(seg: Segments, tol: number): number[] | undefined {
  const out: number[] = [seg.x0, seg.y0];
  const flat2 = (tol / 0.75) * (tol / 0.75);
  let cx = seg.x0;
  let cy = seg.y0;
  let at = 0;
  for (const isCurve of seg.curve) {
    if (!isCurve) {
      if (out.length >= 2 * WARP_MAX_POINTS) return undefined;
      cx = seg.xy[at]!;
      cy = seg.xy[at + 1]!;
      out.push(cx, cy);
      at += 2;
      continue;
    }
    const x3 = seg.xy[at + 4]!;
    const y3 = seg.xy[at + 5]!;
    if (
      !flatCubic(
        out,
        flat2,
        cx,
        cy,
        seg.xy[at]!,
        seg.xy[at + 1]!,
        seg.xy[at + 2]!,
        seg.xy[at + 3]!,
        x3,
        y3,
        0,
      )
    )
      return undefined;
    at += 6;
    cx = x3;
    cy = y3;
  }
  return out;
}

/** The segments with every curve cut into `steps` equal parameter steps (1: the chord); undefined past the cap. */
function flattenSteps(seg: Segments, steps: number, cap: number): number[] | undefined {
  const out: number[] = [seg.x0, seg.y0];
  let cx = seg.x0;
  let cy = seg.y0;
  let at = 0;
  for (const isCurve of seg.curve) {
    if (!isCurve) {
      if (out.length / 2 >= cap) return undefined;
      cx = seg.xy[at]!;
      cy = seg.xy[at + 1]!;
      out.push(cx, cy);
      at += 2;
      continue;
    }
    const x1 = seg.xy[at]!;
    const y1 = seg.xy[at + 1]!;
    const x2 = seg.xy[at + 2]!;
    const y2 = seg.xy[at + 3]!;
    const x3 = seg.xy[at + 4]!;
    const y3 = seg.xy[at + 5]!;
    at += 6;
    for (let i = 1; i <= steps; i++) {
      if (out.length / 2 >= cap) return undefined;
      if (i === steps) out.push(x3, y3);
      else {
        const t = i / steps;
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const d = t * t * t;
        out.push(a * cx + b * x1 + c * x2 + d * x3, a * cy + b * y1 + c * y2 + d * y3);
      }
    }
    cx = x3;
    cy = y3;
  }
  return out;
}

/**
 * A built path flattened to a polyline with its cumulative arc length (only its first sub-path: no preset has a second).
 * Curves are cut by adaptive subdivision until every chord is within `flatness` of its curve; a path that would then hold
 * more than WARP_MAX_POINTS is flattened again at twice the tolerance, up to 30 doublings, then with every curve in
 * 16 equal parameter steps, and last, for a path of more curves than that fits, as its chords: `tol` says which (the
 * tolerance used, Infinity for the two cuts into steps). The path is never cut short and nothing throws; a coordinate that
 * is not finite reads as 0.
 */
export function flattenWarpPath(path: GeomPath, flatness: number = WARP_FLATNESS_PX): WarpArc {
  const f = Number.isFinite(flatness) && flatness > 0 ? flatness : WARP_FLATNESS_PX;
  const seg = segmentsOf(path);
  if (seg === undefined) return { xy: new Float64Array(0), len: new Float64Array(0), total: 0, tol: f };
  let tol = f;
  let pts = flattenAdaptive(seg, tol);
  if (pts === undefined) {
    // Twice the tolerance until it fits, at most 30 times. A coarser tolerance never gives more points, so the smallest
    // doubling that fits is found by halving the range instead of trying every one.
    const doubled = (k: number): number => f * 2 ** k;
    const last = flattenAdaptive(seg, doubled(MAX_DOUBLINGS));
    if (last !== undefined) {
      let lo = 1;
      let hi = MAX_DOUBLINGS;
      let best = last;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const at = flattenAdaptive(seg, doubled(mid));
        if (at !== undefined) {
          best = at;
          hi = mid;
        } else lo = mid + 1;
      }
      pts = best;
      tol = doubled(hi);
    }
  }
  if (pts === undefined) {
    tol = Number.POSITIVE_INFINITY;
    // A built path has at most GEOM_LIMITS.points = WARP_MAX_POINTS points, so its chords always fit.
    pts =
      flattenSteps(seg, FALLBACK_STEPS, WARP_MAX_POINTS) ?? flattenSteps(seg, 1, Number.POSITIVE_INFINITY)!;
  }
  const n = pts.length / 2;
  const xy = new Float64Array(pts);
  const len = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dx = xy[2 * i]! - xy[2 * i - 2]!;
    const dy = xy[2 * i + 1]! - xy[2 * i - 1]!;
    len[i] = len[i - 1]! + Math.sqrt(dx * dx + dy * dy);
  }
  return { xy, len, total: len[n - 1]!, tol };
}

/**
 * The point `u` of the way along an arc's length (0 the first point, 1 the last; u below 0, NaN and -Infinity give the
 * first point, u above 1 and Infinity the last; a zero-length arc gives its point, an empty one the origin). Fills and
 * returns `out` when given, so a painter placing every glyph allocates nothing.
 */
export function arcAt(arc: WarpArc, u: number, out: WarpPoint = { x: 0, y: 0 }): WarpPoint {
  const n = arc.len.length;
  if (n === 0) {
    out.x = 0;
    out.y = 0;
  } else if (!(u > 0) || !(arc.total > 0)) {
    out.x = arc.xy[0]!;
    out.y = arc.xy[1]!;
  } else if (u >= 1) {
    out.x = arc.xy[2 * n - 2]!;
    out.y = arc.xy[2 * n - 1]!;
  } else {
    const target = u * arc.total;
    // The first point at or past the target length; the target is above 0, so this is the end of a segment.
    let lo = 1;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arc.len[mid]! >= target) hi = mid;
      else lo = mid + 1;
    }
    const a = arc.len[lo - 1]!;
    const span = arc.len[lo]! - a;
    const t = span > 0 ? (target - a) / span : 0;
    out.x = arc.xy[2 * lo - 2]! + t * (arc.xy[2 * lo]! - arc.xy[2 * lo - 2]!);
    out.y = arc.xy[2 * lo - 1]! + t * (arc.xy[2 * lo + 1]! - arc.xy[2 * lo - 1]!);
  }
  return out;
}

/** The arc memo, least recently used first (a `Map` keeps insertion order; a hit is deleted and set again). */
const memo = new Map<string, WarpArcs>();

/** A box side as buildGeom reads it. */
function side(v: number): number {
  return v > 0 ? Math.min(v, COORD_LIMIT) : 0;
}

/** The adjust pairs the key reads: of the first four, those with a string name of at most 16 characters and a finite value. */
function keyPairs(adj: AdjustPairs | undefined): [string, number][] {
  const out: [string, number][] = [];
  if (!Array.isArray(adj)) return out;
  for (let i = 0; i < Math.min(adj.length, KEY_PAIRS_MAX); i++) {
    const pair = adj[i];
    if (!Array.isArray(pair)) continue;
    const [name, value] = pair;
    if (
      typeof name === 'string' &&
      name.length <= KEY_NAME_MAX &&
      typeof value === 'number' &&
      Number.isFinite(value)
    )
      out.push([name, value]);
  }
  return out;
}

/**
 * Puts `entry` in a least-recently-used map bounded by `maxEntries` and by the sum of its entries' `points`: the key
 * becomes the newest and the oldest entries go until both bounds hold. An entry larger than the whole points bound is not
 * kept (its caller still returns it).
 */
export function memoPut<T extends { readonly points: number }>(
  map: Map<string, T>,
  key: string,
  entry: T,
  maxEntries: number,
  maxPoints: number,
): void {
  map.delete(key);
  if (maxEntries < 1 || entry.points > maxPoints) return;
  map.set(key, entry);
  let points = 0;
  for (const e of map.values()) points += e.points;
  for (const [k, e] of map) {
    if (map.size <= maxEntries && points <= maxPoints) break;
    if (k === key) break;
    map.delete(k);
    points -= e.points;
  }
}

/**
 * A warp built at a box and flattened, memoised: the same arguments give the same object. The key reads the box as
 * buildGeom does and the first four adjust pairs by name and value only (a pair with a non-finite value or a name over
 * 16 characters is neither keyed nor passed on), so one meaning has one entry. Undefined for a name that is not a warp.
 */
export function warpArcs(name: string, w: number, h: number, adj?: AdjustPairs): WarpArcs | undefined {
  const geom = typeof name === 'string' ? TEXT_WARP_GEOMS.get(name) : undefined;
  if (geom === undefined) return undefined;
  const bw = side(w);
  const bh = side(h);
  const pairs = keyPairs(adj);
  const key = `${name} ${bw} ${bh} ${JSON.stringify(pairs)}`;
  const hit = memo.get(key);
  if (hit !== undefined) {
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const built = buildGeom(geom, bw, bh, pairs);
  const arcs = built.paths.map((p) => flattenWarpPath(p));
  let points = 0;
  for (const a of arcs) points += a.len.length;
  const entry: WarpArcs = {
    name,
    w: built.w,
    h: built.h,
    arcs,
    mode: warpMode(built),
    areas: warpAreas(built),
    points,
  };
  memoPut(memo, key, entry, WARP_MEMO_MAX, WARP_MEMO_POINTS);
  return entry;
}

/**
 * The arcs (or any per-path list) of one text area: with an odd path count each path is an area, with an even one
 * each pair of paths (a top line and a bottom line) is. Empty for an area that does not exist.
 */
export function warpAreaArcs<T>(arcs: readonly T[], area: number): readonly T[] {
  if (!Number.isInteger(area) || area < 0) return [];
  if (arcs.length % 2 === 1) return area < arcs.length ? [arcs[area]!] : [];
  return arcs.slice(2 * area, 2 * area + 2);
}

/** Empties the arc memo. */
export function clearWarpMemo(): void {
  memo.clear();
}

/** What the arc memo holds now: its entries and their points together (WARP_MEMO_MAX and WARP_MEMO_POINTS bound them). */
export function warpMemoStats(): { entries: number; points: number } {
  let points = 0;
  for (const e of memo.values()) points += e.points;
  return { entries: memo.size, points };
}

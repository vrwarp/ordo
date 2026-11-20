import type { AdjustPairs } from './eval.ts';
import { CMD_LINE, CMD_MOVE } from './ops.ts';
import { type BuiltGeom, buildGeom, type GeomPath } from './path.ts';
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
 *   the box and every coordinate) and costs a few microseconds a call.
 *
 * Module state is literals and the generated table only, so a bundler drops this module and the table from every
 * bundle that never builds a warp (the same way it drops the 187-preset table from the phones' first load).
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

// STUB (red first): the arc tables and their memo do nothing yet; the tests of textwarp.test.ts and
// textwarp.fuzz.test.ts fail against it and the next commit builds them.

/** The flatness a path is flattened to, in px (a thousandth of a pixel is far below anything drawn). */
export const WARP_FLATNESS_PX = 0.02;
/** Most points of one flattened path. */
export const WARP_MAX_POINTS = 4096;
/** Most entries of the arc memo. */
export const WARP_MEMO_MAX = 256;
/** Most points of all the arc memo's entries together. */
export const WARP_MEMO_POINTS = 400_000;

/** A path flattened to a polyline with its cumulative length. */
export interface WarpArc {
  readonly xy: Float64Array;
  readonly len: Float64Array;
  readonly total: number;
  readonly tol: number;
}

/** A point of an arc. */
export interface WarpPoint {
  x: number;
  y: number;
}

/** A warp's arcs, one per path, with what a painter asks of the built geometry. */
export interface WarpArcs {
  readonly name: string;
  readonly w: number;
  readonly h: number;
  readonly arcs: readonly WarpArc[];
  readonly mode: WarpMode;
  readonly areas: number;
  readonly points: number;
}

export function flattenWarpPath(_path: GeomPath, _flatness: number = WARP_FLATNESS_PX): WarpArc {
  return { xy: new Float64Array(0), len: new Float64Array(0), total: 0, tol: 0 };
}

export function arcAt(_arc: WarpArc, _u: number, out: WarpPoint = { x: 0, y: 0 }): WarpPoint {
  return out;
}

export function warpArcs(_name: string, _w: number, _h: number, _adj?: AdjustPairs): WarpArcs | undefined {
  return undefined;
}

export function warpAreaArcs<T>(_arcs: readonly T[], _area: number): readonly T[] {
  return [];
}

export function memoPut<T extends { readonly points: number }>(
  _memo: Map<string, T>,
  _key: string,
  _entry: T,
  _maxEntries: number,
  _maxPoints: number,
): void {}

export function clearWarpMemo(): void {}

export function warpMemoStats(): { entries: number; points: number } {
  return { entries: 0, points: 0 };
}

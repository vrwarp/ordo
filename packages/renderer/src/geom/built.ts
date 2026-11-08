import type { ShapeGeom } from '@ordo/domain';
import { parsePathData } from '@ordo/domain/pathdata.ts';
import { clampPoints, GEOM_COST, geomCost } from './cost.ts';
import {
  CMD_CLOSE,
  CMD_CUBIC,
  CMD_LINE,
  CMD_MOVE,
  CMD_QUAD,
  GEOM_LIMITS,
  PATH_FILLS,
  type PathFill,
} from './ops.ts';
import { type BuiltGeom, COORD_LIMIT, type GeomPath, presetGeometry } from './path.ts';

/*
 * A stored geometry's paths built at a box (design/27 §3.1 `ShapeGeom`), and the legacy shapes as
 * geometries: what the drawers draw (`stored.ts` memoises it and reads geometry files) and what the converter
 * rates its emitted objects by (`pptx-scene` `emit.ts`), the same numbers in both. Pure: no clamp, no files.
 */

const CMD_OF: Readonly<Record<string, number>> = {
  M: CMD_MOVE,
  L: CMD_LINE,
  Q: CMD_QUAD,
  C: CMD_CUBIC,
  Z: CMD_CLOSE,
};

/** A box side within the coordinate bound (0 for anything not positive). */
export function boxSide(v: number): number {
  return v > 0 ? Math.min(v, COORD_LIMIT) : 0;
}

function coord(v: number): number {
  return v > COORD_LIMIT ? COORD_LIMIT : v < -COORD_LIMIT ? -COORD_LIMIT : Number.isNaN(v) ? 0 : v + 0;
}

type StoredPath = NonNullable<ShapeGeom['paths']>[number];

/** One stored path in box space. */
export function storedPath(p: StoredPath, w: number, h: number): GeomPath {
  const parsed = parsePathData(p?.d, GEOM_LIMITS.points);
  const sw = typeof p?.w === 'number' && p.w > 0 && Number.isFinite(p.w) ? w / p.w : 1;
  const sh = typeof p?.h === 'number' && p.h > 0 && Number.isFinite(p.h) ? h / p.h : 1;
  const cmds: number[] = [];
  for (const c of parsed.cmds) cmds.push(CMD_OF[c]!);
  const pts = parsed.pts;
  for (let i = 0; i < pts.length; i += 2) {
    pts[i] = coord(pts[i]! * sw);
    pts[i + 1] = coord(pts[i + 1]! * sh);
  }
  const fill: PathFill = PATH_FILLS.includes(p?.fill as PathFill) ? (p.fill as PathFill) : 'norm';
  return { cmds, pts, fill, stroke: p?.stroke !== false };
}

/** A geometry built from stored paths, with its fill estimate (`geomCost`) and its points. */
export interface PathsGeometry {
  readonly built: BuiltGeom;
  readonly est: number;
  readonly points: number;
}

/**
 * Stored paths built at a `w` x `h` box (sides already within the bound, `boxSide`): at most
 * GEOM_LIMITS.paths, a path marked `cont` appended to the one before it (its pieces become the one path they
 * were cut from); undefined for none, or past `GEOM_COST.geometry` (its fill would take seconds: the legacy
 * shape is drawn).
 */
export function pathsGeometry(paths: ShapeGeom['paths'], w: number, h: number): PathsGeometry | undefined {
  if (!Array.isArray(paths) || !paths.length) return undefined;
  const out: GeomPath[] = [];
  for (const p of paths.slice(0, GEOM_LIMITS.paths)) {
    const path = storedPath(p, w, h);
    const prev = out[out.length - 1];
    if (p?.cont === true && prev)
      out[out.length - 1] = { ...prev, cmds: prev.cmds.concat(path.cmds), pts: prev.pts.concat(path.pts) };
    else out.push(path);
  }
  const est = geomCost(out);
  if (!(est <= GEOM_COST.geometry)) return undefined;
  let points = 0;
  for (const p of out) points += clampPoints(p.cmds, p.pts);
  return { built: { w, h, paths: out, text: { l: 0, t: 0, r: w, b: h }, sites: [] }, est, points };
}

/**
 * A stored geometry (its file's content already in place of a ref) at a `w` x `h` box: its preset when the
 * table knows it, else its paths (`pathsGeometry`), else undefined. `est` and `points` are the stored paths'
 * fill estimate and points (a preset's are not stored: 0).
 */
export function geometryAt(
  g: ShapeGeom | undefined,
  w: number,
  h: number,
): { built: BuiltGeom; est: number; points: number; stored: boolean } | undefined {
  if (!g || typeof g !== 'object') return undefined;
  const bw = boxSide(w);
  const bh = boxSide(h);
  if (typeof g.preset === 'string') {
    const adj = Array.isArray(g.adj) ? g.adj.filter((p) => Array.isArray(p) && p.length === 2) : undefined;
    const built = presetGeometry(g.preset, bw, bh, adj as [string, number][] | undefined);
    if (built) return { built, est: 0, points: 0, stored: false };
  }
  const paths = pathsGeometry(g.paths, bw, bh);
  return paths ? { ...paths, stored: true } : undefined;
}

const legacyMemo = new Map<string, BuiltGeom>();

/**
 * The legacy shape as a geometry (`ShapeObject.shape`, `radius`), for an object drawn through the M6 path
 * without a stored geometry: rect (roundRect when `radius` > 0, its corner capped at half the shorter side
 * as Canvas caps it), ellipse, or a line across the middle of the box (open, unfilled), as `drawShape` draws
 * them.
 */
export function legacyGeometry(shape: string, radius: number, w: number, h: number): BuiltGeom {
  const bw = boxSide(w);
  const bh = boxSide(h);
  const ss = Math.min(bw, bh);
  const r = Number.isFinite(radius) && radius > 0 && ss > 0 ? Math.min(radius, ss / 2) : 0;
  const key = `${shape} ${r} ${bw} ${bh}`;
  const hit = legacyMemo.get(key);
  if (hit) return hit;
  let built: BuiltGeom;
  if (shape === 'line') {
    const path: GeomPath = {
      cmds: [CMD_MOVE, CMD_LINE],
      pts: [0, bh / 2, bw, bh / 2],
      fill: 'none',
      stroke: true,
    };
    built = { w: bw, h: bh, paths: [path], text: { l: 0, t: 0, r: bw, b: bh }, sites: [] };
  } else if (shape === 'ellipse') built = presetGeometry('ellipse', bw, bh)!;
  else if (r > 0) built = presetGeometry('roundRect', bw, bh, [['adj', (r / ss) * 100_000]])!;
  else built = presetGeometry('rect', bw, bh)!;
  if (legacyMemo.size >= 256) legacyMemo.clear();
  legacyMemo.set(key, built);
  return built;
}

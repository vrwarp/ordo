import { parsePathData, type ShapeGeom } from '@ordo/domain';
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
 * A stored geometry (design/27 §3.1 `ShapeGeom`: ShapeObject.geom, ImageObject.mask) built at a box, in the
 * caller's units (the drawers use logical px and scale the context):
 * - a known preset by name with the stored adjust pairs (`presetGeometry`, evaluated at the box, so a resized
 *   shape keeps its corners);
 * - else the stored paths: each `d` re-tokenised by `parsePathData` (M L Q C Z and numbers, at most 4,096
 *   points; the string itself never reaches a Path2D), scaled from its own w x h space to the box (a side of 0
 *   is the box's own units), with its fill mode and stroke flag; the text rect is the box;
 * - else undefined: the caller draws the legacy shape (`legacyGeometry`).
 * Results are memoised per geometry object and box size.
 */

const CMD_OF: Readonly<Record<string, number>> = {
  M: CMD_MOVE,
  L: CMD_LINE,
  Q: CMD_QUAD,
  C: CMD_CUBIC,
  Z: CMD_CLOSE,
};

function side(v: number): number {
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

const memo = new WeakMap<object, { w: number; h: number; built: BuiltGeom | undefined }>();

/**
 * A stored geometry built at a w x h box: its preset when the table knows it, else its paths (at most
 * GEOM_LIMITS.paths), else undefined.
 */
export function storedGeometry(g: ShapeGeom | undefined, w: number, h: number): BuiltGeom | undefined {
  if (!g || typeof g !== 'object') return undefined;
  const bw = side(w);
  const bh = side(h);
  const hit = memo.get(g);
  if (hit && hit.w === bw && hit.h === bh) return hit.built;
  let built: BuiltGeom | undefined;
  if (typeof g.preset === 'string') {
    const adj = Array.isArray(g.adj) ? g.adj.filter((p) => Array.isArray(p) && p.length === 2) : undefined;
    built = presetGeometry(g.preset, bw, bh, adj as [string, number][] | undefined);
  }
  if (!built && Array.isArray(g.paths) && g.paths.length) {
    const paths = g.paths.slice(0, GEOM_LIMITS.paths).map((p) => storedPath(p, bw, bh));
    built = { w: bw, h: bh, paths, text: { l: 0, t: 0, r: bw, b: bh }, sites: [] };
  }
  memo.set(g, { w: bw, h: bh, built });
  return built;
}

const legacyMemo = new Map<string, BuiltGeom>();

/**
 * The legacy shape as a geometry (`ShapeObject.shape`, `radius`), for an object drawn through the M6 path
 * without a stored geometry: rect (roundRect when `radius` > 0, its corner capped at half the shorter side
 * as Canvas caps it), ellipse, or a line across the middle of the box (open, unfilled), as `drawShape` draws
 * them.
 */
export function legacyGeometry(shape: string, radius: number, w: number, h: number): BuiltGeom {
  const bw = side(w);
  const bh = side(h);
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

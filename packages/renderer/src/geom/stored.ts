import { GEOM_FILE_MAX_BYTES, parsePathData, type ShapeGeom } from '@ordo/domain';
import { clampGeom } from '../clamp.ts';
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
 * A stored geometry (design/27 §3.1 `ShapeGeom`: ShapeObject.geom, ImageObject.mask) built at a box, in the
 * caller's units (the drawers use logical px and scale the context):
 * - a known preset by name with the stored adjust pairs (`presetGeometry`, evaluated at the box, so a resized
 *   shape keeps its corners);
 * - else the stored paths: each `d` re-tokenised by `parsePathData` (M L Q C Z and numbers, at most 4,096
 *   points; the string itself never reaches a Path2D), scaled from its own w x h space to the box (a side of 0
 *   is the box's own units), with its fill mode and stroke flag; a path marked `cont` is appended to the one
 *   before it (its pieces become the one path they were cut from: one even-odd fill, holes and all, in the
 *   first piece's fill mode and stroke flag; at most GEOM_LIMITS.paths x GEOM_LIMITS.points points); the
 *   text rect is the box;
 * - else undefined: the caller draws the legacy shape (`legacyGeometry`); so too for paths whose drawing
 *   estimate (`cost.ts`) passes `GEOM_COST.geometry` (a zigzag across the box that would take seconds).
 * A geometry with a `ref` (M6 round 2) draws its geometry file's paths once the file is read
 * (`putGeomFile`, `readGeomFiles`: the drawer reads the files a slide names before drawing it, as it decodes
 * its pictures); until then, or without it, it is the geometry beside the ref as above.
 * Results are memoised per geometry (a file's is shared by every shape that names it) and box size.
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

// ── Geometry files (`ShapeGeom.ref`, M6 round 2) ──────────────────────────────────────────────────────────

/** Geometry files kept read: at most this many, and this many characters of path text in all (LRU). */
export const GEOM_FILES_MAX = 4_096;
export const GEOM_FILES_CHARS = 32 * 1024 * 1024;
/** A file that could not be read is asked for again only after this long. */
export const GEOM_FILE_RETRY_MS = 10_000;

/** Read geometry files by ref: each clamped to its paths (`clampGeom`), in least-recently-used order. */
const files = new Map<string, { geom: ShapeGeom; chars: number }>();
let fileChars = 0;
/** Counts the files read (a slide's geometry budget is worked out again when one is). */
let filesRead = 0;

/** Changes whenever a geometry file is read (or the files are forgotten). */
export function geomFilesVersion(): number {
  return filesRead;
}
/** Reads in flight, and when a read last failed, by ref. */
const reading = new Map<string, Promise<GeomFileRead>>();
const failedAt = new Map<string, number>();

/** What became of one file of `readGeomFiles`: read, unavailable (try again later) or not a geometry. */
export type GeomFileRead = 'read' | 'missing' | 'invalid';

/**
 * Keep a geometry file's content (`GeomFile`: `{ paths }`, parsed JSON) under its ref, clamped as inline
 * paths are (`clampGeom`: re-tokenised, at most 8 paths of 4,096 points; nothing else of it is kept).
 * False when nothing drawable is left of it.
 */
export function putGeomFile(ref: string, data: unknown): boolean {
  if (typeof ref !== 'string' || !ref || ref.length > 100) return false;
  const raw = data && typeof data === 'object' ? (data as { paths?: unknown }).paths : undefined;
  const geom = clampGeom({ paths: raw });
  if (!geom?.paths) return false;
  let chars = 0;
  for (const p of geom.paths) chars += p.d.length;
  const old = files.get(ref);
  if (old) {
    files.delete(ref);
    fileChars -= old.chars;
  }
  files.set(ref, { geom, chars });
  fileChars += chars;
  filesRead++;
  failedAt.delete(ref);
  for (const [k, v] of files) {
    if (files.size <= GEOM_FILES_MAX && fileChars <= GEOM_FILES_CHARS) break;
    if (k === ref) continue;
    files.delete(k);
    fileChars -= v.chars;
  }
  return true;
}

/** The geometry of a read file, or undefined. */
export function geomFile(ref: unknown): ShapeGeom | undefined {
  return typeof ref === 'string' ? files.get(ref)?.geom : undefined;
}

/** Whether a stored geometry names a geometry file that is not read (it draws its fallback for now). */
export function geomPending(g: unknown): boolean {
  const ref = g && typeof g === 'object' ? (g as { ref?: unknown }).ref : undefined;
  return typeof ref === 'string' && ref !== '' && !files.has(ref);
}

/**
 * Whether a stored geometry is only a geometry file that is not read: no preset or paths beside its ref, so
 * its fallback would be the legacy shape (for a custom geometry, a filled rect over its whole box). Such a
 * shape, or a picture with such a mask, draws nothing until the file is read, as a picture not decoded yet
 * draws nothing. An older build, which strips `ref`, still draws the legacy shape.
 */
export function geomAwaited(g: unknown): boolean {
  if (!geomPending(g)) return false;
  const x = g as { preset?: unknown; paths?: unknown };
  return typeof x.preset !== 'string' && !(Array.isArray(x.paths) && x.paths.length > 0);
}

/** Forget every read file (tests). */
export function clearGeomFiles(): void {
  files.clear();
  fileChars = 0;
  filesRead++;
  reading.clear();
  failedAt.clear();
}

/**
 * Read the geometry files `refs` names that are not read yet: `read` gives a file's JSON text (undefined or a
 * throw: unavailable for now; null, a file over `GEOM_FILE_MAX_BYTES` or one that is not a geometry: invalid). Reads
 * of one ref are shared, and a ref whose read failed is not asked for again within `GEOM_FILE_RETRY_MS`.
 * Resolves with the outcome of each ref that is not read (empty when every one is).
 */
export async function readGeomFiles(
  refs: Iterable<string>,
  read: (ref: string) => Promise<string | null | undefined>,
  now: () => number = Date.now,
): Promise<Map<string, GeomFileRead>> {
  const out = new Map<string, GeomFileRead>();
  const waits: Promise<void>[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref || files.has(ref) || out.has(ref)) continue;
    let p = reading.get(ref);
    if (!p) {
      const t = failedAt.get(ref);
      if (t !== undefined && now() - t < GEOM_FILE_RETRY_MS) {
        out.set(ref, 'missing');
        continue;
      }
      p = readOne(ref, read).then((r) => {
        reading.delete(ref);
        if (r !== 'read') failedAt.set(ref, now());
        return r;
      });
      reading.set(ref, p);
    }
    waits.push(
      p.then((r) => {
        if (r !== 'read') out.set(ref, r);
      }),
    );
  }
  await Promise.all(waits);
  return out;
}

async function readOne(
  ref: string,
  read: (ref: string) => Promise<string | null | undefined>,
): Promise<GeomFileRead> {
  let text: string | null | undefined;
  try {
    text = await read(ref);
  } catch {
    return 'missing';
  }
  if (text === null) return 'invalid';
  if (typeof text !== 'string') return 'missing';
  if (text.length > GEOM_FILE_MAX_BYTES) return 'invalid';
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return 'invalid';
  }
  return putGeomFile(ref, data) ? 'read' : 'invalid';
}

/** The geometry a stored one draws now: its read file's, else itself. */
export function resolvedGeom(g: ShapeGeom | undefined): ShapeGeom | undefined {
  if (!g || typeof g !== 'object') return undefined;
  return (typeof g.ref === 'string' && files.get(g.ref)?.geom) || g;
}

// ── Building ───────────────────────────────────────────────────────────────────────────────────────────

/** Built geometries per stored geometry, by box size: a few sizes each (a file's is shared by its shapes). */
const memo = new WeakMap<object, Map<string, BuiltGeom | undefined>>();
const MEMO_SIZES = 8;

/** What a geometry built from stored paths costs to draw: its estimate (`cost.ts`) and its points. */
export interface StoredCost {
  readonly est: number;
  readonly points: number;
}
const costs = new WeakMap<BuiltGeom, StoredCost>();

/** The drawing cost of a geometry `storedGeometry` built from stored paths; undefined for a preset. */
export function storedCost(b: BuiltGeom | undefined): StoredCost | undefined {
  return b ? costs.get(b) : undefined;
}

/**
 * A stored geometry built at a w x h box: its read geometry file's paths (`ref`), else its preset when the
 * table knows it, else its paths (at most GEOM_LIMITS.paths), else undefined.
 */
export function storedGeometry(raw: ShapeGeom | undefined, w: number, h: number): BuiltGeom | undefined {
  const g = resolvedGeom(raw);
  if (!g) return undefined;
  const bw = side(w);
  const bh = side(h);
  const key = `${bw} ${bh}`;
  let sizes = memo.get(g);
  if (sizes?.has(key)) return sizes.get(key);
  let built: BuiltGeom | undefined;
  if (typeof g.preset === 'string') {
    const adj = Array.isArray(g.adj) ? g.adj.filter((p) => Array.isArray(p) && p.length === 2) : undefined;
    built = presetGeometry(g.preset, bw, bh, adj as [string, number][] | undefined);
  }
  if (!built && Array.isArray(g.paths) && g.paths.length) {
    const paths: GeomPath[] = [];
    for (const p of g.paths.slice(0, GEOM_LIMITS.paths)) {
      const path = storedPath(p, bw, bh);
      const prev = paths[paths.length - 1];
      if (p?.cont === true && prev)
        paths[paths.length - 1] = {
          ...prev,
          cmds: prev.cmds.concat(path.cmds),
          pts: prev.pts.concat(path.pts),
        };
      else paths.push(path);
    }
    const est = geomCost(paths);
    if (est <= GEOM_COST.geometry) {
      built = { w: bw, h: bh, paths, text: { l: 0, t: 0, r: bw, b: bh }, sites: [] };
      let points = 0;
      for (const p of paths) points += clampPoints(p.cmds, p.pts);
      costs.set(built, { est, points });
    }
  }
  if (!sizes) {
    sizes = new Map();
    memo.set(g, sizes);
  } else if (sizes.size >= MEMO_SIZES) sizes.delete(sizes.keys().next().value!);
  sizes.set(key, built);
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

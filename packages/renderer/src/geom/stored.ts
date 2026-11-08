import { GEOM_FILE_MAX_BYTES, type ShapeGeom } from '@ordo/domain';
import { clampGeom } from '../clamp.ts';
import { geometryAt, legacyGeometry, storedPath } from './built.ts';
import type { BuiltGeom } from './path.ts';

export { legacyGeometry, storedPath };

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
/** A file's text as read, or why there is none. */
type FileText = { text: string } | { why: 'missing' | 'invalid' };
/** Reads in flight, and when a read last failed, by ref. */
const reading = new Map<string, Promise<FileText>>();
const failedAt = new Map<string, number>();
/** What parsing a text read gave, for the other callers sharing its read. */
const parsed = new WeakMap<FileText, GeomFileRead>();

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

/** Runs a synchronous step (a geometry file's parse) and hands back its result: at once by default. */
export type GeomFileStep = <T>(fn: () => T) => Promise<T>;
const atOnce: GeomFileStep = async (fn) => fn();

/**
 * Read the geometry files `refs` names that are not read yet: `read` gives a file's JSON text (undefined or a
 * throw: unavailable for now; null, a file over `GEOM_FILE_MAX_BYTES` or one that is not a geometry: invalid). Reads
 * of one ref are shared, and a ref whose read failed is not asked for again within `GEOM_FILE_RETRY_MS`.
 * Resolves with the outcome of each ref that is not read (empty when every one is).
 *
 * `step` runs each file's parse (JSON and the paths' re-tokenising, 5-15 ms for a file of 320 KB): the
 * asset worker passes its job's lane slice, so the parse waits for the job's turn as its other synchronous
 * work does (design/27 §7.5). A read shared between callers is parsed in the step of the first caller to
 * get there; a step that throws (a cancelled job) rejects that caller only, and the file stays to be parsed
 * by the next.
 */
export async function readGeomFiles(
  refs: Iterable<string>,
  read: (ref: string) => Promise<string | null | undefined>,
  now: () => number = Date.now,
  step: GeomFileStep = atOnce,
): Promise<Map<string, GeomFileRead>> {
  const out = new Map<string, GeomFileRead>();
  const waits: Promise<void>[] = [];
  const asked = new Set<string>();
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref || files.has(ref) || asked.has(ref)) continue;
    asked.add(ref);
    let p = reading.get(ref);
    if (!p) {
      const t = failedAt.get(ref);
      if (t !== undefined && now() - t < GEOM_FILE_RETRY_MS) {
        out.set(ref, 'missing');
        continue;
      }
      p = readText(ref, read).then((r) => {
        reading.delete(ref);
        if ('why' in r) failedAt.set(ref, now());
        return r;
      });
      reading.set(ref, p);
    }
    waits.push(
      p.then(async (got) => {
        if ('why' in got) {
          out.set(ref, got.why);
          return;
        }
        // One text is parsed once, whichever of its callers gets there first.
        const parse = (): GeomFileRead => {
          if (files.has(ref)) return 'read';
          let r = parsed.get(got);
          if (!r) parsed.set(got, (r = parseGeomFile(ref, got.text)));
          return r;
        };
        const r = files.has(ref) ? 'read' : await step(parse);
        if (r === 'read') return;
        failedAt.set(ref, now());
        out.set(ref, r);
      }),
    );
  }
  await Promise.all(waits);
  return out;
}

/** A file's text, or why there is none ('invalid': null or too large). */
async function readText(
  ref: string,
  read: (ref: string) => Promise<string | null | undefined>,
): Promise<FileText> {
  let text: string | null | undefined;
  try {
    text = await read(ref);
  } catch {
    return { why: 'missing' };
  }
  if (text === null) return { why: 'invalid' };
  if (typeof text !== 'string') return { why: 'missing' };
  if (text.length > GEOM_FILE_MAX_BYTES) return { why: 'invalid' };
  return { text };
}

/** Parse a file's text and keep it (`putGeomFile`). */
function parseGeomFile(ref: string, text: string): GeomFileRead {
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

/** What a geometry built from stored paths holds: its fill estimate (`cost.ts`) and its stored points. */
export interface StoredCost {
  readonly est: number;
  readonly points: number;
}
const costs = new WeakMap<BuiltGeom, StoredCost>();

/** The fill estimate and points of a geometry `storedGeometry` built from stored paths; undefined for a preset. */
export function storedCost(b: BuiltGeom | undefined): StoredCost | undefined {
  return b ? costs.get(b) : undefined;
}

/**
 * A stored geometry built at a w x h box: its read geometry file's paths (`ref`), else its preset when the
 * table knows it, else its paths (at most GEOM_LIMITS.paths; none past `GEOM_COST.geometry`, `built.ts`),
 * else undefined.
 */
export function storedGeometry(raw: ShapeGeom | undefined, w: number, h: number): BuiltGeom | undefined {
  const g = resolvedGeom(raw);
  if (!g) return undefined;
  const key = `${w} ${h}`;
  let sizes = memo.get(g);
  if (sizes?.has(key)) return sizes.get(key);
  const at = geometryAt(g, w, h);
  const built = at?.built;
  if (at?.stored) costs.set(at.built, { est: at.est, points: at.points });
  if (!sizes) {
    sizes = new Map();
    memo.set(g, sizes);
  } else if (sizes.size >= MEMO_SIZES) sizes.delete(sizes.keys().next().value!);
  sizes.set(key, built);
  return built;
}

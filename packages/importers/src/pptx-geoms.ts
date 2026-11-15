/**
 * Shape files of a native import (design/27 §3.1 `ShapeGeom.ref`, §3.4, §15 M6 round 2), the import core's
 * one copy: the hub's pool task (`sceneTask.ts`), its client-scene check (`clientScene.ts`) and the client
 * parse (`pptx-client.ts`) name, check and bound them with these functions. Pure TypeScript (the one SHA-256
 * of `sha256.ts`): runs in Node.js, browsers and Web Workers.
 *
 * The converter writes a geometry whose paths are large on its slide (a Google-Slides-traced decoration:
 * 100-1,000 KB of path text, which a layout repeats on every slide and a slide at several sizes) once, as a
 * geometry file named by a placeholder (`pptxgeom:<n>`, `EmitResult.geoms`, numbered per batch).
 *
 * - **Names** each file by the SHA-256 of its JSON (`geomFileOf`: its paths re-tokenised as stored paths are,
 *   `sanitizeGeom`, checked by the `GeomFile` schema and its size bound `GEOM_FILE_MAX_BYTES`), and puts the
 *   name in place of the placeholder in its slides (`nameGeoms`): the same geometry in two batches, two decks
 *   or two imports of one deck is one name. A placeholder whose file is not usable loses its ref (the shape
 *   draws the geometry beside it, else its legacy form).
 * - **Bounds** what one parse returns (`nameShapeFiles`): slide by slide, a slide whose new files would pass
 *   the bound keeps none of them and is listed in `over`; the caller leaves out the objects naming them (M9
 *   `ladder.ts` `withoutFiles`).
 * - **Decoration files** (M9 `decor`, `DecorData.ref` → `DecorFile`, the converter's `EmitResult.decors`,
 *   placeholders `pptxdecor:<n>`): shape files of a second kind (`SHAPE_FILE_KINDS`), named, checked and
 *   bounded by the same functions in the same batch bound, stored, collected and shipped as geometry files are
 *   (`decorFileOf`: parts re-tokenised as stored parts are, `sanitizeDecor`, checked by `DecorFile`, at most
 *   `DECOR_LIMITS.points` points of all parts and `GEOM_FILE_MAX_BYTES`). Both kinds go in one list of a
 *   parse's files (`emittedShapeFiles`) and of a client scene's (`storedShapeFileOf` tells them apart by
 *   their JSON), so the hub's batches and the client name a decoration file by one SHA-256.
 */
import {
  DECOR_LIMITS,
  type DecorData,
  DecorFile,
  drawnShapeFileRefs,
  GEOM_FILE_MAX_BYTES,
  GeomFile,
  type ShapeGeom,
  type Slide,
  type SlideObject,
} from '@ordo/domain';
import { parsePathData, pathDataPoints } from '@ordo/domain/pathdata.ts';
import { DECOR_PREFIX } from '@ordo/pptx-scene/decor.ts';
import { GEOM_PREFIX } from '@ordo/pptx-scene/emit.ts';
import { sanitizeGeom } from './sanitize.ts';
import { sanitizeDecor } from './sanitize/decor.ts';
import { sha256Hex } from './sha256.ts';

/** A shape file ready to store: its name (SHA-256 of `bytes`) and JSON. */
export type NamedGeomFile = { hash: string; bytes: Uint8Array };

/**
 * A converter's geometry file as stored: re-tokenised (`sanitizeGeom`), checked against `GeomFile` and its
 * size bound, as JSON, named by its SHA-256. Undefined when nothing storable is left of it.
 */
export function geomFileOf(file: unknown): NamedGeomFile | undefined {
  const paths = file && typeof file === 'object' ? (file as { paths?: unknown }).paths : undefined;
  if (!Array.isArray(paths)) return undefined;
  const clean = sanitizeGeom({ paths } as ShapeGeom)?.paths;
  const ok = GeomFile.safeParse({ paths: clean });
  if (!ok.success) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(ok.data));
  if (bytes.length > GEOM_FILE_MAX_BYTES) return undefined;
  return { hash: sha256Hex(bytes), bytes };
}

/** A palette of every paint index a decoration may name: a file's parts are checked against the largest. */
const ANY_PAINTS: DecorData['paints'] = Array.from({ length: DECOR_LIMITS.paints }, () => ({}));

/**
 * A converter's decoration file as stored (`DecorFile`, M9): its parts re-tokenised and kept as stored parts
 * are (`sanitizeDecor`, against the largest palette: a part naming a paint its decoration lacks is skipped
 * where it is drawn), checked against `DecorFile`, at most `DECOR_LIMITS.points` points of all its parts (the
 * converter closes a run there) and the size bound, as JSON named by its SHA-256. Undefined when nothing
 * storable is left of it, or when it passes a bound. Never throws.
 */
export function decorFileOf(file: unknown): NamedGeomFile | undefined {
  try {
    const parts = file && typeof file === 'object' ? (file as { parts?: unknown }).parts : undefined;
    if (!Array.isArray(parts) || parts.length > DECOR_LIMITS.parts) return undefined;
    const clean = sanitizeDecor({
      w: 1,
      h: 1,
      paints: ANY_PAINTS,
      parts: parts as DecorData['parts'],
    })?.parts;
    const ok = DecorFile.safeParse({ parts: clean });
    if (!ok.success) return undefined;
    let points = 0;
    for (const p of ok.data.parts) {
      points += pathDataPoints(parsePathData(p.d));
      if (points > DECOR_LIMITS.points) return undefined;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(ok.data));
    if (bytes.length > GEOM_FILE_MAX_BYTES) return undefined;
    return { hash: sha256Hex(bytes), bytes };
  } catch {
    // A hostile value (an accessor that throws, an array whose items are not parts): not storable.
    return undefined;
  }
}

/**
 * A stored shape file's JSON made storable again by its kind, told apart by what it holds (`paths`: a geometry
 * file, `geomFileOf`; `parts`: a decoration file, `decorFileOf`): how a client's files are checked (the hub's
 * `clientScene.ts`, the client's own assembly), where no placeholder says the kind. A file whose JSON is not
 * what its name says is then refused by its caller (the hashes differ).
 */
export function storedShapeFileOf(json: unknown): NamedGeomFile | undefined {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
  if ('paths' in json) return geomFileOf(json);
  if ('parts' in json) return decorFileOf(json);
  return undefined;
}

/**
 * A kind of shape file a converter placeholder may stand for: its placeholder prefix and how a file of it is
 * made storable (`geomFileOf`, `decorFileOf`).
 */
export type ShapeFileKind = {
  prefix: string;
  fileOf: (file: unknown) => NamedGeomFile | undefined;
};

/** The shape-file kinds this build names: geometry files and decoration files (see the module comment). */
export const SHAPE_FILE_KINDS: readonly ShapeFileKind[] = [
  { prefix: GEOM_PREFIX, fileOf: geomFileOf },
  { prefix: DECOR_PREFIX, fileOf: decorFileOf },
];

/** Whether `ref` is a converter's placeholder of a known kind (not a stored file's name). */
export function isShapeFilePlaceholder(
  ref: string,
  kinds: readonly ShapeFileKind[] = SHAPE_FILE_KINDS,
): boolean {
  return shapeFileKind(ref, kinds) !== undefined;
}

/**
 * Every shape file one parse emitted (`EmitResult.geoms` and `EmitResult.decors`, each placeholder once): what
 * `nameShapeFiles` names and bounds as one batch.
 */
export function emittedShapeFiles(r: {
  geoms?: readonly { id: string; file: unknown }[];
  decors?: readonly { id: string; file: unknown }[];
}): { id: string; file: unknown }[] {
  return [...(r.geoms ?? []), ...(r.decors ?? [])];
}

/** The kind of shape file `ref` (a placeholder) names, or undefined when it is none of `kinds`. */
export function shapeFileKind(
  ref: string,
  kinds: readonly ShapeFileKind[] = SHAPE_FILE_KINDS,
): ShapeFileKind | undefined {
  return kinds.find((k) => ref.startsWith(k.prefix));
}

/**
 * A shape file of any known kind (`SHAPE_FILE_KINDS`) for the placeholder `id`, made storable; undefined
 * when the kind is unknown or nothing storable is left of the file.
 */
export function shapeFileOf(
  id: string,
  file: unknown,
  kinds: readonly ShapeFileKind[] = SHAPE_FILE_KINDS,
): NamedGeomFile | undefined {
  return shapeFileKind(id, kinds)?.fileOf(file);
}

/**
 * `slide` with each shape file ref of its objects (`ShapeObject.geom`, `ImageObject.mask`, M9
 * `ShapeObject.decor`) named through `names` (placeholder → file name); a ref `names` does not know is
 * removed: a geometry then draws what is beside it, else its legacy form, and a decoration its inline parts
 * (a decoration left with neither parts nor a file loses the field: its legacy line, nothing, as an older
 * build draws it). Objects without one are kept as they are; the slide itself is new only when something
 * changed.
 */
export function nameGeoms(slide: Slide, names: ReadonlyMap<string, string>): Slide {
  let changed = false;
  const rename = (g: ShapeGeom): ShapeGeom | undefined => {
    const { ref, ...rest } = g;
    const name = ref === undefined ? undefined : names.get(ref);
    if (name === ref) return g;
    changed = true;
    const out: ShapeGeom = name ? { ...rest, ref: name } : rest;
    return out.preset || out.paths || out.ref ? out : undefined;
  };
  const objects = slide.objects.map((o): SlideObject => {
    if (o.type === 'shape' && o.geom?.ref !== undefined) {
      const geom = rename(o.geom);
      if (geom === o.geom) return o;
      const { geom: _g, ...rest } = o;
      return geom ? { ...rest, geom } : rest;
    }
    if (o.type === 'image' && o.mask?.ref !== undefined) {
      const mask = rename(o.mask);
      if (mask === o.mask) return o;
      const { mask: _m, ...rest } = o;
      return mask ? { ...rest, mask } : rest;
    }
    if (o.type === 'shape' && o.decor?.ref !== undefined) {
      const { ref, ...kept } = o.decor;
      const name = names.get(ref);
      if (name === ref) return o;
      changed = true;
      const { decor: _d, ...rest } = o;
      if (name) return { ...rest, decor: { ...kept, ref: name } };
      return kept.parts.length ? { ...rest, decor: kept } : rest;
    }
    return o;
  });
  return changed ? { ...slide, objects } : slide;
}

/** One named shape file of a parse: its placeholder, name and JSON bytes. */
export type NamedShapeFile = { id: string; hash: string; bytes: Uint8Array };

/**
 * The shape files of one parse named (`shapeFileOf`: re-tokenised, checked, serialised and hashed), slide by
 * slide in `slides` order: a slide whose new files (geometry and decoration files alike, `drawnShapeFileRefs`)
 * would take the parse past `maxBytes` of distinct files keeps none and is listed in `over` (the caller leaves
 * out the objects that name them). `files` are the converter's (`emittedShapeFiles`: `EmitResult.geoms` and
 * `EmitResult.decors`); only the named files' bytes are returned.
 */
export function nameShapeFiles(
  slides: readonly { index: number; slide: Slide }[],
  files: readonly { id: string; file: unknown }[],
  maxBytes: number,
  kinds: readonly ShapeFileKind[] = SHAPE_FILE_KINDS,
): { files: NamedShapeFile[]; over: number[] } {
  if (!files.length) return { files: [], over: [] };
  const byId = new Map<string, NamedGeomFile | undefined>();
  for (const g of files) byId.set(g.id, shapeFileOf(g.id, g.file, kinds));
  const kept = new Map<string, NamedGeomFile>();
  const hashes = new Set<string>();
  const over: number[] = [];
  let bytes = 0;
  for (const s of slides) {
    const ids = drawnShapeFileRefs(s.slide).filter((id) => byId.get(id) && !kept.has(id));
    const fresh = new Map<string, number>();
    for (const id of ids) {
      const f = byId.get(id)!;
      if (!hashes.has(f.hash)) fresh.set(f.hash, f.bytes.length);
    }
    const add = [...fresh.values()].reduce((a, b) => a + b, 0);
    if (bytes + add > maxBytes) {
      over.push(s.index);
      continue;
    }
    bytes += add;
    for (const id of ids) {
      const f = byId.get(id)!;
      kept.set(id, f);
      hashes.add(f.hash);
    }
  }
  return { files: [...kept].map(([id, f]) => ({ id, hash: f.hash, bytes: f.bytes })), over };
}

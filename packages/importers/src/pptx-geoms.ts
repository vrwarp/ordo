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
 * - **Decoration files** (M9 `decor`): `SHAPE_FILE_KINDS` names the kinds of shape file a placeholder may
 *   stand for. Only geometry files are named in this build; `decor-render` adds the decoration kind
 *   (`DECOR_PREFIX`, its `decorFileOf`) here, and every caller names, checks and bounds it with the same
 *   functions. Until then the converter is told not to write decoration files (`M9_WRITES` without
 *   'decorFile'), so no `pptxdecor:<n>` placeholder reaches a slide.
 */
import {
  drawnGeomRefs,
  GEOM_FILE_MAX_BYTES,
  GeomFile,
  type ShapeGeom,
  type Slide,
  type SlideObject,
} from '@ordo/domain';
import { GEOM_PREFIX } from '@ordo/pptx-scene/emit.ts';
import { sanitizeGeom } from './sanitize.ts';
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

/**
 * A kind of shape file a converter placeholder may stand for: its placeholder prefix and how a file of it is
 * made storable (`geomFileOf`). The decoration kind of M9 `decor-render` joins this list.
 */
export type ShapeFileKind = {
  prefix: string;
  fileOf: (file: unknown) => NamedGeomFile | undefined;
};

/** The shape-file kinds this build names (see the module comment: decorations join with `decor-render`). */
export const SHAPE_FILE_KINDS: readonly ShapeFileKind[] = [{ prefix: GEOM_PREFIX, fileOf: geomFileOf }];

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
 * `slide` with each geometry ref of its objects (`ShapeObject.geom`, `ImageObject.mask`) named through
 * `names` (placeholder → file name); a ref `names` does not know is removed. Objects without one are kept as
 * they are; the slide itself is new only when something changed.
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
    return o;
  });
  return changed ? { ...slide, objects } : slide;
}

/** One named shape file of a parse: its placeholder, name and JSON bytes. */
export type NamedShapeFile = { id: string; hash: string; bytes: Uint8Array };

/**
 * The shape files of one parse named (`shapeFileOf`: re-tokenised, checked, serialised and hashed), slide by
 * slide in `slides` order: a slide whose new files would take the parse past `maxBytes` of distinct files
 * keeps none and is listed in `over` (the caller leaves out the objects that name them). `geoms` are the
 * converter's files (`EmitResult.geoms`); only the named files' bytes are returned.
 */
export function nameShapeFiles(
  slides: readonly { index: number; slide: Slide }[],
  geoms: readonly { id: string; file: unknown }[],
  maxBytes: number,
  kinds: readonly ShapeFileKind[] = SHAPE_FILE_KINDS,
): { files: NamedShapeFile[]; over: number[] } {
  if (!geoms.length) return { files: [], over: [] };
  const byId = new Map<string, NamedGeomFile | undefined>();
  for (const g of geoms) byId.set(g.id, shapeFileOf(g.id, g.file, kinds));
  const kept = new Map<string, NamedGeomFile>();
  const hashes = new Set<string>();
  const over: number[] = [];
  let bytes = 0;
  for (const s of slides) {
    const ids = drawnGeomRefs(s.slide).filter((id) => byId.get(id) && !kept.has(id));
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

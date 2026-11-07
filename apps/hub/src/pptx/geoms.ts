/**
 * Geometry files of a native import (design/27 §3.1 `ShapeGeom.ref`, §3.4, §15 M6 round 2). The converter
 * writes a geometry whose paths are large on its slide (a Google-Slides-traced decoration: 100-1,000 KB of
 * path text, which a layout repeats on every slide and a slide at several sizes) once, as a geometry file
 * named by a placeholder (`pptxgeom:<n>`, `EmitResult.geoms`, numbered per batch). The job:
 *
 * - **Names** each file by the SHA-256 of its JSON (`GeomFile`: its paths re-tokenised as stored paths are,
 *   `sanitizeGeom`, and checked by the schema), and puts the name in place of the placeholder in its batch's
 *   slides (`nameGeoms`), before the size budget measures them: the same geometry in two batches, two decks
 *   or two imports of one deck is one name. A placeholder whose file is not usable loses its ref (the shape
 *   draws the geometry beside it, else its legacy form).
 * - **Stores** the files the kept slides name (`storeGeomFiles`) in the content store, `application/json`,
 *   once (a file the store has is not written again). Outputs read them as they read pictures (the goLive
 *   manifest lists them, `resolvePlaylist`); the store keeps a file while a stored presentation names it.
 */
import { createHash } from 'node:crypto';
import { GEOM_FILE_MAX_BYTES, GeomFile, type ShapeGeom, type Slide, type SlideObject } from '@ordo/domain';
import { sanitizeGeom } from '@ordo/importers/sanitize.ts';
import { errorMessage } from '../errors.ts';
import type { Library } from '../library.ts';
import type { Store } from '../store.ts';

/** A geometry file ready to store: its name (SHA-256 of `bytes`) and JSON. */
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
  return { hash: createHash('sha256').update(bytes).digest('hex'), bytes };
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

/**
 * Store the geometry files `names` (file names the kept slides use) of `files`, each once: a file the store
 * indexes already is left as it is. Returns how many were written and the names that could not be (warned
 * through `warn` once): their shapes draw their legacy form until a re-import.
 */
export async function storeGeomFiles(
  store: Pick<Store, 'putBytes'>,
  lib: Pick<Library, 'getFile'>,
  files: ReadonlyMap<string, NamedGeomFile>,
  names: Iterable<string>,
  warn: (msg: string) => void,
): Promise<{ written: number; failed: string[] }> {
  let written = 0;
  const failed: string[] = [];
  let reason: string | undefined;
  for (const name of new Set(names)) {
    const f = files.get(name);
    if (!f || lib.getFile(name)) continue;
    try {
      const ref = await store.putBytes(f.bytes, { ext: 'json', mime: 'application/json' });
      if (ref.hash !== name) throw new Error('the stored file has another hash');
      written++;
    } catch (e) {
      failed.push(name);
      reason ??= errorMessage(e);
    }
  }
  if (failed.length)
    warn(
      `${failed.length} shape outline file(s) could not be stored (${reason}): those shapes are drawn plain`,
    );
  return { written, failed };
}

/**
 * Geometry files of a native import (design/27 §3.1 `ShapeGeom.ref`, §3.4, §15 M6 round 2). The converter
 * writes a geometry whose paths are large on its slide (a Google-Slides-traced decoration: 100-1,000 KB of
 * path text, which a layout repeats on every slide and a slide at several sizes) once, as a geometry file
 * named by a placeholder (`pptxgeom:<n>`, `EmitResult.geoms`, numbered per batch). The job:
 *
 * - **Names** each file by the SHA-256 of its JSON (the import core's `geomFileOf` and `nameGeoms`, in the
 *   pool's worker or, for a client scene, re-checked in the pool, `clientScene.ts`), before the size budget
 *   measures them: the same geometry in two batches, two decks or two imports of one deck is one name. A
 *   placeholder whose file is not usable loses its ref (the shape draws the geometry beside it, else its
 *   legacy form).
 * - **Stores** the files the kept slides name (`storeGeomFiles`) in the content store, `application/json`,
 *   once (a file the store has is not written again). Outputs read them as they read pictures (the goLive
 *   manifest lists them, `resolvePlaylist`); the store keeps a file while a stored presentation names it.
 */
import { errorMessage } from '../errors.ts';
import type { Library } from '../library.ts';
import type { Store } from '../store.ts';
import type { NamedGeomFile } from '@ordo/importers/pptx-geoms.ts';

// Naming, checking and bounding shape files is the import core's (`@ordo/importers` `pptx-geoms.ts`), which
// the pool task, the client-scene check and the client parse share; storing them is the hub's.
export { geomFileOf, type NamedGeomFile, nameGeoms } from '@ordo/importers/pptx-geoms.ts';

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

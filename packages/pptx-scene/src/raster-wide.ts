/**
 * The WIDE compile and build the recipe builder reads a shape's geometry with (Q53, C-SR2, D5): the renderer's own
 * `compileGeom` and `buildGeom` with their optional `limits` parameter (the picture maker's commit R), so an outline past the
 * stored and drawn limits (8 paths of 4,096 points) is read whole, up to the reading bound (`RASTER_READ`), for ONE call and
 * never stored. The same functions the screens draw a stored geometry with; only the limit of the call differs. This is the
 * `EmitOptions.rasterGeometry` the hub's pool task and the harness pass when the parse plans pictures (the converter itself does not
 * import this module, so the browser's import worker, which only detects, does not carry it; the renderer's compile is in that worker
 * all the same, through the preset geometry, as before this module).
 *
 * Nothing here raises a stored or drawn limit: `GEOM_STORE` and `GEOM_CLAMP` stay what they were (the renderer's own
 * limits.test.ts pins every number), and the result of this compile never reaches a stored slide: only the recipe holds it.
 */
import { compileGeom } from '@ordo/renderer/geom/compile.ts';
import { buildGeom } from '@ordo/renderer/geom/path.ts';
import type { RasterGeometry } from './raster-emit.ts';

export const WIDE_GEOMETRY: RasterGeometry = {
  compile: (src, notes, limits) => compileGeom(src, notes, limits),
  build: (geom, w, h, adj, notes, limits) => buildGeom(geom, w, h, adj, notes, limits),
};

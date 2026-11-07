import type { Bevel, Look3d } from '@ordo/domain';
import { clampColor, finite } from '../sanitize.ts';

/*
 * `look3d` of an imported shape, picture or text object (design/27 M9) within the schema's bounds: every
 * number finite and bounded, colours clamped, a malformed part dropped. Names outside the closed lists are
 * left to the schema's .catch.
 */

const DEG = 36_000;

function bevel(b: Bevel | undefined): Bevel | undefined {
  if (!b || typeof b !== 'object') return undefined;
  return { ...b, w: finite(b.w, 12, 0, 1_000), h: finite(b.h, 12, 0, 1_000) };
}

/** Three finite angles in degrees, else undefined. */
function angles(r: unknown): [number, number, number] | undefined {
  if (!Array.isArray(r) || r.length !== 3) return undefined;
  if (!r.every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined;
  return [finite(r[0], 0, -DEG, DEG), finite(r[1], 0, -DEG, DEG), finite(r[2], 0, -DEG, DEG)];
}

export function sanitizeLook3d(l: Look3d): Look3d | undefined {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return undefined;
  const out: Look3d = { ...l };
  const set = <K extends keyof Look3d>(k: K, v: Look3d[K] | undefined) => {
    if (v === undefined) delete out[k];
    else out[k] = v;
  };
  if (l.bevel !== undefined) set('bevel', bevel(l.bevel));
  if (l.back !== undefined) set('back', bevel(l.back));
  if (l.depth !== undefined) out.depth = finite(l.depth, 0, 0, 1_000);
  if (l.lift !== undefined) out.lift = finite(l.lift, 0, -1_000, 1_000);
  if (l.contour !== undefined)
    set(
      'contour',
      l.contour && typeof l.contour === 'object'
        ? { width: finite(l.contour.width, 0, 0, 500), color: clampColor(l.contour.color) }
        : undefined,
    );
  if (l.side !== undefined) out.side = clampColor(l.side);
  if (l.grow !== undefined) out.grow = finite(l.grow, 0, 0, 500);
  if (l.flat !== undefined && typeof l.flat !== 'boolean') delete out.flat;
  if (l.light !== undefined) {
    if (l.light && typeof l.light === 'object') {
      const light = { ...l.light };
      if (light.rot !== undefined) {
        const rot = angles(light.rot);
        if (rot) light.rot = rot;
        else delete light.rot;
      }
      out.light = light;
    } else delete out.light;
  }
  if (l.camera !== undefined) {
    if (l.camera && typeof l.camera === 'object') {
      const camera = { ...l.camera };
      if (camera.rot !== undefined) {
        const rot = angles(camera.rot);
        if (rot) camera.rot = rot;
        else delete camera.rot;
      }
      if (camera.fov !== undefined) camera.fov = finite(camera.fov, 0, 0, 180);
      if (camera.zoom !== undefined) camera.zoom = finite(camera.zoom, 1, 0.01, 100);
      out.camera = camera;
    } else delete out.camera;
  }
  return out;
}

import { Look3d } from '@ordo/domain';

/**
 * `look3d` of a shape, picture or text object for drawing (design/27 M9): re-validated against the schema
 * (names outside the closed lists take their defaults) and kept whole, else undefined, and the object draws
 * flat. A stub of the schema track; the 3-D tracks add the full clamp here (widths and contour within
 * `CLAMP.maxEffectPx`, depth and lift within 1,000, angles finite).
 */
export function clampLook3d(v: unknown): Look3d | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  // zod can throw on a hostile value (an object whose `length` has no usable valueOf): the legacy drawing.
  try {
    const r = Look3d.safeParse(v);
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

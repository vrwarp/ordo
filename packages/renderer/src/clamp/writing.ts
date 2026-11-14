import { Writing } from '@ordo/domain';

/**
 * `TextObject.writing` for drawing (design/27 M9): re-validated against the schema (an unknown `upright`
 * is 'cjk') and kept, else undefined, and the text draws horizontally in its turned box. A stub of the schema
 * track; the vertical text track adds what it needs here.
 */
export function clampWriting(v: unknown): Writing | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  // zod can throw on a hostile value (an object whose `length` has no usable valueOf): the legacy drawing.
  try {
    const r = Writing.safeParse(v);
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** `TextObject.centerBlock` (PowerPoint anchorCtr): true or absent (false means what absent means). */
export function clampCenterBlock(v: unknown): true | undefined {
  return v === true ? true : undefined;
}

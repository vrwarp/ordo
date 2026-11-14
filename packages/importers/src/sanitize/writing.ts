import type { Writing } from '@ordo/domain';

/**
 * `TextObject.writing` of an imported text (design/27 M9): `reverse` kept only as a boolean; `upright` is
 * left to the schema's .catch ('cjk').
 */
export function sanitizeWriting(w: Writing): Writing | undefined {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return undefined;
  const out: Writing = { ...w };
  if (w.reverse !== undefined && typeof w.reverse !== 'boolean') delete out.reverse;
  return out;
}

/** `TextObject.centerBlock`: true or absent (false means what absent means). */
export function sanitizeCenterBlock(v: unknown): true | undefined {
  return v === true ? true : undefined;
}

import { TextWarp } from '@ordo/domain';

/**
 * `TextObject.warp` for drawing (design/27 M9): re-validated against the schema (an unknown preset is
 * textPlain) and kept, else undefined, and the text draws unwarped. A stub of the schema track; the warp
 * track adds the full clamp here (adjust names, values pinned by the presets).
 */
export function clampWarp(v: unknown): TextWarp | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = TextWarp.safeParse(v);
  return r.success ? r.data : undefined;
}

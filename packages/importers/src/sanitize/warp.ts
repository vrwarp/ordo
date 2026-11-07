import type { TextWarp } from '@ordo/domain';
import { clipText, finite } from '../sanitize.ts';

/** A warp's adjust values: angles in 60,000ths of a degree, within the schema's ±21,600,000. */
const ADJ = 21_600_000;

/**
 * `TextObject.warp` of an imported text (design/27 M9) within the schema's bounds: at most 4 adjust pairs of
 * a name (cut to 16) and a finite value. The preset name is left to the schema's .catch (textPlain).
 */
export function sanitizeWarp(w: TextWarp): TextWarp | undefined {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return undefined;
  const out: TextWarp = { ...w };
  if (w.adj !== undefined) {
    const adj = (Array.isArray(w.adj) ? w.adj : [])
      .filter((p) => Array.isArray(p) && typeof p[0] === 'string' && Number.isFinite(p[1]))
      .slice(0, 4)
      .map(([n, v]): [string, number] => [clipText(n, 16), finite(v, 0, -ADJ, ADJ)]);
    if (adj.length) out.adj = adj;
    else delete out.adj;
  }
  return out;
}

import { DecorData, cleanPathData } from '@ordo/domain';

/**
 * `ShapeObject.decor` for the render plan (design/27 M9): re-validated against the schema and kept, else
 * undefined, and the shape draws its legacy fields (a line without a stroke: nothing). Each part's path string
 * is re-tokenised as every stored path is (`cleanPathData`), and a part left empty is dropped. Only what tells
 * the shape dispatch that a decoration is there: the field-by-field clamp (paint indices, the point and shadow
 * caps, `DECOR_LIMITS`) is the decoration drawer's (`decor/clamp.ts`), loaded with it, so the operator's first
 * paint carries no decoration code (design/24 "Bundle budget").
 */
export function clampDecor(v: unknown): DecorData | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  // zod can throw on a hostile value (an object whose `length` has no usable valueOf): the legacy drawing.
  try {
    const r = DecorData.safeParse(v);
    if (!r.success) return undefined;
    const parts: DecorData['parts'] = [];
    for (const p of r.data.parts) {
      const d = cleanPathData(p.d);
      if (d) parts.push(d === p.d ? p : { ...p, d });
    }
    return { ...r.data, parts };
  } catch {
    return undefined;
  }
}

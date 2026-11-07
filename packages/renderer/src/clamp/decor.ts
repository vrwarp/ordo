import { DecorData, cleanPathData } from '@ordo/domain';

/**
 * `ShapeObject.decor` for drawing (design/27 M9): re-validated against the schema and kept, else undefined,
 * and the shape draws its legacy fields (a line without a stroke: nothing). Each part's path string is
 * re-tokenised as every stored path is (`cleanPathData`), and a part left empty is dropped. A stub of the
 * schema track; the decoration track adds the full clamp here (paint indices, the point and shadow caps).
 */
export function clampDecor(v: unknown): DecorData | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = DecorData.safeParse(v);
  if (!r.success) return undefined;
  const parts: DecorData['parts'] = [];
  for (const p of r.data.parts) {
    const d = cleanPathData(p.d);
    if (d) parts.push(d === p.d ? p : { ...p, d });
  }
  return { ...r.data, parts };
}

import { TableData } from '@ordo/domain';

/**
 * `ShapeObject.table` for drawing (design/27 M9): re-validated against the schema and kept whole, else
 * undefined, and the shape draws its legacy fields. A stub of the schema track; the table track adds the
 * full clamp here (palette indices that fall back, one font budget per table, the 60,000-character table
 * text, edges in range).
 */
export function clampTable(v: unknown): TableData | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = TableData.safeParse(v);
  return r.success ? r.data : undefined;
}

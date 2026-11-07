import { ChartData } from '@ordo/domain';

/**
 * `ShapeObject.chart` for drawing (design/27 M9): re-validated against the schema and kept whole, else
 * undefined, and the shape draws its legacy fields (the chart area). A stub of the schema track; the chart
 * track adds the full clamp here (palette indices, label and tick caps, one font budget per chart).
 */
export function clampChart(v: unknown): ChartData | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = ChartData.safeParse(v);
  return r.success ? r.data : undefined;
}

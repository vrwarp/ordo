/** Families one vector picture names (the schema's bound). */
export const MAX_VECTOR_FONTS = 8;

/**
 * `ImageObject.vectorFonts` for drawing (design/27 M9): at most 8 names, each cleaned as a run's family is
 * (`family`: the object's `FontBudget`, so names that differ only in case, spaces or control characters are
 * one family), once each; undefined when none is left.
 */
export function clampVectorFonts(v: unknown, family: (f: unknown) => string): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (let i = 0; i < v.length && i < MAX_VECTOR_FONTS; i++) {
    const f = family(v[i]);
    if (f && !out.includes(f)) out.push(f);
  }
  return out.length ? out : undefined;
}

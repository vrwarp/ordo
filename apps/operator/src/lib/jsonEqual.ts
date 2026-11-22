/**
 * The same JSON: objects compared key by key whatever their order, a key holding `undefined` as absent, and
 * `undefined` and `null` alike inside arrays (as `JSON.stringify` writes them).
 */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] ?? null;
      const y = b[i] ?? null;
      if (!same(x, y)) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  let n = 0;
  for (const k in ra) {
    if (!Object.hasOwn(ra, k) || ra[k] === undefined) continue;
    if (!same(ra[k], rb[k])) return false;
    n++;
  }
  for (const k in rb) if (Object.hasOwn(rb, k) && rb[k] !== undefined) n--;
  return n === 0;
}

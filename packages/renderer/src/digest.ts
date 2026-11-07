/**
 * A short, stable digest of a string for cache keys (two 32-bit FNV-1a variants and the length, base 36): a
 * stored geometry or a shape's JSON can be hundreds of kilobytes, which a key must not hold.
 */
export function digest(v: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}${v.length.toString(36)}`;
}

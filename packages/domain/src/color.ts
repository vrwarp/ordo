import type { Rgba } from './schemas.ts';

/** A colour channel as an integer 0..255 (NaN and out-of-range values from bad data are clamped). */
function channel(n: number): number {
  return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(255, n))) : 0;
}

/** Alpha 0..1; anything non-finite is opaque. */
function alpha(a: number): number {
  return Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1;
}

export function rgbaCss(c: Rgba | undefined): string {
  if (!c) return 'transparent';
  return `rgba(${channel(c.r)},${channel(c.g)},${channel(c.b)},${Math.round(alpha(c.a) * 1000) / 1000})`;
}

/**
 * Parse `#rgb`, `#rrggbb` (also `#rrggbbaa`, whose alpha byte is ignored in favour of `a`). Invalid digits
 * read as 0, so any string yields a valid colour.
 */
export function hexToRgba(hex: string, a = 1): Rgba {
  const h = hex.replace('#', '');
  const v =
    h.length === 3
      ? h
          .split('')
          .map((x) => x + x)
          .join('')
      : h.slice(0, 6).padEnd(6, '0');
  const byte = (s: string) => (/^[0-9a-fA-F]{2}$/.test(s) ? Number.parseInt(s, 16) : 0);
  return { r: byte(v.slice(0, 2)), g: byte(v.slice(2, 4)), b: byte(v.slice(4, 6)), a: alpha(a) };
}

export function rgbaHex(c: Rgba): string {
  const p = (n: number) => channel(n).toString(16).padStart(2, '0');
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

/** True when `c` is within `tol` of the key colour on every channel; used to warn about keyed-out text. */
export function nearColor(c: Rgba, key: Rgba, tol = 40): boolean {
  return Math.abs(c.r - key.r) <= tol && Math.abs(c.g - key.g) <= tol && Math.abs(c.b - key.b) <= tol;
}

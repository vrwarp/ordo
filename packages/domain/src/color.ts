import type { Rgba } from './schemas.ts';

export function rgbaCss(c: Rgba | undefined): string {
  if (!c) return 'transparent';
  return `rgba(${c.r},${c.g},${c.b},${c.a})`;
}

export function hexToRgba(hex: string, a = 1): Rgba {
  const h = hex.replace('#', '');
  const v =
    h.length === 3
      ? h
          .split('')
          .map((x) => x + x)
          .join('')
      : h.padEnd(6, '0');
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
    a,
  };
}

export function rgbaHex(c: Rgba): string {
  const p = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, '0');
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

/** True when `c` is within `tol` of the key colour on every channel; used to warn about keyed-out text. */
export function nearColor(c: Rgba, key: Rgba, tol = 40): boolean {
  return Math.abs(c.r - key.r) <= tol && Math.abs(c.g - key.g) <= tol && Math.abs(c.b - key.b) <= tol;
}

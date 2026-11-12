import type { Rgba } from '@ordo/domain';

export interface Hsv {
  /** Hue in [0, 360). */
  h: number;
  /** Saturation in [0, 100]. */
  s: number;
  /** Value (brightness) in [0, 100]. */
  v: number;
  /** Alpha in [0, 1]. */
  a: number;
}

export interface ColorSwatch {
  color: Rgba;
  name: string;
}

export const DEFAULT_SWATCHES: readonly ColorSwatch[] = [
  { name: 'White', color: { r: 255, g: 255, b: 255, a: 1 } },
  { name: 'Warm Cream', color: { r: 245, g: 242, b: 234, a: 1 } },
  { name: 'Amber Gold', color: { r: 253, g: 224, b: 71, a: 1 } },
  { name: 'Sky Blue', color: { r: 125, g: 211, b: 252, a: 1 } },
  { name: 'Royal Blue', color: { r: 59, g: 130, b: 246, a: 1 } },
  { name: 'Coral Red', color: { r: 239, g: 68, b: 68, a: 1 } },
  { name: 'Emerald', color: { r: 16, g: 185, b: 129, a: 1 } },
  { name: 'Midnight', color: { r: 15, g: 23, b: 42, a: 1 } },
];

const MAX_RECENT = 8;
const recentStore: Rgba[] = [];

export function getRecentColors(): readonly Rgba[] {
  return recentStore;
}

export function recordRecentColor(c: Rgba): void {
  const key = `${c.r},${c.g},${c.b},${Math.round(c.a * 100)}`;
  const idx = recentStore.findIndex((x) => `${x.r},${x.g},${x.b},${Math.round(x.a * 100)}` === key);
  if (idx >= 0) recentStore.splice(idx, 1);
  recentStore.unshift({ r: c.r, g: c.g, b: c.b, a: c.a });
  if (recentStore.length > MAX_RECENT) recentStore.length = MAX_RECENT;
}

export function clearRecentColors(): void {
  recentStore.length = 0;
}

/** Convert RGBA (0..255, a in 0..1) to HSV (h in 0..360, s/v in 0..100). */
export function rgbaToHsv(c: Rgba): Hsv {
  const r = Math.max(0, Math.min(255, c.r)) / 255;
  const g = Math.max(0, Math.min(255, c.g)) / 255;
  const b = Math.max(0, Math.min(255, c.b)) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  const s = max === 0 ? 0 : (d / max) * 100;
  const v = max * 100;
  return { h, s, v, a: Math.max(0, Math.min(1, c.a)) };
}

/** Convert HSV (h in 0..360, s/v in 0..100, a in 0..1) to clamped integer RGBA. */
export function hsvToRgba(h: number, s: number, v: number, a = 1): Rgba {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const val = Math.max(0, Math.min(100, v)) / 100;

  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hue < 60) [r1, g1, b1] = [c, x, 0];
  else if (hue < 120) [r1, g1, b1] = [x, c, 0];
  else if (hue < 180) [r1, g1, b1] = [0, c, x];
  else if (hue < 240) [r1, g1, b1] = [0, x, c];
  else if (hue < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
    a: Math.max(0, Math.min(1, Math.round(a * 100) / 100)),
  };
}

/** Parse `#RGB`, `RGB`, `#RRGGBB`, or `RRGGBB` into `{ r, g, b }`, or null when invalid. */
export function parseHexInput(raw: string): { r: number; g: number; b: number } | null {
  const s = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return {
      r: Number.parseInt(s[0]! + s[0]!, 16),
      g: Number.parseInt(s[1]! + s[1]!, 16),
      b: Number.parseInt(s[2]! + s[2]!, 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return {
      r: Number.parseInt(s.slice(0, 2), 16),
      g: Number.parseInt(s.slice(2, 4), 16),
      b: Number.parseInt(s.slice(4, 6), 16),
    };
  }
  return null;
}

export function rgbaCssString(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

import type { Gradient, Rgba } from '@ordo/domain';
import { type Hsv, rgbaToHsv } from './colorMath.ts';

/*
 * The PaintPopover's paint and gradient-stop edits (design/15 "Paint picker"), as pure functions of the
 * value shown and the active stop. Every edit returns the next value and the stop that is active after it,
 * so the popover's sliders and hex field stay on the stop the volunteer is working on while the stops are
 * kept sorted by position (the schema's "stops are sorted by `at`"). Positions are shares of the ramp,
 * 0..1, kept to 3 decimals; a gradient keeps MIN_GRAD_STOPS to MAX_GRAD_STOPS stops (the schema's bounds).
 */

export type PaintMode = 'none' | 'solid' | 'linear' | 'radial';

export type PaintValue =
  | { kind: 'none' }
  | { kind: 'solid'; color: Rgba }
  | { kind: 'gradient'; gradient: Gradient };

export type Stops = Gradient['stops'];

export const MIN_GRAD_STOPS = 2;
export const MAX_GRAD_STOPS = 16;
/** A new linear gradient runs top to bottom (OOXML `a:lin ang` 90°). */
export const DEFAULT_LINEAR_ANGLE = 90;
/** The colour a picker starts from when the value has none ('None', or a gradient without stops). */
export const DEFAULT_SOLID: Rgba = Object.freeze({ r: 59, g: 130, b: 246, a: 1 });

/** A gradient edit: the gradient to store and the index of the active stop in it. */
export interface StopEdit {
  gradient: Gradient;
  active: number;
}

/** The paint's mode, as the popover's tabs name it. */
export function paintMode(v: PaintValue): PaintMode {
  return v.kind === 'none' ? 'none' : v.kind === 'solid' ? 'solid' : v.gradient.kind;
}

/** An index into `stops`, clamped (0 for an empty list). */
export function clampStop(stops: Stops, i: number): number {
  if (stops.length === 0) return 0;
  return Math.max(0, Math.min(stops.length - 1, Number.isFinite(i) ? Math.trunc(i) : 0));
}

/** A position on the ramp: clamped to 0..1, 3 decimals; not a number gives 0. */
export function stopPosition(at: number): number {
  return Math.max(0, Math.min(1, Math.round((Number.isFinite(at) ? at : 0) * 1000) / 1000));
}

/** Stops sorted by position (ties keep their order), and where the stop at `active` went. */
export function sortStopsKeeping(stops: Stops, active: number): { stops: Stops; active: number } {
  const order = stops.map((_, i) => i).sort((a, b) => stops[a]!.at - stops[b]!.at || a - b);
  const keep = clampStop(stops, active);
  return { stops: order.map((i) => stops[i]!), active: Math.max(0, order.indexOf(keep)) };
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t);
  return {
    r: ch(a.r, b.r),
    g: ch(a.g, b.g),
    b: ch(a.b, b.b),
    a: Math.round((a.a + (b.a - a.a) * t) * 1000) / 1000,
  };
}

/** A darker shade of a colour (each channel × f). */
export function shadeColor(c: Rgba, f: number): Rgba {
  return { r: Math.round(c.r * f), g: Math.round(c.g * f), b: Math.round(c.b * f), a: c.a };
}

/** The colour the gradient has at `at` (the stops in position order). */
export function sampleGradient(stops: Stops, at: number): Rgba {
  const sorted = sortStopsKeeping(stops, 0).stops;
  if (sorted.length === 0) return DEFAULT_SOLID;
  if (at <= sorted[0]!.at) return sorted[0]!.color;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (at <= b.at) return mix(a.color, b.color, b.at > a.at ? (at - a.at) / (b.at - a.at) : 0);
  }
  return sorted[sorted.length - 1]!.color;
}

/**
 * A new stop at `at` (a click on the ramp), else in the middle of the widest gap (the + button), in the
 * colour the gradient has there; it becomes the active stop. At MAX_GRAD_STOPS nothing changes.
 */
export function addStop(g: Gradient, active: number, at?: number): StopEdit {
  if (g.stops.length >= MAX_GRAD_STOPS) return { gradient: g, active: clampStop(g.stops, active) };
  const cur = sortStopsKeeping(g.stops, 0).stops;
  let pos = at;
  if (pos === undefined || !Number.isFinite(pos)) {
    let widest = -1;
    let best = 0;
    for (let i = 0; i + 1 < cur.length; i++) {
      const gap = cur[i + 1]!.at - cur[i]!.at;
      if (gap > widest) {
        widest = gap;
        best = i;
      }
    }
    pos = ((cur[best]?.at ?? 0) + (cur[best + 1]?.at ?? 1)) / 2;
  }
  const p = stopPosition(pos);
  const stops = [...cur, { at: p, color: sampleGradient(cur, p) }];
  const sorted = sortStopsKeeping(stops, stops.length - 1);
  return { gradient: { ...g, stops: sorted.stops }, active: sorted.active };
}

/** Stop `i` moved to `at` (a pin drag, the % field); the stops re-sorted with it still the active one. */
export function moveStop(g: Gradient, i: number, at: number): StopEdit {
  const idx = clampStop(g.stops, i);
  if (g.stops.length === 0) return { gradient: g, active: 0 };
  const stops = g.stops.map((s, j) => (j === idx ? { ...s, at: stopPosition(at) } : s));
  const sorted = sortStopsKeeping(stops, idx);
  return { gradient: { ...g, stops: sorted.stops }, active: sorted.active };
}

/** Stop `i` removed; its neighbour (the one after it, else the last) becomes active. Keeps MIN_GRAD_STOPS. */
export function removeStop(g: Gradient, i: number): StopEdit {
  const idx = clampStop(g.stops, i);
  if (g.stops.length <= MIN_GRAD_STOPS) return { gradient: g, active: idx };
  const stops = g.stops.filter((_, j) => j !== idx);
  return { gradient: { ...g, stops }, active: clampStop(stops, idx) };
}

/** Stop `i`'s colour changed (its position and the order stay). */
export function setStopColor(g: Gradient, i: number, color: Rgba): Gradient {
  const idx = clampStop(g.stops, i);
  return { ...g, stops: g.stops.map((s, j) => (j === idx ? { ...s, color } : s)) };
}

/** The colour the sliders show: the solid colour, the active stop's, else `fallback`. */
export function activeColorOf(v: PaintValue, active: number, fallback: Rgba = DEFAULT_SOLID): Rgba {
  if (v.kind === 'solid') return v.color;
  if (v.kind === 'gradient') return v.gradient.stops[clampStop(v.gradient.stops, active)]?.color ?? fallback;
  return fallback;
}

/**
 * Switch the paint's mode from a tab.
 * - None drops the paint; Solid keeps the colour shown (the active stop's).
 * - Linear ↔ Radial keeps the stops and every other field (`center`, `scaled` and the angle stay stored for
 *   switching back; the other kind ignores them); a linear gradient without an angle runs at 90°.
 * - From a colour (or None) a gradient runs from it to a darker shade of it, the first stop active.
 * The same mode returns the value unchanged.
 */
export function switchPaintMode(
  v: PaintValue,
  target: PaintMode,
  active: number,
  fallback: Rgba = DEFAULT_SOLID,
): { value: PaintValue; active: number } {
  if (target === paintMode(v)) return { value: v, active };
  if (target === 'none') return { value: { kind: 'none' }, active: 0 };
  if (target === 'solid') {
    const color =
      v.kind === 'gradient'
        ? (v.gradient.stops[clampStop(v.gradient.stops, active)]?.color ??
          v.gradient.stops[0]?.color ??
          fallback)
        : v.kind === 'solid'
          ? v.color
          : fallback;
    return { value: { kind: 'solid', color }, active: 0 };
  }
  if (v.kind === 'gradient') {
    const gradient: Gradient =
      target === 'linear'
        ? { ...v.gradient, kind: 'linear', angle: v.gradient.angle ?? DEFAULT_LINEAR_ANGLE }
        : { ...v.gradient, kind: 'radial' };
    return { value: { kind: 'gradient', gradient }, active: clampStop(v.gradient.stops, active) };
  }
  const base = v.kind === 'solid' ? v.color : fallback;
  const stops = [
    { at: 0, color: base },
    { at: 1, color: shadeColor(base, 0.55) },
  ];
  const gradient: Gradient =
    target === 'linear' ? { kind: 'linear', angle: DEFAULT_LINEAR_ANGLE, stops } : { kind: 'radial', stops };
  return { value: { kind: 'gradient', gradient }, active: 0 };
}

/** A gradient to store: its stops sorted, and where the stop at `active` went. */
export function sortedGradient(g: Gradient, active: number): StopEdit {
  const s = sortStopsKeeping(g.stops, active);
  return { gradient: { ...g, stops: s.stops }, active: s.active };
}

/**
 * The sliders' HSV for a colour shown, keeping the previous hue where the colour has none (grey, black)
 * and returning `prev` itself when nothing changed, so syncing the sliders from the value never makes a
 * render of its own (#24's picker re-rendered forever on 'None', where the colour was a new object each
 * render).
 */
export function syncHsv(prev: Hsv, color: Rgba): Hsv {
  const next = rgbaToHsv(color);
  const h = next.s === 0 ? prev.h : next.h;
  if (prev.h === h && prev.s === next.s && prev.v === next.v && prev.a === next.a) return prev;
  return { h, s: next.s, v: next.v, a: next.a };
}

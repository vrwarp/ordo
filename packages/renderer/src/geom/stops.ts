/*
 * The stops a gradient is drawn with (design/27 §12 drawing cost; `paint.ts`, `cost.ts`). Pure: the converter
 * rates its gradients with it. Canvas pads a gradient past its outer stops with their colours, so an end stop
 * whose colour its neighbour repeats changes nothing and is dropped: PowerPoint's radial decorations often
 * hold their centre colour from 0 to 15 % and their edge colour from 97 to 100 %, four stops that draw as two.
 * Skia draws two stops at 0 and 1 on its fast path; `paint.ts` draws two stops inside 0..1 as two at 0 and 1
 * over that part of the gradient line (`fastStops`), and `cost.ts` rates any other gradient at twice a pixel
 * (`GEOM_COST.slowGradient`).
 */

/** A gradient stop as the drawers and the converter hold one: its position and colour. */
export interface GradientStopLike {
  readonly at?: unknown;
  readonly color?: { readonly r?: unknown; readonly g?: unknown; readonly b?: unknown; readonly a?: unknown };
}

/** The same colour, exactly (the drawers' clamp keeps channels as given). */
function sameColour(a: GradientStopLike['color'], b: GradientStopLike['color']): boolean {
  return !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/** A stop's position as the clamp reads it: a finite number within 0..1, else 0. */
export function stopAt(s: GradientStopLike | undefined): number {
  const v = s?.at;
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * The stops a gradient is drawn with: sorted by position (stable, as `clampGradient` sorts them), without the
 * end stops whose neighbour repeats their colour (at least two kept). The same array when nothing changes.
 */
export function drawnStops<T extends GradientStopLike>(stops: readonly T[]): readonly T[] {
  let s = stops;
  for (let i = 1; i < s.length; i++)
    if (stopAt(s[i]) < stopAt(s[i - 1])) {
      s = [...s].sort((a, b) => stopAt(a) - stopAt(b));
      break;
    }
  let lo = 0;
  let hi = s.length;
  while (hi - lo > 2 && sameColour(s[lo]!.color, s[lo + 1]!.color)) lo++;
  while (hi - lo > 2 && sameColour(s[hi - 1]!.color, s[hi - 2]!.color)) hi--;
  return lo === 0 && hi === s.length ? s : s.slice(lo, hi);
}

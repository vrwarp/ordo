import { type Gradient, type Rgba, rgbaCss } from '@ordo/domain';
import type { Ctx2D } from '../ctx.ts';
import { type GeomSpacePaint, type GeomStyle, shadeRgba } from './draw.ts';
import { drawnStops } from './stops.ts';

/*
 * Gradients over a box (design/27 §3.1 `Gradient`, §15 M6): a shape's gradient fill and gradient text. Built in
 * box space (0..w, 0..h), so one gradient spans every path of a geometry, and every glyph of a text box, as in
 * PowerPoint and LibreOffice.
 * - linear: OOXML `a:lin ang` clockwise from left→right; the stops run along that direction across the box's
 *   projection on it, from the corner where it starts to the opposite one. `scaled` takes the angle in a
 *   square stretched with the box (the gradient's field is u·p in the unit square, which is the box-space
 *   direction (h cos θ, w sin θ)), so 45° runs exactly corner to corner.
 * - radial (path gradients): stop 0 at the focus (`center`, box fractions from the top-left, default the
 *   centre), stop 1 at the farthest corner, on an ellipse of the box's aspect: a circle in a space whose y is
 *   squeezed by w/h, mapped back by the paint's transform (`GeomSpacePaint`).
 * Each stop is shaded for the path's brightness (`shadeRgba`), as LibreOffice shades each gradient stop.
 *
 * End stops whose neighbour repeats their colour are dropped (`stops.ts` `drawnStops`), and two stops between
 * 0 and 1 (a stop moved in from an end: PowerPoint's 0..60 % radial decorations, a 4:3 background laid over the
 * 16:9 frame) are drawn as stops at 0 and 1 over the part of the gradient line between them (`fastStops`):
 * Canvas pads past the outer stops, so the colours are the same, and Skia draws two stops at 0 and 1 on its
 * fast path, about half the time a pixel of any other gradient (`cost.ts` `slowGradient`).
 */

/**
 * A box-space style for a gradient at a brightness, or a paint in its own space (radial, non-square box). With
 * `circle`, a radial gradient is a circle to the farthest corner instead (for text, which is not filled as a
 * path), and the box is at (x0, y0).
 */
export function gradientStyle(
  ctx: Ctx2D,
  g: Gradient,
  w: number,
  h: number,
  brightness = 0,
  circle?: { x0: number; y0: number },
): GeomStyle | GeomSpacePaint {
  const ox = circle?.x0 ?? 0;
  const oy = circle?.y0 ?? 0;
  const colour = (c: Rgba) => rgbaCss(shadeRgba(c, brightness));
  // Two stops inside 0..1 run from `from` to `to` of the gradient line, as stops at 0 and 1.
  const stops = drawnStops(g.stops);
  const span = fastStops(stops);
  const from = span?.[0] ?? 0;
  const to = span?.[1] ?? 1;
  const add = (cg: CanvasGradient) => {
    if (span) {
      cg.addColorStop(0, colour(stops[0]!.color));
      cg.addColorStop(1, colour(stops[1]!.color));
      return cg;
    }
    for (const s of stops) {
      const at = Number.isFinite(s.at) ? Math.min(Math.max(s.at, 0), 1) : 0;
      cg.addColorStop(at, colour(s.color));
    }
    return cg;
  };
  if (g.kind === 'radial') {
    const cx = (Number.isFinite(g.center?.x) ? g.center!.x : 0.5) * w;
    const cy = (Number.isFinite(g.center?.y) ? g.center!.y : 0.5) * h;
    if (!circle && w > 0 && h > 0 && Math.abs(w - h) > 1e-9 * Math.max(w, h)) {
      // A space where the ellipse is a circle: y' = y·w/h, so the box is w x w there.
      const k = h / w;
      const sy = cy / k;
      const r = farthest(cx, sy, w, w) || 1;
      return {
        style: add(ctx.createRadialGradient(cx, sy, from * r, cx, sy, to * r)),
        transform: [1, 0, 0, k, 0, 0],
      };
    }
    const r = farthest(cx, cy, w, h) || 1;
    return add(ctx.createRadialGradient(cx + ox, cy + oy, from * r, cx + ox, cy + oy, to * r));
  }
  const th = ((Number.isFinite(g.angle) ? g.angle! : 0) * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  let nx = g.scaled ? h * cos : cos;
  let ny = g.scaled ? w * sin : sin;
  const len = Math.hypot(nx, ny);
  if (len > 0) {
    nx /= len;
    ny /= len;
  } else {
    nx = 1;
    ny = 0;
  }
  const half = (Math.abs(w * nx) + Math.abs(h * ny)) / 2 || 0.5;
  // The gradient line runs from w/2 − n·half to w/2 + n·half; its part between the stops when they are moved in.
  const a = (2 * from - 1) * half;
  const b = (2 * to - 1) * half;
  return add(
    ctx.createLinearGradient(
      w / 2 + nx * a + ox,
      h / 2 + ny * a + oy,
      w / 2 + nx * b + ox,
      h / 2 + ny * b + oy,
    ),
  );
}

/**
 * The positions of a gradient's two stops when they lie inside 0..1 and apart (not both at the ends), else
 * undefined: such a gradient is drawn as stops at 0 and 1 over that part of its line (see the header). Stops
 * are sorted (`clampGradient`); unsorted ones keep their own drawing.
 */
export function fastStops(stops: readonly { readonly at: number }[]): [number, number] | undefined {
  if (stops.length !== 2) return undefined;
  const a = stops[0]!.at;
  const b = stops[1]!.at;
  if (!(Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b <= 1 && b - a > 1e-6)) return undefined;
  return a > 0 || b < 1 ? [a, b] : undefined;
}

/** The distance from (x, y) to the farthest corner of a w x h box. */
function farthest(x: number, y: number, w: number, h: number): number {
  return Math.max(Math.hypot(x, y), Math.hypot(w - x, y), Math.hypot(x, h - y), Math.hypot(w - x, h - y));
}

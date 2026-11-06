import { type Gradient, type Rgba, rgbaCss } from '@ordo/domain';
import type { Ctx2D } from '../ctx.ts';
import { type GeomSpacePaint, type GeomStyle, shadeRgba } from './draw.ts';

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
  const stops = g.stops;
  const colour = (c: Rgba) => rgbaCss(shadeRgba(c, brightness));
  const add = (cg: CanvasGradient) => {
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
      const r = farthest(cx, sy, w, w);
      return {
        style: add(ctx.createRadialGradient(cx, sy, 0, cx, sy, r || 1)),
        transform: [1, 0, 0, k, 0, 0],
      };
    }
    const r = farthest(cx, cy, w, h) || 1;
    return add(ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, r));
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
  const x0 = w / 2 - nx * half;
  const y0 = h / 2 - ny * half;
  return add(ctx.createLinearGradient(x0 + ox, y0 + oy, w / 2 + nx * half + ox, h / 2 + ny * half + oy));
}

/** The distance from (x, y) to the farthest corner of a w x h box. */
function farthest(x: number, y: number, w: number, h: number): number {
  return Math.max(Math.hypot(x, y), Math.hypot(w - x, y), Math.hypot(x, h - y), Math.hypot(w - x, h - y));
}

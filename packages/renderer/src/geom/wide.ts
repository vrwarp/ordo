import type { ShapeObject } from '@ordo/domain';
import { num } from '../clamp.ts';
import type { Ctx2D } from '../ctx.ts';
import { drawEffected } from '../effects.ts';
import { clampShapeObject, placeBox, planFrom, styleLines } from '../shape.ts';
import { drawGeom, geomFillPath2D, geomPath2D } from './draw.ts';
import { lineStyleOf } from './outline.ts';
import type { BuiltGeom } from './path.ts';

/*
 * The wide draw (the owner's Q53 and Q56.d: a custom-path shape with many points is drawn as a PICTURE at import
 * by the hub's own headless Chromium running ordo's renderer, and the screens cannot draw such a shape).
 *
 * `drawShapeWide(ctx, shape, built)` draws ONE shape from a geometry the CALLER built (`compileGeom` and
 * `buildGeom` with their own `limits`, geom/ops.ts GEOM_READ): it bypasses the stored-geometry clamp (8 paths x
 * 4,096 points: stored.ts) and the cost refusal (`pathsGeometry`, built.ts) that `drawGeomShape` goes through,
 * and draws with the SAME paint, stroke, dash, join, cap, arrowhead, gradient and effects code through the two
 * hooks of shape.ts (`planFrom`, `styleLines`), so a shape within today's limits comes out pixel for pixel as
 * `drawGeomShape` draws it (wide.browser.test.ts pins that; no golden).
 *
 * What it never is: a live path. No module of the renderer, the output, the operator, the stage or the live
 * state imports this file (wide.test.ts greps it), it is in no barrel and no initial bundle, and it draws no 3-D
 * look, no table, chart or decoration. Its callers are the hub's picture page (apps/hub/src/pptx/raster-page.ts),
 * the fidelity harness and tests. It stores nothing and reads no geometry file.
 *
 * Units: the caller sets the context's transform (the page: density 2 and the run's box offset), so the shape is
 * drawn at scale 1 in logical px: `shape.box` places it, flips and rotation as `drawGeomShape` does. The shape's
 * non-geometry fields go through the screens' own `clampShapeObject` (a recipe's member carries no geometry, so
 * that clamp cuts none of it and bounds every other field as for a live object); a `geom` on the shape is
 * ignored (the built geometry is the shape's geometry).
 */

/** Draws `shape` over the built geometry `built` at its box, in the context's own units; see the file header. */
export function drawShapeWide(ctx: Ctx2D, shape: ShapeObject, built: BuiltGeom): void {
  const { geom: _geom, ...bare } = shape;
  const o = clampShapeObject(bare as ShapeObject);
  const plan = planFrom(ctx, o, built);
  const opacity = num(o.opacity, 0, 1, 1);
  if ((!plan.fill && !plan.stroke) || opacity <= 0) return;
  ctx.save();
  placeBox(ctx, o.box, 1, o.flipH === true, o.flipV === true);
  if ((o.shadow || o.glow || o.softEdge) && typeof ctx.getTransform === 'function') {
    const m = ctx.getTransform();
    const device = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    const drawn = drawEffected(
      ctx,
      {
        transform: m,
        scale: device,
        bounds: plan.bounds,
        draw: (c) => {
          styleLines(c, o);
          drawGeom(c, plan.built, plan.fill, plan.stroke);
        },
        // Built only when a layer is made, once per plan.
        get fill() {
          if (!plan.fill) return undefined;
          plan.fillPath ??= geomFillPath2D(plan.built);
          return plan.fillPath;
        },
        get strokes() {
          if (!plan.stroke) return undefined;
          plan.strokePaths ??= plan.built.paths.filter((p) => p.stroke).map(geomPath2D);
          return plan.strokePaths;
        },
        lineWidth: plan.stroke?.width ?? 0,
        ...lineStyleOf(o),
        shadow: o.shadow,
        glow: o.glow,
        softEdge: o.softEdge,
        // One picture is made once: no effect sprite is cached under a key (the geometry is not in the shape).
        key: undefined,
      },
      opacity,
    );
    if (drawn) {
      ctx.restore();
      return;
    }
  }
  ctx.globalAlpha *= opacity;
  styleLines(ctx, o);
  drawGeom(ctx, plan.built, plan.fill, plan.stroke);
  ctx.restore();
}

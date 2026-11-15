import type { Rgba, ShapeObject, Slide } from '@ordo/domain';

/*
 * Slides of effects past the slide's effect budget (`EFFECT_COST.slide`), for the effect units' tests, the
 * browser check and the e2e (design/14 "Effect units"; not shipped: *.test-util.ts). The worship corpus never
 * reaches the budget (its most effected slides weigh 7.7 of 10): hand-made and ProPresenter slides do.
 */

const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });

/** The shadow of the panels: about 0.21 of a slide area of layer each at 800 x 480 (`effectArea`). */
export const PANEL_SHADOW = { dx: 6, dy: 6, blur: 12, color: rgba(0, 0, 0, 0.55) };

/** A shadowed panel (a rounded rect preset) of `w` x `h` at x, y in its own colour. */
export function panel(id: string, x: number, y: number, w: number, h: number, i: number): ShapeObject {
  return {
    id,
    type: 'shape',
    box: { x, y, w, h, rotation: 0 },
    shape: 'rect',
    fill: rgba(40 + ((i * 37) % 180), 90 + ((i * 53) % 140), 200 - ((i * 29) % 150)),
    opacity: 1,
    radius: 0,
    geom: { preset: 'roundRect' },
    shadow: PANEL_SHADOW,
  };
}

/** A full-frame soft-edged shape (8 weighted slide areas of the budget's 10: `EFFECT_COST.softEdge`). */
export function softFrame(): ShapeObject {
  return {
    id: 'soft',
    type: 'shape',
    box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
    shape: 'rect',
    fill: rgba(250, 236, 200),
    opacity: 1,
    radius: 0,
    geom: { preset: 'rect' },
    softEdge: 60,
  };
}

/**
 * One full-frame soft-edged shape and 12 shadowed panels over it (each 800 x 480, about 0.21 of a slide area
 * of layer): the budget keeps the soft edge (8) and the first 9 shadows (9.9), and leaves out the last 3, whose
 * units together are about 0.63 of a frame (within one frame of units a slide). With `size` the panels are
 * that size instead (larger ones pass one frame of units).
 */
export function effectsSlide(size: { w: number; h: number } = { w: 800, h: 480 }): Slide {
  const panels = Array.from({ length: 12 }, (_, i) =>
    panel(`p${i}`, 40 + (i % 4) * 340, 40 + Math.floor(i / 4) * 230, size.w, size.h, i),
  );
  return { id: 'effects', objects: [softFrame(), ...panels] };
}

/**
 * A thin chain of `links` rings of `sides` corners, stroked 2 px and not filled, as stored paths (at most 4,096
 * points a piece, `cont` pieces after the first): its outline's legs, joins and points pass `GEOM_COST.slide` on
 * their own, so no call within a task draws it at once. By default strung along three turns of a sine as the
 * e2e deck's (`e2e/pptxdecks.ts` `loneChainPath`: the rings overlap); with `rows`, in that many rows of rings that
 * never touch (a sliced unit's groups then draw exactly the pixels of one call).
 */
export function loneChain(links = 900, sides = 23, rows?: number): ShapeObject {
  const w = 1680;
  const h = 900;
  const subs: string[] = [];
  const perRow = rows ? Math.ceil(links / rows) : links;
  const r = rows ? Math.min(w / perRow, h / rows) * 0.3 : Math.min(w, h) * 0.004;
  for (let i = 0; i < links; i++) {
    let cx: number;
    let cy: number;
    if (rows) {
      cx = ((i % perRow) + 0.5) * (w / perRow);
      cy = (Math.floor(i / perRow) + 0.5) * (h / rows);
    } else {
      const t = (i + 0.5) / links;
      cx = r * 2 + t * (w - r * 4);
      cy = h / 2 + (h / 2 - r * 3) * Math.sin(t * Math.PI * 6);
    }
    let d = '';
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      d += `${k ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
    }
    subs.push(`${d}Z`);
  }
  // Pieces of whole rings within a path's 4,096 points (`PATH_DATA_LIMITS`).
  const per = Math.floor(4096 / (sides + 1));
  const paths: { d: string; w: number; h: number; fill: 'none'; cont?: true }[] = [];
  for (let i = 0; i < subs.length; i += per)
    paths.push({
      d: subs.slice(i, i + per).join(''),
      w,
      h,
      fill: 'none',
      ...(i ? { cont: true as const } : {}),
    });
  return {
    id: 'chain',
    type: 'shape',
    box: { x: 120, y: 90, w, h, rotation: 0 },
    shape: 'rect',
    opacity: 1,
    radius: 0,
    stroke: { width: 2, color: rgba(0, 0, 0) },
    geom: { paths },
  } as ShapeObject;
}

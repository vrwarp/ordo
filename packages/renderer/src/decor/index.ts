import { registerDecorHooks, registerShapeDrawer } from '../shape.ts';
import { decorCapped, decorCost, decorReach, decorShapeCount, drawDecor, drawDecorRange } from './draw.ts';

/*
 * The decoration drawer (design/27 M9 decorations, `ShapeObject.decor`; decor-render): source shapes, paint,
 * shadows, sprite, cost and reach (`draw.ts`). Importing this module registers the drawer with the shape
 * dispatch (`shape.ts` `registerShapeDrawer`); the renderer's index registers its loader, so a worker or page
 * loads it the first time a slide holds a decoration (`loadShapeDrawers`), and until then a decoration draws its
 * legacy line without a stroke (nothing), as an older build does. The decoration files' store (`files.ts`) is
 * not here: it is small and loaded with the renderer's index, so reading a slide's files never loads this.
 *
 * What the outputs' effect units (units.ts) and the drawing budget (geombudget.ts) read of a decoration, through
 * the hooks registered here (`shape.ts` `registerDecorHooks`, so neither loads this module): whether it is past
 * its sprite thresholds (`decorCapped`, `DECOR_SPRITE`), `drawDecorRange` over `decorShapeCount` shapes, its cost
 * (`decorCost`) and where it draws (`decorReach`).
 */

export {
  DECOR_SPRITE,
  decorCapped,
  type DecorGeometry,
  type DecorShape,
  decorCost,
  decorReach,
  decorShapeCount,
  decorShapes,
  drawDecor,
  drawDecorRange,
  withDirectDecor,
} from './draw.ts';

registerShapeDrawer('decor', drawDecor, (_ctx, o) => decorReach(o));
registerDecorHooks({
  capped: decorCapped,
  count: decorShapeCount,
  range: drawDecorRange,
  cost: decorCost,
  reach: decorReach,
});

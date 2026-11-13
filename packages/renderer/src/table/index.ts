import { registerShapeDrawer } from '../shape.ts';
import { drawTable } from './draw.ts';

/*
 * The table object's drawer (design/27 M9 tables, `ShapeObject.table`): model, layout, drawing, hit test and
 * the M6 group it replaces. Importing this module registers the drawer with the shape dispatch (`shape.ts`
 * `registerShapeDrawer`), so every drawer that imports the renderer draws tables: until then a table shape
 * draws its legacy rect, as an older build does.
 */

export { drawTable } from './draw.ts';
export { tableHit, tablePoint } from './hit.ts';
export {
  CELL_CACHE,
  type TableCellLayout,
  type TableLayout,
  type TableStroke,
  clearTableCache,
  layoutTable,
  prepareTableLayout,
  tableCacheSize,
  tableHasVertical,
  tableStrokes,
} from './layout.ts';
export { legacyGroup } from './legacy.ts';
export {
  type TableModel,
  cellIsVertical,
  cellStyleIndex,
  cellText,
  tableModel,
  tableModelOf,
} from './model.ts';

registerShapeDrawer('table', (ctx, o, scale) => drawTable(ctx, o, scale) !== undefined);

import { registerShapeDrawerLoader } from './shape.ts';

export * from './text2d.ts';
export * from './picture.ts';
export * from './timing.ts';
export * from './stacks.ts';
export * from './scene.ts';
export * from './scene-raster.ts';
export * from './plan.ts';
export * from './props.ts';
export * from './health.ts';
export * from './raster.ts';
export * from './sprite.ts';
export * from './messages.ts';
export * from './cache-policy.ts';
export * from './bitmap-cache.ts';
export type { Compositor, FrameInputs, VideoFrames } from './compositor.ts';
export { MAX_VIDEO_SLOTS } from './compositor.ts';
export * from './clamp.ts';
export * from './content.ts';
export * from './text/index.ts';
export * from './geom/index.ts';
export * from './shape.ts';
export * from './effects.ts';
export * from './spritecache.ts';
export * from './geombudget.ts';
// Geometry units (units.ts) are made only on the asset and thumbnail workers: they import
// '@ordo/renderer/units.ts' themselves (its import registers the slide objects' drawer), so the operator's main
// thread, which never makes one, does not carry it (r2a repair: 2.7 kB of its initial bundle). Types only here.
export type {
  GeomUnit,
  SlideUnitsMade,
  SlideUnitsOptions,
  UnitImage,
  UnitLeft,
  UnitRect,
  UnitRun,
} from './units.ts';
export {
  clearDecorFiles,
  DECOR_FILE_RETRY_MS,
  type DecorFileRead,
  decorFileParts,
  decorFilesVersion,
  decorPending,
  putDecorFile,
  readDecorFiles,
} from './decor/files.ts';

// M9 drawers per object kind, each loaded the first time a slide holds that kind (`loadShapeDrawers`): the
// table's model, layout, drawing and reach (`@ordo/renderer/table/index.ts`) and the decoration's drawing
// (`@ordo/renderer/decor/index.ts`; its files' store above is eager), imported directly by code that draws them
// at once (the fidelity harness, goldens and benches), stay out of every initial bundle.
registerShapeDrawerLoader('table', () => import('./table/index.ts'));
registerShapeDrawerLoader('decor', () => import('./decor/index.ts'));

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

// M9 drawers per object kind, each loaded the first time a slide holds that kind (`loadShapeDrawers`): the
// table's model, layout, drawing and reach (`@ordo/renderer/table/index.ts`, imported directly by code that
// draws tables at once: the fidelity harness, goldens and benches) stay out of every initial bundle.
registerShapeDrawerLoader('table', () => import('./table/index.ts'));

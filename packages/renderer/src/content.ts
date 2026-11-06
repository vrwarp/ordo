import { type SlideDrawing, slideContent } from '@ordo/domain';
import { clampSlide } from './clamp.ts';

/**
 * The one fallback rule every drawer follows (design/27 §5 "One rule for every drawer"): `slideContent`
 * decides what a slide draws, a whole-slide picture (the PowerPoint reference picture while the slide is
 * set to show it, else an imported page picture) under its objects (only the operator's own on a reference
 * picture). The rule lives in `@ordo/domain` so the media a goLive ships (`referencedMediaIds`) follows it
 * too; it is re-exported here for the drawers: the output's asset worker (`drawSlide2D` and the scene
 * split), the planner (`slideVisible`, the in-slide video), the thumbnail worker, look previews, the editor
 * canvas and previews (`drawnMediaIds`).
 */
export {
  type SlideDrawing,
  drawnMediaIds,
  fromImport,
  referencePicture,
  slideContent,
} from '@ordo/domain';

const drawableMemo = new WeakMap<object, SlideDrawing>();

/**
 * What a look that draws slides as authored draws of `slide`: `slideContent` of its drawable copy
 * (`clampSlide`, whose image budget counts only the pictures this draws). Memoised per slide, so the objects
 * array is the same on every call (the drawers memoise layout per object). Never throws.
 */
export function drawableContent(slide: unknown): SlideDrawing {
  const key = slide && typeof slide === 'object' ? slide : undefined;
  const hit = key && drawableMemo.get(key);
  if (hit) return hit;
  const clamped = clampSlide(slide);
  const out = drawableMemo.get(clamped) ?? slideContent(clamped);
  drawableMemo.set(clamped, out);
  if (key) drawableMemo.set(key, out);
  return out;
}

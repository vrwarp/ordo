import type { Slide, SlideObject } from './schemas.ts';

/**
 * What a slide draws (design/27 §5 "One rule for every drawer"): one whole-slide picture, contain-fitted
 * under the objects, and the objects bottom first.
 */
export type SlideDrawing = {
  /**
   * The picture under the objects: the slide's PowerPoint reference picture while the slide is set to show
   * it, else the imported page picture of a picture slide; undefined when there is none.
   */
  pictureMediaId?: string;
  /**
   * Whether `pictureMediaId` is the reference picture (`Slide.pptx.refMediaId`), which goLive treats as
   * optional (design/27 §8 "Domain").
   */
  reference: boolean;
  /** The objects drawn, bottom first: every object, or only the operator's own on a reference picture. */
  objects: SlideObject[];
};

/** Whether an object came from a PowerPoint import (`origin`), rather than from the operator. */
export function fromImport(o: unknown): boolean {
  const origin = (o as { origin?: unknown } | null | undefined)?.origin;
  return typeof origin === 'object' && origin !== null;
}

/**
 * The reference picture a slide is set to show instead of its imported objects ('Show PowerPoint picture':
 * `pptx.show === 'picture'` with a `refMediaId`), else undefined.
 */
export function referencePicture(slide: Pick<Slide, 'pptx'>): string | undefined {
  const p = (slide as { pptx?: unknown }).pptx as { show?: unknown; refMediaId?: unknown } | undefined;
  if (!p || typeof p !== 'object' || p.show !== 'picture') return undefined;
  return typeof p.refMediaId === 'string' && p.refMediaId ? p.refMediaId : undefined;
}

/**
 * The one fallback rule every drawer follows (design/27 §5 "One rule for every drawer", §7):
 * - a slide set to show its PowerPoint picture (`pptx.show === 'picture'` and `pptx.refMediaId`) draws that
 *   picture and only the objects without `origin`, the ones the operator added in ordo;
 * - any other slide draws its imported page picture (`imported.imageMediaId`, a picture-class slide or a
 *   legacy page) when it has one, and every object. A native or hybrid slide (its art is an ordinary
 *   locked image object at its place in the z-order) has no page picture; a slide still waiting for
 *   LibreOffice (`pptx.pending`) draws what it stores.
 *
 * Outputs (asset worker, scene split, planner), thumbnails, look previews, the editor canvas, previews and
 * the media a goLive ships (`referencedMediaIds`, `slideImages`, `previewMedia`) all read slides through
 * it, so every screen shows the same thing and has every picture it draws. Pure and defensive: it reads
 * unclamped slides too, and returns the slide's own `objects` array when nothing is left out.
 */
export function slideContent(slide: Pick<Slide, 'objects' | 'imported' | 'pptx'>): SlideDrawing {
  const objects: SlideObject[] = Array.isArray(slide.objects) ? slide.objects : [];
  const ref = referencePicture(slide);
  if (ref) return { pictureMediaId: ref, reference: true, objects: objects.filter((o) => !fromImport(o)) };
  const page = (slide.imported as { imageMediaId?: unknown } | undefined)?.imageMediaId;
  return {
    pictureMediaId: typeof page === 'string' && page ? page : undefined,
    reference: false,
    objects,
  };
}

/**
 * Every media id a slide draws as a picture, in drawing order and once each: its picture
 * (`slideContent`), then its image objects' media (a video's poster where the media is a video). What a
 * drawer must be given, and what it needs no more of.
 */
export function drawnMediaIds(slide: Pick<Slide, 'objects' | 'imported' | 'pptx'>): string[] {
  const c = slideContent(slide);
  const out = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === 'string' && id) out.add(id);
  };
  add(c.pictureMediaId);
  for (const o of c.objects) if (o?.type === 'image') add(o.mediaId);
  return [...out];
}

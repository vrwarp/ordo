/**
 * The render copy (design/27 §5 "Render copy", M3 item D): the minimal deck LibreOffice prints for the
 * slides that need it. It replaces the main-thread `pptxForRendering` of `@ordo/importers` and runs on the
 * hub's CPU pool (task `pptx-render-copy`), with linear tag scans and the part budgets of §12.
 *
 * - Only the needed slides are listed in `p:sldIdLst`, in page order: page k of the PDF is `pages[k - 1]`,
 *   so hidden slides can never shift a page.
 * - An art slide appears twice, once over a forced white background and once over black (slide, layout and
 *   master backgrounds overridden, master shapes hidden), and keeps only the art's own elements.
 * - A picture-class slide is kept whole, apart from media payloads.
 * - Media payload relationships (video, audio) are removed, posters stay; `vbaProject.bin`, OLE binaries
 *   (their preview pictures stay) and every External relationship are removed; the outline strip of
 *   design/20 is applied (LibreOffice draws a coloured outline on filled text as hollow letters).
 *
 * Pure like the rest of the package: parts in, parts out; the hub zips them with the spilled media.
 */
import type { ElementRef } from './ir.ts';
import type { PartSource } from './opc.ts';

/** One printed page of the render copy. */
export type RenderCopyPage =
  /** A picture-class slide (or a reference picture): the slide as it is, media payloads removed. */
  | { index: number; mode: 'whole' }
  /** One of an art slide's two pages: only `keep` printed, over a forced white or black background. */
  | { index: number; mode: 'art'; background: 'white' | 'black'; keep: ElementRef[] };

export interface RenderCopyResult {
  /** The copy's XML parts by name (content types and relationships included), ready to zip. */
  parts: Map<string, Uint8Array>;
  /** Media parts the copy still references (pictures, posters): the hub adds their bytes from disk. */
  media: string[];
  /** The printed pages in order: page k of the PDF is `pages[k - 1]`. */
  pages: RenderCopyPage[];
  /** Text runs whose outline was removed (the job log counts them). */
  outlines: number;
  /** What could not be honoured (sanitised short lines). */
  notes: string[];
}

/**
 * Build the render copy of `src` for `pages` (`RenderCopyPage.index` is `SlideRef.index`). Throws only when
 * the deck has no readable presentation part; a page whose slide cannot be read is dropped with a note.
 */
export function buildRenderCopy(src: PartSource, pages: readonly RenderCopyPage[]): RenderCopyResult {
  void src;
  void pages;
  throw new Error('buildRenderCopy is not implemented yet (M3 item D)');
}

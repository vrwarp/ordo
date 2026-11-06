/**
 * Legacy text repair (design/27 §11 "Round trip and migration"; M3 item G). PowerPoint presentations
 * imported before M3 hold `imported.textBoxes` matched by list index (`imports.ts`), so after a hidden slide
 * they belong to another page. Text readers trust them only with `imported.textAligned`.
 *
 * The one-shot, resumable `pptx-text-repair` job goes over every pptx-sourced presentation without
 * `source.native` whose deck is still stored, re-extracts the text with pptx-scene keyed by the slide each
 * page actually shows (`pagesOf`), rewrites `textBoxes` with the uniform contain mapping, sets
 * `textAligned` and saves a new revision. Locked presentations are retried after End service; a
 * presentation whose deck is gone keeps today's behaviour (no text fallback).
 */
import type { PptxRenderer } from '@ordo/domain';
import type { JobHandler } from '../jobs.ts';
import type { PptxDeps, TextRepairPayload } from './shared.ts';
import { notYet } from './shared.ts';

export function textRepairJob(deps: PptxDeps): JobHandler<TextRepairPayload> {
  void deps;
  return async (ctx) => {
    void ctx;
    throw notYet('G', 'the legacy text repair');
  };
}

/**
 * Which listed slide (`SlideRef.index`) each page of a legacy picture import shows: for `renderer`
 * 'libreoffice' or unset, pages count shown slides; for 'pptx-preview', shown slides only when the page
 * count equals the shown count, else every listed slide.
 */
export function pagesOf(
  renderer: PptxRenderer | undefined,
  listed: readonly { index: number; hidden: boolean; shown?: number }[],
  pageCount: number,
): number[] {
  void renderer;
  void listed;
  void pageCount;
  throw notYet('G', 'pagesOf');
}

/**
 * The light `pptx-native` job (design/27 §2 steps 1-6, §5 "Two-phase save"; M3 item B): an untrusted .pptx
 * into an editable ordo presentation, version 1, before any LibreOffice process starts.
 *
 * 1. `extractZip(store.abs(deck))` with the skip filter and caps of §12 (`PPTX_LIMITS`): XML and
 *    relationship parts in memory; referenced `ppt/media/*` and `ppt/fonts/*` spilled under generated names;
 *    embeddings, `vbaProject.bin` and `customXml` skipped; no nested zips.
 * 2. Pool task `pptx-scene` (`sceneTask.ts`) in batches of `PPTX_LIMITS.batchSlides`, within
 *    `PPTX_LIMITS.importPoolMs` of pool time; past it the remaining slides become picture class (or the
 *    import fails cleanly when nothing could be saved).
 * 3. Classification and the §3.4 size budgets (`@ordo/domain` `planImportSizes`): slides over budget become
 *    picture class, logged.
 * 4. When any slide is hybrid or picture class, or shows a metafile: `pptx-lo` is enqueued now, before any
 *    clip job of this deck (`enqueuePptx`).
 * 5. Pictures prepared and stored (`pictures.ts`, `mediaParts.ts`), recorded as resume pairs.
 * 6. Placeholders remapped, notes, sections, transitions and `Slide.pptx` written, `sanitizePresentation`,
 *    `lib.savePresentation`: version 1. `Slide.pptx.digest` is `digestOf` over the objects exactly as
 *    stored (after the remap, the sanitizer and `Slide.parse`, which orders keys and fills defaults).
 */
import type { JobHandler } from '../jobs.ts';
import type { PptxDeps, PptxNativePayload, PptxNativeResult } from './shared.ts';
import { notYet } from './shared.ts';

export function nativeJob(deps: PptxDeps): JobHandler<PptxNativePayload> {
  void deps;
  return async (ctx): Promise<PptxNativeResult> => {
    void ctx;
    throw notYet('B', 'the native PowerPoint import');
  };
}

/**
 * 'Re-import from PowerPoint' (design/27 §11 "Round trip and migration", §15 M4; M4 item F,
 * apps/operator/src/views/editor/M4.md). The light `pptx-reimport` job runs the native import again on the
 * presentation's stored deck (`Presentation.source.fileId`, read through `deckParts.ts` and the
 * `pptx-scene` pool task exactly as `nativeJob.ts` reads it: the deck is untrusted, design/27 §12) and merges
 * the fresh slides into the stored presentation as one new revision (`savedBy` 'pptx-reimport'), which
 * History can restore:
 * - slides are matched by deck position (`Slide.pptx.index`; legacy picture slides by page, with the text
 *   repair's page rule `pagesOf`);
 * - a native slide is regenerated only while its objects still match `Slide.pptx.digest` (or when it is in
 *   `reset`); an edited one is kept as it is;
 * - kept from the stored presentation: slide ids, sections, arrangements, notes (unless empty), durations,
 *   per-slide backgrounds, and the operator's own objects (no `origin`), kept on top;
 * - legacy picture slides (`imported`) become the native slide; made-editable slides (no `imported`, in a
 *   pptx-sourced presentation, the bottom object a full-frame ImageObject whose media is tagged 'document')
 *   lose that page picture and every text object whose text equals an extracted box, unless in `keep`, so
 *   no content is doubled;
 * - any other slide is kept as it is;
 * - pictures go through `storePictures` (prepared, deduplicated by hash), hybrid and picture slides queue
 *   the `pptx-lo` follow-up as the first import does.
 * Refused while the presentation is live-locked (the route answers 423; a queued job defers itself, as the
 * follow-ups do, and never writes during a service: ADR 0007). 'Make editable' on one legacy slide is this
 * job with `slideIds: [that slide]`.
 *
 * Scaffold (M4): the types, the route, the job registration and these stubs. `planReimport` and
 * `mergeReimport` are pure, so most of item F is unit-tested without a hub.
 */
import type { Presentation, Slide } from '@ordo/domain';
import type {
  Job,
  PptxReimportKind,
  PptxReimportPlan,
  PptxReimportReq,
  PptxReimportResult,
} from '@ordo/protocol';
import { notFound } from '../errors.ts';
import type { JobHandler } from '../jobs.ts';
import { enqueuePptx, PPTX_JOBS, type PptxDeps, type PptxReimportPayload } from './shared.ts';

/** `savedBy` of the revisions a re-import writes. */
export const REIMPORT_BY = 'pptx-reimport';

/** The media tags `planReimport` reads ('document' marks a legacy page picture). */
export type MediaTags = (mediaId: string) => readonly string[] | undefined;

/**
 * Which kind of slide each slide of `p` is for a re-import, in authoring order (design/27 §11; the kinds of
 * `PptxReimportKind`). `tags` gives a media item's tags (a made-editable slide's bottom picture is tagged
 * 'document').
 *
 * Scaffold: every slide is 'other' (kept). Item F.
 */
export function reimportKinds(p: Presentation, _tags: MediaTags): PptxReimportKind[] {
  return p.sections.flatMap((s) => s.slides.map(() => 'other' as const));
}

/**
 * What a re-import of `p` with `req` would do, slide by slide, without reading the deck: the dialog lists the
 * made-editable slides so the user can keep any of them (`GET /presentations/:id/pptx-reimport`).
 *
 * Scaffold: no slides. Item F.
 */
export function planReimport(p: Presentation, _req: PptxReimportReq, _tags: MediaTags): PptxReimportPlan {
  const fileId = (p.source?.kind === 'pptx' ? p.source.fileId : undefined) ?? '';
  return { presentationId: p.id, fileId, slides: [] };
}

/** The slides the native import made from the stored deck, by deck position, before they are merged. */
export type FreshDeck = {
  slides: {
    /** `SlideRef.index`: position in the deck's slide order, hidden slides counted. */
    index: number;
    /** Position among the shown slides (the LibreOffice page); absent for a hidden slide. */
    shown?: number;
    /** The converted slide, its media ids already the library's (`storePictures`). */
    slide: Slide;
  }[];
  /** Extracted text boxes per deck slide, for the made-editable rule (text objects equal to one are replaced). */
  texts?: { index: number; texts: string[] }[];
};

/**
 * The stored presentation `current` with the fresh slides merged in, by the rules at the top of this file,
 * and the counts the job reports. Pure: no I/O. Returns `current` itself (the same object) when nothing
 * changes, so the job saves no revision then.
 *
 * Scaffold: `current` unchanged, nothing counted. Item F.
 */
export function mergeReimport(
  current: Presentation,
  _fresh: FreshDeck,
  _req: PptxReimportReq,
  _tags: MediaTags,
): { p: Presentation; counts: Omit<PptxReimportResult, 'presentationId' | 'rev'> } {
  return { p: current, counts: { regenerated: 0, keptEdited: 0, replaced: 0, userObjects: 0 } };
}

/** Queue a re-import (the route has checked the lock and the stored deck). */
export function queueReimport(
  deps: Pick<PptxDeps, 'jobs'>,
  presentationId: string,
  hash: string,
  req: PptxReimportReq,
  by?: string,
): Job {
  return enqueuePptx(deps.jobs, PPTX_JOBS.reimport, {
    presentationId,
    hash,
    ...(by ? { by } : {}),
    ...(req.slideIds ? { slideIds: req.slideIds } : {}),
    ...(req.reset ? { reset: req.reset } : {}),
    ...(req.keep ? { keep: req.keep } : {}),
  });
}

/**
 * The `pptx-reimport` job: read the stored deck, convert it on the pool (`nativeJob.ts`'s steps 1-5 for
 * the slides asked for), `mergeReimport`, save one revision by `REIMPORT_BY`, queue the follow-up.
 *
 * Scaffold: finds the presentation and reports that nothing changed, saving nothing. Item F.
 */
export function reimportJob(deps: PptxDeps): JobHandler<PptxReimportPayload> {
  return async (ctx) => {
    const p = deps.lib.presentations.get(ctx.payload.presentationId);
    if (!p) throw notFound('The presentation is gone');
    ctx.log('re-import: not built yet (M4 item F); nothing changed');
    const result: PptxReimportResult = {
      presentationId: p.id,
      regenerated: 0,
      keptEdited: 0,
      replaced: 0,
      userObjects: 0,
    };
    return result;
  };
}

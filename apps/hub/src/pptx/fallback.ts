/**
 * The LibreOffice follow-up (design/27 §2, §5 "Two-phase save", "Render copy", "Operator fallback", "soffice
 * hardening"; M3 item D). LibreOffice is never on the native critical path: these heavy jobs run after
 * version 1 is saved, and only on the slides that need it.
 *
 * `pptx-lo` (enqueued by the native job before any clip job of the deck):
 * 1. while the presentation is live-locked, defer with backoff and never write it (ADR 0007);
 * 2. pool task `pptx-render-copy`: every art slide twice (forced white and forced black background),
 *    picture-class slides once, External relationships and media payloads removed;
 * 3. soffice once (hardened, `sofficeToPdf`), then `pdftoppm -r 288 -f k -l k` per needed page;
 * 4. pool task `pptx-art` per art slide; picture-class pages contain-fitted at the slide's aspect, 3840 px
 *    wide at 16:9, stored unpadded; metafiles converted to PNG;
 * 5. `addReadyPicture`, then a patch of each slide whose objects still match its `Slide.pptx.digest`: the
 *    art replaces `ArtInfo.replaces` at `ArtInfo.at`. A slide edited meanwhile gets the art as an extra
 *    locked object on top, with a note. `pending` is cleared; version 2 is one new revision.
 *
 * `pptx-reference` ('Show PowerPoint picture', refused by the route while the presentation is locked):
 * every shown slide once into `Slide.pptx.refMediaId`, and `show: 'picture'`.
 */
import type { JobHandler } from '../jobs.ts';
import type { PptxDeps, PptxLoPayload, PptxReferencePayload } from './shared.ts';
import { notYet } from './shared.ts';

export function loJob(deps: PptxDeps): JobHandler<PptxLoPayload> {
  void deps;
  return async (ctx) => {
    void ctx;
    throw notYet('D', 'the LibreOffice follow-up');
  };
}

export function referenceJob(deps: PptxDeps): JobHandler<PptxReferencePayload> {
  void deps;
  return async (ctx) => {
    void ctx;
    throw notYet('D', 'the PowerPoint reference pictures');
  };
}

/**
 * LibreOffice headless conversion to PDF, hardened (design/27 §5 "soffice hardening", design/21): External
 * relationships are already gone from its input (the primary control); it runs in an empty network
 * namespace (`unshare -rn`) where the container allows it, else with proxy variables pointing at a dead
 * port; under an address-space cap (`prlimit --as`); with `tools.run`'s timeout and SIGKILL.
 */
export async function sofficeToPdf(
  input: string,
  outDir: string,
  opts: { timeoutMs: number; signal: AbortSignal; addressSpaceMb?: number },
): Promise<string> {
  void input;
  void outDir;
  void opts;
  throw notYet('D', 'sofficeToPdf');
}

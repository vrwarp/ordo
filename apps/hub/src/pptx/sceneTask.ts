/**
 * Worker side of the `pptx-scene` pool task (design/27 §2 step 2; M3 item B): one batch of slides through
 * `convertDeck`, on the CPU pool's bounded heap and timeout. Imported by `cpu.worker.ts` only; it must not
 * import the library, the store or anything else of the main thread.
 *
 * Object and slide ids are ULIDs (batches never collide); picture ids are `pptxmedia:<n>` per batch, which
 * the job maps to parts through `result.media` before it remaps them to stored media.
 *
 * - **Scan** (`input.scan`, the import's first call, no slide converted): the deck facts of `convertDeck`
 *   (slide list, frame, sections) and what the job needs before the batches: the picture parts the listed
 *   slides, their layouts, masters and themes relate to, their SmartArt drawings' included (the job spills
 *   only those), the metafiles each slide
 *   may show (LibreOffice converts them), speaker notes (`notes.ts`, read once here so no batch needs the
 *   notes parts), the show's loop flag and the clip parts of the listed slides (`clips.ts` spills and sniffs
 *   them before the batches, which emit `ImageObject.play` and `Slide.audio` with the sniffed kinds).
 * - **Batch**: the slides of `range`, plus each one's transition and timing (`transition.ts`), which
 *   `convertDeck` does not read: only the part's tail after `p:cSld` is parsed for it.
 * - **Rescue** (`input.rescue`, M9 `ladder`): the slides of `range` as their text alone (`rescueDeck`), for
 *   slides whose conversion failed; no geometry, picture or extra is read.
 */
import { getHeapStatistics } from 'node:v8';
import { newId } from '@ordo/domain';
import { emittedShapeFiles, nameShapeFiles } from '@ordo/importers/pptx-geoms.ts';
import { extrasOf, scanDeck } from '@ordo/importers/pptx-scan.ts';
import { convertDeck, rescueDeck } from '@ordo/pptx-scene';
import { openPackage } from '@ordo/pptx-scene/opc.ts';
import { libraryFaces } from './faces.ts';
import { M9_WRITES, PPTX_LIMITS, PPTX_SHEETS, type SceneTaskInput, type SceneTaskOutput } from './shared.ts';

// The scan, the extras and shape-file naming are the import core's (`@ordo/importers`), which the client
// parse shares: re-exported for the hub's tests and tools.
export { CLIP_CANDIDATES, clipParts, scanDeck } from '@ordo/importers/pptx-scan.ts';

export function sceneTask(input: SceneTaskInput): SceneTaskOutput {
  const t0 = performance.now();
  // M9 `ladder`: the text rescue of slides that could not be converted (text bodies only).
  if (input.rescue) {
    const result = rescueDeck(input.parts, { range: input.range, newId });
    return {
      result,
      ms: performance.now() - t0,
      heapMb: getHeapStatistics().used_heap_size / (1024 * 1024),
    };
  }
  const sizes = new Map(input.pictureSizes);
  const kinds = new Map(input.mediaKinds ?? []);
  const result = convertDeck(input.parts, {
    range: input.range,
    pictureSize: (part) => sizes.get(part),
    mediaKind: (part) => kinds.get(part),
    ...(input.fonts?.length ? { fontFace: libraryFaces(input.fonts) } : {}),
    ...(input.libreoffice === false ? { libreoffice: false } : {}),
    extendBackgrounds: input.options.extendBackgrounds ?? true,
    transitionSounds: input.options.transitionSounds ?? false,
    m9Writes: M9_WRITES,
    sheets: PPTX_SHEETS,
    newId,
  });
  const out: SceneTaskOutput = { result, ms: 0, heapMb: 0 };
  nameGeomFiles(out, input.geomBytes ?? PPTX_LIMITS.batchGeomBytes);
  if (input.scan) out.scan = scanDeck(openPackage(input.parts), result.listed);
  else if (result.slides.length) out.extras = extrasOf(openPackage(input.parts), result);
  out.ms = performance.now() - t0;
  out.heapMb = getHeapStatistics().used_heap_size / (1024 * 1024);
  return out;
}

/**
 * The batch's shape files (geometry files and M9 decoration files, `emittedShapeFiles`) named here, in the
 * worker (the import core's `nameShapeFiles`: re-tokenised, checked, serialised and hashed), slide by slide: a
 * slide whose new files would take the batch past `maxBytes` keeps none and is listed in `geomOver` (the job
 * leaves out the objects that name them). `result.geoms` and `result.decors` are emptied: the job reads only
 * the named files, whose bytes are all it holds.
 */
export function nameGeomFiles(out: SceneTaskOutput, maxBytes: number): void {
  const files = emittedShapeFiles(out.result);
  if (!files.length) return;
  const named = nameShapeFiles(out.result.slides, files, maxBytes);
  out.result.geoms = [];
  out.result.decors = [];
  out.geomFiles = named.files;
  if (named.over.length) out.geomOver = named.over;
}

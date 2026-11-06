/**
 * Worker side of the `pptx-scene` pool task (design/27 §2 step 2; M3 item B): one batch of slides through
 * `convertDeck`, on the CPU pool's bounded heap and timeout. Imported by `cpu.worker.ts` only; it must not
 * import the library, the store or anything else of the main thread.
 *
 * Object and slide ids are ULIDs (batches never collide); picture ids are `pptxmedia:<n>` per batch, which
 * the job maps to parts through `result.media` before it remaps them to stored media.
 */
import { getHeapStatistics } from 'node:v8';
import { newId } from '@ordo/domain';
import { convertDeck } from '@ordo/pptx-scene';
import type { SceneTaskInput, SceneTaskOutput } from './shared.ts';

export function sceneTask(input: SceneTaskInput): SceneTaskOutput {
  const t0 = performance.now();
  const sizes = new Map(input.pictureSizes);
  const result = convertDeck(input.parts, {
    range: input.range,
    pictureSize: (part) => sizes.get(part),
    extendBackgrounds: input.options.extendBackgrounds ?? true,
    newId,
  });
  return {
    result,
    ms: performance.now() - t0,
    heapMb: getHeapStatistics().used_heap_size / (1024 * 1024),
  };
}

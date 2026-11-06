/**
 * Worker side of the `pptx-render-copy` pool task (design/27 §5 "Render copy"; M3 item D): build the
 * minimal deck LibreOffice prints with `@ordo/pptx-scene` `buildRenderCopy`, add the spilled media it keeps
 * and write it as a .pptx to `input.out`. Imported by `cpu.worker.ts` only.
 *
 * Replaces the main-thread `pptxForRendering` for the native import's follow-up and for the 'Pictures
 * (LibreOffice)' import option alike.
 */
import type { RenderCopyTaskInput, RenderCopyTaskOutput } from './shared.ts';
import { notYet } from './shared.ts';

export async function renderCopyTask(input: RenderCopyTaskInput): Promise<RenderCopyTaskOutput> {
  void input;
  throw notYet('D', 'the pptx-render-copy task');
}

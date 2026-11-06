/**
 * The native PowerPoint import in the library process (design/27 §2, M3; README.md): registers the pptx
 * jobs and queues them. One instance per process, owned by `ImportService` (`imports.pptx`).
 */
import type { Job } from '@ordo/protocol';
import { loJob, referenceJob } from './fallback.ts';
import { nativeJob } from './nativeJob.ts';
import { enqueuePptx, PPTX_JOBS, type PptxDeps, type PptxImportOptions } from './shared.ts';
import { textRepairJob } from './textRepair.ts';

export class PptxImports {
  constructor(readonly deps: PptxDeps) {
    const { jobs } = deps;
    jobs.register(PPTX_JOBS.native, nativeJob(deps));
    jobs.register(PPTX_JOBS.lo, loJob(deps));
    jobs.register(PPTX_JOBS.reference, referenceJob(deps));
    jobs.register(PPTX_JOBS.textRepair, textRepairJob(deps));
  }

  /** Queue the native import of a stored deck (`POST /import/document` with `renderer=native`). */
  queueNative(hash: string, name: string, options: PptxImportOptions = {}): Job {
    return enqueuePptx(this.deps.jobs, PPTX_JOBS.native, { hash, name, options });
  }

  /**
   * Queue 'Show PowerPoint picture' for a presentation (the route refuses it while it is locked).
   * `showPicture`: the slides switched to the picture (`PptxReferencePayload.showPicture`); absent: all.
   */
  queueReference(presentationId: string, hash: string, by?: string, showPicture?: string[]): Job {
    return enqueuePptx(this.deps.jobs, PPTX_JOBS.reference, {
      presentationId,
      hash,
      ...(by ? { by } : {}),
      ...(showPicture ? { showPicture } : {}),
    });
  }
}

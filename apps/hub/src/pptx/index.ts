/**
 * The native PowerPoint import in the library process (design/27 §2, M3; README.md): registers the pptx
 * jobs and queues them. One instance per process, owned by `ImportService` (`imports.pptx`).
 */
import type { Job } from '@ordo/protocol';
import { loJob, referenceJob } from './fallback.ts';
import { nativeJob } from './nativeJob.ts';
import { enqueuePptx, PPTX_JOBS, type PptxDeps, type PptxImportOptions } from './shared.ts';
import { queueTextRepair, textRepairJob } from './textRepair.ts';

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

  /** Queue 'Show PowerPoint picture' for a presentation (the route refuses it while it is locked). */
  queueReference(presentationId: string, hash: string, by?: string): Job {
    return enqueuePptx(this.deps.jobs, PPTX_JOBS.reference, { presentationId, hash, ...(by ? { by } : {}) });
  }

  /**
   * The one-shot repair of legacy PowerPoint text boxes (design/27 §11): queued when a stored presentation
   * still needs it and no repair is queued or running; undefined otherwise (`textRepair.ts`).
   */
  queueTextRepair(): Job | undefined {
    return queueTextRepair(this.deps);
  }
}

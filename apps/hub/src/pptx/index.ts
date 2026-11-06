/**
 * The native PowerPoint import in the library process (design/27 §2, M3; README.md): registers the pptx
 * jobs and queues them. One instance per process, owned by `ImportService` (`imports.pptx`).
 */
import type { Presentation } from '@ordo/domain';
import type { Job, PptxReimportReq } from '@ordo/protocol';
import { loJob, queueFollowUp, referenceJob } from './fallback.ts';
import { nativeJob, queueStoredClips } from './nativeJob.ts';
import { queueReimport, reimportJob } from './reimport.ts';
import {
  enqueuePptx,
  PPTX_JOBS,
  type PptxDeps,
  type PptxImportOptions,
  type PptxNativePayload,
  type PptxReferencePayload,
} from './shared.ts';
import { queueTextRepair, textRepairJob } from './textRepair.ts';

export class PptxImports {
  constructor(readonly deps: PptxDeps) {
    const { jobs } = deps;
    // Abandoned after repeated crashes: the clips it stored still get their media jobs.
    jobs.register(PPTX_JOBS.native, nativeJob(deps), (payload: PptxNativePayload) =>
      queueStoredClips(deps, payload?.done),
    );
    jobs.register(PPTX_JOBS.lo, loJob(deps));
    jobs.register(PPTX_JOBS.reference, referenceJob(deps));
    jobs.register(PPTX_JOBS.textRepair, textRepairJob(deps));
    jobs.register(PPTX_JOBS.reimport, reimportJob(deps));
  }

  /** Queue the native import of a stored deck (`POST /import/document` with `renderer=native`). */
  queueNative(hash: string, name: string, options: PptxImportOptions = {}): Job {
    return enqueuePptx(this.deps.jobs, PPTX_JOBS.native, { hash, name, options });
  }

  /**
   * Queue 'Show PowerPoint picture' for a presentation (the route refuses it while it is locked).
   * `showPicture`: the slides switched to the picture (`PptxReferencePayload.showPicture`); absent: all.
   *
   * At most one job per presentation waits: a request while one is queued joins it (the slides to switch
   * are merged, absent meaning all), and one asking for what a running job does gets that job. Repeated
   * clicks or a scripted client never stack LibreOffice runs on the heavy queue.
   */
  queueReference(presentationId: string, hash: string, by?: string, showPicture?: string[]): Job {
    const { jobs, lib } = this.deps;
    const active = lib.db
      .prepare(
        `SELECT id, state, payload FROM jobs WHERE kind = ? AND state IN ('queued', 'running')
         AND json_extract(payload, '$.presentationId') = ? AND json_extract(payload, '$.hash') = ?
         ORDER BY created_at, id`,
      )
      .all(PPTX_JOBS.reference, presentationId, hash) as { id: string; state: string; payload: string }[];
    const queued = active.find((r) => r.state === 'queued');
    if (queued) {
      const pl = JSON.parse(queued.payload) as PptxReferencePayload;
      const merged = mergeShown(pl.showPicture, showPicture);
      if (!sameShown(merged, pl.showPicture)) {
        const { showPicture: _old, ...rest } = pl;
        const next: PptxReferencePayload = { ...rest, ...(merged ? { showPicture: merged } : {}) };
        lib.db
          .prepare(`UPDATE jobs SET payload = ? WHERE id = ? AND state = 'queued'`)
          .run(JSON.stringify(next), queued.id);
      }
      return jobs.get(queued.id);
    }
    const running = active.find((r) => r.state === 'running');
    if (running) {
      const pl = JSON.parse(running.payload) as PptxReferencePayload;
      if (sameShown(pl.showPicture, showPicture)) return jobs.get(running.id);
    }
    return enqueuePptx(jobs, PPTX_JOBS.reference, {
      presentationId,
      hash,
      ...(by ? { by } : {}),
      ...(showPicture ? { showPicture } : {}),
    });
  }

  /**
   * After a save from the editor or a restored revision: the LibreOffice follow-up for slides of a native
   * import that are `pending` again while none is queued or running (`queueFollowUp`). Never throws.
   */
  followUp(p: Presentation): Job | undefined {
    try {
      return queueFollowUp(this.deps, p);
    } catch (e) {
      this.deps.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'pptx follow-up not queued');
      return undefined;
    }
  }

  /**
   * The one-shot repair of legacy PowerPoint text boxes (design/27 §11): queued when a stored presentation
   * still needs it and no repair is queued or running; undefined otherwise (`textRepair.ts`).
   */
  queueTextRepair(): Job | undefined {
    return queueTextRepair(this.deps);
  }

  /**
   * Queue 'Re-import from PowerPoint' for a presentation (M4 item F, `reimport.ts`; the route refuses it
   * while the presentation is locked or has no stored deck).
   */
  queueReimport(presentationId: string, hash: string, req: PptxReimportReq, by?: string): Job {
    return queueReimport(this.deps, presentationId, hash, req, by);
  }
}

/** Slides a reference job switches, merged: absent (every slide) wins; ids at most the route's 5,000. */
function mergeShown(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a || !b) return undefined;
  return [...new Set([...a, ...b])].slice(0, 5_000);
}

function sameShown(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return !a && !b;
  const s = new Set(a);
  return s.size === new Set(b).size && b.every((x) => s.has(x));
}

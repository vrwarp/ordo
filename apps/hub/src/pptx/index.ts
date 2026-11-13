/**
 * The native PowerPoint import in the library process (design/27 §2, M3; README.md): registers the pptx
 * jobs and queues them. One instance per process, owned by `ImportService` (`imports.pptx`).
 */
import type { Presentation } from '@ordo/domain';
import type { Job, PptxReimportReq } from '@ordo/protocol';
import { loJob, queueFollowUp, referenceJob, releaseReferencePdf } from './fallback.ts';
import { nativeJob, queueStoredClips } from './nativeJob.ts';
import { importOptionsOf, queueReimport, reimportJob } from './reimport.ts';
import {
  enqueuePptx,
  PPTX_JOBS,
  type PptxDeps,
  type PptxImportOptions,
  type PptxNativePayload,
  type PptxReferencePayload,
  type PptxReimportPayload,
} from './shared.ts';
import { queueTextRepair, textRepairJob } from './textRepair.ts';

export class PptxImports {
  readonly deps: PptxDeps;
  constructor(deps: PptxDeps) {
    this.deps = deps;
    const { jobs } = deps;
    // Abandoned after repeated crashes: the clips it stored still get their media jobs.
    jobs.register(PPTX_JOBS.native, nativeJob(deps), (payload: PptxNativePayload) =>
      queueStoredClips(deps, payload?.done),
    );
    // On a hub without LibreOffice the follow-up re-imports the slides that waited for it (M9).
    jobs.register(
      PPTX_JOBS.lo,
      loJob(deps, {
        reimport: (presentationId, hash, slideIds) =>
          this.queueReimport(presentationId, hash, { slideIds }, 'pptx-lo'),
      }),
    );
    // Abandoned after repeated crashes: its uploaded PDF is released (unless another job still uses it).
    jobs.register(PPTX_JOBS.reference, referenceJob(deps), (payload: PptxReferencePayload) => {
      void releaseReferencePdf(deps, payload?.pdf);
    });
    jobs.register(PPTX_JOBS.textRepair, textRepairJob(deps));
    // Abandoned after repeated crashes: the clips its conversion stored still get their media jobs.
    jobs.register(PPTX_JOBS.reimport, reimportJob(deps), (payload: PptxReimportPayload) =>
      queueStoredClips(deps, payload?.done),
    );
  }

  /** Queue the native import of a stored deck (`POST /import/document` with `renderer=native`). */
  queueNative(hash: string, name: string, options: PptxImportOptions = {}, sceneHash?: string): Job {
    return enqueuePptx(this.deps.jobs, PPTX_JOBS.native, {
      hash,
      name,
      options,
      ...(sceneHash ? { sceneHash } : {}),
    });
  }

  /**
   * Queue 'Show PowerPoint picture' for a presentation (the route refuses it while it is locked).
   * `showPicture`: the slides switched to the picture (`PptxReferencePayload.showPicture`); absent: all.
   * `pdf`: the pictures come from this stored PDF, PowerPoint's own export (M9); absent: LibreOffice draws them.
   *
   * At most one job per presentation and source waits: a request while one is queued joins it (the slides to
   * switch are merged, absent meaning all), and one asking for what a running job does gets that job. Repeated
   * clicks or a scripted client never stack LibreOffice runs on the heavy queue.
   */
  queueReference(
    presentationId: string,
    hash: string,
    by?: string,
    showPicture?: string[],
    pdf?: string,
  ): Job {
    const { jobs, lib } = this.deps;
    const active = lib.db
      .prepare(
        `SELECT id, state, payload FROM jobs WHERE kind = ? AND state IN ('queued', 'running')
         AND json_extract(payload, '$.presentationId') = ? AND json_extract(payload, '$.hash') = ?
         AND coalesce(json_extract(payload, '$.pdf'), '') = ?
         ORDER BY created_at, id`,
      )
      .all(PPTX_JOBS.reference, presentationId, hash, pdf ?? '') as {
      id: string;
      state: string;
      payload: string;
    }[];
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
      ...(pdf ? { pdf } : {}),
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
   * while the presentation is locked or has no stored deck), with the options of its first import when the
   * queue still has that job. The same request while one is queued or running gets that job: repeated
   * clicks never stack conversions.
   */
  queueReimport(presentationId: string, hash: string, req: PptxReimportReq, by?: string): Job {
    const { jobs, lib } = this.deps;
    const active = lib.db
      .prepare(
        `SELECT id, payload FROM jobs WHERE kind = ? AND state IN ('queued', 'running')
         AND json_extract(payload, '$.presentationId') = ? AND json_extract(payload, '$.hash') = ?
         ORDER BY created_at, id`,
      )
      .all(PPTX_JOBS.reimport, presentationId, hash) as { id: string; payload: string }[];
    const ask = requestKey(req);
    for (const r of active) {
      try {
        if (requestKey(JSON.parse(r.payload) as PptxReimportPayload) === ask) return jobs.get(r.id);
      } catch {
        /* a payload that is not JSON is not this request */
      }
    }
    const options = importOptionsOf(this.deps, presentationId, hash);
    return queueReimport(this.deps, presentationId, hash, req, by, options);
  }
}

/** A re-import request compared by what it asks (the order of the ids does not matter). */
function requestKey(r: Pick<PptxReimportReq, 'slideIds' | 'reset' | 'keep'>): string {
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(String))].sort() : null);
  return JSON.stringify([ids(r.slideIds), ids(r.reset), ids(r.keep)]);
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

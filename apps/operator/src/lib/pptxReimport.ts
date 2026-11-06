/**
 * 'Re-import from PowerPoint' from the operator (design/27 §11 "Round trip and migration"; M4 item F): the
 * plan the dialog shows, the request, and the job's result. The hub's answers are read defensively, as every
 * job result is (`pptxImport.ts`): another hub version shows less, never breaks the dialog.
 */
import { api } from '@ordo/client';
import type {
  Job,
  PptxReimportAction,
  PptxReimportKind,
  PptxReimportPlan,
  PptxReimportPlanSlide,
  PptxReimportReq,
  PptxReimportResult,
} from '@ordo/protocol';

/** The job kind (its revisions are saved by it too). */
export const PPTX_REIMPORT_JOB = 'pptx-reimport';

/** What a re-import would do (nothing is written). */
export async function reimportPlan(presentationId: string): Promise<PptxReimportPlan | undefined> {
  return readReimportPlan(await api<unknown>(`/presentations/${presentationId}/pptx-reimport`));
}

/** Queue the re-import; the job to follow (`original.ts` `followJob`). */
export function requestReimport(presentationId: string, req: PptxReimportReq = {}): Promise<Job> {
  return api<Job>(`/presentations/${presentationId}/pptx-reimport`, { method: 'POST', json: req });
}

const KINDS: readonly PptxReimportKind[] = ['native', 'page', 'made-editable', 'other'];
const ACTIONS: readonly PptxReimportAction[] = ['regenerate', 'keep-edited', 'replace', 'keep'];
/** Slides a plan lists at most (as many as the route accepts slide ids). */
const MAX_PLAN = 5_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100_000, Math.round(v))) : 0;
const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined);

/** A plan, or undefined when the answer is not one; slides that are not well formed are left out. */
export function readReimportPlan(v: unknown): PptxReimportPlan | undefined {
  if (!isObj(v)) return undefined;
  const presentationId = id(v.presentationId);
  const fileId = id(v.fileId);
  if (!presentationId || !fileId || !Array.isArray(v.slides)) return undefined;
  const slides: PptxReimportPlanSlide[] = [];
  for (const s of v.slides.slice(0, MAX_PLAN)) {
    if (!isObj(s)) continue;
    const slideId = id(s.slideId);
    const kind = KINDS.find((k) => k === s.kind);
    const action = ACTIONS.find((a) => a === s.action);
    if (!slideId || !kind || !action) continue;
    slides.push({ slideId, number: count(s.number), kind, action, userObjects: count(s.userObjects) });
  }
  return { presentationId, fileId, slides };
}

/** The job's numbers, or undefined when the result is not one. */
export function readReimportResult(v: unknown): PptxReimportResult | undefined {
  if (!isObj(v)) return undefined;
  const presentationId = id(v.presentationId);
  if (!presentationId) return undefined;
  const rev = typeof v.rev === 'number' && Number.isInteger(v.rev) && v.rev > 0 ? v.rev : undefined;
  return {
    presentationId,
    ...(rev ? { rev } : {}),
    regenerated: count(v.regenerated),
    keptEdited: count(v.keptEdited),
    replaced: count(v.replaced),
    userObjects: count(v.userObjects),
  };
}

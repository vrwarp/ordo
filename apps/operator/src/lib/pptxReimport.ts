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

/** What the 'Re-import from PowerPoint' dialog says a plan will do. */
export type PlanSummary = {
  /** Native slides as imported (or reset): rebuilt from the deck. */
  rebuild: number;
  /** Native slides edited in ordo: kept as they are. */
  keptEdited: number;
  /** Legacy picture pages: become editable slides. */
  pages: number;
  /** Slides made editable by an older build: listed, each with 'Keep as it is'. */
  madeEditable: PptxReimportPlanSlide[];
  /** Any other slide (typed in ordo, from another file): kept as it is. */
  other: number;
  /** Objects added in ordo on the slides that change, kept on top. */
  userObjects: number;
};

/** A plan in the dialog's terms. */
export function planSummary(plan: PptxReimportPlan): PlanSummary {
  const out: PlanSummary = {
    rebuild: 0,
    keptEdited: 0,
    pages: 0,
    madeEditable: [],
    other: 0,
    userObjects: 0,
  };
  for (const s of plan.slides) {
    if (s.kind === 'native' && s.action === 'regenerate') out.rebuild++;
    else if (s.kind === 'native') out.keptEdited++;
    else if (s.kind === 'page') out.pages++;
    else if (s.kind === 'made-editable') out.madeEditable.push(s);
    else out.other++;
    if (s.action === 'regenerate' || s.action === 'replace') out.userObjects += s.userObjects;
  }
  return out;
}

/** What asked for a re-import: the Presentation panel, 'Reset slide' or 'Make editable'. */
export type ReimportWhat = 'reimport' | 'reset' | 'make-editable';

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** What the editor says when a re-import job is done (its result read defensively). */
export function reimportMessage(
  what: ReimportWhat,
  r: PptxReimportResult | undefined,
): { text: string; tone: 'ok' | 'warn' } {
  if (!r) return { text: 'The re-import is done. Reload the presentation to see it.', tone: 'warn' };
  if (what === 'reset')
    return r.regenerated
      ? { text: 'The slide is as the PowerPoint file has it again.', tone: 'ok' }
      : { text: 'Nothing to reset: the slide is as the PowerPoint file has it.', tone: 'ok' };
  if (what === 'make-editable')
    return r.replaced
      ? {
          text: 'The slide was rebuilt from the PowerPoint file: its text, pictures and shapes are editable.',
          tone: 'ok',
        }
      : {
          text: 'ordo could not rebuild this slide from the PowerPoint file: it stays a picture.',
          tone: 'warn',
        };
  if (!r.rev) return { text: 'Nothing changed: every slide is as the PowerPoint file has it.', tone: 'ok' };
  const parts = [
    ...(r.regenerated ? [`${n(r.regenerated, 'slide')} rebuilt`] : []),
    ...(r.replaced ? [`${n(r.replaced, 'picture slide')} made editable`] : []),
    ...(r.keptEdited
      ? [`${n(r.keptEdited, 'edited slide')} kept as ${r.keptEdited === 1 ? 'it is' : 'they are'}`]
      : []),
  ];
  return { text: `Re-imported from PowerPoint: ${parts.join(', ') || 'nothing changed'}.`, tone: 'ok' };
}

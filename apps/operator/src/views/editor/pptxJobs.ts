/**
 * The editor's side of 'Re-import from PowerPoint' (design/27 §11 "Round trip and migration", §15 M4; M4
 * item F): the Presentation panel's re-import, the PowerPoint card's 'Reset slide from PowerPoint' and the
 * Slide panel's 'Make editable' on a legacy page all run the hub's `pptx-reimport` job. Unsaved edits are
 * saved first (the job writes a new revision), the job is followed (`original.ts` `followJob`), and its
 * revision is taken over like a PowerPoint follow-up's (`adoptJobSaves`: 'pptx-reimport' is one of
 * `PPTX_JOB_SAVERS`), so edits made meanwhile stay, slide by slide. One re-import per presentation at a time.
 */
import { api } from '@ordo/client';
import type { Presentation, Slide } from '@ordo/domain';
import type { Job, PptxReimportReq } from '@ordo/protocol';
import { create } from 'zustand';
import {
  type ReimportWhat,
  readReimportResult,
  reimportMessage,
  requestReimport,
} from '../../lib/pptxReimport.ts';
import { upsertLocal } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { adoptJobSaves, replaceBase, save, useEditor } from './editorStore.ts';
import { followJob } from './original.ts';

/** A re-import job as far as the editor followed it. */
export type ReimportRun = {
  id: string;
  what: ReimportWhat;
  /** The slide a 'Reset slide' or 'Make editable' is for. */
  slideId?: string;
  state: Job['state'];
  progress: number;
  error?: string;
};

/** The re-import each presentation asked for in this visit. */
export const useReimport = create<{ runs: Record<string, ReimportRun> }>(() => ({ runs: {} }));

/** A re-import still running (or waiting) for a presentation. */
export function reimportRunning(r: ReimportRun | undefined): boolean {
  return !!r && (r.state === 'queued' || r.state === 'running');
}

function track(
  pid: string,
  j: Pick<Job, 'id' | 'state' | 'progress' | 'error'>,
  what: ReimportWhat,
  slideId?: string,
) {
  useReimport.setState((s) => ({
    runs: {
      ...s.runs,
      [pid]: {
        id: j.id,
        what,
        ...(slideId ? { slideId } : {}),
        state: j.state,
        progress: j.progress,
        ...(j.error ? { error: j.error } : {}),
      },
    },
  }));
}

/**
 * Take the job's revision into the open editor: as a PowerPoint job's when only such jobs saved since its
 * base; else, when nothing is unsaved, the latest version as it is (with unsaved edits, the editor's banner
 * says a newer version exists and the next save meets the conflict dialog).
 */
async function takeOver(pid: string): Promise<void> {
  if (useEditor.getState().id !== pid) {
    upsertLocal('presentations', await api<Presentation>(`/presentations/${pid}`));
    return;
  }
  if ((await adoptJobSaves()) !== 'other') return;
  const latest = await api<Presentation>(`/presentations/${pid}`);
  upsertLocal('presentations', latest);
  const s = useEditor.getState();
  if (s.id === pid && !s.dirty) replaceBase(latest);
}

/** Follow a re-import job the hub queued (the request's answer, or 'Make editable''s), then take it over. */
export function followReimport(
  pid: string,
  job: Pick<Job, 'id' | 'state' | 'progress' | 'error'>,
  what: ReimportWhat,
  slideId?: string,
): Promise<Job | undefined> {
  track(pid, job, what, slideId);
  return followJob(job.id, {
    getJob: (id) => api<Job>(`/jobs/${id}`),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    seen: (j) => track(pid, j, what, slideId),
    ended: async (j) => {
      if (j.state === 'failed') {
        toast(`Could not re-import from PowerPoint: ${j.error ?? 'unknown error'}`, 'error', 10_000);
        return;
      }
      const r = readReimportResult(j.result);
      try {
        if (r?.rev) await takeOver(pid);
      } catch (e) {
        toast(`The re-import is done; reload the presentation to see it (${errorText(e)}).`, 'warn');
        return;
      }
      const m = reimportMessage(what, r);
      toast(m.text, m.tone, 8000);
    },
  });
}

/**
 * Ask the hub for a re-import of the open presentation and follow it: unsaved edits are saved first.
 * Resolves once the job is queued (true) or refused (false).
 */
export async function startReimport(
  p: Pick<Presentation, 'id'>,
  req: PptxReimportReq,
  what: ReimportWhat,
  slideId?: string,
): Promise<boolean> {
  if (reimportRunning(useReimport.getState().runs[p.id])) {
    toast('A re-import of this presentation is already running.', 'warn');
    return false;
  }
  if (useEditor.getState().dirty && !(await save())) return false;
  let job: Job;
  try {
    job = await requestReimport(p.id, req);
  } catch (e) {
    toast(`Could not re-import from PowerPoint: ${errorText(e)}`, 'error');
    return false;
  }
  void followReimport(p.id, job, what, slideId);
  return true;
}

/** Whether a hub answer is a queued job (a rerouted 'Make editable') rather than a presentation. */
export function isJob(v: unknown): v is Job {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as Job).id === 'string' &&
    typeof (v as Job).kind === 'string' &&
    typeof (v as Job).state === 'string'
  );
}

/**
 * Whether 'Make editable' on this slide rebuilds it from the PowerPoint file (the hub reroutes it to the
 * re-import while the file is stored): a legacy page of a PowerPoint import that is not a native slide.
 */
export function rebuildsFromPptx(
  p: Pick<Presentation, 'source'>,
  slide: Pick<Slide, 'imported' | 'pptx'>,
): boolean {
  const fileId = p.source?.kind === 'pptx' ? p.source.fileId : undefined;
  return !!fileId && !!slide.imported && !slide.pptx && slide.imported.fileId === fileId;
}

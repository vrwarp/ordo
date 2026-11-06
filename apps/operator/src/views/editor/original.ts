/**
 * The editor's 'Show original' (design/27 §5 "Operator fallback", §11; M3 item H): the slide canvas shows
 * the PowerPoint picture of the slide (`Slide.pptx.refMediaId`, drawn by LibreOffice) over the rebuilt
 * objects, so a volunteer can compare the two. It is a view of the editor, per presentation; it changes
 * nothing stored and nothing the screens show.
 *
 * When a slide has no picture yet, turning it on asks the hub for them (`pptx-reference`, one LibreOffice
 * run for every slide, hidden ones too; `showPicture: []` so no slide switches to its picture) and follows
 * the job: when it is done the editor takes the job's revision over (`adoptJobSaves`, unsaved edits kept). When
 * someone else saved meanwhile, only the pictures go into the draft (`withReferences`) and the next save
 * meets the usual conflict dialog.
 */
import { api } from '@ordo/client';
import type { Presentation, Slide } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { create } from 'zustand';
import { originalMediaId, withReferences } from '../../lib/pptxImport.ts';
import { upsertLocal } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { adoptJobSaves, replaceBase, save, useEditor } from './editorStore.ts';

/** The reference job of a presentation, as far as the editor followed it. */
export type ReferenceJob = {
  id: string;
  state: Job['state'];
  progress: number;
  error?: string;
};

type OriginalState = {
  /** Presentations whose editor shows the originals. */
  on: Record<string, boolean>;
  /** The reference job each presentation asked for in this visit. */
  jobs: Record<string, ReferenceJob>;
};

export const useOriginal = create<OriginalState>(() => ({ on: {}, jobs: {} }));

export function setShowOriginal(presentationId: string, on: boolean): void {
  useOriginal.setState((s) => ({ on: { ...s.on, [presentationId]: on } }));
}

/** The picture the canvas shows over this slide of the open presentation, if any. */
export function useOriginalOver(slide: Pick<Slide, 'pptx'>): string | undefined {
  const pid = useEditor((s) => s.id);
  const on = useOriginal((s) => (pid ? !!s.on[pid] : false));
  return on ? originalMediaId(slide) : undefined;
}

/** A reference job still drawing for this presentation. */
export function referenceRunning(j: ReferenceJob | undefined): boolean {
  return !!j && (j.state === 'queued' || j.state === 'running');
}

/** What following a job needs: replaced in tests. */
export type FollowDeps = {
  getJob(id: string): Promise<Job>;
  wait(ms: number): Promise<void>;
  /** The job ended (done or failed). */
  ended(job: Job): void | Promise<void>;
  /** Every state seen while it runs. */
  seen?(job: Job): void;
  /** Give up after this long (default two hours: it can wait behind transcodes on the heavy queue). */
  maxMs?: number;
  now?(): number;
};

/**
 * Poll a hub job until it ends: every 1.5 s for two minutes, every 5 s after. A request that fails is
 * retried; a job that outlives `maxMs` is left alone (the presentation updates through the library anyway).
 */
export async function followJob(id: string, d: FollowDeps): Promise<Job | undefined> {
  const now = d.now ?? Date.now;
  const t0 = now();
  const maxMs = d.maxMs ?? 2 * 3600_000;
  for (;;) {
    let j: Job | undefined;
    try {
      j = await d.getJob(id);
    } catch {
      j = undefined;
    }
    if (j) {
      d.seen?.(j);
      if (j.state === 'done' || j.state === 'failed') {
        await d.ended(j);
        return j;
      }
    }
    const t = now() - t0;
    if (t > maxMs) return undefined;
    await d.wait(t < 120_000 ? 1500 : 5000);
  }
}

function track(pid: string, j: Pick<Job, 'id' | 'state' | 'progress' | 'error'>): void {
  useOriginal.setState((s) => ({
    jobs: {
      ...s.jobs,
      [pid]: { id: j.id, state: j.state, progress: j.progress, ...(j.error ? { error: j.error } : {}) },
    },
  }));
}

/**
 * Take the pictures the job stored into the open editor: its revision when only PowerPoint jobs saved since
 * the editor's base (`adoptJobSaves`); else, with unsaved edits, only the pictures, into the draft, which
 * keeps its revision (its next save meets the conflict dialog).
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
  if (s.id !== pid || !s.draft) return;
  // Nothing unsaved: the latest version as it is. Unsaved edits: they keep their revision and get the pictures.
  if (!s.dirty) replaceBase(latest);
  else useEditor.setState({ draft: withReferences(s.draft, latest) });
}

/**
 * Turn 'Show original' on for a presentation whose slides have no PowerPoint picture yet: save unsaved
 * edits first (the job saves a new revision), then ask the hub for the pictures and follow the job.
 * `showPicture`: the slides the job also sets to show their picture on the screens (the PowerPoint card's
 * 'Show the PowerPoint picture on the screens', M4 item F); none by default.
 * Resolves once the request is queued (true) or refused (false).
 */
export async function requestOriginals(
  p: Pick<Presentation, 'id'>,
  showPicture: string[] = [],
): Promise<boolean> {
  if (referenceRunning(useOriginal.getState().jobs[p.id])) return true;
  if (useEditor.getState().dirty && !(await save())) return false;
  let job: Job;
  try {
    job = await api<Job>(`/presentations/${p.id}/pptx-reference`, {
      method: 'POST',
      json: { showPicture },
    });
  } catch (e) {
    toast(`Could not ask for the PowerPoint pictures: ${errorText(e)}`, 'error');
    return false;
  }
  track(p.id, job);
  setShowOriginal(p.id, true);
  void followJob(job.id, {
    getJob: (id) => api<Job>(`/jobs/${id}`),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    seen: (j) => track(p.id, j),
    ended: async (j) => {
      if (j.state === 'failed') {
        toast(`LibreOffice could not draw the PowerPoint pictures: ${j.error ?? 'unknown error'}`, 'error');
        return;
      }
      try {
        await takeOver(p.id);
        toast('The PowerPoint pictures are ready.', 'ok');
      } catch (e) {
        toast(
          `The PowerPoint pictures are ready; reload the presentation to see them (${errorText(e)}).`,
          'warn',
        );
      }
    },
  });
  return true;
}

import { api, DEMO } from '@ordo/client';
import type { Job } from '@ordo/protocol';
import { useEffect, useState } from 'react';
import { loadLibrary, useLibrary } from '../state/library.ts';

/** Follow a hub job: library.delta 'job' changes when the hub sends them, polling otherwise. */
export function useJob(id: string | undefined): Job | undefined {
  const fromDelta = useLibrary((s) => (id ? s.data.jobs[id] : undefined));
  const [polled, setPolled] = useState<Job>();
  useEffect(() => {
    if (!id) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api<Job>(`/jobs/${id}`);
        if (!alive) return;
        setPolled(j);
        if (j.state === 'done' || j.state === 'failed') {
          // The GitHub Pages demo has no hub socket to announce what the job created: fetch the library.
          if (DEMO && j.state === 'done') loadLibrary();
          return;
        }
      } catch {
        /* retry */
      }
      if (alive) timer = setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);
  if (!fromDelta) return polled;
  if (!polled) return fromDelta;
  return fromDelta.updatedAt >= polled.updatedAt ? fromDelta : polled;
}

export function jobResultPresentationId(j: Job | undefined): string | undefined {
  const r = j?.result as { presentationId?: string; presentationIds?: string[] } | undefined;
  return r?.presentationId ?? r?.presentationIds?.[0];
}

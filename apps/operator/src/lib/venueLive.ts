import { api } from '@ordo/client';
import type { LiveState } from '@ordo/domain';
import { type LiveRes, type LiveSummaryRes, ROUTES } from '@ordo/protocol';
import { create } from 'zustand';

/**
 * What the venue is running, as an edit-profile device sees it (design/15 "iPad editing"). Its core joins
 * the hub as an editor, and the hub sends live state only to operators and outputs, so an iPad (signed in
 * with the edit or the operate PIN) polls `GET /live/summary` instead: enough for the "Live now" chip and to
 * lock the live playlist's presentations in the editor before the hub has to refuse a save with 423. An
 * older hub without the summary answers 404: an operate session then falls back to `GET /live`. Never
 * started on the venue PC (the full profile reads the core's live state).
 */
export type VenueLive = {
  playlistId: string;
  playlistName: string;
  cueLabel?: string;
  presentationIds: string[];
};

export const useVenueLive = create<{ live?: VenueLive; seq: number }>(() => ({ seq: -1 }));

/** The hub's summary as the store keeps it (undefined when idle). */
export function fromSummary(r: LiveSummaryRes): VenueLive | undefined {
  if (r.mode !== 'live' || !r.playlistId) return undefined;
  return {
    playlistId: r.playlistId,
    playlistName: r.playlistName ?? '',
    cueLabel: r.liveLabel,
    presentationIds: [...r.lockedPresentationIds].sort(),
  };
}

/** The summary of a hub live state (undefined when idle); the fallback for a hub without /live/summary. */
export function summarize(state: LiveState): VenueLive | undefined {
  if (state.mode !== 'live' || !state.resolved) return undefined;
  const pl = state.resolved.playlist;
  const cue = state.live !== undefined ? state.cues?.[state.live] : undefined;
  return {
    playlistId: pl.id,
    playlistName: pl.name,
    cueLabel: cue?.label,
    presentationIds: Object.keys(state.resolved.presentations).sort(),
  };
}

function same(a: VenueLive | undefined, b: VenueLive | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export const VENUE_POLL_MS = 8000;

/** Read the summary, or the full state from a hub that predates it (operate sessions only). */
export async function fetchVenueLive(
  role: 'operate' | 'edit',
  get: <T>(path: string) => Promise<T> = api,
): Promise<{ seq: number; live: VenueLive | undefined }> {
  try {
    const r = await get<LiveSummaryRes>(ROUTES.liveSummary);
    return { seq: r.seq, live: fromSummary(r) };
  } catch (e) {
    if (role !== 'operate' || (e as { status?: number }).status !== 404) throw e;
    const r = await get<LiveRes>(ROUTES.live);
    return { seq: r.seq, live: summarize(r.state) };
  }
}

/** Poll the venue's live summary while the page is visible; returns the stop function. */
export function watchVenueLive(role: 'operate' | 'edit', intervalMs = VENUE_POLL_MS): () => void {
  let stopped = false;
  let busy = false;
  const poll = async () => {
    if (stopped || busy || (typeof document !== 'undefined' && document.hidden)) return;
    busy = true;
    try {
      const { seq, live } = await fetchVenueLive(role);
      if (stopped || seq === useVenueLive.getState().seq) return;
      if (same(live, useVenueLive.getState().live)) useVenueLive.setState({ seq });
      else useVenueLive.setState({ seq, live });
    } catch {
      /* hub unreachable or signed out: keep the last known */
    } finally {
      busy = false;
    }
  };
  void poll();
  const t = setInterval(() => void poll(), intervalMs);
  // Back from a suspension: look at once rather than at the next tick.
  const onVisible = () => {
    if (!document.hidden) void poll();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    stopped = true;
    clearInterval(t);
    document.removeEventListener('visibilitychange', onVisible);
    useVenueLive.setState({ live: undefined, seq: -1 });
  };
}

import { api } from '@ordo/client';
import type { LiveState } from '@ordo/domain';
import { type LiveRes, ROUTES } from '@ordo/protocol';
import { create } from 'zustand';

/**
 * What the venue is running, as an edit-profile device sees it (design/15 "iPad editing"). Its core joins
 * the hub as an editor, and the hub sends live state only to operators and outputs, so an iPad signed in
 * with the operate PIN polls `GET /live` instead: enough for the "Live now" chip and to lock the live
 * playlist's presentations in the editor before the hub has to refuse a save with 423. Never started on
 * the venue PC (the full profile reads the core's live state).
 */
export type VenueLive = {
  playlistId: string;
  playlistName: string;
  cueLabel?: string;
  presentationIds: string[];
};

export const useVenueLive = create<{ live?: VenueLive; seq: number }>(() => ({ seq: -1 }));

/** The summary of a hub live state (undefined when idle). */
export function summarize(state: LiveState): VenueLive | undefined {
  if (state.mode !== 'live' || !state.resolved) return undefined;
  const pl = state.resolved.playlist;
  const cue = state.live !== undefined ? state.cues?.[state.live] : undefined;
  return {
    playlistId: pl.id,
    playlistName: pl.name,
    cueLabel: cue?.label,
    presentationIds: pl.items.flatMap((it) => (it.kind === 'presentation' ? [it.presentationId] : [])),
  };
}

function same(a: VenueLive | undefined, b: VenueLive | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export const VENUE_POLL_MS = 8000;

/** Poll the hub's live state while the page is visible; returns the stop function. */
export function watchVenueLive(intervalMs = VENUE_POLL_MS): () => void {
  let stopped = false;
  let busy = false;
  const poll = async () => {
    if (stopped || busy || (typeof document !== 'undefined' && document.hidden)) return;
    busy = true;
    try {
      const r = await api<LiveRes>(ROUTES.live);
      if (stopped || r.seq === useVenueLive.getState().seq) return;
      const live = summarize(r.state);
      if (same(live, useVenueLive.getState().live)) useVenueLive.setState({ seq: r.seq });
      else useVenueLive.setState({ seq: r.seq, live });
    } catch {
      /* hub unreachable or not an operate session: keep the last known */
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

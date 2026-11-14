import { api } from '@ordo/client';
import type { LiveState } from '@ordo/domain';
import { type LiveRes, type LiveSummaryRes, ROUTES } from '@ordo/protocol';
import { create } from 'zustand';
import { refreshSession } from '../state/session.ts';
import { currentLayout } from './layout.ts';

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

/**
 * Where the summary stands: 'unknown' until the first answer, 'ok' after one, 'failing' after two polls in a
 * row failed (the hub unreachable or the session gone). The compact layout's Live now strip reads it
 * (lib/liveStrip.ts); the iPad's chip reads `live` only.
 */
export type VenueLiveStatus = 'unknown' | 'ok' | 'failing';

export const useVenueLive = create<{ live?: VenueLive; seq: number; status: VenueLiveStatus }>(() => ({
  seq: -1,
  status: 'unknown',
}));

/** Polls in a row that must fail before the status reads 'failing'. */
export const VENUE_FAILS = 2;

/** The running watch's poll, for pollVenueLiveNow (undefined while none runs). */
let pollNow: (() => void) | undefined;

/**
 * Poll the summary at once if a watch runs (the compact layout calls it on `pageshow`, a restored page
 * included, and on `online`, design/28 §3.11; the iPad keeps its interval and visibility poll).
 */
export function pollVenueLiveNow(): void {
  pollNow?.();
}

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

/**
 * Poll the venue's live summary while the page is visible; returns the stop function. On the compact layout a
 * 401 means the hub is there but refused the session (a PIN change, an expiry): `onRefused` asks the hub who
 * this is at once (refreshSession, which brings up the sign-in) instead of counting toward 'failing', so the
 * Live now strip never says "can't reach ordo" for the 10 to 15 s before the socket's refusal (review of P0).
 * The regular layout (the iPad's chip) counts it as before.
 */
export function watchVenueLive(
  role: 'operate' | 'edit',
  intervalMs = VENUE_POLL_MS,
  opts: { onRefused?: () => void } = {},
): () => void {
  const onRefused =
    opts.onRefused ?? (currentLayout() === 'compact' ? () => void refreshSession() : undefined);
  let stopped = false;
  let busy = false;
  let fails = 0;
  const poll = async () => {
    if (stopped || busy || (typeof document !== 'undefined' && document.hidden)) return;
    busy = true;
    try {
      const { seq, live } = await fetchVenueLive(role);
      if (stopped) return;
      fails = 0;
      const st = useVenueLive.getState();
      if (seq === st.seq) {
        if (st.status !== 'ok') useVenueLive.setState({ status: 'ok' });
        return;
      }
      if (same(live, st.live)) useVenueLive.setState({ seq, status: 'ok' });
      else useVenueLive.setState({ seq, live, status: 'ok' });
    } catch (e) {
      if (stopped) return;
      if (onRefused && (e as { status?: number }).status === 401) {
        onRefused();
        return;
      }
      // Hub unreachable: keep the last known, and say so after the second failure in a row.
      fails++;
      if (fails >= VENUE_FAILS && useVenueLive.getState().status !== 'failing')
        useVenueLive.setState({ status: 'failing' });
    } finally {
      busy = false;
    }
  };
  pollNow = () => void poll();
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
    pollNow = undefined;
    useVenueLive.setState({ live: undefined, seq: -1, status: 'unknown' });
  };
}

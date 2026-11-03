import type { LiveState } from '@ordo/domain';
import { initialState } from '@ordo/live-state';
import type { OutputHealthEntry } from '@ordo/protocol';
import { create } from 'zustand';
import type { Authority, Reconcile } from '../lib/liveCore.ts';

export type LiveStore = {
  state: LiveState;
  authority: Authority;
  reconcile: Reconcile;
  hubConnected: boolean;
  /** Ever connected since load (distinguishes "connecting" from "lost"). */
  everConnected: boolean;
  pending: number;
  health: Record<string, OutputHealthEntry>;
  /** Clear-all confirm pending until this time (ms). */
  clearAllUntil?: number;
  ownCache: { ready: number; total: number; failed: number; manifestId?: string };
  conflict?: { hubPlaylist?: string; localPlaylist?: string };
  /** Why the hub refused the last goLive, shown in a dialog. */
  goLiveError?: string;
  /** Wall-clock offset/rtt for diagnostics. */
  clock: { offset: number; rtt: number };
};

export const useLive = create<LiveStore>(() => ({
  state: initialState(),
  authority: 'hub',
  reconcile: null,
  hubConnected: false,
  everConnected: false,
  pending: 0,
  health: {},
  ownCache: { ready: 0, total: 0, failed: 0 },
  clock: { offset: 0, rtt: 0 },
}));

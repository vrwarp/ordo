import type { LiveState } from '@ordo/domain';
import { initialState } from '@ordo/live-state';
import type { BudgetRow, SupervisedStats } from '@ordo/client';
import type { OutputHealthEntry } from '@ordo/protocol';
import type { CoreStats } from '../core/protocol.ts';
import { create } from 'zustand';
import type { CacheIntegrity } from '../lib/health.ts';
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
  /** Result of the last cache integrity check after Launch outputs (prd/08). */
  cacheCheck?: { at: number; message: string | null; rows: CacheIntegrity[] };
  // ---- isolation (design/25) ----
  /** The core worker is restarting or has missed heartbeats: the UI shows "recovering". */
  recovering: boolean;
  /** The supervisor spent the core's restart budget. */
  coreGaveUp: boolean;
  /** Supervisor stats of the operator's own workers (core, thumbnails). */
  workers: SupervisedStats[];
  /** Budgets counted in the core worker and on the main thread. */
  coreBudgets: BudgetRow[];
  mainBudgets: BudgetRow[];
  /** The core's own stats: main-thread stall as it sees it, bus endpoints. */
  core?: CoreStats;
  /** Actions posted to the core and not yet acknowledged. */
  unacknowledged: number;
  supervisionKey?: string;
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
  recovering: false,
  coreGaveUp: false,
  workers: [],
  coreBudgets: [],
  mainBudgets: [],
  unacknowledged: 0,
}));

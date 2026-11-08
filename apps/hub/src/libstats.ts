/**
 * What hub health reports about the library (design/27 §3.4): the size of a full library snapshot, which
 * every operator downloads and keeps, and which grows with every imported deck. The library process
 * measures it; in the two-process hub the supervisor relays it to the live process, which serves
 * `GET /health` (`librarySnapshotBytes`).
 */
import { formatBytes, SIZE_BUDGETS } from '@ordo/domain';
import type { Logger } from 'pino';
import type { Library } from './library.ts';

export type LibraryStats = {
  /** Bytes of `GET /library/snapshot` in full. */
  snapshotBytes: number;
  presentations: number;
  /** The library sequence it was measured at, and when. */
  seq: number;
  at: number;
};

/**
 * Library stats measured from the stored JSON (`Library.snapshotStats`, no entity parsed), again only when
 * the library changed and at most once per `minIntervalMs`. Logs once when the snapshot passes
 * `SIZE_BUDGETS.librarySnapshotWarn`, where summary-only snapshots become worth building.
 */
export class LibraryStatsCache {
  private last?: LibraryStats;
  private warned = false;

  constructor(
    private lib: Library,
    private log: Logger,
    private opts: { minIntervalMs?: number; now?: () => number } = {},
  ) {}

  get(): LibraryStats {
    const now = this.opts.now?.() ?? Date.now();
    const last = this.last;
    if (last && now - last.at < (this.opts.minIntervalMs ?? 5000)) return last;
    const seq = this.lib.seq();
    if (last && last.seq === seq) return last;
    const s = this.lib.snapshotStats();
    this.last = { ...s, seq, at: now };
    if (!this.warned && s.snapshotBytes > SIZE_BUDGETS.librarySnapshotWarn) {
      this.warned = true;
      this.log.warn(
        { snapshotBytes: s.snapshotBytes, presentations: s.presentations },
        `the library snapshot is ${formatBytes(s.snapshotBytes)}: every operator loads all of it; archive or delete old presentations`,
      );
    }
    return this.last;
  }
}

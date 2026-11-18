/**
 * The hub disk's free-space floor (design/29 §1.3 "Free-space floor", A25, W44; design/28 P2 reuses it): while the
 * data volume has less free space than the floor, every route that stores a user's file answers 507 and
 * `GET /health` says how much room is left. Saving a presentation or a playlist, settings, deleting, GO and
 * everything on the live process go on: only what adds files to the folder is paused.
 *
 * The floor is 5 % of the volume, never less than 5 GiB and never more than 25 GiB (owner question OQ-PS1: design
 * 29's "the larger of 5 GB and 5 %" would refuse every upload under 200 GB free on a 4 TB NAS volume).
 * `ORDO_MIN_FREE_GB` replaces it (`HubConfig.minFreeBytes`); 0 turns it off. It fails open: a volume that does
 * not answer is one warning and no refusal, because refusing uploads over a failed measurement is worse than the
 * risk it measures. Read from the library process only; the live process never calls it.
 */
import { statfs } from 'node:fs/promises';
import { HttpError } from './errors.ts';

export const GIB = 1024 ** 3;
/** The least and the most the computed floor is. */
export const FLOOR_MIN_BYTES = 5 * GIB;
export const FLOOR_MAX_BYTES = 25 * GIB;
/** The share of the volume the computed floor is, between the two bounds. */
export const FLOOR_SHARE = 0.05;
/** The longest a measurement is reused. */
export const STATFS_CACHE_MS = 2000;
/** How often the hub measures the volume on its own (health shows it). */
export const DISK_MEASURE_MS = 30_000;

/** What `fs.promises.statfs` answers, as far as the floor reads it. */
export type StatFsResult = { bavail: number | bigint; bsize: number | bigint; blocks: number | bigint };
export type StatFsFn = (dir: string) => Promise<StatFsResult>;

export type DiskState = {
  known: boolean;
  freeBytes?: number;
  totalBytes?: number;
  floorBytes?: number;
  /** Free space is below the floor (never true while the floor is off or the volume unknown). */
  low: boolean;
};

/** The computed floor of a volume of `totalBytes`: 5 % of it, from 5 GiB to 25 GiB. */
export function computedFloor(totalBytes: number): number {
  const share = Math.floor(totalBytes * FLOOR_SHARE);
  return Math.min(FLOOR_MAX_BYTES, Math.max(FLOOR_MIN_BYTES, share));
}

/** "3.2 GB": gigabytes with one decimal, rounded down (never more room than there is). */
export function formatGb(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return `${(Math.floor((n / GIB) * 10) / 10).toFixed(1)} GB`;
}

/**
 * W44 (design/29 §3, critical, blocks uploads): the line Setup and the top bar show, and the answer of every
 * refused upload. Owner words; the free space in GB with one decimal.
 */
export function diskMessage(freeBytes: number): string {
  return `The hub's disk is almost full (${formatGb(freeBytes)} free). New uploads and pictures are paused so the service keeps running. Delete old media or presentations.`;
}

/** ORDO_MIN_FREE_GB read: whole GB from 0 to 10,000 (0: the floor is off); anything else is the computed floor. */
export function minFreeConfig(v: string | undefined): { bytes?: number; warning?: string } {
  if (v === undefined || v.trim() === '') return {};
  const t = v.trim();
  const n = Number(t);
  if (/^\d{1,5}$/.test(t) && Number.isInteger(n) && n >= 0 && n <= 10_000) return { bytes: n * GIB };
  return {
    warning: `ORDO_MIN_FREE_GB is not a whole number of GB from 0 to 10000 (${JSON.stringify(t.slice(0, 40))}): the computed floor applies`,
  };
}

export type DiskFloorOptions = {
  statfs?: StatFsFn;
  /** A configured floor (`HubConfig.minFreeBytes`): replaces the computed one; 0 turns the floor off. */
  minFreeBytes?: number;
  now?: () => number;
  warn?: (msg: string) => void;
};

export class DiskFloor {
  private dir: string;
  private statfs: StatFsFn;
  private minFreeBytes: number | undefined;
  private now: () => number;
  private warn: (msg: string) => void;
  private cached?: { at: number; p: Promise<DiskState> };
  private last: DiskState = { known: false, low: false };
  private warned = false;
  private refusedListeners: (() => void)[] = [];

  constructor(dir: string, opts: DiskFloorOptions = {}) {
    this.dir = dir;
    this.statfs = opts.statfs ?? ((d) => statfs(d));
    this.minFreeBytes = opts.minFreeBytes;
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? (() => undefined);
    if (this.minFreeBytes === 0)
      this.warn('ORDO_MIN_FREE_GB=0: the free-space floor is off, every upload is accepted');
  }

  /** Whether the floor is off (ORDO_MIN_FREE_GB=0). */
  get off(): boolean {
    return this.minFreeBytes === 0;
  }

  floorBytes(totalBytes: number): number {
    return this.minFreeBytes ?? computedFloor(totalBytes);
  }

  /** The volume's state, measured at most once per STATFS_CACHE_MS (a cached promise). Never rejects. */
  state(): Promise<DiskState> {
    const now = this.now();
    if (this.cached && now - this.cached.at < STATFS_CACHE_MS) return this.cached.p;
    const p = this.measure();
    this.cached = { at: now, p };
    return p;
  }

  private async measure(): Promise<DiskState> {
    try {
      const s = await this.statfs(this.dir);
      const bsize = Number(s.bsize);
      const free = Number(s.bavail) * bsize;
      const total = Number(s.blocks) * bsize;
      if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0 || free < 0)
        throw new Error('the volume reported no size');
      const floorBytes = this.floorBytes(total);
      this.warned = false;
      this.last = {
        known: true,
        freeBytes: free,
        totalBytes: total,
        floorBytes,
        low: floorBytes > 0 && free < floorBytes,
      };
      return this.last;
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        this.warn(
          `the free space of the data volume cannot be read (${(e as Error).message}): uploads are not refused for it`,
        );
      }
      this.last = { known: false, low: false };
      return this.last;
    }
  }

  /**
   * Throws 507 `disk` with W44's sentence when `incomingBytes` more would leave less than the floor free:
   * `incomingBytes` is the declared size (a resumable create's `size`, a request's Content-Length), 0 when
   * unknown. Fails open.
   */
  async assertRoom(incomingBytes = 0): Promise<void> {
    if (this.off) return;
    const s = await this.state();
    if (!s.known || s.freeBytes === undefined || s.floorBytes === undefined) return;
    const incoming = Number.isFinite(incomingBytes) && incomingBytes > 0 ? incomingBytes : 0;
    if (s.freeBytes - incoming >= s.floorBytes) return;
    for (const l of this.refusedListeners) l();
    throw new HttpError(507, 'disk', diskMessage(s.freeBytes), {
      reason: 'disk',
      freeBytes: s.freeBytes,
      floorBytes: s.floorBytes,
    });
  }

  /** The numbers `GET /health` carries, from the last measurement (none while the volume is unknown). */
  healthFields(): { diskFreeBytes?: number; diskFloorBytes?: number } {
    const s = this.last;
    if (!s.known || s.freeBytes === undefined) return {};
    return { diskFreeBytes: s.freeBytes, diskFloorBytes: this.off ? 0 : s.floorBytes };
  }

  /** Called when a request was refused (the library process measures again and reports it). */
  onRefused(fn: () => void): void {
    this.refusedListeners.push(fn);
  }
}

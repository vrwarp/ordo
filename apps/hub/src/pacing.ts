/**
 * Jobs paced while a service is live (design/28 §3.4, §5.3; design/24 "Feature flags are settings"). Pure and
 * clock-driven, so it is tested with a fake clock; the job queue asks it what may start and when to look again.
 *
 * - Holding: while the service is live, and for `graceMs` after End service (a second service on the same
 *   morning, the venue PC's offline download after the first).
 * - Held: a heavy job (a transcode, a document import, LibreOffice's pictures) while holding, unless its kind
 *   is exempt, when Phones is on (`settings.phones.enabled`), or whatever the switch says when it was queued
 *   during a capped (phone) request (`paced`: design/28 §10 items 8 and 11).
 * - Light tools run under `nice -n 19` with one thread while live, when Phones is on or the job was queued during
 *   a capped request (a phone's audio upload or large photo, whatever the switch says).
 * Phones off and no capped request: nothing is held, nothing niced, no timer.
 */
import type { JobClass } from './jobs.ts';

/** Job kinds a running service needs: never held (none in P0; renditions or a goLive bake would go here). */
export const PACE_EXEMPT: ReadonlySet<string> = new Set<string>();

/** The longest delay Node keeps: a longer one (Infinity included) fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** The niceness light tools get while held back (design/28 §5.3). */
export const LIVE_NICE = 19;

export type PacedJob = { kind: string; class: JobClass; paced: boolean };

export class JobPacing {
  private mode: 'idle' | 'live' = 'idle';
  private endedAt: number | undefined;
  private on: boolean;
  private readonly graceMs: number;
  private readonly clock: () => number;
  private readonly exempt: ReadonlySet<string>;
  constructor(
    opts: { graceMs: number; enabled?: boolean; now?: () => number; exempt?: ReadonlySet<string> } = {
      graceMs: 120_000,
    },
  ) {
    this.graceMs = Math.max(0, opts.graceMs);
    this.on = opts.enabled === true;
    this.clock = opts.now ?? Date.now;
    this.exempt = opts.exempt ?? PACE_EXEMPT;
  }

  /** The live service's mode: End service starts the grace. */
  onMode(mode: 'idle' | 'live', now = this.clock()): void {
    if (mode === 'live') this.endedAt = undefined;
    else if (this.mode === 'live') this.endedAt = now;
    this.mode = mode;
  }

  /** `settings.phones.enabled`, as the process caches it. */
  setEnabled(on: boolean): void {
    this.on = on;
  }

  enabled(): boolean {
    return this.on;
  }

  live(): boolean {
    return this.mode === 'live';
  }

  /** While live, and for the grace after End service. */
  holding(now = this.clock()): boolean {
    return this.mode === 'live' || (this.endedAt !== undefined && now < this.endedAt + this.graceMs);
  }

  /** Whether a queued job must wait for the service to end. */
  held(job: PacedJob, now = this.clock()): boolean {
    return job.class === 'heavy' && !this.exempt.has(job.kind) && (this.on || job.paced) && this.holding(now);
  }

  /** Kinds that are never held (the queue's SQL filter uses them). */
  exemptKinds(): readonly string[] {
    return [...this.exempt];
  }

  /**
   * When held jobs may start: undefined while live (End service wakes the queue, no timer runs) or when
   * nothing is held; the end of the grace after End service, at most MAX_TIMER_MS ahead.
   */
  wakeAt(now = this.clock()): number | undefined {
    if (this.mode === 'live' || this.endedAt === undefined) return undefined;
    const end = this.endedAt + this.graceMs;
    if (now >= end) return undefined;
    return Math.min(end, now + MAX_TIMER_MS);
  }

  /** The niceness for a light job's tools: 19 while live with Phones on or for a `paced` job, else 0. */
  childNice(paced = false): number {
    return this.mode === 'live' && (this.on || paced) ? LIVE_NICE : 0;
  }

  /** ffmpeg's thread count for a light job's tools: 1 while live with Phones on or for a `paced` job. */
  lightThreads(paced = false): number | undefined {
    return this.mode === 'live' && (this.on || paced) ? 1 : undefined;
  }
}

/**
 * What a light job's tools run with now: `{ nice: 19, threads: 1 }` while live with Phones on, or for a job a
 * capped request queued (`paced`, `JobQueue.paced`) whatever the switch says; else `{}`.
 */
export function lightToolPace(p: JobPacing | undefined, paced = false): { nice?: number; threads?: number } {
  if (!p) return {};
  const nice = p.childNice(paced);
  const threads = p.lightThreads(paced);
  return { ...(nice ? { nice } : {}), ...(threads ? { threads } : {}) };
}

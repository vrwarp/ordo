/**
 * Per-lane timing of the asset worker's jobs (design/27 §7.5 raster lanes), kept by the link from what each
 * result reports (`done` and `warmed`: wait, busy time on the thread and longest slice): the last `WINDOW` jobs of each lane,
 * summarised as percentiles for telemetry and the diagnostics view, and the count of jobs the link cancelled
 * because they were superseded.
 */

export type Lane = 'interactive' | 'bulk';

/** Jobs per lane the percentiles are taken over. */
export const WINDOW = 128;

export type LaneSummary = {
  /** Jobs reported since the window started (all of them, not only those in the window). */
  jobs: number;
  waitP50: number;
  waitP95: number;
  busyP50: number;
  busyP95: number;
  /** The longest slice of any job in the window: what a props job could have waited behind. */
  longestMs: number;
};

export type LanesSummary = { interactive: LaneSummary; bulk: LaneSummary; cancelled: number };

/** The `p` quantile (0..1) of `xs`, nearest rank; 0 for none. */
export function quantile(xs: readonly number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

class Ring {
  wait: number[] = [];
  busy: number[] = [];
  longest: number[] = [];
  jobs = 0;
  add(wait: number, busy: number, longest: number): void {
    this.jobs++;
    for (const [a, v] of [
      [this.wait, wait],
      [this.busy, busy],
      [this.longest, longest],
    ] as const) {
      a.push(Number.isFinite(v) && v > 0 ? v : 0);
      if (a.length > WINDOW) a.shift();
    }
  }
  summary(): LaneSummary {
    return {
      jobs: this.jobs,
      waitP50: round(quantile(this.wait, 0.5)),
      waitP95: round(quantile(this.wait, 0.95)),
      busyP50: round(quantile(this.busy, 0.5)),
      busyP95: round(quantile(this.busy, 0.95)),
      longestMs: round(this.longest.length ? Math.max(...this.longest) : 0),
    };
  }
}

export class LaneStats {
  private lanes: Record<Lane, Ring> = { interactive: new Ring(), bulk: new Ring() };
  private cancelledJobs = 0;

  add(lane: Lane, waitMs: number, busyMs: number, longestMs: number): void {
    (this.lanes[lane] ?? this.lanes.interactive).add(waitMs, busyMs, longestMs);
  }

  cancelled(n: number): void {
    this.cancelledJobs += n;
  }

  summary(): LanesSummary {
    return {
      interactive: this.lanes.interactive.summary(),
      bulk: this.lanes.bulk.summary(),
      cancelled: this.cancelledJobs,
    };
  }

  /** One line for the diagnostics view. */
  line(): string {
    const s = this.summary();
    const one = (n: string, l: LaneSummary) =>
      l.jobs
        ? `${n} ${l.jobs} jobs, wait p95 ${l.waitP95} ms, busy p50/p95 ${l.busyP50}/${l.busyP95} ms, longest slice ${l.longestMs} ms`
        : `${n} idle`;
    return `${one('interactive', s.interactive)}; ${one('bulk', s.bulk)}; ${s.cancelled} superseded`;
  }
}

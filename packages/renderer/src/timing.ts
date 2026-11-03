/**
 * Frame timing helpers shared by the render worker and tests. Everything here is allocation-free once
 * constructed, because it runs inside the frame loop.
 */

export const DEFAULT_FRAME_MS = 1000 / 60;

/** Cubic smoothstep on [0, 1]; inputs outside are clamped. */
export function smoothstep(x: number): number {
  /* @hot */
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/**
 * Weight of the incoming stack of a crossfade that started at `start` (hub ms) and lasts `ms`.
 * A cut (ms <= 0) is always 1.
 */
export function crossfadeWeight(now: number, start: number, ms: number): number {
  /* @hot */
  if (ms <= 0) return 1;
  return smoothstep((now - start) / ms);
}

/**
 * Whether a flip scheduled for hub time `at` happens on the frame whose rAF callback runs at hub time
 * `now`. The frame is presented roughly one vsync after the callback; flipping when `now + frameMs/2 >= at`
 * picks the first vsync at or after `at` (design/14).
 */
export function flipDue(now: number, at: number, frameMs: number): boolean {
  /* @hot */
  return now + frameMs / 2 >= at;
}

/**
 * A flip is late when it happens more than one frame after its target time, and the request arrived early
 * enough that it could have been on time (state replays after a reconnect are not late flips).
 */
export function isLateFlip(now: number, at: number, requestedAt: number, frameMs: number): boolean {
  /* @hot */
  if (requestedAt > at - frameMs / 2) return false;
  return now - at > frameMs;
}

/** Gaps at least this long between consecutive rAF callbacks count as a stall (the Long Tasks threshold). */
export const STALL_MS = 50;
/** Number of rAF gaps the frame period is learned from before misses are counted. */
export const WARMUP_GAPS = 16;
const MIN_FRAME_MS = 1000 / 240;
const MAX_FRAME_MS = 1000 / 20;

/**
 * rAF-gap based frame accounting. `tick(ts)` once per rAF with the callback timestamp (ms, any monotonic
 * timeline). The vsync period is established from the median of the first `WARMUP_GAPS` gaps (so a 30 Hz
 * or 50 Hz display is learned instead of counted as missed frames), then tracked with an EMA of on-time
 * gaps. A sustained run of gaps at exactly twice the period means the display rate halved (a 60 Hz TV
 * switched to 30 Hz): the period is learned again and the misses counted during that run are taken back.
 * Long gaps are stalls (the worker's long-task measure, since PerformanceObserver long tasks are not
 * available in workers). Keeps a ring of the last `ringSize` frame timestamps for telemetry.
 */
export class FrameClock {
  frameMs = DEFAULT_FRAME_MS;
  presented = 0;
  missed = 0;
  /** rAF gaps of STALL_MS or more that were not a pause: the render thread was blocked. */
  stalls = 0;
  /** Longest stall seen (ms). */
  maxStallMs = 0;
  last = -1;
  /** False until the first WARMUP_GAPS gaps have set the period. */
  learned = false;
  readonly ring: Float64Array;
  ringPos = 0;
  ringCount = 0;
  /** Gaps larger than this are a pause (window hidden, debugger) and not counted as missed frames. */
  pauseMs = 1000;
  private readonly warm = new Float64Array(WARMUP_GAPS);
  private warmCount = 0;
  private doubleRun = 0;
  private doubleMissed = 0;

  constructor(ringSize = 600) {
    this.ring = new Float64Array(ringSize);
  }

  tick(ts: number): number {
    /* @hot */
    let missedNow = 0;
    if (this.last >= 0) {
      const gap = ts - this.last;
      if (gap > 0 && gap < this.pauseMs) {
        if (gap >= STALL_MS) {
          this.stalls++;
          if (gap > this.maxStallMs) this.maxStallMs = gap;
        }
        if (!this.learned) {
          this.warm[this.warmCount++] = gap;
          if (this.warmCount >= WARMUP_GAPS) this.learn();
        } else if (gap < this.frameMs * 1.5) {
          // Track the vsync period from on-time gaps only (EMA).
          this.frameMs += (gap - this.frameMs) * 0.05;
          this.doubleRun = 0;
          this.doubleMissed = 0;
        } else {
          missedNow = Math.round(gap / this.frameMs) - 1;
          if (missedNow < 0) missedNow = 0;
          this.missed += missedNow;
          if (missedNow === 1 && gap > this.frameMs * 1.75 && gap < this.frameMs * 2.25) {
            this.doubleRun++;
            this.doubleMissed += missedNow;
            this.warm[this.doubleRun % WARMUP_GAPS] = gap;
            if (this.doubleRun >= 90) {
              // Not a stutter: the display runs at half the rate we learned. Learn again, undo the misses.
              this.missed -= this.doubleMissed;
              this.warmCount = WARMUP_GAPS;
              this.learn();
              missedNow = 0;
            }
          } else {
            this.doubleRun = 0;
            this.doubleMissed = 0;
          }
        }
      }
    }
    this.last = ts;
    this.presented++;
    this.ring[this.ringPos] = ts;
    this.ringPos = (this.ringPos + 1) % this.ring.length;
    if (this.ringCount < this.ring.length) this.ringCount++;
    return missedNow;
  }

  /** Set the period from the median of the warm-up gaps (insertion sort in place: no allocation). */
  private learn(): void {
    /* @hot */
    const w = this.warm;
    const n = this.warmCount;
    for (let i = 1; i < n; i++) {
      const v = w[i]!;
      let j = i - 1;
      while (j >= 0 && w[j]! > v) {
        w[j + 1] = w[j]!;
        j--;
      }
      w[j + 1] = v;
    }
    const med = n % 2 ? w[(n - 1) / 2]! : (w[n / 2 - 1]! + w[n / 2]!) / 2;
    this.frameMs = Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, med));
    this.learned = true;
    this.warmCount = 0;
    this.doubleRun = 0;
    this.doubleMissed = 0;
  }

  /** Frames per second over the ring (not hot). */
  fps(): number {
    if (this.ringCount < 2) return 0;
    const n = this.ring.length;
    const newest = this.ring[(this.ringPos - 1 + n) % n]!;
    const oldest = this.ring[(this.ringPos - this.ringCount + n) % n]!;
    const span = newest - oldest;
    return span > 0 ? ((this.ringCount - 1) * 1000) / span : 0;
  }

  /** The ring in chronological order (allocates; telemetry only). */
  frames(): number[] {
    const out: number[] = [];
    const n = this.ring.length;
    for (let i = this.ringCount; i > 0; i--) out.push(this.ring[(this.ringPos - i + n) % n]!);
    return out;
  }
}

/** Milliseconds until the next whole second of `nowMs`, plus `leadMs` earlier (never negative). */
export function msToNextSecond(nowMs: number, leadMs = 0): number {
  const next = Math.floor(nowMs / 1000) * 1000 + 1000;
  return Math.max(0, next - nowMs - leadMs);
}

/**
 * The second boundary the props layer is being prepared for at `nowMs`: within `leadMs` before a whole
 * second the text for that second is already rasterized and scheduled, so the model is evaluated at the
 * boundary; otherwise at `nowMs`. Every caller (the per-second tick and state-driven syncs) evaluates at
 * the same instant, so a sync cannot flip the layer back to the previous second's text.
 */
export function propsEvalTime(nowMs: number, leadMs: number): number {
  const next = Math.ceil(nowMs / 1000) * 1000;
  return next - nowMs <= leadMs ? next : nowMs;
}

/**
 * Delay until the props tick should wake: `leadMs` before the next whole second that is still at least
 * `leadMs` away (never 0, so the last `leadMs` of a second cannot busy-loop).
 */
export function propsTickDelay(nowMs: number, leadMs: number): number {
  let next = Math.floor(nowMs / 1000) * 1000 + 1000;
  if (next - nowMs <= leadMs) next += 1000;
  return next - leadMs - nowMs;
}

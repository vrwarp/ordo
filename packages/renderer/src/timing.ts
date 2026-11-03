/**
 * Frame timing helpers shared by the render worker and tests. Everything here is allocation-free once
 * constructed, because it runs inside the frame loop.
 */

export const DEFAULT_FRAME_MS = 1000 / 60;

/** Cubic smoothstep on [0, 1]; inputs outside are clamped. */
export function smoothstep(x: number): number {
  /* @hot */
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
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

/**
 * rAF-gap based frame accounting. `tick(ts)` once per rAF with the callback timestamp (ms, any monotonic
 * timeline). Tracks the vsync period from short gaps, counts missed vsyncs from long gaps, and keeps a
 * ring of the last `ringSize` frame timestamps for telemetry.
 */
export class FrameClock {
  frameMs = DEFAULT_FRAME_MS;
  presented = 0;
  missed = 0;
  last = -1;
  readonly ring: Float64Array;
  ringPos = 0;
  ringCount = 0;
  /** Gaps larger than this are a pause (window hidden, debugger) and not counted as missed frames. */
  pauseMs = 1000;

  constructor(ringSize = 600) {
    this.ring = new Float64Array(ringSize);
  }

  tick(ts: number): number {
    /* @hot */
    let missedNow = 0;
    if (this.last >= 0) {
      const gap = ts - this.last;
      if (gap > 0 && gap < this.frameMs * 1.5) {
        // Track the vsync period from on-time gaps only (EMA).
        this.frameMs += (gap - this.frameMs) * 0.05;
      } else if (gap >= this.frameMs * 1.5 && gap < this.pauseMs) {
        missedNow = Math.round(gap / this.frameMs) - 1;
        if (missedNow < 0) missedNow = 0;
        this.missed += missedNow;
      }
    }
    this.last = ts;
    this.presented++;
    this.ring[this.ringPos] = ts;
    this.ringPos = (this.ringPos + 1) % this.ring.length;
    if (this.ringCount < this.ring.length) this.ringCount++;
    return missedNow;
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

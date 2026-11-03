import { estimateOffset } from '@ordo/protocol';

/**
 * Hub clock estimate. Samples NTP-style exchanges and keeps the offset of the minimum round trip among
 * the last 8 samples. In fallback mode every window is on one PC, so the offset is forced to zero.
 */
export class HubClock {
  private samples: { c: number; s: number; r: number }[] = [];
  offset = 0;
  rtt = 0;
  fallback = false;

  now(): number {
    return Date.now() + (this.fallback ? 0 : this.offset);
  }

  addSample(c: number, s: number, r: number = Date.now()): void {
    this.samples.push({ c, s, r });
    if (this.samples.length > 8) this.samples.shift();
    const est = estimateOffset(this.samples);
    if (est) {
      this.offset = est.offset;
      this.rtt = est.rtt;
    }
  }

  reset(): void {
    this.samples = [];
  }
}

/** Shared default clock for a window. */
export const clock = new HubClock();
export const hubNow = (): number => clock.now();

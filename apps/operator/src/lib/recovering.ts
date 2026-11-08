/** A heartbeat older than this shows "Recovering…" (the supervisor restarts the core at 1.5 s). */
export const LATE_BEAT_MS = 750;

/**
 * Whether the UI shows the core as recovering (review item 29). A restart in progress always counts. A
 * late heartbeat counts only when this thread itself has been ticking on time: after a long main-thread
 * task the core's heartbeats are still queued behind the tick that judges them, so their age says nothing
 * about the core (the supervisor applies the same correction). The judgment resumes LATE_BEAT_MS after the
 * stall ends, by which time the queued heartbeats have been read.
 */
export class RecoveringGate {
  private last = Number.NaN;
  private quietUntil = 0;

  constructor(private periodMs: number) {}

  judge(now: number, restarting: boolean, sinceHeartbeatMs: number): boolean {
    if (now - this.last > this.periodMs * 1.5) this.quietUntil = now + LATE_BEAT_MS;
    this.last = now;
    if (restarting) return true;
    return sinceHeartbeatMs > LATE_BEAT_MS && now >= this.quietUntil;
  }
}

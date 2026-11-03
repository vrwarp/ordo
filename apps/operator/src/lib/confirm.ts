/**
 * Clear-all-to-black needs two presses within `windowMs` (prd/02). The first press arms the confirm and
 * the UI shows it; the second within the window fires.
 */
export class DoublePressGuard {
  private armedAt?: number;
  constructor(private windowMs = 2000) {}

  /** Returns true when this press should fire. */
  press(now: number): boolean {
    if (this.armedAt !== undefined && now - this.armedAt <= this.windowMs) {
      this.armedAt = undefined;
      return true;
    }
    this.armedAt = now;
    return false;
  }

  /** Time at which the pending confirm expires, or undefined. */
  pendingUntil(now: number): number | undefined {
    if (this.armedAt === undefined) return undefined;
    const until = this.armedAt + this.windowMs;
    return until > now ? until : undefined;
  }

  cancel(): void {
    this.armedAt = undefined;
  }
}

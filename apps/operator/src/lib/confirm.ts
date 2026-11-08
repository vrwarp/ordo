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

type Timer = unknown;

/**
 * Clear-all "or hold" (prd/02): a press that is held for `holdMs` fires without the second press. `down()`
 * starts the hold, `up()` ends it and reports whether the hold already fired, so the caller can ignore the
 * click that follows the release.
 */
export class HoldGuard {
  private timer?: Timer;
  private fired = false;
  constructor(
    private holdMs = 1000,
    private setTimer: (fn: () => void, ms: number) => Timer = (fn, ms) => setTimeout(fn, ms),
    private clearTimer: (t: Timer) => void = (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  ) {}

  /** Start holding; `fire` runs once if the press is still held after `holdMs`. */
  down(fire: () => void): void {
    this.cancel();
    this.fired = false;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.fired = true;
      fire();
    }, this.holdMs);
  }

  /** Release; true when the hold fired (the release click should then be ignored). */
  up(): boolean {
    this.cancel();
    const fired = this.fired;
    this.fired = false;
    return fired;
  }

  get holding(): boolean {
    return this.timer !== undefined;
  }

  cancel(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }
}

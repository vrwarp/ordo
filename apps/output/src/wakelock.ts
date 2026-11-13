/**
 * Keeps a Screen Wake Lock held while the output is visible (review item 11). Chrome releases the sentinel
 * on its own when the window is hidden or occluded (a dialog or ProPresenter over the output), so the
 * sentinel's `release` event is watched and the lock is requested again whenever the page is visible:
 * on visibility and fullscreen changes, on focus, and on a slow timer in case none of those fire.
 */

export type WakeSentinel = {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', fn: () => void): void;
};

export type WakeLockHost = {
  request: (() => Promise<WakeSentinel>) | undefined;
  visible: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  log?: (m: string) => void;
};

export class WakeLockKeeper {
  sentinel: WakeSentinel | null = null;
  requests = 0;
  private pending = false;

  private host: WakeLockHost;
  constructor(host: WakeLockHost, retryMs = 30_000) {
    this.host = host;
    host.setInterval(() => void this.acquire(), retryMs);
  }

  get held(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  /** Request the lock when the page is visible and no lock is held. Safe to call often. */
  async acquire(): Promise<void> {
    if (!this.host.request || this.pending || this.held || !this.host.visible()) return;
    this.pending = true;
    this.requests++;
    try {
      const s = await this.host.request();
      this.sentinel = s;
      s.addEventListener?.('release', () => {
        if (this.sentinel === s) this.sentinel = null;
        this.host.log?.('wake lock released by the browser; will request it again when visible');
        if (this.host.visible()) void this.acquire();
      });
    } catch (err) {
      this.sentinel = null;
      this.host.log?.(`wake lock request failed: ${(err as Error).message}`);
    } finally {
      this.pending = false;
    }
  }
}

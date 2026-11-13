import { appEnv } from './env.ts';

export const WINDOW_PROBE_CHANNEL = 'ordo-window-probe';

export type WindowProbeMessage =
  | { t: 'window:ping'; outputId?: string }
  | { t: 'window:pong'; outputId: string; role?: 'output' | 'stage' }
  | { t: 'window:closed'; outputId: string };

function isDomainMode(): boolean {
  try {
    return typeof location !== 'undefined' ? !!appEnv().domain : false;
  } catch {
    return false;
  }
}

/**
 * Registers an output or stage window to respond to local BroadcastChannel window probes.
 * Returns an unregister / cleanup function.
 */
export function registerWindowProbe(outputId: string, role: 'output' | 'stage' = 'output'): () => void {
  if (typeof BroadcastChannel === 'undefined' || isDomainMode()) return () => {};
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(WINDOW_PROBE_CHANNEL);
  } catch {
    return () => {};
  }

  const sendPong = () => {
    try {
      ch?.postMessage({ t: 'window:pong', outputId, role } satisfies WindowProbeMessage);
    } catch {
      /* channel closed */
    }
  };

  const onMessage = (ev: MessageEvent) => {
    const data = ev.data as WindowProbeMessage | undefined;
    if (data && typeof data === 'object' && data.t === 'window:ping') {
      if (!data.outputId || data.outputId === outputId) {
        sendPong();
      }
    }
  };

  ch.onmessage = onMessage;

  // Immediately broadcast pong so any listening operator learns of this window
  sendPong();

  const onUnload = () => {
    try {
      ch?.postMessage({ t: 'window:closed', outputId } satisfies WindowProbeMessage);
    } catch {
      /* ignore */
    }
  };

  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      sendPong();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onUnload);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onUnload);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    onUnload();
    try {
      ch?.close();
    } catch {
      /* ignore */
    }
    ch = null;
  };
}

/**
 * Operator-side tracker for local output windows responding on BroadcastChannel.
 */
export class LocalWindowTracker {
  private localOutputs = new Map<string, number>(); // outputId -> lastSeen timestamp
  private ch: BroadcastChannel | null = null;
  private interval?: ReturnType<typeof setInterval>;

  constructor() {
    if (typeof BroadcastChannel !== 'undefined' && !isDomainMode()) {
      try {
        this.ch = new BroadcastChannel(WINDOW_PROBE_CHANNEL);
        this.ch.onmessage = (ev: MessageEvent) => {
          const d = ev.data as WindowProbeMessage | undefined;
          if (d && typeof d === 'object') {
            if (d.t === 'window:pong' && typeof d.outputId === 'string') {
              this.localOutputs.set(d.outputId, Date.now());
            } else if (d.t === 'window:closed' && typeof d.outputId === 'string') {
              this.localOutputs.delete(d.outputId);
            }
          }
        };
        // Initial ping to discover any already-open local output windows
        this.ping();
        // Periodic gentle ping every 5 seconds to keep known windows fresh
        this.interval = setInterval(() => this.ping(), 5000);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Whether probes can confirm windows at all. Not in domain mode (the venue setup), where every output has
   * its own origin and a BroadcastChannel never crosses origins: callers then fall back to what is known
   * otherwise (launched from this browser session, reported connected by the hub).
   */
  get available(): boolean {
    return this.ch !== null;
  }

  ping(outputId?: string): void {
    if (!this.ch) return;
    try {
      this.ch.postMessage({ t: 'window:ping', outputId } satisfies WindowProbeMessage);
    } catch {
      /* ignore */
    }
  }

  /**
   * Explicitly probes for matching output IDs and waits up to `timeoutMs` for pongs.
   * Returns the set of output IDs that responded (or are already known to be recently active).
   */
  async probe(outputIds?: string[], timeoutMs = 40): Promise<Set<string>> {
    const found = new Set<string>();
    const now = Date.now();
    const targets = outputIds ? new Set(outputIds) : null;
    for (const [id, lastSeen] of this.localOutputs) {
      if ((!targets || targets.has(id)) && now - lastSeen < 10_000) {
        found.add(id);
      }
    }
    // If all requested targets are already known, return immediately without waiting
    if (targets && [...targets].every((id) => found.has(id))) {
      return found;
    }
    if (!this.ch) return found;

    const handler = (ev: MessageEvent) => {
      const d = ev.data as WindowProbeMessage | undefined;
      if (d && typeof d === 'object' && d.t === 'window:pong' && typeof d.outputId === 'string') {
        if (!targets || targets.has(d.outputId)) {
          found.add(d.outputId);
          this.localOutputs.set(d.outputId, Date.now());
        }
      }
    };

    this.ch.addEventListener('message', handler);
    this.ping(outputIds?.length === 1 ? outputIds[0] : undefined);

    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    this.ch.removeEventListener('message', handler);
    return found;
  }

  isConfirmedLocal(outputId: string, maxAgeMs = 15_000): boolean {
    const lastSeen = this.localOutputs.get(outputId);
    if (lastSeen === undefined) return false;
    return Date.now() - lastSeen < maxAgeMs;
  }

  confirmedLocalIds(maxAgeMs = 15_000): Set<string> {
    const now = Date.now();
    const set = new Set<string>();
    for (const [id, lastSeen] of this.localOutputs) {
      if (now - lastSeen < maxAgeMs) {
        set.add(id);
      }
    }
    return set;
  }

  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    try {
      this.ch?.close();
    } catch {
      /* ignore */
    }
    this.ch = null;
    this.localOutputs.clear();
  }
}

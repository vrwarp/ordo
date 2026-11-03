import type { BusEndpoint } from '@ordo/client';
import type { FallbackMessage } from '@ordo/protocol';

/**
 * The stage link worker's fallback-bus endpoint (same design as the output's, apps/output/src/bus.ts).
 * Two carriers feed it:
 * - the newest MessagePort the operator handed over (offerPort/acceptPorts): the operator's worker and
 *   this link worker talk directly, no main thread on the path (design/25);
 * - the host's relay of window.postMessage from the opener (a port to the main thread), for an operator
 *   that does not hand over ports, and while a restarted link worker waits for a fresh port.
 * Replies go back the way the operator last spoke, falling back to the other carrier.
 */
export class MuxEndpoint implements BusEndpoint {
  private port?: BusEndpoint;
  private unsubPort?: () => void;
  private unsubBridge: () => void;
  private subs = new Set<(m: FallbackMessage) => void>();
  private lastFrom: 'port' | 'bridge' = 'bridge';

  constructor(private bridge: BusEndpoint) {
    this.unsubBridge = bridge.onMessage((m) => {
      this.lastFrom = 'bridge';
      this.deliver(m);
    });
  }

  get kind(): 'port' | 'window' {
    return this.port?.alive() ? 'port' : 'window';
  }

  /** Use a newly handed-over port (the newest wins; the previous one is closed). */
  setPort(ep: BusEndpoint): void {
    this.unsubPort?.();
    this.port?.close();
    this.port = ep;
    this.lastFrom = 'port';
    this.unsubPort = ep.onMessage((m) => {
      this.lastFrom = 'port';
      this.deliver(m);
    });
  }

  get hasPort(): boolean {
    return !!this.port?.alive();
  }

  post(m: FallbackMessage): void {
    const port = this.port?.alive() ? this.port : undefined;
    if (port && (this.lastFrom === 'port' || !this.bridge.alive())) port.post(m);
    else if (this.bridge.alive()) this.bridge.post(m);
    else port?.post(m);
  }

  onMessage(fn: (m: FallbackMessage) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  alive(): boolean {
    return !!this.port?.alive() || this.bridge.alive();
  }

  close(): void {
    this.unsubPort?.();
    this.unsubBridge();
    this.port?.close();
    this.bridge.close();
    this.subs.clear();
  }

  private deliver(m: FallbackMessage): void {
    for (const fn of this.subs) fn(m);
  }
}

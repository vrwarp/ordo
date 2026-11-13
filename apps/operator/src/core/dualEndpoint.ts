import type { BusEndpoint } from '@ordo/client';
import type { FallbackMessage } from '@ordo/protocol';
import type { EndpointInfo } from './protocol.ts';

type Channel = { ep: BusEndpoint; unsub: () => void; lastRx: number };

/** A proven port that has been silent this long while the relay hears the window is considered gone. */
export const PORT_DEAD_MS = 5000;

/**
 * The core worker's bus endpoint for one window (design/25, port handoff). It holds up to two channels:
 *
 * - `port`: a MessagePort the operator handed to the window (preferred: neither main thread is on the
 *   path);
 * - `relay`: a port the operator's main thread bridges to window.postMessage, for a window that never
 *   took a port (an older output build, or a page that has not received its offer yet).
 *
 * Messages are accepted from both. Until the window has spoken on the current port, posts go to both
 * channels: duplicates are harmless on the bus (the mirror drops a delta it already applied, hellos and
 * heartbeats are idempotent), and the direct copy arrives first, so a port-capable window answers on the
 * port and proves it. From then on posts go to the port only, unless the port falls silent for
 * PORT_DEAD_MS while the relay hears the window (it reloaded and has no port yet). Replacing a channel
 * keeps the other one.
 */
export class DualEndpoint implements BusEndpoint {
  private port?: Channel;
  private relay?: Channel;
  private subs = new Set<(m: FallbackMessage) => void>();
  private closed = false;
  /** When the main thread last offered a port to the window (for the re-offer watch). */
  lastOffer = 0;

  private now: () => number;
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  get kind(): 'port' | 'window' {
    const a = this.active();
    return a === 'window' ? 'window' : this.port ? 'port' : 'window';
  }

  setPort(ep: BusEndpoint): void {
    this.port = this.swap(this.port, ep);
    this.lastOffer = this.now();
  }

  setRelay(ep: BusEndpoint): void {
    this.relay = this.swap(this.relay, ep);
  }

  hasPort(): boolean {
    return !!this.port;
  }

  /** The window has spoken on the current port (it is proven). */
  portSpoke(): boolean {
    return !!this.port?.lastRx;
  }

  /** A port is held and not known to be closed. */
  portAlive(): boolean {
    return !!this.port && this.port.ep.alive();
  }

  /** Time of the last message from the window on any channel (0: never). */
  lastRx(): number {
    return Math.max(this.port?.lastRx ?? 0, this.relay?.lastRx ?? 0);
  }

  active(): EndpointInfo['active'] {
    const p = this.port;
    const r = this.relay;
    if (!p && !r) return 'none';
    if (p && !r) return 'port';
    if (r && !p) return 'window';
    if (!p!.lastRx) return 'both';
    if (r!.lastRx > p!.lastRx && this.now() - p!.lastRx > PORT_DEAD_MS) return 'window';
    return 'port';
  }

  info(ready: boolean): EndpointInfo {
    const rx = this.lastRx();
    return {
      active: this.active(),
      port: !!this.port,
      relay: !!this.relay,
      sinceRxMs: rx ? this.now() - rx : -1,
      ready,
    };
  }

  post(m: FallbackMessage): void {
    if (this.closed) return;
    switch (this.active()) {
      case 'port':
        this.port?.ep.post(m);
        return;
      case 'window':
        this.relay?.ep.post(m);
        return;
      case 'both':
        this.port?.ep.post(m);
        this.relay?.ep.post(m);
        return;
      default:
        return;
    }
  }

  onMessage(fn: (m: FallbackMessage) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  alive(): boolean {
    if (this.closed) return false;
    return !!(this.port?.ep.alive() || this.relay?.ep.alive());
  }

  close(): void {
    this.closed = true;
    this.subs.clear();
    for (const c of [this.port, this.relay]) {
      if (!c) continue;
      c.unsub();
      c.ep.close();
    }
    this.port = undefined;
    this.relay = undefined;
  }

  private swap(old: Channel | undefined, ep: BusEndpoint): Channel {
    if (old) {
      old.unsub();
      old.ep.close();
    }
    const ch: Channel = { ep, unsub: () => undefined, lastRx: 0 };
    ch.unsub = ep.onMessage((m) => {
      if (this.closed) return;
      ch.lastRx = this.now();
      for (const fn of this.subs) fn(m);
    });
    return ch;
  }
}

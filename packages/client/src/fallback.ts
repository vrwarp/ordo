import type { LiveEvent, LiveState } from '@ordo/domain';
import {
  type FallbackMessage,
  type LiveDeltaMsg,
  type LiveStateMsg,
  type OutputHealth,
  PROTOCOL_VERSION,
} from '@ordo/protocol';
import { Emitter } from './emitter.ts';

/**
 * One side of a fallback-bus link to one peer. The bus protocol (FallbackMessage) is the same whatever
 * carries it: a MessagePort handed over when the operator opened the window (preferred: worker-safe, so
 * neither main thread is on the path), or the legacy window.postMessage with origin checks.
 */
export interface BusEndpoint {
  readonly kind: 'port' | 'window';
  post(m: FallbackMessage): void;
  /** Subscribe to messages from the peer; returns an unsubscribe function. */
  onMessage(fn: (m: FallbackMessage) => void): () => void;
  /** False once the peer is known to be gone (closed window, closed port). */
  alive(): boolean;
  close(): void;
}

function validBusMessage(d: unknown): d is FallbackMessage {
  return (
    !!d &&
    typeof d === 'object' &&
    (d as { v?: unknown }).v === PROTOCOL_VERSION &&
    typeof (d as { t?: unknown }).t === 'string'
  );
}

/** A bus endpoint over a MessagePort. Trust was established when the port was handed over. */
export function portEndpoint(port: MessagePort): BusEndpoint {
  let open = true;
  const subs = new Set<(m: FallbackMessage) => void>();
  port.onmessage = (ev) => {
    if (!validBusMessage(ev.data)) return;
    for (const fn of subs) fn(ev.data);
  };
  (port as MessagePort & { onclose?: (() => void) | null }).onclose = () => {
    open = false;
  };
  port.start?.();
  return {
    kind: 'port',
    post(m) {
      if (!open) return;
      try {
        port.postMessage(m);
      } catch {
        open = false;
      }
    },
    onMessage(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    alive: () => open,
    close() {
      open = false;
      subs.clear();
      try {
        port.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * A bus endpoint over window.postMessage (main thread only). Messages are accepted only from `peer` at
 * `origin`. `peer` may be a getter so the output side can follow window.opener.
 */
export function windowEndpoint(peer: Window | (() => Window | null), origin: string): BusEndpoint {
  const get = typeof peer === 'function' ? (peer as () => Window | null) : () => peer as Window;
  const subs = new Set<(m: FallbackMessage) => void>();
  const listener = (ev: MessageEvent) => {
    const w = get();
    if (!w || ev.source !== w || ev.origin !== origin) return;
    if (!validBusMessage(ev.data)) return;
    for (const fn of subs) fn(ev.data);
  };
  if (typeof window !== 'undefined') window.addEventListener('message', listener);
  const alive = () => {
    try {
      const w = get();
      return !!w && !w.closed;
    } catch {
      return false;
    }
  };
  return {
    kind: 'window',
    post(m) {
      try {
        const w = get();
        if (w && !w.closed) w.postMessage(m, origin);
      } catch {
        /* window gone */
      }
    },
    onMessage(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    alive,
    close() {
      subs.clear();
      if (typeof window !== 'undefined') window.removeEventListener('message', listener);
    },
  };
}

type Win = { ep: BusEndpoint; ready: boolean; unsub: () => void };

/** Period of the host's announcements (hello to windows not yet ready, heartbeat to ready ones). */
export const FALLBACK_HEARTBEAT_MS = 2000;
/** An output leaves the fallback bus on its own after this long without a message from the host. */
export const FALLBACK_SILENCE_MS = 5000;
const RECENT_EVENT_IDS = 200;

/**
 * Operator side of the fallback bus. Holds the WindowProxy of every output and stage window it opened,
 * and, while the hub is unreachable, acts as the hub for them over postMessage.
 *
 * While active it posts a heartbeat (`fallback.hub { hubUp: false }`) to every ready window every 2 s;
 * outputs that stop hearing it for 5 s leave the bus by themselves (design/17), so a closed or crashed
 * operator tab cannot leave them stuck. While inactive (hub mode) every window it registers or hears
 * from is told `fallback.hub { hubUp: true }`, so a window left in fallback by an earlier tab follows
 * the hub again as soon as this tab acquires it.
 */
export class FallbackHost extends Emitter<{
  health: { outputId: string; health: OutputHealth };
  /** media.ended / audio.ended reported by the audio-master output while the operator is the authority. */
  event: { outputId: string; event: LiveEvent };
  ready: { outputId: string; appliedSeq: number };
}> {
  private windows = new Map<string, Win>();
  active = false;
  private lastState?: LiveStateMsg;
  private timer?: ReturnType<typeof setInterval>;
  private seenEvents: string[] = [];
  private seenEventSet = new Set<string>();
  getFile?: (hash: string) => Promise<Blob | undefined>;

  dispose(): void {
    clearInterval(this.timer);
    for (const id of [...this.windows.keys()]) this.unregister(id);
  }

  /** Legacy registration over window.postMessage (main thread). Prefer registerEndpoint with a port. */
  register(outputId: string, win: Window, origin: string): void {
    this.registerEndpoint(outputId, windowEndpoint(win, origin));
  }

  /** Register (or replace) the bus endpoint of one output or stage window. */
  registerEndpoint(outputId: string, ep: BusEndpoint): void {
    this.unregister(outputId);
    const w: Win = { ep, ready: false, unsub: () => undefined };
    w.unsub = ep.onMessage((m) => this.onMessage(outputId, w, m));
    this.windows.set(outputId, w);
    // A window acquired while the hub is the authority may still be on an older tab's fallback bus.
    if (!this.active) this.postTo(w, { t: 'fallback.hub', v: 1, hubUp: true });
    else if (this.lastState)
      this.postTo(w, { t: 'fallback.hello', v: 1, seq: this.lastState.seq, operatorMs: Date.now() });
  }

  /**
   * The endpoint of one window now reaches a new page (a fresh port after a reload or re-offer): forget
   * that it was ready and introduce the bus again, exactly as a new registration would, without closing
   * the endpoint.
   */
  reintroduce(outputId: string): void {
    const w = this.windows.get(outputId);
    if (!w) return;
    w.ready = false;
    if (!this.active) this.postTo(w, { t: 'fallback.hub', v: 1, hubUp: true });
    else if (this.lastState)
      this.postTo(w, { t: 'fallback.hello', v: 1, seq: this.lastState.seq, operatorMs: Date.now() });
  }

  /** Whether a window has answered the current introduction with fallback.ready. */
  isReady(outputId: string): boolean {
    return this.windows.get(outputId)?.ready ?? false;
  }

  unregister(outputId: string): void {
    const w = this.windows.get(outputId);
    if (!w) return;
    w.unsub();
    w.ep.close();
    this.windows.delete(outputId);
  }

  handles(): Map<string, Win> {
    return this.windows;
  }

  /** Become the authority: announce to every window and keep re-announcing to those not yet ready. */
  activate(state: LiveState): void {
    this.active = true;
    this.lastState = { t: 'live.state', v: 1, seq: state.seq, state };
    for (const w of this.windows.values()) w.ready = false;
    this.announce();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.announce(), FALLBACK_HEARTBEAT_MS);
  }

  /** Hub is back: tell windows to return to their hub connection. */
  deactivate(): void {
    this.active = false;
    clearInterval(this.timer);
    this.timer = undefined;
    this.post({ t: 'fallback.hub', v: 1, hubUp: true });
  }

  broadcastDelta(d: LiveDeltaMsg, state: LiveState): void {
    this.lastState = { t: 'live.state', v: 1, seq: state.seq, state };
    if (!this.active) return;
    for (const w of this.windows.values()) if (w.ready) this.postTo(w, d);
  }

  /** Hello to windows not yet on the bus; heartbeat to those that are. */
  private announce(): void {
    if (!this.lastState || !this.active) return;
    for (const w of this.windows.values()) {
      if (!w.ep.alive()) continue;
      if (w.ready) this.postTo(w, { t: 'fallback.hub', v: 1, hubUp: false });
      else this.postTo(w, { t: 'fallback.hello', v: 1, seq: this.lastState.seq, operatorMs: Date.now() });
    }
  }

  private post(m: FallbackMessage): void {
    for (const w of this.windows.values()) this.postTo(w, m);
  }

  private postTo(w: Win, m: FallbackMessage): void {
    w.ep.post(m);
  }

  private seenEvent(id: string | undefined): boolean {
    if (!id) return false;
    if (this.seenEventSet.has(id)) return true;
    this.seenEventSet.add(id);
    this.seenEvents.push(id);
    if (this.seenEvents.length > RECENT_EVENT_IDS) this.seenEventSet.delete(this.seenEvents.shift()!);
    return false;
  }

  private onMessage(outputId: string, w: Win, m: FallbackMessage): void {
    if (this.windows.get(outputId) !== w) return;
    if (m.t === 'fallback.ready') {
      w.ready = true;
      if (this.active && this.lastState) this.postTo(w, this.lastState);
      else if (!this.active) this.postTo(w, { t: 'fallback.hub', v: 1, hubUp: true });
      this.emit('ready', { outputId, appliedSeq: m.appliedSeq });
    } else if (m.t === 'health') {
      // A window still talking to us over the bus while the hub is the authority belongs on the hub.
      if (!this.active) this.postTo(w, { t: 'fallback.hub', v: 1, hubUp: true });
      this.emit('health', { outputId, health: m.health });
    } else if ((m as { t: string }).t === 'live.event') {
      const le = m as unknown as { id?: string; event?: LiveEvent };
      const e = le.event;
      if (!e || (e.k !== 'media.ended' && e.k !== 'audio.ended')) return;
      if (this.seenEvent(le.id)) return;
      if (!this.active) {
        this.postTo(w, { t: 'fallback.hub', v: 1, hubUp: true });
        return;
      }
      this.emit('event', { outputId, event: e });
    } else if (m.t === 'fallback.file') {
      void (async () => {
        const blob = await this.getFile?.(m.hash).catch(() => undefined);
        this.postTo(w, {
          t: 'fallback.file.res',
          v: 1,
          reqId: m.reqId,
          hash: m.hash,
          blob,
          error: blob ? undefined : 'missing',
        });
      })();
    }
  }
}

/**
 * Output and stage side of the fallback bus. Accepts messages only from window.opener at the operator origin.
 */
export class FallbackClient extends Emitter<{
  hello: { seq: number };
  state: LiveStateMsg;
  delta: LiveDeltaMsg;
  hub: { hubUp: boolean };
}> {
  private pendingFiles = new Map<string, (b: Blob | undefined) => void>();
  private ep: BusEndpoint;
  private unsub: () => void;
  private outputId: string;
  /** Set by the host layer when it learns the opener is gone (a worker cannot see window.opener). */
  openerClosed = false;
  /** Time of the last accepted message from the operator (0 before the first). */
  lastTraffic = 0;

  /**
   * `new FallbackClient(operatorOrigin, outputId)` listens to window.opener (main thread, legacy);
   * `new FallbackClient({ endpoint, outputId })` uses a handed-over port (works in a worker).
   */
  constructor(a: string | { endpoint: BusEndpoint; outputId: string }, outputId?: string) {
    super();
    if (typeof a === 'string') {
      this.ep = windowEndpoint(
        () => (typeof window !== 'undefined' ? (window.opener as Window | null) : null),
        a,
      );
      this.outputId = outputId ?? 'unknown';
    } else {
      this.ep = a.endpoint;
      this.outputId = a.outputId;
    }
    this.unsub = this.ep.onMessage((m) => this.onMessage(m));
  }

  get transport(): BusEndpoint['kind'] {
    return this.ep.kind;
  }

  get available(): boolean {
    return !this.openerClosed && this.ep.alive();
  }

  /** Swap to a new endpoint (a new port from a relaunch or a new operator tab). */
  replaceEndpoint(ep: BusEndpoint): void {
    this.unsub();
    this.ep.close();
    this.ep = ep;
    this.openerClosed = false;
    this.unsub = ep.onMessage((m) => this.onMessage(m));
  }

  dispose(): void {
    this.unsub();
    this.ep.close();
  }

  ready(appliedSeq: number): void {
    this.post({ t: 'fallback.ready', v: 1, outputId: this.outputId, appliedSeq });
  }

  /**
   * Report media.ended / audio.ended to the operator while it is the authority (fallback bus). The id
   * lets the host de-duplicate a resend after a bus change.
   */
  sendEvent(event: LiveEvent, id: string = Math.random().toString(36).slice(2)): boolean {
    if (!this.available) return false;
    this.ep.post({ t: 'live.event', v: 1, id, event } as unknown as FallbackMessage);
    return true;
  }

  sendHealth(health: OutputHealth): void {
    this.post({ t: 'health', v: 1, health, outputId: this.outputId });
  }

  requestFile(hash: string): Promise<Blob | undefined> {
    const reqId = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      this.pendingFiles.set(reqId, resolve);
      this.post({ t: 'fallback.file', v: 1, hash, reqId });
      setTimeout(() => {
        if (this.pendingFiles.delete(reqId)) resolve(undefined);
      }, 30_000);
    });
  }

  private post(m: FallbackMessage): void {
    if (!this.available) return;
    this.ep.post(m);
  }

  private onMessage(m: FallbackMessage): void {
    this.lastTraffic = Date.now();
    switch (m.t) {
      case 'fallback.hello':
        this.emit('hello', { seq: m.seq });
        return;
      case 'live.state':
        this.emit('state', m);
        return;
      case 'live.delta':
        this.emit('delta', m);
        return;
      case 'fallback.hub':
        this.emit('hub', { hubUp: m.hubUp });
        return;
      case 'fallback.file.res': {
        const r = this.pendingFiles.get(m.reqId);
        if (r) {
          this.pendingFiles.delete(m.reqId);
          r(m.blob);
        }
        return;
      }
    }
  }
}

/** Message a role window receives from the operator carrying its bus port (transferred). */
export const PORT_OFFER = 'ordo.port';
export type PortOffer = { t: typeof PORT_OFFER; v: 1; outputId: string };

/**
 * Operator main thread: create a channel for one opened window, post one end to it, return the other end
 * (to be transferred into the operator's core worker or wrapped with portEndpoint).
 * Re-offer after the window navigates (load) or when re-acquired; the window keeps the newest port.
 */
export function offerPort(win: Window, origin: string, outputId: string): MessagePort {
  const ch = new MessageChannel();
  const offer: PortOffer = { t: PORT_OFFER, v: 1, outputId };
  win.postMessage(offer, origin, [ch.port2]);
  return ch.port1;
}

/**
 * Role-window main thread: accept bus ports from window.opener at the operator origin. Calls `onPort`
 * with each new port (newest wins). Returns an unsubscribe function.
 */
export function acceptPorts(operatorOrigin: string, onPort: (port: MessagePort) => void): () => void {
  const listener = (ev: MessageEvent) => {
    if (ev.source !== window.opener || ev.origin !== operatorOrigin) return;
    const d = ev.data as Partial<PortOffer> | undefined;
    if (!d || d.t !== PORT_OFFER || d.v !== PROTOCOL_VERSION) return;
    const port = ev.ports[0];
    if (port) onPort(port);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/**
 * Role-window → opener: "my bus port is gone, offer a new one". A role window sends it when its link
 * worker restarted (the port it held died with the worker). The operator answers with `offerPort` for
 * that window; until it does, the window's legacy window.postMessage relay keeps the bus working.
 */
export const PORT_REQUEST = 'ordo.port.request';
export type PortRequest = { t: typeof PORT_REQUEST; v: 1; outputId: string };

/** Role-window main thread: ask window.opener for a fresh bus port. False when there is no opener. */
export function requestPort(operatorOrigin: string, outputId: string): boolean {
  try {
    const op = window.opener as Window | null;
    if (!op || op.closed) return false;
    op.postMessage({ t: PORT_REQUEST, v: PROTOCOL_VERSION, outputId } satisfies PortRequest, operatorOrigin);
    return true;
  } catch {
    return false;
  }
}

/** Operator side: whether `data` is a port request (check the event's source and origin as well). */
export function isPortRequest(data: unknown): data is PortRequest {
  const d = data as Partial<PortRequest> | undefined;
  return !!d && d.t === PORT_REQUEST && d.v === PROTOCOL_VERSION && typeof d.outputId === 'string';
}

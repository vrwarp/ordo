import type { LiveEvent, LiveState } from '@ordo/domain';
import {
  type FallbackMessage,
  type LiveDeltaMsg,
  type LiveStateMsg,
  type OutputHealth,
  PROTOCOL_VERSION,
} from '@ordo/protocol';
import { Emitter } from './emitter.ts';

type Win = { win: Window; origin: string; ready: boolean };

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
  private listener = (ev: MessageEvent) => this.onMessage(ev);
  private seenEvents: string[] = [];
  private seenEventSet = new Set<string>();
  getFile?: (hash: string) => Promise<Blob | undefined>;

  constructor() {
    super();
    if (typeof window !== 'undefined') window.addEventListener('message', this.listener);
  }

  dispose(): void {
    if (typeof window !== 'undefined') window.removeEventListener('message', this.listener);
    clearInterval(this.timer);
  }

  register(outputId: string, win: Window, origin: string): void {
    const w: Win = { win, origin, ready: false };
    this.windows.set(outputId, w);
    // A window acquired while the hub is the authority may still be on an older tab's fallback bus.
    if (!this.active) this.postTo(w, { t: 'fallback.hub', v: 1, hubUp: true });
  }

  unregister(outputId: string): void {
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
      if (w.win.closed) continue;
      if (w.ready) this.postTo(w, { t: 'fallback.hub', v: 1, hubUp: false });
      else this.postTo(w, { t: 'fallback.hello', v: 1, seq: this.lastState.seq, operatorMs: Date.now() });
    }
  }

  private post(m: FallbackMessage): void {
    for (const w of this.windows.values()) this.postTo(w, m);
  }

  private postTo(w: Win, m: FallbackMessage): void {
    try {
      if (!w.win.closed) w.win.postMessage(m, w.origin);
    } catch {
      /* window gone */
    }
  }

  private seenEvent(id: string | undefined): boolean {
    if (!id) return false;
    if (this.seenEventSet.has(id)) return true;
    this.seenEventSet.add(id);
    this.seenEvents.push(id);
    if (this.seenEvents.length > RECENT_EVENT_IDS) this.seenEventSet.delete(this.seenEvents.shift()!);
    return false;
  }

  private onMessage(ev: MessageEvent): void {
    let entry: [string, Win] | undefined;
    for (const e of this.windows) if (e[1].win === ev.source) entry = e;
    if (!entry || ev.origin !== entry[1].origin) return;
    const [outputId, w] = entry;
    const m = ev.data as FallbackMessage;
    if (!m || typeof m !== 'object' || m.v !== PROTOCOL_VERSION) return;
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
  private listener = (ev: MessageEvent) => this.onMessage(ev);
  /** Time of the last accepted message from the operator (0 before the first). */
  lastTraffic = 0;

  constructor(
    private operatorOrigin: string,
    private outputId: string,
  ) {
    super();
    window.addEventListener('message', this.listener);
  }

  get available(): boolean {
    try {
      return !!window.opener && !(window.opener as Window).closed;
    } catch {
      return false;
    }
  }

  dispose(): void {
    window.removeEventListener('message', this.listener);
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
    try {
      (window.opener as Window).postMessage({ t: 'live.event', v: 1, id, event }, this.operatorOrigin);
      return true;
    } catch {
      return false;
    }
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
    try {
      (window.opener as Window).postMessage(m, this.operatorOrigin);
    } catch {
      /* opener navigated away */
    }
  }

  private onMessage(ev: MessageEvent): void {
    if (ev.source !== window.opener || ev.origin !== this.operatorOrigin) return;
    const m = ev.data as FallbackMessage;
    if (!m || typeof m !== 'object' || m.v !== PROTOCOL_VERSION) return;
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

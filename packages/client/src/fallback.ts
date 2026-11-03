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

/**
 * Operator side of the fallback bus. Holds the WindowProxy of every output and stage window it opened,
 * and, while the hub is unreachable, acts as the hub for them over postMessage.
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
    this.windows.set(outputId, { win, origin, ready: false });
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
    this.timer = setInterval(() => this.announce(), 2000);
  }

  /** Hub is back: tell windows to return to their hub connection. */
  deactivate(): void {
    this.active = false;
    clearInterval(this.timer);
    this.post({ t: 'fallback.hub', v: 1, hubUp: true });
  }

  broadcastDelta(d: LiveDeltaMsg, state: LiveState): void {
    this.lastState = { t: 'live.state', v: 1, seq: state.seq, state };
    if (!this.active) return;
    for (const w of this.windows.values()) if (w.ready) this.postTo(w, d);
  }

  private announce(): void {
    if (!this.lastState) return;
    for (const w of this.windows.values()) {
      if (w.ready) continue;
      if (w.win.closed) continue;
      this.postTo(w, { t: 'fallback.hello', v: 1, seq: this.lastState.seq, operatorMs: Date.now() });
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
      this.emit('ready', { outputId, appliedSeq: m.appliedSeq });
    } else if (m.t === 'health') {
      this.emit('health', { outputId, health: m.health });
    } else if ((m as { t: string }).t === 'live.event') {
      const ev = (m as unknown as { event?: LiveEvent }).event;
      if (ev && (ev.k === 'media.ended' || ev.k === 'audio.ended'))
        this.emit('event', { outputId, event: ev });
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

  constructor(
    private operatorOrigin: string,
    private outputId: string,
  ) {
    super();
    window.addEventListener('message', this.listener);
  }

  get available(): boolean {
    return !!window.opener && !(window.opener as Window).closed;
  }

  dispose(): void {
    window.removeEventListener('message', this.listener);
  }

  ready(appliedSeq: number): void {
    this.post({ t: 'fallback.ready', v: 1, outputId: this.outputId, appliedSeq });
  }

  /** Report media.ended / audio.ended to the operator while it is the authority (fallback bus). */
  sendEvent(event: LiveEvent): void {
    const op = window.opener as Window | null;
    if (!op || op.closed) return;
    try {
      op.postMessage(
        { t: 'live.event', v: 1, id: Math.random().toString(36).slice(2), event },
        this.operatorOrigin,
      );
    } catch {
      /* opener gone */
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
    const op = window.opener as Window | null;
    if (!op || op.closed) return;
    try {
      op.postMessage(m, this.operatorOrigin);
    } catch {
      /* opener navigated away */
    }
  }

  private onMessage(ev: MessageEvent): void {
    if (ev.source !== window.opener || ev.origin !== this.operatorOrigin) return;
    const m = ev.data as FallbackMessage;
    if (!m || typeof m !== 'object' || m.v !== PROTOCOL_VERSION) return;
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

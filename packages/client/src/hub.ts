import {
  type Bye,
  type ClientMessage,
  type HealthSummary,
  type LibraryDelta,
  type LiveAck,
  type LiveDeltaMsg,
  type LiveStateMsg,
  PROTOCOL_VERSION,
  type Role,
  type ServerMessage,
  type TimePong,
  type Welcome,
} from '@ordo/protocol';
import { Emitter } from './emitter.ts';
import { clock as defaultClock, type HubClock } from './clock.ts';

/** A client message without the protocol version field (added on send). */
export type ClientMessageBody = ClientMessage extends infer T
  ? T extends unknown
    ? Omit<T, 'v'>
    : never
  : never;

export type RtcSignalIn = { t: 'rtc.signal'; v: 1; to: string; from: string; sdp?: unknown; ice?: unknown };

export type HubEvents = {
  status: { connected: boolean };
  welcome: Welcome;
  state: LiveStateMsg;
  delta: LiveDeltaMsg;
  ack: LiveAck;
  library: LibraryDelta;
  health: HealthSummary;
  rtc: RtcSignalIn;
  bye: Bye;
};

export type HubConnectionOptions = {
  role: Role;
  appVersion: string;
  outputId?: string;
  token?: string;
  clock?: HubClock;
  /** Override for tests. Default: ws(s)://<current host>/ws */
  url?: string;
  pingIntervalMs?: number;
};

/**
 * One WebSocket to the hub with hello, clock sync, liveness and automatic reconnect.
 * The connection is considered lost on close or after three unanswered pings.
 */
export class HubConnection extends Emitter<HubEvents> {
  private ws?: WebSocket;
  private stopped = false;
  private backoff = 500;
  private pingTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private unanswered = 0;
  private lastSeq?: number;
  readonly clock: HubClock;
  connected = false;

  constructor(private opts: HubConnectionOptions) {
    super();
    this.clock = opts.clock ?? defaultClock;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.setConnected(false);
  }

  /** Force a reconnect (used when liveness fails). */
  kick(): void {
    this.ws?.close();
  }

  noteSeq(seq: number): void {
    this.lastSeq = seq;
  }

  send(m: ClientMessageBody): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.connected) return false;
    this.ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION }));
    return true;
  }

  private url(): string {
    if (this.opts.url) return this.opts.url;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = this.opts.token ? `?token=${encodeURIComponent(this.opts.token)}` : '';
    return `${proto}//${location.host}/ws${q}`;
  }

  private open(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          t: 'hello',
          v: PROTOCOL_VERSION,
          role: this.opts.role,
          outputId: this.opts.outputId,
          appVersion: this.opts.appVersion,
          lastSeq: this.lastSeq,
        }),
      );
    };
    ws.onmessage = (ev) => this.onMessage(ev.data as string);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.setConnected(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* close follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), this.backoff);
    this.backoff = Math.min(5000, this.backoff * 2);
  }

  private ping(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.unanswered++;
    if (this.unanswered > 3) {
      this.ws.close();
      return;
    }
    this.ws.send(JSON.stringify({ t: 'time.ping', v: PROTOCOL_VERSION, c: Date.now() }));
  }

  private onMessage(raw: string): void {
    let m: ServerMessage;
    try {
      m = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (m.t) {
      case 'welcome': {
        this.backoff = 500;
        this.unanswered = 0;
        this.clock.addSample(Date.now(), m.hubMs, Date.now());
        this.setConnected(true);
        // A burst of pings for a good initial offset, then one every interval.
        for (let i = 0; i < 4; i++) setTimeout(() => this.ping(), 30 * i);
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.ping(), this.opts.pingIntervalMs ?? 10_000);
        this.emit('welcome', m);
        return;
      }
      case 'time.pong': {
        const p = m as TimePong;
        this.unanswered = 0;
        this.clock.addSample(p.c, p.s, Date.now());
        return;
      }
      case 'live.state':
        this.lastSeq = m.seq;
        this.emit('state', m);
        return;
      case 'live.delta':
        this.lastSeq = m.seq;
        this.emit('delta', m);
        return;
      case 'live.ack':
        this.emit('ack', m);
        return;
      case 'library.delta':
        this.emit('library', m);
        return;
      case 'health.summary':
        this.emit('health', m);
        return;
      case 'rtc.signal':
        this.emit('rtc', m as RtcSignalIn);
        return;
      case 'bye':
        this.emit('bye', m);
        if (m.reason === 'version' && typeof location !== 'undefined')
          setTimeout(() => location.reload(), 500);
        return;
    }
  }

  private setConnected(c: boolean): void {
    if (this.connected === c) return;
    this.connected = c;
    this.emit('status', { connected: c });
  }
}

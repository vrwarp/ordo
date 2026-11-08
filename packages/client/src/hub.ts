import { DEMO } from './demo.ts';
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
/** "Send to preview" relayed by the hub to one idle output (protocol PreviewMsg). */
export type PreviewIn = {
  t: 'preview';
  v: 1;
  to: string;
  from: string;
  presentation?: unknown;
  slideId?: string;
  clear?: boolean;
};

export type HubEvents = {
  status: { connected: boolean };
  welcome: Welcome;
  state: LiveStateMsg;
  delta: LiveDeltaMsg;
  ack: LiveAck;
  library: LibraryDelta;
  health: HealthSummary;
  rtc: RtcSignalIn;
  preview: PreviewIn;
  bye: Bye;
  /**
   * The hub refused this client's credentials (`bye unauthorized` or `forbidden`: an expired session, a
   * revoked token). Not a hub loss: the hub is up and answering. Reconnects back off to AUTH_RETRY_MS and
   * beyond until `resume()` (after a new sign-in) or a welcome.
   */
  auth: { reason: 'unauthorized' | 'forbidden' };
  /** Liveness failed: the socket was discarded without waiting for a close handshake. */
  lost: { sincePongMs: number };
};

export type HubConnectionOptions = {
  role: Role;
  appVersion: string;
  outputId?: string;
  token?: string;
  clock?: HubClock;
  /** Override for tests. Default: ws(s)://<current host>/ws */
  url?: string;
  /** Ping period while no playlist is live (default 10 s). */
  pingIntervalMs?: number;
  /** Ping period while a playlist is live (default 3 s). */
  livePingIntervalMs?: number;
  /** Declare the connection lost after this long without a pong (default 9 s live, 3 × idle period idle). */
  lostAfterMs?: number;
};

export const IDLE_PING_MS = 10_000;
export const LIVE_PING_MS = 3000;
export const LIVE_LOST_MS = 9000;
/** First reconnect delay after the hub refused the credentials (doubles up to AUTH_RETRY_MAX_MS). */
export const AUTH_RETRY_MS = 30_000;
export const AUTH_RETRY_MAX_MS = 120_000;
/** How often liveness is judged (independent of the ping period, so loss is noticed within a second). */
const CHECK_MS = 1000;

/**
 * One WebSocket to the hub with hello, clock sync, liveness and automatic reconnect.
 *
 * Liveness is judged by the time since the last pong (or welcome), never by counting sent pings: the
 * clock-seeding burst after welcome does not count, and a slow pong only delays the estimate. While a
 * playlist is live the hub is pinged every 3 s and the connection is declared lost after 9 s without a
 * pong; idle, every 10 s and 30 s. On loss the socket is discarded at once (no close handshake, which
 * never completes on a dead peer), `status { connected: false }` fires and a reconnect is scheduled.
 */
export class HubConnection extends Emitter<HubEvents> {
  private ws?: WebSocket;
  private stopped = false;
  private backoff = 500;
  private pingTimer?: ReturnType<typeof setInterval>;
  private checkTimer?: ReturnType<typeof setInterval>;
  private burstTimers: ReturnType<typeof setTimeout>[] = [];
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private lastPong = 0;
  private lastSeq?: number;
  private live = false;
  private authRetry = AUTH_RETRY_MS;
  /** The hub refused the credentials; cleared by a welcome or `resume()`. */
  authBlocked = false;
  readonly clock: HubClock;
  connected = false;

  constructor(private opts: HubConnectionOptions) {
    super();
    this.clock = opts.clock ?? defaultClock;
  }

  start(): void {
    this.stopped = false;
    // The GitHub Pages demo has no hub to connect to (demo.ts): stay disconnected.
    if (DEMO) return;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      this.detach(ws);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.setConnected(false);
  }

  /**
   * Reconnect now after the credentials were renewed (a new sign-in): clears the auth back-off. A no-op
   * while connected.
   */
  resume(): void {
    this.authBlocked = false;
    this.authRetry = AUTH_RETRY_MS;
    this.backoff = 500;
    if (this.stopped || this.ws) return;
    clearTimeout(this.reconnectTimer);
    this.open();
  }

  /** Force a reconnect: drop the socket now and reconnect after the backoff. */
  kick(): void {
    this.lose('kicked');
  }

  noteSeq(seq: number): void {
    this.lastSeq = seq;
  }

  /**
   * Whether a playlist is live, which selects the ping period. Learned from the hub's own state
   * messages; callers that know better (the operator in fallback) may set it too.
   */
  setLive(on: boolean): void {
    if (this.live === on) return;
    this.live = on;
    if (this.connected) this.startPinging();
  }

  get isLive(): boolean {
    return this.live;
  }

  /** Milliseconds since the last pong or welcome (Infinity before the first connection). */
  get sincePongMs(): number {
    return this.lastPong ? Date.now() - this.lastPong : Number.POSITIVE_INFINITY;
  }

  get pingIntervalMs(): number {
    return this.live
      ? (this.opts.livePingIntervalMs ?? LIVE_PING_MS)
      : (this.opts.pingIntervalMs ?? IDLE_PING_MS);
  }

  get lostAfterMs(): number {
    if (this.opts.lostAfterMs) return this.opts.lostAfterMs;
    return this.live ? LIVE_LOST_MS : 3 * (this.opts.pingIntervalMs ?? IDLE_PING_MS);
  }

  send(m: ClientMessageBody): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.connected) return false;
    try {
      this.ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION }));
    } catch {
      return false;
    }
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
      if (this.ws !== ws) return;
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
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(ev.data as string);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.clearTimers();
      this.setConnected(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* close follows */
    };
  }

  private detach(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }

  /** Liveness failed (or a kick): discard the socket without a handshake and reconnect. */
  private lose(reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    const since = this.sincePongMs;
    this.ws = undefined;
    this.clearTimers();
    this.detach(ws);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    this.setConnected(false);
    if (reason === 'liveness') this.emit('lost', { sincePongMs: since });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    if (this.authBlocked) {
      // Refused credentials do not get better by hammering the hub every 5 s (review item 5).
      this.reconnectTimer = setTimeout(() => this.open(), this.authRetry);
      this.authRetry = Math.min(AUTH_RETRY_MAX_MS, this.authRetry * 2);
      return;
    }
    this.reconnectTimer = setTimeout(() => this.open(), this.backoff);
    this.backoff = Math.min(5000, this.backoff * 2);
  }

  private clearTimers(): void {
    clearInterval(this.pingTimer);
    clearInterval(this.checkTimer);
    this.pingTimer = undefined;
    this.checkTimer = undefined;
    for (const t of this.burstTimers) clearTimeout(t);
    this.burstTimers = [];
  }

  private startPinging(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);
    if (!this.checkTimer) this.checkTimer = setInterval(() => this.check(), CHECK_MS);
  }

  private check(): void {
    if (!this.ws || !this.connected) return;
    if (this.sincePongMs >= this.lostAfterMs) this.lose('liveness');
  }

  private ping(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ t: 'time.ping', v: PROTOCOL_VERSION, c: Date.now() }));
    } catch {
      /* the close event follows */
    }
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
        this.authBlocked = false;
        this.authRetry = AUTH_RETRY_MS;
        this.lastPong = Date.now();
        this.clock.addSample(Date.now(), m.hubMs, Date.now());
        this.setConnected(true);
        // A burst of pings for a good initial offset (min-RTT selection); they do not count for liveness.
        this.clearTimers();
        for (let i = 0; i < 4; i++) this.burstTimers.push(setTimeout(() => this.ping(), 30 * i));
        this.startPinging();
        this.emit('welcome', m);
        return;
      }
      case 'time.pong': {
        const p = m as TimePong;
        this.lastPong = Date.now();
        this.clock.addSample(p.c, p.s, Date.now());
        return;
      }
      case 'live.state':
        this.lastSeq = m.seq;
        this.setLive(m.state.mode === 'live');
        this.emit('state', m);
        return;
      case 'live.delta':
        this.lastSeq = m.seq;
        if (m.event.k === 'goLive') this.setLive(true);
        else if (m.event.k === 'endService') this.setLive(false);
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
      case 'preview':
        this.emit('preview', m as PreviewIn);
        return;
      case 'bye':
        // Refused credentials: flag it before the close (and its status event) follows, so listeners can
        // tell an auth refusal from a hub loss.
        if (m.reason === 'unauthorized' || m.reason === 'forbidden') {
          const first = !this.authBlocked;
          this.authBlocked = true;
          this.emit('bye', m);
          if (first) this.emit('auth', { reason: m.reason });
          return;
        }
        this.emit('bye', m);
        // On the main thread a stale app reloads itself; inside a worker the host decides (it sees 'bye').
        if (m.reason === 'version' && typeof document !== 'undefined' && typeof location !== 'undefined')
          setTimeout(() => location.reload(), 500);
        // A newer window took this output's place: never reconnect (the window closes itself).
        if (m.reason === 'superseded') this.stop();
        return;
    }
  }

  private setConnected(c: boolean): void {
    if (this.connected === c) return;
    this.connected = c;
    this.emit('status', { connected: c });
  }
}

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { LiveState, Output } from '@ordo/domain';
import {
  APP_VERSION,
  COOKIE_SESSION,
  HEADER_TOKEN,
  type LibraryKind,
  type OutputHealth,
  type OutputHealthEntry,
  parseClientMessage,
  PROTOCOL_VERSION,
  type Role,
  type ServerMessage,
  type SessionCap,
} from '@ordo/protocol';
import type { Logger } from 'pino';
import { WebSocket, WebSocketServer } from 'ws';
import { type Auth, capAtLeast, type Principal } from './auth.ts';
import { CLIENT_MESSAGE_CAP, SERVER_MESSAGE_CAP } from './caps.ts';
import { errorMessage, HttpError } from './errors.ts';
import type { Change } from './library.ts';
import { LiveRejection, type LiveService } from './live.ts';
import { originAllowed } from './net.ts';

export const QUEUE_LIMIT = 100;
const HEALTH_STALE_MS = 3500;
/** Sessions slide on socket activity at most this often (one DB write per session per interval). */
export const SESSION_TOUCH_MS = 30_000;
/** Recently acknowledged command ids kept for de-duplication of re-submissions after a reconnect. */
export const RECENT_CMD_IDS = 1000;

/**
 * Per-socket limits (design/25 "WebSocket from clients"). A socket that breaks one is closed with
 * `bye` + 1008; it reconnects like after any blip, and no other socket is affected.
 * - MAX_MESSAGE_BYTES: every message, except the two that carry a whole state or presentation from the
 *   operator (`live.adopt`, `preview`), which may use MAX_LARGE_MESSAGE_BYTES.
 * - Rate: a token bucket of RATE_BURST messages refilled at RATE_PER_S (a held key auto-repeats at about
 *   30 per second; health and clock pings add a few).
 */
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_LARGE_MESSAGE_BYTES = 16 * 1024 * 1024;
export const RATE_BURST = 50;
export const RATE_PER_S = 50;

type Client = {
  ws: WebSocket;
  principal: Principal | null;
  /**
   * The session's cap (design/28 §3.3); 'full' for every other socket. Below full (a phone) the socket's
   * messages are checked against CLIENT_MESSAGE_CAP and SERVER_MESSAGE_CAP; a full socket runs no such check.
   */
  cap: SessionCap;
  role?: Role;
  outputId?: string;
  /**
   * A Pulpit Lectern on the stage output's link (hello `view: 'lectern'`): it gets the live state as the stage
   * does, but it is not the output's window (no superseding either way, no health, not counted as connected).
   */
  view?: 'lectern';
  /**
   * The id of the resolved copy this socket holds, as far as the hub knows (live-by-ref): what it said in its
   * hello or last resync, or the copy the hub wrote to it (a whole state, a goLive delta). A state for a socket
   * that holds the live copy is sent without it.
   */
  holds?: string;
  inflight: number;
  needsState: boolean;
  alive: boolean;
  ip: string;
  /** Last time this socket slid its session (session principals only). */
  touched: number;
  /** Token bucket for the message rate limit. */
  tokens: number;
  refilled: number;
};

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const EMPTY_HEALTH: OutputHealth = {
  presented: 0,
  missed: 0,
  longTasks: 0,
  lateFlips: 0,
  cache: { ready: 0, total: 0 },
  gpuLost: 0,
  videoDropped: 0,
};

/** All WebSocket clients: hello, live fan-out, library deltas, health, signalling. */
export class SocketHub {
  readonly wss: WebSocketServer;
  private clients = new Set<Client>();
  private health = new Map<string, { health: OutputHealth; lastSeen: number }>();
  private healthTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  /** Command id -> journal seq for the last RECENT_CMD_IDS accepted commands (insertion ordered). */
  private recentCmds = new Map<string, number>();
  /** Commands accepted for submission but not yet applied (queued behind a goLive). */
  private pendingCmds = new Map<string, Promise<number>>();
  /** The encoded `live.state` messages of the state object last sent, by variant (see `stateFrame`). */
  private framed?: { state: LiveState; whole?: Buffer; byName?: Buffer };

  /** Sockets closed for breaking a limit, by reason (diagnostics). */
  readonly limitClosures: Record<string, number> = {};

  private auth: Auth;
  private live: LiveService;
  private byRef: boolean;
  /** The configured outputs (for the health table); the Library's or the live process's cached copy. */
  private outputs: () => Output[];
  private log: Logger;
  private opts: {
    domain: string;
    healthIntervalMs: number;
    clientIp: (req: IncomingMessage) => string;
    /**
     * Are the output tokens known yet? The live process starts without its library context (live
     * started before the library, or a restore cleared the copies) and cannot tell a valid token from
     * a revoked one until it has it. Default: always.
     */
    contextReady?: () => boolean;
    /** ORDO_LIVE_BYREF (default on): states go by name to sockets that hold the copy. */
    byRef?: boolean;
  };
  constructor(
    auth: Auth,
    live: LiveService,
    outputs: () => Output[],
    log: Logger,
    opts: {
      domain: string;
      healthIntervalMs: number;
      clientIp: (req: IncomingMessage) => string;
      /**
       * Are the output tokens known yet? The live process starts without its library context (live
       * started before the library, or a restore cleared the copies) and cannot tell a valid token from
       * a revoked one until it has it. Default: always.
       */
      contextReady?: () => boolean;
      byRef?: boolean;
    },
  ) {
    this.auth = auth;
    this.live = live;
    this.byRef = opts.byRef ?? true;
    this.outputs = outputs;
    this.log = log;
    this.opts = opts;
    this.wss = new WebSocketServer({
      noServer: true,
      // The hard cap; per-message limits by type are enforced in attach().
      maxPayload: MAX_LARGE_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    // Command ids journalled before a restart still count: a command journalled just before a crash and
    // re-sent after the reconnect is acknowledged with its seq, not applied twice.
    for (const r of live.recentCommandIds(RECENT_CMD_IDS)) this.recentCmds.set(r.id, r.seq);
    live.onDelta((d) => this.broadcastDelta(d));
    live.onState((s) => this.broadcastState(s));
  }

  start(): void {
    this.healthTimer = setInterval(() => this.sendHealth(), this.opts.healthIntervalMs);
    this.healthTimer.unref();
    this.pingTimer = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }, 30_000);
    this.pingTimer.unref();
  }

  async close(): Promise<void> {
    clearInterval(this.healthTimer);
    clearInterval(this.pingTimer);
    for (const c of this.clients) {
      this.send(c, { t: 'bye', v: 1, reason: 'shutdown' });
      c.ws.close(1001, 'shutdown');
    }
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  /** Close every socket of an output (after token rotation). */
  disconnectOutput(outputId: string, reason: string): void {
    for (const c of this.clients) if (c.outputId === outputId) this.bye(c, reason);
  }

  get size(): number {
    return this.clients.size;
  }

  /** Origin must be the request's own host or one of the venue's role hosts (net.ts `originAllowed`). */
  originAllowed(req: IncomingMessage): boolean {
    return originAllowed(req.headers.origin, req.headers.host ?? '', this.opts.domain);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!this.originAllowed(req)) {
      this.log.warn({ origin: req.headers.origin }, 'websocket origin rejected');
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const tokenHeader = req.headers[HEADER_TOKEN];
    const token =
      url.searchParams.get('token') ?? (typeof tokenHeader === 'string' ? tokenHeader : undefined);
    const principal = this.auth.principal({
      cookie: parseCookies(req.headers.cookie)[COOKIE_SESSION],
      token,
    });
    const ip = this.opts.clientIp(req);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, principal, ip, !!token));
  }

  private attach(ws: WebSocket, principal: Principal | null, ip: string, hadToken: boolean): void {
    const now = Date.now();
    const c: Client = {
      ws,
      principal,
      cap: principal?.kind === 'session' ? principal.cap : 'full',
      inflight: 0,
      needsState: false,
      alive: true,
      ip,
      touched: now,
      tokens: RATE_BURST,
      refilled: now,
    };
    this.clients.add(c);
    ws.on('pong', () => {
      c.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        const bytes = Array.isArray(data)
          ? data.reduce((n, b) => n + b.length, 0)
          : (data as Buffer | ArrayBuffer).byteLength;
        if (!this.withinRate(c)) return this.closeForLimit(c, 'rate-limited');
        const raw = data.toString();
        if (bytes > MAX_MESSAGE_BYTES && !this.largeAllowed(c, raw))
          return this.closeForLimit(c, 'too-large');
        if (!this.touchSession(c)) return;
        this.onMessage(c, raw);
      } catch (e) {
        this.log.error({ err: errorMessage(e) }, 'ws message handler failed');
      }
    });
    ws.on('close', () => {
      this.clients.delete(c);
      if (c.outputId) this.sendHealth();
    });
    ws.on('error', () => ws.terminate());
    if (!principal) {
      if (hadToken && !(this.opts.contextReady?.() ?? true)) {
        // The token may well be valid: without the library context there is no list to check it against.
        // `retry` is a plain reconnect for the client (back in 0.5 to 5 s), not an auth refusal (which
        // backs off for minutes and tells the operator the output was revoked).
        this.log.info({ ip }, 'websocket with an output token before the library context; asking to retry');
        this.bye(c, 'retry');
        return;
      }
      // PRD 09: unauthenticated sockets are closed after the first message (or a short grace period).
      if (hadToken) this.log.warn({ ip }, 'websocket with an invalid output token');
      const t = setTimeout(() => this.bye(c, 'unauthorized'), 5000);
      ws.once('message', () => {
        clearTimeout(t);
        this.bye(c, 'unauthorized');
      });
    }
  }

  /** Token bucket: RATE_BURST messages, refilled at RATE_PER_S. */
  private withinRate(c: Client, now = Date.now()): boolean {
    c.tokens = Math.min(RATE_BURST, c.tokens + ((now - c.refilled) / 1000) * RATE_PER_S);
    c.refilled = now;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  }

  /** Only an operator's `live.adopt` and `preview` may exceed MAX_MESSAGE_BYTES. */
  private largeAllowed(c: Client, raw: string): boolean {
    if (c.role !== 'operate') return false;
    // Look for the type without parsing megabytes first; the full parse below validates it properly.
    const m =
      /"t"\s*:\s*"(live\.adopt|preview)"/.exec(raw.slice(0, 4096)) ??
      /"t"\s*:\s*"(live\.adopt|preview)"/.exec(raw.slice(-4096));
    return !!m;
  }

  private closeForLimit(c: Client, reason: string): void {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    this.limitClosures[reason] = (this.limitClosures[reason] ?? 0) + 1;
    this.log.warn(
      { ip: c.ip, role: c.role, outputId: c.outputId, reason },
      'websocket closed for breaking a limit',
    );
    this.send(c, { t: 'bye', v: 1, reason });
    c.ws.close(1008, reason);
    // A flooding client may ignore the close handshake.
    setTimeout(() => c.ws.terminate(), 1000).unref();
  }

  /**
   * Every message (pings included) counts as activity for a session principal: the session slides at
   * most every SESSION_TOUCH_MS, and a session that was ended meanwhile (PIN change, logout, expiry)
   * closes the socket. Returns false when the socket was closed.
   */
  private touchSession(c: Client, now = Date.now()): boolean {
    const p = c.principal;
    if (p?.kind !== 'session') return true;
    if (now - c.touched < SESSION_TOUCH_MS) return true;
    c.touched = now;
    if (this.auth.touchSession(p.sessionId, now)) return true;
    this.log.info({ role: p.role }, 'websocket session ended; closing socket');
    c.principal = null;
    this.bye(c, 'unauthorized');
    return false;
  }

  /** Remember an accepted command id so a re-submission after a reconnect is acknowledged, not re-applied. */
  private rememberCmd(id: string, seq: number): void {
    if (this.recentCmds.has(id)) this.recentCmds.delete(id);
    this.recentCmds.set(id, seq);
    if (this.recentCmds.size > RECENT_CMD_IDS) {
      const oldest = this.recentCmds.keys().next().value;
      if (oldest !== undefined) this.recentCmds.delete(oldest);
    }
  }

  /** Seq of a recently accepted command id (tests and diagnostics). */
  recentCommandSeq(id: string): number | undefined {
    return this.recentCmds.get(id);
  }

  private bye(c: Client, reason: string): void {
    this.send(c, { t: 'bye', v: 1, reason });
    setTimeout(() => c.ws.close(4000, reason), 20).unref();
  }

  /**
   * A message is an object (stringified here), a string, or a Buffer that already holds the encoded message:
   * the live state and a goLive delta are encoded once and the same bytes go to every socket, as a text frame
   * (`binary: false`: a browser receives a string). A string would be encoded again for every socket.
   */
  private send(c: Client, m: ServerMessage | string | Buffer): void {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    // A capped socket never receives what its cap does not reach (the broadcasts that build a string already
    // skip edit sockets for live state, health and signalling).
    const typed = typeof m !== 'string' && !Buffer.isBuffer(m);
    if (c.cap !== 'full' && typed && !capAtLeast(c.cap, SERVER_MESSAGE_CAP[m.t])) return;
    c.inflight++;
    const done = () => {
      c.inflight--;
      if (c.needsState && c.inflight < QUEUE_LIMIT / 4) {
        c.needsState = false;
        this.sendState(c);
      }
    };
    if (typed) c.ws.send(JSON.stringify(m), done);
    else c.ws.send(m, { binary: false }, done);
  }

  /**
   * The live state as the bytes of one `live.state` message, encoded once per variant for the state object it
   * was built from (the reducer makes a new object at every event, so the cache is dropped with it): the state
   * without its copy and cue list is stringified (small), the cue list's JSON comes from the live service's
   * cache and, for the whole variant, the copy's bytes are spliced in. Nothing here stringifies the copy or the
   * cue list. While a service is live (and ORDO_LIVE_BYREF is on) the message carries the copy's id; the by-name
   * variant leaves the copy out (live-by-ref).
   */
  private stateFrame(byName: boolean): Buffer {
    const s = this.live.state;
    if (this.framed?.state !== s) this.framed = { state: s };
    const cached = byName ? this.framed.byName : this.framed.whole;
    if (cached) return cached;
    const { resolved: _r, cues: _c, ...rest } = s;
    const head = JSON.stringify(rest);
    const copy = s.mode === 'live' && s.resolved ? this.live.resolvedCopy() : undefined;
    const open = head.length > 2 ? `${head.slice(0, -1)},` : '{';
    const lead = `{"t":"live.state","v":${PROTOCOL_VERSION},"seq":${s.seq},"state":${open}"cues":${this.live.cuesJson(s.cues)}`;
    const idPart = copy && this.byRef ? `,"resolvedId":"${copy.id}"` : '';
    const frame =
      copy && !byName
        ? Buffer.concat([Buffer.from(`${lead},"resolved":`), copy.json, Buffer.from(`}${idPart}}`)])
        : Buffer.from(`${lead}}${idPart}}`);
    if (byName) this.framed.byName = frame;
    else this.framed.whole = frame;
    return frame;
  }

  /**
   * The state for one socket: by name when it holds the live copy, else whole (and then it holds it). Idle, or
   * with ORDO_LIVE_BYREF off, every state is whole and no socket is ever recorded as holding a copy.
   */
  private frameFor(c: Client): Buffer {
    const s = this.live.state;
    if (!this.byRef || s.mode !== 'live' || !s.resolved) return this.stateFrame(false);
    const id = this.live.resolvedCopy()!.id;
    if (c.holds === id) return this.stateFrame(true);
    c.holds = id;
    return this.stateFrame(false);
  }

  private sendState(c: Client): void {
    this.send(c, this.frameFor(c));
  }

  private receivesLive(c: Client): boolean {
    return !!c.role && c.role !== 'edit';
  }

  private onMessage(c: Client, raw: string) {
    if (!c.principal) return;
    const m = parseClientMessage(raw);
    if ('error' in m) {
      let t: unknown;
      try {
        t = (JSON.parse(raw) as { t?: unknown; v?: unknown }).t;
        if (t === 'hello') return this.bye(c, 'version');
      } catch {
        /* ignore */
      }
      this.log.debug({ err: m.error }, 'bad ws message');
      return;
    }
    if (m.t !== 'hello' && !c.role) return;
    // A capped socket (a phone) sends only what its cap reaches: a live command is refused with an ack, the rest
    // is dropped (design/28 §3.3, §10 item 1).
    if (c.cap !== 'full' && !capAtLeast(c.cap, CLIENT_MESSAGE_CAP[m.t])) {
      if (m.t === 'live.event') this.send(c, { t: 'live.ack', v: 1, id: m.id, rejected: 'forbidden: cap' });
      return;
    }
    switch (m.t) {
      case 'hello': {
        if (m.appVersion !== APP_VERSION) return this.bye(c, 'version');
        const p = c.principal;
        let role: Role;
        if (p.kind === 'token') {
          if (m.role !== p.role || (m.outputId && m.outputId !== p.outputId)) return this.bye(c, 'forbidden');
          role = p.role;
          c.outputId = p.outputId;
        } else {
          if (m.role === 'operate' && p.role === 'operate') role = 'operate';
          else if (m.role === 'edit') role = 'edit';
          else return this.bye(c, 'forbidden');
        }
        c.role = role;
        c.holds = this.byRef ? m.resolvedId : undefined;
        // Only the stage output has a lectern; any other window that says so is the output's own window.
        if (role === 'stage' && m.view === 'lectern') c.view = 'lectern';
        if (c.outputId && !c.view) {
          // A newer window for this output (a Relaunch from another operator tab, which cannot reach the
          // old window by name) supersedes any older one, which closes itself on this bye (item 1). A Pulpit
          // Lectern opened on the stage output's link is neither: it never replaces the Stage Display window,
          // nor a newer display it (any number of lecterns follow one stage output).
          for (const o of this.clients) {
            if (o === c || !o.role || o.outputId !== c.outputId || o.view) continue;
            this.log.info({ outputId: c.outputId }, 'output window superseded by a newer one');
            this.bye(o, 'superseded');
          }
        }
        this.send(c, {
          t: 'welcome',
          v: 1,
          hubMs: Date.now(),
          seq: this.live.state.seq,
          role,
          appVersion: APP_VERSION,
        });
        if (this.receivesLive(c)) this.sendState(c);
        if (role === 'operate') this.sendHealth(c);
        if (c.outputId && !c.view) {
          const h = this.health.get(c.outputId);
          this.health.set(c.outputId, { health: h?.health ?? EMPTY_HEALTH, lastSeen: Date.now() });
        }
        return;
      }
      case 'time.ping':
        return this.send(c, { t: 'time.pong', v: 1, c: m.c, s: Date.now() });
      case 'live.resync':
        // A resync says what the socket holds now: nothing, when it does not say.
        c.holds = this.byRef ? m.resolvedId : undefined;
        if (this.receivesLive(c)) this.sendState(c);
        return;
      case 'live.event': {
        if (c.role === 'edit')
          return this.send(c, { t: 'live.ack', v: 1, id: m.id, rejected: 'forbidden: edit role' });
        // A command re-submitted after a reconnect (its ack or delta was lost in the blip) is already
        // journalled: acknowledge it with the seq it got, without applying it twice.
        const dup = this.recentCmds.get(m.id);
        if (dup !== undefined) {
          this.log.debug({ id: m.id, seq: dup }, 'duplicate command id acknowledged');
          return this.send(c, { t: 'live.ack', v: 1, id: m.id, seq: dup });
        }
        const id = m.id;
        const ack = (seq: number) => this.send(c, { t: 'live.ack', v: 1, id, seq });
        const nack = (e: unknown) => this.send(c, { t: 'live.ack', v: 1, id, rejected: errorMessage(e) });
        // A re-submission of a command still waiting in the queue (behind a goLive) gets the same answer.
        const pending = this.pendingCmds.get(id);
        if (pending) {
          pending.then(ack, nack);
          return;
        }
        try {
          const origin =
            c.role === 'operate'
              ? { role: 'operate' as const, id }
              : { role: c.role as 'output' | 'stage', outputId: c.outputId!, id };
          const p = this.live.submitQueued(m.event, origin);
          this.pendingCmds.set(id, p);
          p.finally(() => this.pendingCmds.delete(id)).catch(() => undefined);
          p.then(
            (seq) => {
              this.rememberCmd(id, seq);
              ack(seq);
            },
            (e: unknown) => {
              if (!(e instanceof LiveRejection) && !(e instanceof HttpError))
                this.log.error({ err: errorMessage(e) }, 'live event failed');
              nack(e);
            },
          );
        } catch (e) {
          nack(e);
        }
        return;
      }
      case 'live.adopt': {
        if (c.role !== 'operate')
          return this.send(c, { t: 'live.ack', v: 1, id: 'adopt', rejected: 'forbidden' });
        const r = this.live.adopt(m.state, m.force);
        if (r.ok) this.send(c, { t: 'live.ack', v: 1, id: 'adopt', seq: r.seq });
        else {
          this.send(c, { t: 'live.ack', v: 1, id: 'adopt', rejected: r.reason });
          this.sendState(c);
        }
        return;
      }
      case 'health': {
        // The output's health is its own window's; a lectern's is not taken for it.
        if (!c.outputId || c.view) return;
        this.health.set(c.outputId, { health: m.health, lastSeen: Date.now() });
        return;
      }
      case 'rtc.signal': {
        if (c.role === 'edit') return;
        const from = c.role === 'operate' ? 'operator' : c.outputId!;
        const out = JSON.stringify({ ...m, from });
        for (const o of this.clients) {
          if (o === c || !o.role) continue;
          if (m.to === 'operator' ? o.role === 'operate' : o.outputId === m.to) this.send(o, out);
        }
        return;
      }
      // ---- preview relay (prd/03 "Send to preview"): operator -> one output, like rtc.signal ----
      case 'preview': {
        if (c.role !== 'operate') return;
        const out = JSON.stringify({ ...m, from: 'operator' });
        for (const o of this.clients) if (o !== c && o.role && o.outputId === m.to) this.send(o, out);
        return;
      }
      // ---- end preview relay ----
    }
  }

  /**
   * One delta message for every socket: a goLive's is assembled from the copy's bytes (the live service has
   * them: the prepared text), any other is small.
   */
  private deltaFrame(d: {
    seq: number;
    fromSeq: number;
    event: unknown;
    id?: string;
    copy?: { id: string; json: Uint8Array };
  }): Buffer {
    if (!d.copy)
      return Buffer.from(
        JSON.stringify({ t: 'live.delta', v: PROTOCOL_VERSION, seq: d.seq, fromSeq: d.fromSeq, event: d.event, id: d.id }),
      );
    const idPart = d.id === undefined ? '' : `"id":${JSON.stringify(d.id)},`;
    const copyId = this.byRef ? `"resolvedId":"${d.copy.id}",` : '';
    const lead = `{"t":"live.delta","v":${PROTOCOL_VERSION},"seq":${d.seq},"fromSeq":${d.fromSeq},${idPart}${copyId}"event":{"k":"goLive","resolved":`;
    return Buffer.concat([Buffer.from(lead), d.copy.json, Buffer.from('}}')]);
  }

  private broadcastDelta(d: {
    seq: number;
    fromSeq: number;
    event: unknown;
    id?: string;
    copy?: { id: string; json: Uint8Array };
  }): void {
    const raw = this.deltaFrame(d);
    for (const c of this.clients) {
      if (!this.receivesLive(c)) continue;
      if (c.needsState) continue;
      if (c.inflight > QUEUE_LIMIT) {
        // A slow socket gets a full state once its queue drains instead of a backlog of deltas.
        c.needsState = true;
        continue;
      }
      // A goLive delta carries the copy: the socket holds it from here. End service: nothing is held any more.
      if (this.byRef && d.copy) c.holds = d.copy.id;
      else if ((d.event as { k?: string }).k === 'endService') c.holds = undefined;
      this.send(c, raw);
    }
  }

  private broadcastState(_s: LiveState): void {
    for (const c of this.clients) if (this.receivesLive(c)) this.send(c, this.frameFor(c));
  }

  /**
   * Library changes to every client. Outputs and the stage get only ids of what their config holds:
   * `forOutputs` picks those (default: settings; the live process adds fonts and the logo media).
   */
  broadcastLibrary(
    changes: Change[],
    forOutputs: (ch: Change) => boolean = (ch) => ch.kind === 'settings',
  ): void {
    const tokens = (ch: Change) => ch.kind === 'settings' && ch.id === 'outputs' && Array.isArray(ch.entity);
    const strip = (ch: Change): Change =>
      tokens(ch)
        ? { ...ch, entity: (ch.entity as { token?: string }[]).map(({ token: _t, ...o }) => o) }
        : ch;
    // One stringify per delta (design/28 §3.4): the whole batch is serialised when the first session socket
    // needs it, and a second time without tokens only when the batch has outputs with tokens; otherwise edit
    // sockets get the same string (its bytes are those of the stripped one: strip changes nothing then).
    let full: string | undefined;
    let stripped: string | undefined;
    const needsStrip = changes.some(tokens);
    const fullMsg = () => {
      full ??= JSON.stringify({ t: 'library.delta', v: PROTOCOL_VERSION, changes });
      return full;
    };
    const strippedMsg = () => {
      if (!needsStrip) return fullMsg();
      stripped ??= JSON.stringify({ t: 'library.delta', v: PROTOCOL_VERSION, changes: changes.map(strip) });
      return stripped;
    };
    const relevant = changes.filter(forOutputs);
    const toOutputs = relevant.length
      ? JSON.stringify({
          t: 'library.delta',
          v: PROTOCOL_VERSION,
          changes: relevant.map((ch) => ({ kind: ch.kind, id: ch.id, rev: ch.rev })),
        })
      : undefined;
    for (const c of this.clients) {
      if (c.role === 'operate') this.send(c, fullMsg());
      else if (c.role === 'edit') this.send(c, strippedMsg());
      else if ((c.role === 'output' || c.role === 'stage') && toOutputs) this.send(c, toOutputs);
    }
  }

  /**
   * Tell outputs and the stage to refetch their config (a settings-only delta, ids only): the live
   * process's copy of the library context changed without a library delta (it came back after a restart).
   */
  broadcastConfigRefresh(): void {
    const m = JSON.stringify({
      t: 'library.delta',
      v: PROTOCOL_VERSION,
      changes: [{ kind: 'settings' satisfies LibraryKind, id: 'general' }],
    });
    for (const c of this.clients) if (c.role === 'output' || c.role === 'stage') this.send(c, m);
  }

  /** Per-output health with connection state, for the operator and diagnostics. */
  healthTable(): Record<string, OutputHealthEntry> {
    const now = Date.now();
    const connected = new Set<string>();
    for (const c of this.clients) if (c.outputId && c.role && !c.view) connected.add(c.outputId);
    const out: Record<string, OutputHealthEntry> = {};
    for (const o of this.outputs()) {
      const h = this.health.get(o.id);
      out[o.id] = {
        ...(h?.health ?? EMPTY_HEALTH),
        outputId: o.id,
        name: o.name,
        lastSeen: h?.lastSeen ?? 0,
        connected: connected.has(o.id) && !!h && now - h.lastSeen < HEALTH_STALE_MS,
      };
    }
    return out;
  }

  private sendHealth(target?: Client): void {
    const raw = JSON.stringify({ t: 'health.summary', v: PROTOCOL_VERSION, outputs: this.healthTable() });
    if (target) {
      if (target.role === 'operate') this.send(target, raw);
      return;
    }
    const ops = [...this.clients].filter((c) => c.role === 'operate');
    if (!ops.length) return;
    for (const c of ops) this.send(c, raw);
  }
}

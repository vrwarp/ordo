import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { LiveState } from '@ordo/domain';
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
} from '@ordo/protocol';
import type { Logger } from 'pino';
import { WebSocket, WebSocketServer } from 'ws';
import type { Auth, Principal } from './auth.ts';
import { errorMessage, HttpError } from './errors.ts';
import type { Change, Library } from './library.ts';
import { LiveRejection, type LiveService } from './live.ts';

export const QUEUE_LIMIT = 100;
const HEALTH_STALE_MS = 3500;

type Client = {
  ws: WebSocket;
  principal: Principal | null;
  role?: Role;
  outputId?: string;
  inflight: number;
  needsState: boolean;
  alive: boolean;
  ip: string;
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

  constructor(
    private auth: Auth,
    private live: LiveService,
    private lib: Library,
    private log: Logger,
    private opts: { domain: string; healthIntervalMs: number; clientIp: (req: IncomingMessage) => string },
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
    live.onDelta((d) => this.broadcastDelta(d));
    live.onState((s) => this.broadcastState(s));
    lib.onChange((changes) => this.broadcastLibrary(changes));
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

  /** Origin must be the request's own host or one of the venue's role hosts. */
  originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    let host: string;
    let hostname: string;
    try {
      const u = new URL(origin);
      host = u.host.toLowerCase();
      hostname = u.hostname.toLowerCase();
    } catch {
      return false;
    }
    if (host === (req.headers.host ?? '').toLowerCase()) return true;
    const d = this.opts.domain;
    return hostname === d || hostname.endsWith(`.${d}`);
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
    const token = url.searchParams.get('token') ?? (typeof tokenHeader === 'string' ? tokenHeader : undefined);
    const principal = this.auth.principal({ cookie: parseCookies(req.headers.cookie)[COOKIE_SESSION], token });
    const ip = this.opts.clientIp(req);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, principal, ip, !!token));
  }

  private attach(ws: WebSocket, principal: Principal | null, ip: string, hadToken: boolean): void {
    const c: Client = { ws, principal, inflight: 0, needsState: false, alive: true, ip };
    this.clients.add(c);
    ws.on('pong', () => {
      c.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        this.onMessage(c, data.toString());
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
      // PRD 09: unauthenticated sockets are closed after the first message (or a short grace period).
      if (hadToken) this.log.warn({ ip }, 'websocket with an invalid output token');
      const t = setTimeout(() => this.bye(c, 'unauthorized'), 5000);
      ws.once('message', () => {
        clearTimeout(t);
        this.bye(c, 'unauthorized');
      });
    }
  }

  private bye(c: Client, reason: string): void {
    this.send(c, { t: 'bye', v: 1, reason });
    setTimeout(() => c.ws.close(4000, reason), 20).unref();
  }

  private send(c: Client, m: ServerMessage | string): void {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    c.inflight++;
    c.ws.send(typeof m === 'string' ? m : JSON.stringify(m), () => {
      c.inflight--;
      if (c.needsState && c.inflight < QUEUE_LIMIT / 4) {
        c.needsState = false;
        this.sendState(c);
      }
    });
  }

  private sendState(c: Client): void {
    this.send(c, { t: 'live.state', v: 1, seq: this.live.state.seq, state: this.live.state });
  }

  private receivesLive(c: Client): boolean {
    return !!c.role && c.role !== 'edit';
  }

  private onMessage(c: Client, raw: string): void {
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
        this.send(c, {
          t: 'welcome',
          v: 1,
          hubMs: Date.now(),
          seq: this.live.state.seq,
          role,
          appVersion: APP_VERSION,
        });
        if (this.receivesLive(c)) this.sendState(c);
        if (c.outputId) {
          const h = this.health.get(c.outputId);
          this.health.set(c.outputId, { health: h?.health ?? EMPTY_HEALTH, lastSeen: Date.now() });
        }
        return;
      }
      case 'time.ping':
        return this.send(c, { t: 'time.pong', v: 1, c: m.c, s: Date.now() });
      case 'live.resync':
        if (this.receivesLive(c)) this.sendState(c);
        return;
      case 'live.event': {
        if (c.role === 'edit') return this.send(c, { t: 'live.ack', v: 1, id: m.id, rejected: 'forbidden: edit role' });
        try {
          const origin =
            c.role === 'operate'
              ? { role: 'operate' as const, id: m.id }
              : { role: c.role as 'output' | 'stage', outputId: c.outputId!, id: m.id };
          const seq = this.live.submit(m.event, origin);
          this.send(c, { t: 'live.ack', v: 1, id: m.id, seq });
        } catch (e) {
          if (!(e instanceof LiveRejection) && !(e instanceof HttpError)) this.log.error({ err: errorMessage(e) }, 'live event failed');
          this.send(c, { t: 'live.ack', v: 1, id: m.id, rejected: errorMessage(e) });
        }
        return;
      }
      case 'live.adopt': {
        if (c.role !== 'operate') return this.send(c, { t: 'live.ack', v: 1, id: 'adopt', rejected: 'forbidden' });
        const r = this.live.adopt(m.state, m.force);
        if (r.ok) this.send(c, { t: 'live.ack', v: 1, id: 'adopt', seq: r.seq });
        else {
          this.send(c, { t: 'live.ack', v: 1, id: 'adopt', rejected: r.reason });
          this.sendState(c);
        }
        return;
      }
      case 'health': {
        if (!c.outputId) return;
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
    }
  }

  private broadcastDelta(d: { seq: number; fromSeq: number; event: unknown; id?: string }): void {
    const raw = JSON.stringify({ t: 'live.delta', v: PROTOCOL_VERSION, ...d });
    for (const c of this.clients) {
      if (!this.receivesLive(c)) continue;
      if (c.needsState) continue;
      if (c.inflight > QUEUE_LIMIT) {
        // A slow socket gets a full state once its queue drains instead of a backlog of deltas.
        c.needsState = true;
        continue;
      }
      this.send(c, raw);
    }
  }

  private broadcastState(s: LiveState): void {
    const raw = JSON.stringify({ t: 'live.state', v: PROTOCOL_VERSION, seq: s.seq, state: s });
    for (const c of this.clients) if (this.receivesLive(c)) this.send(c, raw);
  }

  broadcastLibrary(changes: Change[]): void {
    const strip = (ch: Change): Change =>
      ch.kind === 'settings' && ch.id === 'outputs' && Array.isArray(ch.entity)
        ? { ...ch, entity: (ch.entity as { token?: string }[]).map(({ token: _t, ...o }) => o) }
        : ch;
    const full = JSON.stringify({ t: 'library.delta', v: PROTOCOL_VERSION, changes });
    const stripped = JSON.stringify({ t: 'library.delta', v: PROTOCOL_VERSION, changes: changes.map(strip) });
    const settingsOnly = changes.filter((ch) => ch.kind === ('settings' satisfies LibraryKind));
    const forOutputs = settingsOnly.length
      ? JSON.stringify({
          t: 'library.delta',
          v: PROTOCOL_VERSION,
          changes: settingsOnly.map((ch) => ({ kind: ch.kind, id: ch.id, rev: ch.rev })),
        })
      : undefined;
    for (const c of this.clients) {
      if (c.role === 'operate') this.send(c, full);
      else if (c.role === 'edit') this.send(c, stripped);
      else if ((c.role === 'output' || c.role === 'stage') && forOutputs) this.send(c, forOutputs);
    }
  }

  /** Per-output health with connection state, for the operator and diagnostics. */
  healthTable(): Record<string, OutputHealthEntry> {
    const now = Date.now();
    const connected = new Set<string>();
    for (const c of this.clients) if (c.outputId && c.role) connected.add(c.outputId);
    const out: Record<string, OutputHealthEntry> = {};
    for (const o of this.lib.getSetting('outputs')) {
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

  private sendHealth(): void {
    const ops = [...this.clients].filter((c) => c.role === 'operate');
    if (!ops.length) return;
    const raw = JSON.stringify({ t: 'health.summary', v: PROTOCOL_VERSION, outputs: this.healthTable() });
    for (const c of ops) this.send(c, raw);
  }
}

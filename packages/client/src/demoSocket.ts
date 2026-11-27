/**
 * The demo's hub socket (docs/design/26-pages-demo.md, "The VM hub"): a WebSocket look-alike for the hub's `/ws`
 * when the hub runs in a Linux machine in the operator tab. A page cannot open a TCP connection into that machine,
 * so the socket's frames go over a BroadcastChannel to the VM host (apps/demo/src/vm-host.ts), which holds the real
 * connection. It works in windows and workers alike. The messages are apps/demo/src/vm-wire.ts's `WsUp`/`WsDown`.
 *
 * Only what HubConnection (hub.ts) uses: readyState, the four handlers, send() and close().
 */
const CHANNEL = 'ordo-vm-ws';
const ALIVE_MS = 2000;
const ALIVE_TIMEOUT_MS = 7000;

type Down =
  | { t: 'opened'; id: string; protocol: string }
  | { t: 'msg'; id: string; data: string | ArrayBuffer }
  | { t: 'closed'; id: string; code: number; reason: string; wasClean: boolean }
  | { t: 'host'; at: number };

let channel: BroadcastChannel | undefined;
const live = new Map<string, DemoSocket>();
let lastHost = 0;
let aliveTimer: ReturnType<typeof setInterval> | undefined;

function bus(): BroadcastChannel {
  if (channel) return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (ev: MessageEvent<Down>) => {
    const m = ev.data;
    if (m.t === 'host') {
      lastHost = Date.now();
      return;
    }
    live.get(m.id)?.down(m);
  };
  return channel;
}

function startAlive(): void {
  if (aliveTimer) return;
  aliveTimer = setInterval(() => {
    if (!live.size) return;
    bus().postMessage({ t: 'alive', ids: [...live.keys()] });
    // The operator tab (and its hub) went away: the sockets are gone, as a server that disappears.
    if (Date.now() - lastHost > ALIVE_TIMEOUT_MS)
      for (const s of [...live.values()]) if (Date.now() - s.openedAt > ALIVE_TIMEOUT_MS) s.drop();
  }, ALIVE_MS);
}

export class DemoSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  protocol = '';
  readonly url: string;
  readonly openedAt = Date.now();
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private readonly id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    const u = new URL(this.url);
    const at = u.pathname.lastIndexOf('/ws');
    const path = (at >= 0 ? u.pathname.slice(at) : '/ws') + u.search;
    live.set(this.id, this);
    startAlive();
    bus().postMessage({
      t: 'open',
      id: this.id,
      path,
      protocols: protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols],
    });
  }

  /** A message from the host for this socket. */
  down(m: Exclude<Down, { t: 'host' }>): void {
    if (m.t === 'opened') {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.protocol = m.protocol;
      this.onopen?.(new Event('open'));
    } else if (m.t === 'msg') {
      if (this.readyState === 1) this.onmessage?.(new MessageEvent('message', { data: m.data }));
    } else this.finish(m.code, m.reason, m.wasClean);
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) {
      if (this.readyState === 0) throw new DOMException('Still in CONNECTING state.', 'InvalidStateError');
      return;
    }
    bus().postMessage({ t: 'send', id: this.id, data });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    bus().postMessage({ t: 'close', id: this.id, code, reason });
    this.finish(code ?? 1000, reason ?? '', true);
  }

  /** The host is gone: fail like a dropped connection. */
  drop(): void {
    if (this.readyState === 0) this.onerror?.(new Event('error'));
    this.finish(1006, '', false);
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    live.delete(this.id);
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean }));
  }
}

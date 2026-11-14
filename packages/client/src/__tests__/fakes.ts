/** Test doubles for the client package: a scriptable WebSocket and a postMessage window pair. */

export class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readonly OPEN = 1;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  /** The server accepted the socket. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  /** The server sent a message. */
  receive(m: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  /** The close handshake completed (or the peer closed). */
  finishClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Answer every ping sent so far that has no pong yet. */
  pongAll(hubMs = Date.now()): number {
    let n = 0;
    for (const m of this.sent.splice(0)) {
      if (m.t === 'time.ping') {
        this.receive({ t: 'time.pong', v: 1, c: m.c, s: hubMs });
        n++;
      }
    }
    return n;
  }

  pings(): number {
    return this.sent.filter((m) => m.t === 'time.ping').length;
  }
}

export function installFakeWebSocket(): void {
  FakeWebSocket.reset();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
}

export function lastSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error('no socket');
  return ws;
}

export function welcome(ws: FakeWebSocket, seq = 0): void {
  ws.open();
  ws.receive({ t: 'welcome', v: 1, hubMs: Date.now(), seq, role: 'output', appVersion: '0.1.0' });
}

type Listener = (ev: unknown) => void;

/** A window-like object: an event target with `postMessage` that records what was posted to it. */
export class FakeWindow {
  closed = false;
  opener: FakeWindow | null = null;
  posted: { m: Record<string, unknown>; origin: string }[] = [];
  private listeners = new Map<string, Set<Listener>>();

  readonly origin: string;
  constructor(origin: string) {
    this.origin = origin;
  }

  addEventListener(type: string, fn: Listener): void {
    let s = this.listeners.get(type);
    if (!s) this.listeners.set(type, (s = new Set()));
    s.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  postMessage(m: Record<string, unknown>, targetOrigin: string): void {
    if (this.closed) throw new Error('window closed');
    this.posted.push({ m, origin: targetOrigin });
  }

  /** Deliver a message event as if `source` had posted it. */
  deliver(source: FakeWindow, data: unknown, origin = source.origin): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ source, origin, data });
  }

  /** Forward everything posted to this window so far to it, as message events from `from`. */
  pump(from: FakeWindow): Record<string, unknown>[] {
    const out = this.posted.splice(0);
    for (const p of out) this.deliver(from, p.m, from.origin);
    return out.map((p) => p.m);
  }
}

export function installWindow(w: FakeWindow): void {
  (globalThis as unknown as { window: unknown }).window = w;
}

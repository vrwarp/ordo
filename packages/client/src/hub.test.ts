import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubClock } from './clock.ts';
import { AUTH_RETRY_MS, HubConnection, IDLE_PING_MS, LIVE_LOST_MS, LIVE_PING_MS } from './hub.ts';
import { FakeWebSocket, installFakeWebSocket, lastSocket, welcome } from './__tests__/fakes.ts';

function connect(opts: Partial<ConstructorParameters<typeof HubConnection>[0]> = {}) {
  const statuses: boolean[] = [];
  const lost: number[] = [];
  const hub = new HubConnection({
    role: 'output',
    appVersion: '0.1.0',
    url: 'ws://hub.test/ws',
    clock: new HubClock(),
    ...opts,
  });
  hub.on('status', ({ connected }) => statuses.push(connected));
  hub.on('lost', ({ sincePongMs }) => lost.push(sincePongMs));
  hub.start();
  return { hub, statuses, lost };
}

const liveState = (seq = 3) => ({ t: 'live.state', v: 1, seq, state: { seq, mode: 'live' } });
const idleState = (seq = 3) => ({ t: 'live.state', v: 1, seq, state: { seq, mode: 'idle' } });

describe('HubConnection liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeWebSocket();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not count the clock-seeding burst: a 120 ms pong delay keeps one socket connected', () => {
    const { hub, statuses } = connect();
    const ws = lastSocket();
    welcome(ws);
    expect(hub.connected).toBe(true);
    vi.advanceTimersByTime(100); // the four burst pings went out, nothing answered yet
    expect(ws.pings()).toBe(4);
    vi.advanceTimersByTime(20);
    ws.pongAll();
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(ws.closed).toBe(false);
    expect(statuses).toEqual([true]);
  });

  it('judges liveness by time since the last pong and drops the socket after ~9 s while live', () => {
    const { hub, statuses, lost } = connect();
    const ws = lastSocket();
    welcome(ws);
    vi.advanceTimersByTime(200);
    ws.pongAll();
    ws.receive(liveState());
    expect(hub.isLive).toBe(true);
    // Pongs keep arriving: alive for as long as you like.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(LIVE_PING_MS);
      expect(ws.pongAll()).toBeGreaterThanOrEqual(1);
    }
    expect(hub.connected).toBe(true);
    expect(FakeWebSocket.instances.length).toBe(1);
    // Then the hub falls silent (a frozen TCP connection): no close event ever arrives.
    const silentAt = Date.now();
    vi.advanceTimersByTime(LIVE_LOST_MS - 1500);
    expect(hub.connected).toBe(true);
    while (hub.connected && Date.now() - silentAt < 20_000) vi.advanceTimersByTime(100);
    expect(hub.connected).toBe(false);
    const tookMs = Date.now() - silentAt;
    expect(tookMs).toBeGreaterThanOrEqual(LIVE_LOST_MS);
    expect(tookMs).toBeLessThanOrEqual(LIVE_LOST_MS + 1000); // the 1 s check phase
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeGreaterThanOrEqual(LIVE_LOST_MS);
    // The socket was discarded without waiting for the close handshake, and its late events are ignored.
    expect(ws.closed).toBe(true);
    expect(ws.onclose).toBeNull();
    expect(ws.onmessage).toBeNull();
    expect(statuses).toEqual([true, false]);
    // A reconnect follows after the backoff with a fresh socket.
    vi.advanceTimersByTime(600);
    expect(FakeWebSocket.instances.length).toBe(2);
    const ws2 = lastSocket();
    welcome(ws2, 3);
    expect(hub.connected).toBe(true);
    expect(statuses).toEqual([true, false, true]);
    // The old socket's handshake completing later changes nothing.
    ws.finishClose();
    expect(hub.connected).toBe(true);
  });

  it('pings every 3 s while live and every 10 s idle, with a 30 s allowance when idle', () => {
    const { hub } = connect();
    const ws = lastSocket();
    welcome(ws);
    vi.advanceTimersByTime(200);
    ws.pongAll();
    ws.receive(idleState());
    expect(hub.isLive).toBe(false);
    vi.advanceTimersByTime(IDLE_PING_MS * 2 + 10);
    expect(ws.pings()).toBe(2);
    ws.pongAll();
    // Idle and silent: lost only after 3 × the idle period.
    vi.advanceTimersByTime(IDLE_PING_MS * 2 + 500);
    expect(hub.connected).toBe(true);
    vi.advanceTimersByTime(IDLE_PING_MS + 1000);
    expect(hub.connected).toBe(false);
    // Reconnect, go live through a delta: the period drops to 3 s.
    vi.advanceTimersByTime(1000);
    const ws2 = lastSocket();
    welcome(ws2, 3);
    vi.advanceTimersByTime(200);
    ws2.pongAll();
    ws2.receive({ t: 'live.delta', v: 1, seq: 4, fromSeq: 3, event: { k: 'goLive', resolved: {} } });
    expect(hub.isLive).toBe(true);
    vi.advanceTimersByTime(LIVE_PING_MS * 3 + 10);
    expect(ws2.pings()).toBe(3);
    ws2.pongAll();
    ws2.receive({ t: 'live.delta', v: 1, seq: 5, fromSeq: 4, event: { k: 'endService', at: 1 } });
    expect(hub.isLive).toBe(false);
  });

  it('a close from the peer reconnects with backoff and resets it on welcome', () => {
    const { hub, statuses } = connect();
    welcome(lastSocket());
    lastSocket().finishClose();
    expect(hub.connected).toBe(false);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances.length).toBe(2);
    lastSocket().finishClose(); // refused
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(3);
    welcome(lastSocket());
    expect(statuses).toEqual([true, false, true]);
    hub.stop();
    expect(hub.connected).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances.length).toBe(3);
  });

  it('never reconnects after bye: superseded', () => {
    const { hub, statuses } = connect();
    const ws = lastSocket();
    welcome(ws);
    const byes: string[] = [];
    hub.on('bye', (m) => byes.push(m.reason));
    ws.receive({ t: 'bye', v: 1, reason: 'superseded' });
    expect(byes).toEqual(['superseded']);
    expect(hub.connected).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(statuses).toEqual([true, false]);
  });

  it('bye unauthorized is not a hub loss: one auth event, a strong back-off, and resume() reconnects now', () => {
    const { hub, statuses } = connect({ role: 'operate' });
    const auths: string[] = [];
    hub.on('auth', (a) => auths.push(a.reason));
    const ws = lastSocket();
    welcome(ws);
    // The session ended while connected: the bye arrives first, then the close.
    ws.receive({ t: 'bye', v: 1, reason: 'unauthorized' });
    expect(hub.authBlocked).toBe(true);
    expect(auths).toEqual(['unauthorized']);
    ws.finishClose();
    expect(statuses).toEqual([true, false]);
    // No reconnect every 5 s: the first retry waits AUTH_RETRY_MS.
    vi.advanceTimersByTime(AUTH_RETRY_MS - 1);
    expect(FakeWebSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(2);
    // Refused again: no second auth event, and the next retry backs off further.
    lastSocket().open();
    lastSocket().receive({ t: 'bye', v: 1, reason: 'unauthorized' });
    lastSocket().finishClose();
    expect(auths).toEqual(['unauthorized']);
    vi.advanceTimersByTime(AUTH_RETRY_MS * 2 - 1);
    expect(FakeWebSocket.instances.length).toBe(2);
    // Signed in again: resume() reconnects at once and a welcome clears the block.
    hub.resume();
    expect(FakeWebSocket.instances.length).toBe(3);
    welcome(lastSocket());
    expect(hub.authBlocked).toBe(false);
    expect(statuses).toEqual([true, false, true]);
    // A plain close afterwards uses the normal 500 ms backoff again.
    lastSocket().finishClose();
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances.length).toBe(4);
    hub.stop();
  });

  it('bye forbidden on hello also backs off (a revoked output token)', () => {
    const { hub } = connect();
    const auths: string[] = [];
    hub.on('auth', (a) => auths.push(a.reason));
    lastSocket().open();
    lastSocket().receive({ t: 'bye', v: 1, reason: 'forbidden' });
    lastSocket().finishClose();
    expect(auths).toEqual(['forbidden']);
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances.length).toBe(1);
    hub.stop();
  });

  it('bye retry (the hub has no output list yet) is a plain reconnect: no auth event, the normal backoff', () => {
    const { hub, statuses } = connect();
    const auths: string[] = [];
    const byes: string[] = [];
    hub.on('auth', (a) => auths.push(a.reason));
    hub.on('bye', (m) => byes.push(m.reason));
    lastSocket().open();
    lastSocket().receive({ t: 'bye', v: 1, reason: 'retry' });
    lastSocket().finishClose();
    expect(byes).toEqual(['retry']);
    expect(auths).toEqual([]);
    expect(hub.authBlocked).toBe(false);
    // Back in 500 ms, not AUTH_RETRY_MS.
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(2);
    welcome(lastSocket());
    expect(hub.connected).toBe(true);
    expect(statuses).toEqual([true]);
    hub.stop();
  });

  it('send fails while disconnected and the hello carries the last seq', () => {
    const { hub } = connect();
    expect(hub.send({ t: 'live.resync' })).toBe(false);
    const ws = lastSocket();
    welcome(ws, 7);
    ws.receive(liveState(9));
    expect(hub.send({ t: 'live.resync' })).toBe(true);
    hub.kick();
    expect(hub.connected).toBe(false);
    vi.advanceTimersByTime(600);
    const ws2 = lastSocket();
    ws2.open();
    expect(ws2.sent[0]).toMatchObject({ t: 'hello', role: 'output', lastSeq: 9 });
  });
});

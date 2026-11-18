import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubClock } from './clock.ts';
import { AUTH_RETRY_MS, HubConnection, IDLE_PING_MS, LIVE_LOST_MS, LIVE_PING_MS, STALL_MS } from './hub.ts';
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

  /** A connection that is live and has just had its pongs answered. */
  function liveConnection() {
    const c = connect();
    const ws = lastSocket();
    welcome(ws);
    vi.advanceTimersByTime(200);
    ws.pongAll();
    ws.receive(liveState());
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(LIVE_PING_MS);
      ws.pongAll();
    }
    return { ...c, ws };
  }

  /** This thread is blocked for `ms`: the clock moves, no timer and no message runs meanwhile. */
  function stall(ms: number) {
    vi.setSystemTime(Date.now() + ms);
  }

  it('a stall of this thread with the pong queued behind the check keeps the socket (no false hub loss)', () => {
    const { hub, statuses, lost, ws } = liveConnection();
    const lastPongAt = Date.now();
    // A ping goes out and the hub answers at once, but the answer waits in the queue: this thread is blocked
    // (a long task, a GC) for 8 s, and the 1 s check runs before the queued message is read.
    vi.advanceTimersByTime(LIVE_PING_MS);
    expect(ws.pings()).toBeGreaterThanOrEqual(1);
    stall(8000);
    vi.advanceTimersByTime(1000);
    expect(Date.now() - lastPongAt).toBeGreaterThan(LIVE_LOST_MS);
    expect(hub.connected).toBe(true);
    // The queued pongs are read; the check that judges sees a fresh pong.
    ws.pongAll();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(LIVE_PING_MS);
      ws.pongAll();
    }
    expect(hub.connected).toBe(true);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(lost).toEqual([]);
    expect(statuses).toEqual([true]);
  });

  it('a dead hub is still lost within 12 s of its last pong when this thread stalls meanwhile', () => {
    for (const [at, ms] of [
      [2000, 3000],
      [5000, STALL_MS + 1500],
      [7500, 2600],
    ] as const) {
      const { hub, lost, ws } = liveConnection();
      const lastPongAt = Date.now();
      vi.advanceTimersByTime(at);
      stall(ms);
      while (hub.connected && Date.now() - lastPongAt < 30_000) vi.advanceTimersByTime(100);
      expect(hub.connected).toBe(false);
      expect(Date.now() - lastPongAt).toBeGreaterThanOrEqual(LIVE_LOST_MS);
      expect(Date.now() - lastPongAt).toBeLessThanOrEqual(LIVE_LOST_MS + LIVE_PING_MS + 1000);
      expect(lost).toHaveLength(1);
      expect(ws.closed).toBe(true);
      hub.stop();
    }
  });

  it('timers that are late on every tick (a throttled background tab) still judge every other tick', () => {
    const { hub, lost } = liveConnection();
    let ticks = 0;
    while (hub.connected && ticks < 5) {
      stall(59_000);
      vi.advanceTimersByTime(1000);
      ticks++;
    }
    expect(hub.connected).toBe(false);
    expect(ticks).toBe(2);
    expect(lost).toHaveLength(1);
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

  it("a Pulpit Lectern's hello says view 'lectern'; the output's own window's has no view", () => {
    const { hub: display } = connect({ role: 'stage', outputId: 'stage-1' });
    const d = lastSocket();
    d.open();
    expect(d.sent[0]).toMatchObject({ t: 'hello', role: 'stage', outputId: 'stage-1' });
    expect(d.sent[0]).not.toHaveProperty('view');
    const { hub: lectern } = connect({ role: 'stage', outputId: 'stage-1', view: 'lectern' });
    const l = lastSocket();
    l.open();
    expect(l.sent[0]).toMatchObject({ t: 'hello', role: 'stage', outputId: 'stage-1', view: 'lectern' });
    display.stop();
    lectern.stop();
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

describe('HubConnection holds the resolved copy (live-by-ref)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeWebSocket();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const copy = (name = 'a') => ({ playlist: { id: 'pl', name }, presentations: {} });
  const whole = (resolvedId: string, resolved: unknown, seq = 3) => ({
    t: 'live.state',
    v: 1,
    seq,
    resolvedId,
    state: { seq, mode: 'live', cues: [], resolved },
  });
  const byName = (resolvedId: string, seq = 4) => ({
    t: 'live.state',
    v: 1,
    seq,
    resolvedId,
    state: { seq, mode: 'live', cues: [] },
  });
  const reconnect = (hub: HubConnection) => {
    hub.kick();
    vi.advanceTimersByTime(600);
    const ws = lastSocket();
    ws.open();
    welcome(ws);
    return ws;
  };

  it('the hello carries no id before a copy was given, and carries it after a whole state or a goLive delta', () => {
    const { hub } = connect();
    const ws = lastSocket();
    ws.open();
    expect(ws.sent[0]).toMatchObject({ t: 'hello' });
    expect(ws.sent[0]).not.toHaveProperty('resolvedId');
    welcome(ws);
    ws.receive(whole('a'.repeat(64), copy()));
    const ws2 = reconnect(hub);
    expect(ws2.sent[0]).toMatchObject({ t: 'hello', resolvedId: 'a'.repeat(64) });
    // a goLive delta holds its copy under its id
    ws2.receive({
      t: 'live.delta',
      v: 1,
      seq: 5,
      fromSeq: 4,
      resolvedId: 'b'.repeat(64),
      event: { k: 'goLive', resolved: copy('b') },
    });
    const ws3 = reconnect(hub);
    expect(ws3.sent[0]).toMatchObject({ resolvedId: 'b'.repeat(64) });
  });

  it('a by-name state is emitted joined, and its resolved is the held object itself across three reconnects', () => {
    const { hub } = connect();
    const emitted: { resolved?: unknown; seq: number }[] = [];
    hub.on('state', (m) => emitted.push({ resolved: m.state.resolved, seq: m.state.seq }));
    let ws = lastSocket();
    welcome(ws);
    const held = copy();
    ws.receive(whole('a'.repeat(64), held));
    expect(emitted[0]!.resolved).toBe(held);
    for (let i = 0; i < 3; i++) {
      ws = reconnect(hub);
      ws.receive(byName('a'.repeat(64), 10 + i));
    }
    expect(emitted.length).toBe(4);
    for (const e of emitted) expect(e.resolved).toBe(held);
  });

  it('a by-name state whose id is not held emits nothing and asks once, without an id, per two seconds', () => {
    const { hub } = connect();
    const emitted: unknown[] = [];
    hub.on('state', (m) => emitted.push(m));
    const ws = lastSocket();
    welcome(ws);
    ws.sent.length = 0;
    ws.receive(byName('c'.repeat(64)));
    const resyncs = () => ws.sent.filter((m) => m.t === 'live.resync');
    expect(emitted).toEqual([]);
    expect(resyncs().length).toBe(1);
    expect(resyncs()[0]).not.toHaveProperty('resolvedId');
    ws.receive(byName('c'.repeat(64), 5));
    expect(resyncs().length).toBe(1);
    vi.advanceTimersByTime(2100);
    ws.receive(byName('c'.repeat(64), 6));
    expect(resyncs().length).toBe(2);
    hub.stop();
  });

  it('a resync carries the held id, and resolvedId: undefined says nothing', () => {
    const { hub } = connect();
    const ws = lastSocket();
    welcome(ws);
    ws.receive(whole('a'.repeat(64), copy()));
    ws.sent.length = 0;
    hub.send({ t: 'live.resync' });
    hub.send({ t: 'live.resync', resolvedId: undefined });
    expect(ws.sent[0]).toMatchObject({ t: 'live.resync', resolvedId: 'a'.repeat(64) });
    expect(ws.sent[1]).toMatchObject({ t: 'live.resync' });
    expect(ws.sent[1]).not.toHaveProperty('resolvedId');
  });

  it('an idle state and endService clear the copy', () => {
    const { hub } = connect();
    let ws = lastSocket();
    welcome(ws);
    ws.receive(whole('a'.repeat(64), copy()));
    ws.receive(idleState(8));
    ws = reconnect(hub);
    expect(ws.sent[0]).not.toHaveProperty('resolvedId');
    ws.receive(whole('a'.repeat(64), copy()));
    ws.receive({ t: 'live.delta', v: 1, seq: 9, fromSeq: 8, event: { k: 'endService', at: 1 } });
    ws = reconnect(hub);
    expect(ws.sent[0]).not.toHaveProperty('resolvedId');
  });

  it('a state with no resolvedId leaves the held copy alone and is emitted as it came', () => {
    const { hub } = connect();
    const emitted: { state: unknown }[] = [];
    hub.on('state', (m) => emitted.push(m));
    let ws = lastSocket();
    welcome(ws);
    ws.receive(whole('a'.repeat(64), copy()));
    const plain = { t: 'live.state', v: 1, seq: 12, state: { seq: 12, mode: 'live', resolved: copy('z') } };
    ws.receive(plain);
    expect(emitted.at(-1)!.state).toEqual(plain.state);
    ws = reconnect(hub);
    expect(ws.sent[0]).toMatchObject({ resolvedId: 'a'.repeat(64) });
  });
});

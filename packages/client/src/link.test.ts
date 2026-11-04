import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState } from '@ordo/domain';
import { initialState } from '@ordo/live-state';
import { clock, HubClock } from './clock.ts';
import { FALLBACK_SILENCE_MS, FallbackClient } from './fallback.ts';
import { HubConnection } from './hub.ts';
import { OutputLink, RESYNC_BUDGET, RESYNC_WINDOW_MS } from './link.ts';
import { FakeWindow, installFakeWebSocket, installWindow, lastSocket, welcome } from './__tests__/fakes.ts';

const OP = 'http://op.test';
const OUT = 'http://out1.test';

function st(seq: number, extra: Partial<LiveState> = {}): LiveState {
  return { ...initialState(), seq, ...extra };
}

function setup() {
  const op = new FakeWindow(OP);
  const out = new FakeWindow(OUT);
  out.opener = op;
  installWindow(out);
  const hub = new HubConnection({
    role: 'output',
    appVersion: '0.1.0',
    url: 'ws://hub.test/ws',
    clock: new HubClock(),
  });
  const fallback = new FallbackClient(OP, 'o1');
  const link = new OutputLink({ role: 'output', appVersion: '0.1.0', hub, fallback, outputId: 'o1' });
  const buses: string[] = [];
  link.on('bus', ({ bus, reason }) => buses.push(`${bus}${reason ? `:${reason}` : ''}`));
  link.start();
  const ws = lastSocket();
  welcome(ws);
  ws.sent = [];
  ws.receive({ t: 'live.state', v: 1, seq: 2, state: st(2) });
  const hello = (seq = 2) => out.deliver(op, { t: 'fallback.hello', v: 1, seq, operatorMs: Date.now() });
  return { op, out, hub, fallback, link, buses, ws, hello };
}

describe('OutputLink bus transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    installFakeWebSocket();
    clock.fallback = false;
  });
  afterEach(() => vi.useRealTimers());

  it('joins the fallback bus on hello and follows the operator while on it', () => {
    const { link, buses, op, out, hello } = setup();
    expect(buses).toEqual(['hub:hub connected']);
    hello();
    expect(link.bus).toBe('fallback');
    expect(clock.fallback).toBe(true);
    expect(op.posted.at(-1)!.m).toMatchObject({ t: 'fallback.ready', appliedSeq: 2 });
    out.deliver(op, { t: 'live.state', v: 1, seq: 2, state: st(2) });
    out.deliver(op, { t: 'live.delta', v: 1, seq: 3, fromSeq: 2, event: { k: 'endService', at: 1 } });
    expect(link.state.seq).toBe(3);
  });

  it('leaves fallback when the hub state sequence catches up, not before', () => {
    const { link, buses, ws, hello, out, op } = setup();
    hello();
    out.deliver(op, { t: 'live.state', v: 1, seq: 2, state: st(2) });
    out.deliver(op, { t: 'live.delta', v: 1, seq: 3, fromSeq: 2, event: { k: 'endService', at: 1 } });
    out.deliver(op, { t: 'live.delta', v: 1, seq: 4, fromSeq: 3, event: { k: 'endService', at: 2 } });
    // The hub restarted from its journal at seq 2: still behind, the output stays with the operator.
    ws.receive({ t: 'live.state', v: 1, seq: 2, state: st(2) });
    ws.receive({ t: 'live.delta', v: 1, seq: 3, fromSeq: 2, event: { k: 'endService', at: 9 } });
    expect(link.bus).toBe('fallback');
    expect(link.state.seq).toBe(4);
    // The hub adopted the operator's state (seq 4): back to the hub, state applied.
    ws.sent = [];
    ws.receive({ t: 'live.state', v: 1, seq: 4, state: st(4, { black: true }) });
    expect(link.bus).toBe('hub');
    expect(clock.fallback).toBe(false);
    expect(link.state.black).toBe(true);
    expect(ws.sent).toEqual([{ t: 'live.resync', v: 1 }]);
    expect(buses.at(-1)).toBe('hub:hub caught up');
    // Later fallback traffic from the old operator page is ignored.
    out.deliver(op, { t: 'live.delta', v: 1, seq: 5, fromSeq: 4, event: { k: 'endService', at: 3 } });
    expect(link.state.seq).toBe(4);
  });

  it('leaves fallback after 5 s without operator traffic', () => {
    const { link, buses, hello, out, op } = setup();
    hello();
    expect(link.bus).toBe('fallback');
    vi.advanceTimersByTime(1500);
    out.deliver(op, { t: 'fallback.hub', v: 1, hubUp: false }); // heartbeat
    vi.advanceTimersByTime(FALLBACK_SILENCE_MS - 1000);
    expect(link.bus).toBe('fallback');
    vi.advanceTimersByTime(1500);
    expect(link.bus).toBe('hub');
    expect(buses.at(-1)).toBe('hub:operator silent');
  });

  it('leaves fallback when the opener closes, to "none" when the hub is down too', () => {
    const { link, hello, op, ws } = setup();
    hello();
    ws.finishClose();
    expect(link.bus).toBe('fallback'); // the hub going away does not disturb the fallback bus
    op.closed = true;
    link.watchFallback();
    expect(link.bus).toBe('none');
    expect(clock.fallback).toBe(false);
    // The hub returns: straight to the hub bus.
    vi.advanceTimersByTime(600);
    welcome(lastSocket(), 2);
    expect(link.bus).toBe('hub');
  });

  it('returns to the hub when the operator says so', () => {
    const { link, hello, out, op } = setup();
    hello();
    out.deliver(op, { t: 'fallback.hub', v: 1, hubUp: true });
    expect(link.bus).toBe('hub');
  });
});

describe('OutputLink ended events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    installFakeWebSocket();
    clock.fallback = false;
  });
  afterEach(() => vi.useRealTimers());

  it('queues media.ended until a bus is up and resends it with the same id on a bus change', () => {
    const { link, ws, hello, op } = setup();
    ws.finishClose();
    expect(link.bus).toBe('none');
    link.sendEvent({ k: 'media.ended', cueIndex: 1, at: 100_000 });
    expect(link.queuedEvents).toBe(1);
    // The operator takes over: the queued event goes to it.
    hello();
    const sentToOp = op.posted.filter((p) => p.m.t === 'live.event').map((p) => p.m);
    expect(sentToOp).toEqual([
      {
        t: 'live.event',
        v: 1,
        id: 'o1-media.ended-1-100000',
        event: { k: 'media.ended', cueIndex: 1, at: 100_000 },
      },
    ]);
    expect(link.queuedEvents).toBe(0);
    // The hub comes back and catches up: the recent event is resent to the hub with the same id.
    vi.advanceTimersByTime(600);
    const ws2 = lastSocket();
    welcome(ws2, 2);
    ws2.sent = [];
    ws2.receive({ t: 'live.state', v: 1, seq: 2, state: st(2) });
    expect(link.bus).toBe('hub');
    expect(ws2.sent.filter((m) => m.t === 'live.event')).toEqual([
      {
        t: 'live.event',
        v: 1,
        id: 'o1-media.ended-1-100000',
        event: { k: 'media.ended', cueIndex: 1, at: 100_000 },
      },
    ]);
    // Old events are not resent after 30 s.
    vi.advanceTimersByTime(31_000);
    ws2.pongAll();
    ws2.finishClose();
    vi.advanceTimersByTime(1000);
    const ws3 = lastSocket();
    welcome(ws3, 2);
    expect(ws3.sent.filter((m) => m.t === 'live.event')).toEqual([]);
  });
});

describe('LiveMirror on malformed input', () => {
  it('keeps the previous state and reports a gap', () => {
    const { link, ws } = (() => {
      vi.useFakeTimers();
      installFakeWebSocket();
      return setup();
    })();
    const gaps: unknown[] = [];
    link.mirror.on('gap', (g) => gaps.push(g));
    ws.sent = [];
    ws.receive({ t: 'live.delta', v: 1, seq: 3, fromSeq: 2, event: { k: 'nonsense' } });
    expect(link.state.seq).toBe(2);
    expect(gaps).toHaveLength(1);
    expect(ws.sent).toEqual([{ t: 'live.resync', v: 1 }]);
    ws.receive({ t: 'live.state', v: 1, seq: 9, state: { seq: 9 } });
    expect(link.state.seq).toBe(2);
    expect(gaps).toHaveLength(2);
    vi.useRealTimers();
  });
});

describe('OutputLink resync budget (review 2026-11-04 finding 25)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    installFakeWebSocket();
    clock.fallback = false;
  });
  afterEach(() => vi.useRealTimers());

  it('stops asking after the budget, keeps the last good state, reports it in health, asks once a minute', () => {
    const { link, ws } = setup();
    const resyncs = () => ws.sent.filter((m) => m.t === 'live.resync').length;
    /** Answer the hub pings (keeps the socket alive) without losing what else was sent. */
    const pong = () => {
      const keep = ws.sent.filter((m) => m.t !== 'time.ping');
      ws.pongAll();
      ws.sent.push(...keep);
    };
    const gaps: string[] = [];
    link.mirror.on('gap', (g) => gaps.push(g.reason));
    // The hub answers every resync with a malformed full state, and keeps sending deltas from seq 7.
    ws.sent = [];
    for (let i = 0; i < 200; i++) {
      vi.advanceTimersByTime(300);
      pong();
      ws.receive({ t: 'live.state', v: 1, seq: 7, state: { seq: 7 } });
      ws.receive({ t: 'live.delta', v: 1, seq: 8 + i, fromSeq: 7 + i, event: { k: 'endService', at: i } });
    }
    expect(gaps).toContain('malformed-state');
    expect(gaps).toContain('sequence');
    // 60 s of it: the budget plus at most one slow retry, not one per delta.
    expect(resyncs()).toBeLessThanOrEqual(RESYNC_BUDGET + 1);
    expect(resyncs()).toBeGreaterThanOrEqual(RESYNC_BUDGET);
    expect(link.state.seq).toBe(2);
    expect(link.resyncError).toMatch(/no valid state after 10 resyncs/);
    ws.sent = [];
    link.sendHealth({ presented: 0, missed: 0, longTasks: 0, lateFlips: 0, live: -1 } as never);
    const h = ws.sent.find((m) => m.t === 'health') as unknown as { health: { error?: string } };
    expect(h.health.error).toMatch(/showing the last good state/);
    // Once a minute after that.
    ws.sent = [];
    for (let t = 0; t < RESYNC_WINDOW_MS; t += 1000) {
      vi.advanceTimersByTime(1000);
      pong();
    }
    expect(link.hub.connected).toBe(true);
    ws.receive({ t: 'live.delta', v: 1, seq: 999, fromSeq: 998, event: { k: 'endService', at: 1 } });
    ws.receive({ t: 'live.delta', v: 1, seq: 1000, fromSeq: 999, event: { k: 'endService', at: 1 } });
    expect(resyncs()).toBe(1);
    // A valid state ends it: the budget is whole again.
    ws.receive({ t: 'live.state', v: 1, seq: 9, state: st(9) });
    expect(link.state.seq).toBe(9);
    expect(link.resyncError).toBeUndefined();
    ws.sent = [];
    ws.receive({ t: 'live.delta', v: 1, seq: 11, fromSeq: 10, event: { k: 'endService', at: 1 } });
    expect(resyncs()).toBe(1);
  });

  it('applies on the fallback bus too', () => {
    const { link, hello, out, op } = setup();
    hello();
    const before = op.posted.length;
    for (let i = 0; i < 50; i++)
      out.deliver(op, {
        t: 'live.delta',
        v: 1,
        seq: 50 + i,
        fromSeq: 49 + i,
        event: { k: 'endService', at: i },
      });
    const readies = op.posted.slice(before).filter((p) => (p.m as { t: string }).t === 'fallback.ready');
    expect(readies.length).toBe(RESYNC_BUDGET);
    expect(link.resyncError).toBeDefined();
  });
});

describe('resync budget counts only unanswered resyncs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    installFakeWebSocket();
    clock.fallback = false;
  });
  afterEach(() => vi.useRealTimers());

  it('serves every genuine sequence gap that the hub answers with a valid state', () => {
    const { link, ws } = setup();
    const resyncs = () => ws.sent.filter((m) => m.t === 'live.resync').length;
    ws.sent = [];
    for (let i = 0; i < RESYNC_BUDGET + 5; i++) {
      vi.advanceTimersByTime(2000);
      const keep = ws.sent.filter((m) => m.t !== 'time.ping');
      ws.pongAll();
      ws.sent.push(...keep);
      // A delta from the future (a real gap), then the hub's valid answer.
      ws.receive({ t: 'live.delta', v: 1, seq: 100 + i, fromSeq: 99 + i, event: { k: 'endService', at: 1 } });
      ws.receive({ t: 'live.state', v: 1, seq: 3 + i, state: st(3 + i) });
    }
    expect(resyncs()).toBe(RESYNC_BUDGET + 5);
    expect(link.resyncError).toBeUndefined();
    expect(link.state.seq).toBe(3 + RESYNC_BUDGET + 4);
  });
});

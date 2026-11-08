import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState } from '@ordo/domain';
import { initialState } from '@ordo/live-state';
import { FALLBACK_HEARTBEAT_MS, FallbackClient, FallbackHost } from './fallback.ts';
import { FakeWindow, installWindow } from './__tests__/fakes.ts';

const OP = 'http://op.test';
const OUT = 'http://out1.test';

function state(seq: number): LiveState {
  return { ...initialState(), seq };
}

describe('FallbackHost', () => {
  let op: FakeWindow;
  let out: FakeWindow;
  let host: FallbackHost;
  beforeEach(() => {
    vi.useFakeTimers();
    op = new FakeWindow(OP);
    out = new FakeWindow(OUT);
    out.opener = op;
    installWindow(op);
    host = new FallbackHost();
  });
  afterEach(() => {
    host.dispose();
    vi.useRealTimers();
  });

  it('heartbeats ready windows every 2 s while active and releases them on deactivate', () => {
    host.register('o1', out as unknown as Window, OUT);
    expect(out.posted.map((p) => p.m.t)).toEqual(['fallback.hub']); // hub mode: "the hub is up"
    expect(out.posted[0]!.m).toMatchObject({ hubUp: true });
    expect(out.posted[0]!.origin).toBe(OUT);
    out.posted = [];
    host.activate(state(5));
    expect(out.posted.map((p) => p.m.t)).toEqual(['fallback.hello']);
    // Not ready yet: hello again, no heartbeat.
    vi.advanceTimersByTime(FALLBACK_HEARTBEAT_MS);
    expect(out.posted.map((p) => p.m.t)).toEqual(['fallback.hello', 'fallback.hello']);
    out.posted = [];
    op.deliver(out, { t: 'fallback.ready', v: 1, outputId: 'o1', appliedSeq: 5 });
    expect(out.posted.map((p) => p.m.t)).toEqual(['live.state']);
    out.posted = [];
    vi.advanceTimersByTime(FALLBACK_HEARTBEAT_MS * 3);
    expect(out.posted.map((p) => p.m)).toEqual([
      { t: 'fallback.hub', v: 1, hubUp: false },
      { t: 'fallback.hub', v: 1, hubUp: false },
      { t: 'fallback.hub', v: 1, hubUp: false },
    ]);
    out.posted = [];
    host.deactivate();
    expect(out.posted.map((p) => p.m)).toEqual([{ t: 'fallback.hub', v: 1, hubUp: true }]);
    out.posted = [];
    vi.advanceTimersByTime(FALLBACK_HEARTBEAT_MS * 3);
    expect(out.posted).toEqual([]);
  });

  it('carries the hold of a service this PC started in every hello and heartbeat until released', () => {
    host.register('o1', out as unknown as Window, OUT);
    out.posted = [];
    host.activate(state(5), { hold: true });
    expect(out.posted.at(-1)!.m).toMatchObject({ t: 'fallback.hello', hold: true });
    op.deliver(out, { t: 'fallback.ready', v: 1, outputId: 'o1', appliedSeq: 5 });
    out.posted = [];
    vi.advanceTimersByTime(FALLBACK_HEARTBEAT_MS);
    expect(out.posted.map((p) => p.m)).toEqual([{ t: 'fallback.hub', v: 1, hubUp: false, hold: true }]);
    // The service ended with the hub still away: still the authority, no longer holding.
    host.setHold(false);
    out.posted = [];
    vi.advanceTimersByTime(FALLBACK_HEARTBEAT_MS);
    expect(out.posted.map((p) => p.m)).toEqual([{ t: 'fallback.hub', v: 1, hubUp: false }]);
    host.setHold(true);
    host.deactivate();
    expect(host.hold).toBe(false);
  });

  it('reintroduces a window whose endpoint now reaches a new page (a reload or a re-offered port)', () => {
    host.register('o1', out as unknown as Window, OUT);
    host.activate(state(3));
    op.deliver(out, { t: 'fallback.ready', v: 1, outputId: 'o1', appliedSeq: 3 });
    expect(host.isReady('o1')).toBe(true);
    out.posted = [];
    host.reintroduce('o1');
    expect(host.isReady('o1')).toBe(false);
    expect(out.posted.map((p) => p.m.t)).toEqual(['fallback.hello']);
    host.deactivate();
    out.posted = [];
    host.reintroduce('o1');
    expect(out.posted.map((p) => p.m)).toEqual([{ t: 'fallback.hub', v: 1, hubUp: true }]);
    host.reintroduce('missing'); // no-op
  });

  it('tells a window still talking to it in hub mode that the hub is up, and de-duplicates events', () => {
    host.register('o1', out as unknown as Window, OUT);
    out.posted = [];
    const events: string[] = [];
    host.on('event', ({ event }) => events.push(event.k));
    const health = {
      presented: 1,
      missed: 0,
      longTasks: 0,
      lateFlips: 0,
      cache: { ready: 0, total: 0 },
      gpuLost: 0,
      videoDropped: 0,
    };
    op.deliver(out, { t: 'health', v: 1, outputId: 'o1', health });
    expect(out.posted.map((p) => p.m)).toEqual([{ t: 'fallback.hub', v: 1, hubUp: true }]);
    // Events while the hub is the authority are not applied; the window is pointed at the hub.
    const ev = { k: 'media.ended', cueIndex: 0, at: 1 };
    op.deliver(out, { t: 'live.event', v: 1, id: 'e1', event: ev });
    expect(events).toEqual([]);
    host.activate(state(1));
    op.deliver(out, { t: 'fallback.ready', v: 1, outputId: 'o1', appliedSeq: 1 });
    op.deliver(out, { t: 'live.event', v: 1, id: 'e2', event: ev });
    op.deliver(out, { t: 'live.event', v: 1, id: 'e2', event: ev }); // a resend after a bus change
    op.deliver(out, { t: 'live.event', v: 1, id: 'e3', event: ev });
    expect(events).toEqual(['media.ended', 'media.ended']);
    // Messages from an unknown window or the wrong origin are ignored.
    const stranger = new FakeWindow('http://evil.test');
    op.deliver(stranger, { t: 'live.event', v: 1, id: 'e4', event: ev });
    op.deliver(out, { t: 'live.event', v: 1, id: 'e5', event: ev }, 'http://evil.test');
    expect(events).toHaveLength(2);
  });
});

describe('FallbackClient', () => {
  let op: FakeWindow;
  let out: FakeWindow;
  beforeEach(() => {
    vi.useFakeTimers();
    op = new FakeWindow(OP);
    out = new FakeWindow(OUT);
    out.opener = op;
    installWindow(out);
  });
  afterEach(() => vi.useRealTimers());

  it('accepts messages only from the opener at the operator origin, records traffic and sends events by id', () => {
    const c = new FallbackClient(OP, 'o1');
    const got: string[] = [];
    c.on('hello', () => got.push('hello'));
    c.on('hub', ({ hubUp }) => got.push(`hub:${hubUp}`));
    expect(c.lastTraffic).toBe(0);
    vi.setSystemTime(1000);
    out.deliver(op, { t: 'fallback.hello', v: 1, seq: 1, operatorMs: 1 });
    expect(c.lastTraffic).toBe(1000);
    out.deliver(op, { t: 'fallback.hub', v: 1, hubUp: false });
    out.deliver(new FakeWindow(OP), { t: 'fallback.hub', v: 1, hubUp: true }); // not the opener
    out.deliver(op, { t: 'fallback.hub', v: 1, hubUp: true }, 'http://evil.test'); // wrong origin
    expect(got).toEqual(['hello', 'hub:false']);
    expect(c.sendEvent({ k: 'media.ended', cueIndex: 2, at: 5 }, 'id-1')).toBe(true);
    expect(op.posted.at(-1)).toEqual({
      m: { t: 'live.event', v: 1, id: 'id-1', event: { k: 'media.ended', cueIndex: 2, at: 5 } },
      origin: OP,
    });
    op.closed = true;
    expect(c.available).toBe(false);
    expect(c.sendEvent({ k: 'media.ended', cueIndex: 3, at: 6 }, 'id-2')).toBe(false);
    c.dispose();
  });
});

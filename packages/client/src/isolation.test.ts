import { describe, expect, it } from 'vitest';
import { ErrorBudget, Supervisor, type SupervisorClock, type WorkerLike } from './isolation.ts';
import { FallbackClient, FallbackHost, portEndpoint } from './fallback.ts';

class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = [];
  listeners: Record<string, Set<(e: Event) => void>> = {
    message: new Set(),
    error: new Set(),
    messageerror: new Set(),
  };
  terminated = false;
  posted: unknown[] = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  addEventListener(t: 'message' | 'error' | 'messageerror', fn: (e: Event) => void) {
    this.listeners[t]!.add(fn);
  }
  removeEventListener(t: 'message' | 'error' | 'messageerror', fn: (e: Event) => void) {
    this.listeners[t]!.delete(fn);
  }
  emit(t: 'message' | 'error', data: unknown) {
    for (const fn of this.listeners[t]!) fn({ data, message: String(data), type: t } as unknown as Event);
  }
  beat() {
    this.emit('message', { __ordo: 'hb', at: 0 });
  }
}

function fakeClock() {
  let now = 0;
  const fns: (() => void)[] = [];
  const clock: SupervisorClock = {
    now: () => now,
    setInterval: (fn) => fns.push(fn),
    clearInterval: () => undefined,
  };
  return {
    clock,
    advance(ms: number) {
      for (let t = 0; t < ms; t += 250) {
        now += 250;
        for (const f of fns) f();
      }
    },
  };
}

describe('Supervisor', () => {
  it('starts, keeps a beating worker, restarts a silent one', () => {
    FakeWorker.all = [];
    const c = fakeClock();
    const sup = new Supervisor(c.clock);
    const gens: number[] = [];
    sup.add({ name: 'link', create: () => new FakeWorker(), start: (_w, g) => gens.push(g) });
    const w0 = FakeWorker.all[0]!;
    for (let i = 0; i < 8; i++) {
      w0.beat();
      c.advance(500);
    }
    expect(gens).toEqual([0]);
    c.advance(2500); // silence
    expect(w0.terminated).toBe(true);
    expect(gens).toEqual([0, 1]);
    expect(sup.stats()[0]).toMatchObject({ name: 'link', restarts: 1, generation: 1 });
  });

  it('restarts on error and on fatal, ignoring a stale generation', async () => {
    FakeWorker.all = [];
    const c = fakeClock();
    const sup = new Supervisor(c.clock);
    const reasons: string[] = [];
    sup.on('restart', (r) => reasons.push(r.reason));
    sup.add({ name: 'w', create: () => new FakeWorker(), start: () => undefined });
    FakeWorker.all[0]!.emit('error', 'boom');
    await Promise.resolve();
    FakeWorker.all[0]!.emit('error', 'late error from the dead worker');
    FakeWorker.all[1]!.emit('message', { __ordo: 'fatal', reason: 'invariant' });
    await Promise.resolve();
    expect(reasons).toEqual(['error: boom', 'fatal: invariant']);
    expect(FakeWorker.all).toHaveLength(3);
  });

  it('gives up after the restart budget and can be revived', async () => {
    FakeWorker.all = [];
    const c = fakeClock();
    const sup = new Supervisor(c.clock);
    let gaveUp = '';
    sup.on('gaveUp', (g) => (gaveUp = g.reason));
    sup.add({
      name: 'w',
      create: () => new FakeWorker(),
      start: () => undefined,
      budget: { max: 2, windowMs: 60_000 },
    });
    for (let i = 0; i < 3; i++) {
      FakeWorker.all.at(-1)!.emit('error', `crash ${i}`);
      await Promise.resolve();
    }
    expect(gaveUp).toBe('error: crash 2');
    expect(sup.worker('w')).toBeUndefined();
    c.advance(5000);
    expect(FakeWorker.all).toHaveLength(3); // no restarts after giving up
    sup.revive('w');
    expect(sup.worker('w')).toBeDefined();
  });

  it('retries a worker whose constructor throws', () => {
    const c = fakeClock();
    const sup = new Supervisor(c.clock);
    let n = 0;
    sup.add({
      name: 'w',
      create: () => {
        if (n++ === 0) throw new Error('no worker yet');
        return new FakeWorker();
      },
      start: () => undefined,
    });
    expect(sup.worker('w')).toBeUndefined();
    c.advance(250);
    expect(sup.worker('w')).toBeDefined();
  });
});

describe('ErrorBudget', () => {
  it('counts in a sliding window and reports exceeded', () => {
    let now = 0;
    const b = new ErrorBudget({ arm: { max: 2, windowMs: 1000 } }, () => now);
    expect(b.record('arm').exceeded).toBe(false);
    b.record('arm');
    expect(b.record('arm', 'third').exceeded).toBe(true);
    expect(b.snapshot().find((r) => r.kind === 'arm')).toMatchObject({
      count: 3,
      exceeded: true,
      last: 'third',
    });
    now = 1500;
    expect(b.exceeded('arm')).toBe(false);
  });
});

describe('fallback bus over a MessagePort', () => {
  it('carries hello, ready, state and health between host and client without any window', async () => {
    const ch = new MessageChannel();
    const host = new FallbackHost();
    const client = new FallbackClient({
      endpoint: portEndpoint(ch.port2 as unknown as MessagePort),
      outputId: 'o1',
    });
    host.registerEndpoint('o1', portEndpoint(ch.port1 as unknown as MessagePort));
    const got: string[] = [];
    client.on('hello', () => {
      got.push('hello');
      client.ready(0);
    });
    client.on('state', () => got.push('state'));
    client.on('hub', ({ hubUp }) => got.push(`hub:${hubUp}`));
    host.on('health', ({ outputId }) => got.push(`health:${outputId}`));
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toContain('hub:true'); // registered while inactive: told to follow the hub
    host.activate({ seq: 7 } as never);
    await new Promise((r) => setTimeout(r, 20));
    client.sendHealth({
      presented: 1,
      missed: 0,
      longTasks: 0,
      lateFlips: 0,
      cache: { ready: 0, total: 0 },
      gpuLost: 0,
      videoDropped: 0,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(expect.arrayContaining(['hello', 'state', 'health:o1']));
    expect(client.transport).toBe('port');
    host.dispose();
    client.dispose();
    ch.port1.close();
    ch.port2.close();
  });
});

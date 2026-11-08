import type { BusEndpoint } from '@ordo/client';
import { Supervisor, type SupervisorClock } from '@ordo/client';
import type { FallbackMessage } from '@ordo/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../src/core/client.ts';
import { DualEndpoint } from '../src/core/dualEndpoint.ts';
import { applyLibOp, applyLibPatch, diffLibrary, emptyLibrary } from '../src/core/libraryStore.ts';
import type { MainToCore } from '../src/core/protocol.ts';
import { firstRed } from '../src/lib/budgets.ts';
import { buildChecklist } from '../src/lib/checklist.ts';
import { BUDGET_INFO, CORE_GAVE_UP } from '../src/lib/budgets.ts';
import { EMPTY_SETTINGS } from '../src/core/libraryStore.ts';

function fakeEndpoint(kind: 'port' | 'window') {
  const subs = new Set<(m: FallbackMessage) => void>();
  const posted: FallbackMessage[] = [];
  let closed = false;
  const ep: BusEndpoint = {
    kind,
    post: (m) => posted.push(m),
    onMessage: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    alive: () => !closed,
    close: () => {
      closed = true;
    },
  };
  return {
    ep,
    posted,
    get closed() {
      return closed;
    },
    deliver: (m: FallbackMessage) => {
      for (const fn of subs) fn(m);
    },
  };
}

const HUB_UP: FallbackMessage = { t: 'fallback.hub', v: 1, hubUp: true };
const READY: FallbackMessage = { t: 'fallback.ready', v: 1, outputId: 'o1', appliedSeq: 1 };

describe('DualEndpoint (port handoff with the legacy relay as fallback)', () => {
  it('posts to both channels until the window speaks, then to the one that heard it last', () => {
    let now = 1000;
    const d = new DualEndpoint(() => now);
    const port = fakeEndpoint('port');
    const relay = fakeEndpoint('window');
    d.setPort(port.ep);
    d.setRelay(relay.ep);
    const got: string[] = [];
    d.onMessage((m) => got.push(m.t));
    expect(d.active()).toBe('both');
    d.post(HUB_UP);
    expect(port.posted).toHaveLength(1);
    expect(relay.posted).toHaveLength(1);

    now = 2000;
    port.deliver(READY);
    expect(got).toEqual(['fallback.ready']);
    expect(d.active()).toBe('port');
    expect(d.kind).toBe('port');
    d.post(HUB_UP);
    expect(port.posted).toHaveLength(2);
    expect(relay.posted).toHaveLength(1);

    // A relay copy heard shortly after does not move the bus off the proven port.
    now = 3000;
    relay.deliver(READY);
    expect(d.active()).toBe('port');
    // The window reloaded (the port went silent) and speaks on the relay: follow it.
    now = 9000;
    relay.deliver(READY);
    expect(d.active()).toBe('window');
    d.post(HUB_UP);
    expect(relay.posted).toHaveLength(2);
    expect(d.info(true)).toMatchObject({
      active: 'window',
      port: true,
      relay: true,
      sinceRxMs: 0,
      ready: true,
    });
  });

  it('replacing the port closes the old one and keeps the relay', () => {
    const d = new DualEndpoint(() => 5);
    const a = fakeEndpoint('port');
    const b = fakeEndpoint('port');
    const relay = fakeEndpoint('window');
    d.setRelay(relay.ep);
    d.setPort(a.ep);
    expect(d.lastOffer).toBe(5);
    d.setPort(b.ep);
    expect(a.closed).toBe(true);
    expect(relay.closed).toBe(false);
    a.deliver(READY); // the old port no longer counts
    expect(d.lastRx()).toBe(0);
    d.close();
    expect(b.closed && relay.closed).toBe(true);
    expect(d.alive()).toBe(false);
  });
});

describe('library posting by reference identity', () => {
  it('posts only changed entities and the main read model converges', () => {
    const a = {
      ...emptyLibrary(),
      presentations: [{ id: 'p1' }, { id: 'p2' }] as never[],
      media: [{ id: 'm1' }] as never[],
    };
    let b = applyLibOp(a, { k: 'upsert', key: 'presentations', entity: { id: 'p2', title: 'x' } });
    b = applyLibOp(b, { k: 'upsert', key: 'presentations', entity: { id: 'p3' } });
    b = applyLibOp(b, { k: 'remove', key: 'media', id: 'm1' });
    b = applyLibOp(b, { k: 'settings', key: 'audio', value: { ...EMPTY_SETTINGS.audio, masterDb: -6 } });
    const patch = diffLibrary(a, b)!;
    expect(patch.upsert?.presentations?.map((e) => e.id)).toEqual(['p2', 'p3']);
    expect(patch.remove?.media).toEqual(['m1']);
    expect(patch.settings?.audio.masterDb).toBe(-6);
    expect(patch.upsert?.media).toBeUndefined();
    const main = applyLibPatch(structuredClone(a), structuredClone(patch));
    expect(main).toEqual(b);
    expect(diffLibrary(b, b)).toBeNull();
  });
});

describe('budgets map every red state to one action', () => {
  it('first exceeded budget wins and the checklist lists every red state', () => {
    expect(firstRed([{ kind: 'socket', count: 1, max: 3, windowMs: 1, exceeded: false }])).toBeNull();
    const r = firstRed([
      { kind: 'unknown', count: 9, max: 1, windowMs: 1, exceeded: true },
      { kind: 'cacheFill', count: 3, max: 2, windowMs: 1, exceeded: true },
    ]);
    expect(r?.kind).toBe('cacheFill');
    expect(r?.info.actionLabel).toBe('Retry download');
    const items = buildChecklist(EMPTY_SETTINGS, 'http://op').flatMap((s) => s.items);
    for (const b of Object.values(BUDGET_INFO)) expect(items).toContain(b.checklist);
    expect(items).toContain(CORE_GAVE_UP.checklist);
  });
});

/** A fake Worker: records posts; `ack` answers like the core would. */
class FakeWorker extends EventTarget {
  posted: MainToCore[] = [];
  terminated = false;
  postMessage(m: MainToCore): void {
    if (this.terminated) return;
    this.posted.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function fakeClock() {
  let t = 0;
  const fns: (() => void)[] = [];
  const clock: SupervisorClock = {
    now: () => t,
    setInterval: (fn) => {
      fns.push(fn);
      return fns.length;
    },
    clearInterval: () => undefined,
  };
  return {
    clock,
    advance(ms: number) {
      for (let k = 0; k < ms; k += 250) {
        t += 250;
        for (const fn of fns) fn();
      }
    },
  };
}

describe('CoreClient outbox (a core crash does not lose a GO)', () => {
  let client: CoreClient | undefined;
  afterEach(() => client?.dispose());

  it('re-sends unacknowledged actions to the restarted core with the same ids, and stops after the ack', () => {
    const c = fakeClock();
    const workers: FakeWorker[] = [];
    client = new CoreClient(
      'operate',
      'test',
      () => {
        const w = new FakeWorker();
        workers.push(w);
        return w as unknown as Worker;
      },
      { supervisor: new Supervisor(c.clock, 250) },
    );
    const w0 = workers[0]!;
    expect(w0.posted[0]).toMatchObject({ t: 'init', role: 'operate', generation: 0 });
    w0.reply({ t: 'ready', generation: 0 });
    expect(client.alive).toBe(true);

    client.action({ id: 'go' }, 'keyboard');
    client.action({ id: 'next' }, 'streamdeck');
    const sent = w0.posted.filter((m) => m.t === 'action') as Extract<MainToCore, { t: 'action' }>[];
    expect(sent).toHaveLength(2);
    w0.reply({ t: 'ack', aid: sent[0]!.aid });
    expect(client.unacknowledged).toBe(1);

    // The core dies silently (no heartbeats): the supervisor restarts it after 1.5 s.
    w0.terminate();
    const restarts: string[] = [];
    client.on('supervisor', (e) => restarts.push(e.reason));
    c.advance(1000);
    expect(workers).toHaveLength(1);
    c.advance(1000);
    expect(workers).toHaveLength(2);
    expect(restarts[0]).toMatch(/no heartbeat/);
    expect(client.recovering).toBe(true);
    const w1 = workers[1]!;
    const again = w1.posted.filter((m) => m.t === 'action') as Extract<MainToCore, { t: 'action' }>[];
    expect(w1.posted[0]).toMatchObject({ t: 'init', generation: 1 });
    expect(again.map((m) => m.aid)).toEqual([sent[1]!.aid]);
    let ready: { restart: boolean } | undefined;
    client.on('ready', (r) => {
      ready = r;
    });
    w1.reply({ t: 'ready', generation: 1 });
    expect(ready?.restart).toBe(true);
    w1.reply({ t: 'ack', aid: sent[1]!.aid });
    expect(client.unacknowledged).toBe(0);
    expect(client.budgets.snapshot().find((b) => b.kind === 'workerRestart')?.count).toBe(1);
  });

  it('ignores messages from a worker that is no longer the current one, and supervisor control messages', () => {
    const c = fakeClock();
    const workers: FakeWorker[] = [];
    client = new CoreClient(
      'operate',
      'test',
      () => {
        const w = new FakeWorker();
        workers.push(w);
        return w as unknown as Worker;
      },
      { supervisor: new Supervisor(c.clock, 250) },
    );
    const logs: string[] = [];
    client.on('log', (l) => logs.push(l.text));
    workers[0]!.reply({ __ordo: 'hb', at: 0 });
    workers[0]!.reply({ t: 'log', level: 'info', text: 'a' });
    client.sup.restart('core', 'test');
    workers[0]!.reply({ t: 'log', level: 'info', text: 'stale' });
    workers[1]!.reply({ t: 'log', level: 'info', text: 'b' });
    expect(logs).toEqual(['a', 'b']);
  });
});

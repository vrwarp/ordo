/**
 * The boot of the bake service (services/bakeBoot.ts, in the first load): it decides from the gate whether the
 * service's chunk is wanted at all, loads it once, starts it, passes the press of Go live to it, and gives the
 * editor and the Go-live check the actions. The service itself is replaced by a fake: its own tests are
 * bakeService.test.ts; here the question is only WHEN the chunk is fetched and what is called on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BakeVerdict } from '../src/lib/capabilities.ts';
import type { BakeService } from '../src/services/bake.ts';
import { createBakeBoot } from '../src/services/bakeBoot.ts';

type Fake = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  holdForGoLive: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  makeNow: ReturnType<typeof vi.fn>;
  makeAgain: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
};

const state: {
  verdict: BakeVerdict;
  loads: number;
  failLoads: number;
  fake: Fake;
  testMode: boolean;
  clock: number;
  caps: Set<() => void>;
  capsAsked: boolean[];
  reconnect: Set<() => void>;
  win: { __ordo?: Record<string, unknown> };
} = {
  verdict: { ok: false, why: 'unknown', list: false },
  loads: 0,
  failLoads: 0,
  fake: undefined as never,
  testMode: false,
  clock: 0,
  caps: new Set(),
  capsAsked: [],
  reconnect: new Set(),
  win: {},
};

function makeFake(): Fake {
  const stop = vi.fn();
  return {
    start: vi.fn(() => stop),
    stop,
    holdForGoLive: vi.fn(),
    refresh: vi.fn(async () => undefined),
    makeNow: vi.fn(async () => ({ ok: true as const, queued: 2 })),
    makeAgain: vi.fn(async () => ({ ok: true as const })),
    focus: vi.fn(),
    snapshot: vi.fn(() => ({ sweeps: 3 })),
  };
}

/** The hub's capabilities changed: every listener the boot registered runs. */
const capsChange = () => {
  for (const fn of [...state.caps]) fn();
};

const OK: BakeVerdict = { ok: true, list: true };
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
const boot = async () =>
  createBakeBoot({
    gate: () => state.verdict,
    load: async () => {
      state.loads++;
      if (state.failLoads > 0) {
        state.failLoads--;
        throw new Error('chunk failed');
      }
      return state.fake as unknown as BakeService;
    },
    now: () => state.clock,
    testMode: () => state.testMode,
    onCaps: (fn) => {
      state.caps.add(fn);
      return () => state.caps.delete(fn);
    },
    loadCaps: async (force) => {
      state.capsAsked.push(force);
    },
    onReconnect: (fn) => {
      state.reconnect.add(fn);
      return () => state.reconnect.delete(fn);
    },
    win: state.win,
  });

beforeEach(() => {
  state.verdict = { ok: false, why: 'unknown', list: false };
  state.loads = 0;
  state.failLoads = 0;
  state.fake = makeFake();
  state.testMode = false;
  state.clock = 1_000_000;
  state.caps.clear();
  state.capsAsked = [];
  state.reconnect.clear();
  state.win = {};
});
afterEach(() => {});

describe('when the chunk is fetched (BT1-BT3)', () => {
  for (const [name, v] of [
    ['a phone, the demo or a tablet', { ok: false, why: 'unsupported', list: false }],
    ['a hub with the switch off', { ok: false, why: 'off', list: false }],
    ['a hub that has not answered', { ok: false, why: 'unknown', list: false }],
  ] as const)
    it(`BT1 ${name}: the service chunk is not fetched`, async () => {
      state.verdict = v;
      const { installBake } = await boot();
      const off = installBake();
      await flush();
      expect(state.loads).toBe(0);
      off();
    });

  it('BT2 a computer that can: the chunk is fetched once and the service is started; the stop is the cleanup, and a remount starts it again without a second fetch', async () => {
    state.verdict = OK;
    const { installBake } = await boot();
    const off = installBake();
    await flush();
    expect(state.loads).toBe(1);
    expect(state.fake.start).toHaveBeenCalledTimes(1);
    expect(state.fake.stop).not.toHaveBeenCalled();
    off();
    expect(state.fake.stop).toHaveBeenCalledTimes(1);
    // a strict-mode remount: stop, start again; the chunk is the one already fetched
    const off2 = installBake();
    await flush();
    expect(state.loads).toBe(1);
    expect(state.fake.start).toHaveBeenCalledTimes(2);
    off2();
    expect(state.fake.stop).toHaveBeenCalledTimes(2);
  });

  it("BT3 the hub's capabilities arrive later: the chunk is fetched then, not before", async () => {
    const { installBake } = await boot();
    const off = installBake();
    await flush();
    expect(state.loads).toBe(0);
    state.verdict = OK;
    capsChange();
    await flush();
    expect(state.loads).toBe(1);
    expect(state.fake.start).toHaveBeenCalledTimes(1);
    off();
  });

  it('BT3 the boot asks the hub for its capabilities (nothing else on the first screens does) and again when the link comes back', async () => {
    const { installBake } = await boot();
    const off = installBake();
    await flush();
    expect(state.capsAsked).toEqual([false]);
    for (const fn of [...state.reconnect]) fn();
    expect(state.capsAsked).toEqual([false, true]);
    off();
    expect(state.reconnect.size).toBe(0);
    expect(state.caps.size).toBe(0);
  });

  it('BT3 a cleanup before the chunk arrives starts nothing', async () => {
    state.verdict = OK;
    const { installBake } = await boot();
    const off = installBake();
    off();
    await flush();
    expect(state.fake.start).not.toHaveBeenCalled();
  });

  it('BT7 a chunk that failed to load is tried again at the next trigger, and nothing throws', async () => {
    state.verdict = OK;
    state.failLoads = 1;
    const { installBake } = await boot();
    const off = installBake();
    await flush();
    expect(state.fake.start).not.toHaveBeenCalled();
    capsChange();
    await flush();
    expect(state.fake.start).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('the press of Go live (BT4)', () => {
  it('BT4 with no service loaded it fetches nothing; with one loaded it is passed on at once', async () => {
    const { holdBakesForGoLive, installBake } = await boot();
    holdBakesForGoLive();
    await flush();
    expect(state.loads).toBe(0);
    state.verdict = OK;
    const off = installBake();
    await flush();
    // the chunk arrived within a minute of the press: the hold is passed on
    expect(state.fake.holdForGoLive).toHaveBeenCalledTimes(1);
    holdBakesForGoLive();
    expect(state.fake.holdForGoLive).toHaveBeenCalledTimes(2);
    off();
  });

  it('BT4 a press long before the chunk arrives is not carried over', async () => {
    const { holdBakesForGoLive, installBake } = await boot();
    holdBakesForGoLive();
    state.clock += 61_000;
    state.verdict = OK;
    const off = installBake();
    await flush();
    expect(state.fake.start).toHaveBeenCalledTimes(1);
    expect(state.fake.holdForGoLive).not.toHaveBeenCalled();
    off();
  });
});

describe('the actions (BT5)', () => {
  it('BT5 refresh on a phone or the demo fetches nothing; on a computer that lists it goes to the service', async () => {
    const { bakeActions } = await boot();
    state.verdict = { ok: false, why: 'unsupported', list: false };
    await bakeActions.refresh('p1');
    expect(state.loads).toBe(0);
    state.verdict = { ok: false, why: 'unsupported', list: true };
    await bakeActions.refresh('p1', { force: true });
    expect(state.loads).toBe(1);
    expect(state.fake.refresh).toHaveBeenCalledWith('p1', { force: true });
    // a hub with the switch off: the editor still gets its words ("off"), from the service
    state.verdict = { ok: false, why: 'off', list: false };
    await bakeActions.refresh('p2');
    expect(state.fake.refresh).toHaveBeenCalledWith('p2', undefined);
  });

  it("BT5 Make the pictures now answers the gate's refusals without fetching the service", async () => {
    const { bakeActions } = await boot();
    state.verdict = { ok: false, why: 'unsupported', list: true };
    expect(await bakeActions.makeNow()).toEqual({ ok: false, why: 'unsupported' });
    state.verdict = { ok: false, why: 'off', list: false };
    expect(await bakeActions.makeNow()).toEqual({ ok: false, why: 'off' });
    state.verdict = { ok: false, why: 'unknown', list: false };
    expect(await bakeActions.makeNow()).toEqual({ ok: false, why: 'hub' });
    expect(state.loads).toBe(0);
    state.verdict = OK;
    expect(await bakeActions.makeNow({ playlistId: 'pl' })).toEqual({ ok: true, queued: 2 });
    expect(state.fake.makeNow).toHaveBeenCalledWith({ playlistId: 'pl' });
  });

  it('BT5 Make picture again and the focus go to the service; the focus of a computer that cannot is nothing', async () => {
    const { bakeActions } = await boot();
    state.verdict = { ok: false, why: 'unsupported', list: false };
    expect(await bakeActions.makeAgain('p', 's')).toEqual({ ok: false, why: 'hub' });
    await bakeActions.focus({ presentationId: 'p' });
    expect(state.loads).toBe(0);
    state.verdict = OK;
    expect(await bakeActions.makeAgain('p', 's')).toEqual({ ok: true });
    expect(state.fake.makeAgain).toHaveBeenCalledWith('p', 's');
    await bakeActions.focus({ presentationId: 'p' });
    expect(state.fake.focus).toHaveBeenCalledWith({ presentationId: 'p' });
  });

  it('BT5 a service that cannot be fetched is a refusal, not a throw', async () => {
    const { bakeActions } = await boot();
    state.verdict = OK;
    state.failLoads = 1;
    expect(await bakeActions.makeNow()).toEqual({ ok: false, why: 'hub' });
    state.failLoads = 1;
    await expect(bakeActions.refresh('p')).resolves.toBeUndefined();
  });
});

describe('the test hook (BT6)', () => {
  it('BT6 in the product nothing is put on window', async () => {
    const { installBake } = await boot();
    state.verdict = OK;
    const off = installBake();
    await flush();
    expect(state.win.__ordo).toBeUndefined();
    off();
  });

  it('BT6 in test mode window.__ordo.bake has the fields of C-BW8: the real gate before the service is fetched, its snapshot after', async () => {
    state.testMode = true;
    state.verdict = { ok: false, why: 'unsupported', list: false };
    const { installBake } = await boot();
    const off = installBake();
    await flush();
    const hook = state.win.__ordo?.bake as Record<string, unknown> & { loaded(): boolean };
    expect(Object.keys(hook).sort()).toEqual([
      'gate',
      'hold',
      'lastMade',
      'presentations',
      'requests',
      'running',
      'slides',
      'sweeps',
      'timings',
      'totals',
      'workers',
    ]);
    // a phone: the gate says so and the service was never fetched
    expect(hook.gate).toBe('unsupported');
    expect(hook.workers).toBe(0);
    expect(hook.requests).toEqual([]);
    expect(hook.loaded()).toBe(false);
    expect(state.loads).toBe(0);
    state.verdict = { ok: false, why: 'off', list: false };
    expect(hook.gate).toBe('off');
    state.verdict = { ok: false, why: 'unknown', list: false };
    expect(hook.gate).toBe('unknown');
    // a computer that can: the service is fetched and the fields are its snapshot's
    state.verdict = OK;
    capsChange();
    await flush();
    expect(hook.loaded()).toBe(true);
    state.fake.snapshot.mockReturnValue({
      gate: 'ready',
      hold: 'service',
      workers: 1,
      sweeps: 3,
      requests: [{ method: 'GET', path: '/x', status: 200 }],
    });
    expect(hook.gate).toBe('ready');
    expect(hook.hold).toBe('service');
    expect(hook.workers).toBe(1);
    expect(hook.sweeps).toBe(3);
    off();
  });
});

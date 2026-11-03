import { describe, expect, it } from 'vitest';
import { WakeLockKeeper, type WakeSentinel } from './wakelock.ts';

/** A sentinel whose release the test triggers (Chrome releases it when the window is occluded). */
class FakeSentinel implements WakeSentinel {
  released = false;
  private listeners: (() => void)[] = [];
  async release(): Promise<void> {
    this.released = true;
    for (const l of this.listeners) l();
  }
  addEventListener(_t: 'release', fn: () => void): void {
    this.listeners.push(fn);
  }
}

function setup(visibleAtStart = true) {
  let visible = visibleAtStart;
  const sentinels: FakeSentinel[] = [];
  const timers: (() => void)[] = [];
  const keeper = new WakeLockKeeper({
    request: async () => {
      const s = new FakeSentinel();
      sentinels.push(s);
      return s;
    },
    visible: () => visible,
    setInterval: (fn) => timers.push(fn),
  });
  return { keeper, sentinels, timers, setVisible: (v: boolean) => (visible = v) };
}

describe('wake lock keeper (review item 11)', () => {
  it('requests the lock again after the browser released it', async () => {
    const { keeper, sentinels } = setup();
    await keeper.acquire();
    expect(keeper.held).toBe(true);
    expect(sentinels).toHaveLength(1);
    // Occlusion: Chrome releases the sentinel; the keeper notices and asks again at once (page visible).
    await sentinels[0]!.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(sentinels).toHaveLength(2);
    expect(keeper.held).toBe(true);
    expect(keeper.sentinel).toBe(sentinels[1]);
  });

  it('waits for visibility, then re-requests on the next visibility change or timer', async () => {
    const { keeper, sentinels, timers, setVisible } = setup();
    await keeper.acquire();
    setVisible(false);
    await sentinels[0]!.release(); // hidden: nothing to do yet
    await Promise.resolve();
    expect(sentinels).toHaveLength(1);
    expect(keeper.held).toBe(false);
    await keeper.acquire(); // still hidden
    expect(sentinels).toHaveLength(1);
    setVisible(true);
    timers[0]!(); // the periodic guard
    await Promise.resolve();
    await Promise.resolve();
    expect(sentinels).toHaveLength(2);
    expect(keeper.held).toBe(true);
    // Holding a lock: further calls do not request another.
    await keeper.acquire();
    expect(sentinels).toHaveLength(2);
  });

  it('does nothing when the API is missing and survives a refused request', async () => {
    const none = new WakeLockKeeper({ request: undefined, visible: () => true, setInterval: () => 0 });
    await none.acquire();
    expect(none.held).toBe(false);
    let calls = 0;
    const refused = new WakeLockKeeper({
      request: async () => {
        calls++;
        throw new Error('NotAllowedError');
      },
      visible: () => true,
      setInterval: () => 0,
    });
    await refused.acquire();
    await refused.acquire();
    expect(calls).toBe(2);
    expect(refused.held).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { Cancelled, type LaneJob, Lanes, RANK, type Steps, laneOf } from './lanes.ts';

/*
 * The raster lanes with fakes (design/27 §7.5): a task poster whose tasks run only when the test says, a
 * clock the test moves, and jobs whose slices log what ran. A slice's "work" advances the clock.
 */

function harness() {
  let clock = 0;
  const tasks: (() => void)[] = [];
  const errors: unknown[] = [];
  const lanes = new Lanes({
    post: (fn) => tasks.push(fn),
    now: () => clock,
    onError: (err) => errors.push(err),
  });
  /** Let every microtask run (job continuations) without running a posted task. */
  const settle = () => new Promise<void>((r) => setImmediate(r));
  /** Run one posted task (one turn), then its continuations. */
  async function step(): Promise<boolean> {
    await settle();
    const t = tasks.shift();
    if (!t) return false;
    t();
    await settle();
    return true;
  }
  async function drain(): Promise<void> {
    while (await step());
  }
  const log: string[] = [];
  /** A job of `slices` slices of `ms` each; `between` runs between two slices (an await, a decode). */
  function job(
    key: string,
    o: { chain?: string; rank?: number; slices?: number; ms?: number; gate?: Promise<unknown> } = {},
    between?: (i: number, s: Steps) => Promise<void>,
  ): LaneJob & { steps?: Steps; finished?: boolean; unwound?: boolean } {
    const j: LaneJob & { steps?: Steps; finished?: boolean; unwound?: boolean } = {
      key,
      chain: o.chain ?? key,
      rank: o.rank ?? RANK.armed,
      gate: o.gate,
      async run(s) {
        j.steps = s;
        try {
          for (let i = 0; i < (o.slices ?? 1); i++) {
            if (i > 0 && between) await between(i, s);
            await s.slice(() => {
              log.push(`${key}${i}`);
              clock += o.ms ?? 10;
            });
          }
          j.finished = true;
        } finally {
          j.unwound = true;
        }
      },
    };
    return j;
  }
  return { lanes, step, drain, settle, log, job, errors, tick: (ms: number) => (clock += ms), tasks };
}

describe('raster lanes: order', () => {
  it('runs the most urgent waiting slice first: props, live, armed, bulk', async () => {
    const h = harness();
    h.lanes.push(h.job('bulk', { rank: RANK.bulk }));
    h.lanes.push(h.job('armed', { rank: RANK.armed }));
    h.lanes.push(h.job('live', { rank: RANK.live }));
    h.lanes.push(h.job('props', { rank: RANK.props }));
    await h.drain();
    expect(h.log).toEqual(['props0', 'live0', 'armed0', 'bulk0']);
    expect(laneOf(RANK.props)).toBe('interactive');
    expect(laneOf(RANK.armed)).toBe('interactive');
    expect(laneOf(RANK.bulk)).toBe('bulk');
  });

  it('runs the jobs of one chain one at a time, queued in rank then arrival order', async () => {
    const h = harness();
    h.lanes.push(h.job('a1', { chain: 'slide', rank: RANK.armed, slices: 2 }));
    h.lanes.push(h.job('a2', { chain: 'slide', rank: RANK.armed }));
    h.lanes.push(h.job('l1', { chain: 'slide', rank: RANK.live }));
    await h.drain();
    // a1 had started: it finishes first; then the live job overtakes the armed one queued before it.
    expect(h.log).toEqual(['a10', 'a11', 'l10', 'a20']);
  });

  it('lets another chain run while a job awaits a decode off this thread', async () => {
    const h = harness();
    let decoded!: () => void;
    const decode = new Promise<void>((r) => (decoded = r));
    const slide = h.job('slide', { chain: 'slide', rank: RANK.armed, slices: 2 }, () => decode);
    h.lanes.push(slide);
    await h.step();
    h.lanes.push(h.job('bg', { chain: 'bg', rank: RANK.armed }));
    await h.drain();
    expect(h.log).toEqual(['slide0', 'bg0']);
    decoded();
    await h.drain();
    expect(h.log).toEqual(['slide0', 'bg0', 'slide1']);
    expect(slide.finished).toBe(true);
  });
});

describe('raster lanes: preemption', () => {
  it('a props job that arrives during a heavy slide runs before the slide’s next slice', async () => {
    const h = harness();
    // A slide prepared in four 30 ms bands, then drawn.
    h.lanes.push(h.job('slide', { chain: 'slide', rank: RANK.armed, slices: 5, ms: 30 }));
    await h.step(); // band 0 runs
    // A props job arrives (as a message, in its own task) while the slide waits for its next turn.
    h.lanes.push(h.job('props', { chain: 'props', rank: RANK.props, ms: 2 }));
    await h.drain();
    expect(h.log).toEqual(['slide0', 'props0', 'slide1', 'slide2', 'slide3', 'slide4']);
  });

  it('bulk work yields to every interactive slice that waits, and runs when nothing else does', async () => {
    const h = harness();
    const warm = h.job('warm', { chain: 'warm', rank: RANK.bulk, slices: 3 });
    h.lanes.push(warm);
    await h.step();
    h.lanes.push(h.job('armed', { chain: 'slide', rank: RANK.armed, slices: 2 }));
    h.lanes.push(h.job('props', { chain: 'props', rank: RANK.props }));
    await h.drain();
    expect(h.log).toEqual(['warm0', 'props0', 'armed0', 'armed1', 'warm1', 'warm2']);
    expect(warm.finished).toBe(true);
  });

  it('bulk work starts only once nothing interactive is queued or running', async () => {
    const h = harness();
    let decoded!: () => void;
    const decode = new Promise<void>((r) => (decoded = r));
    const armed = h.job('armed', { chain: 'slide', rank: RANK.armed, slices: 2 }, () => decode);
    const warm = h.job('warm', { chain: 'warm', rank: RANK.bulk });
    h.lanes.push(armed);
    h.lanes.push(warm);
    await h.drain();
    // The armed job awaits its decode: the warm job has not even started (no read, no decode of its own).
    expect(h.log).toEqual(['armed0']);
    expect(warm.steps).toBeUndefined();
    decoded();
    await h.drain();
    expect(h.log).toEqual(['armed0', 'armed1', 'warm0']);
  });

  it('a slice that runs is never interrupted: the most urgent job waits for it to end', async () => {
    const h = harness();
    const props = h.job('props', { chain: 'props', rank: RANK.props });
    const slide: LaneJob = {
      key: 'slide',
      chain: 'slide',
      rank: RANK.armed,
      async run(s) {
        await s.slice(() => {
          // A props job is queued from inside the slice (as if its message had arrived meanwhile).
          h.lanes.push(props);
          h.log.push('slide-start');
          h.log.push('slide-end');
        });
      },
    };
    h.lanes.push(slide);
    await h.drain();
    expect(h.log).toEqual(['slide-start', 'slide-end', 'props0']);
  });
});

describe('raster lanes: cancellation', () => {
  it('drops a queued job and stops a running one at its next slice, through its finally blocks', async () => {
    const h = harness();
    const running = h.job('old', { chain: 'slide', slices: 3 });
    const queued = h.job('older-queued', { chain: 'slide' });
    const kept = h.job('new', { chain: 'slide' });
    h.lanes.push(running);
    h.lanes.push(queued);
    await h.step();
    expect(h.lanes.keys()).toEqual({ slide: ['old', 'older-queued'] });
    expect(h.lanes.cancel(['old', 'older-queued', 'absent'])).toBe(2);
    h.lanes.push(kept);
    await h.drain();
    expect(h.log).toEqual(['old0', 'new0']);
    expect(running.finished).toBeUndefined();
    expect(running.unwound).toBe(true);
    expect(running.steps!.cancelled).toBe(true);
    expect(queued.steps).toBeUndefined(); // never started
    expect(h.errors).toEqual([]);
    expect(h.lanes.size).toBe(0);
  });

  it('a job cancelled while it awaits a decode finds out at its next check, and a waiter is let go at once', async () => {
    const h = harness();
    let decoded!: () => void;
    const decode = new Promise<void>((r) => (decoded = r));
    const seen: string[] = [];
    const j: LaneJob = {
      key: 'k',
      chain: 'slide',
      rank: RANK.armed,
      async run(s) {
        try {
          await decode;
          s.check();
          seen.push('not reached');
        } catch (err) {
          seen.push(err instanceof Cancelled ? 'cancelled' : 'other');
          throw err;
        }
      },
    };
    h.lanes.push(j);
    await h.settle();
    h.lanes.cancel(['k']);
    decoded();
    await h.drain();
    expect(seen).toEqual(['cancelled']);
    // A job waiting for its turn behind a long slice is rejected without waiting for it.
    const waiting = h.job('w', { chain: 'w2', rank: RANK.armed, slices: 2 });
    h.lanes.push(h.job('busy', { chain: 'busy', rank: RANK.props }));
    h.lanes.push(waiting);
    await h.settle(); // both wait for a turn
    h.lanes.cancel(['w']);
    await h.drain();
    expect(h.log).toEqual(['busy0']);
    expect(waiting.unwound).toBe(true);
    expect(await Promise.race([h.lanes.idle().then(() => 'idle'), h.settle().then(() => 'busy')])).toBe(
      'idle',
    );
  });

  it('reports a job’s own failure once, and goes on with the chain', async () => {
    const h = harness();
    h.lanes.push({
      key: 'bad',
      chain: 'c',
      rank: RANK.armed,
      run: async () => {
        throw new Error('raster failed');
      },
    });
    h.lanes.push(h.job('next', { chain: 'c' }));
    await h.drain();
    expect((h.errors[0] as Error).message).toBe('raster failed');
    expect(h.log).toEqual(['next0']);
  });
});

describe('raster lanes: fonts and timing', () => {
  it('starts a job only once the fonts sent before it are loaded; earlier jobs do not wait', async () => {
    const h = harness();
    let loaded!: () => void;
    const fonts = new Promise<void>((r) => (loaded = r));
    h.lanes.push(h.job('before', { chain: 'a' }));
    h.lanes.push(h.job('after', { chain: 'b', gate: fonts }));
    await h.drain();
    expect(h.log).toEqual(['before0']);
    loaded();
    await h.drain();
    expect(h.log).toEqual(['before0', 'after0']);
    // A failed font load does not hold text back forever.
    h.lanes.push(h.job('failed-fonts', { chain: 'c', gate: Promise.reject(new Error('font')) }));
    await h.drain();
    expect(h.log.at(-1)).toBe('failed-fonts0');
  });

  it('times the wait (queue, turns) and the slices of each job by lane', async () => {
    const h = harness();
    const slide = h.job('slide', { chain: 'slide', rank: RANK.armed, slices: 2, ms: 30 });
    const props = h.job('props', { chain: 'props', rank: RANK.props, ms: 4 });
    h.lanes.push(slide);
    await h.step(); // slide0 runs 30 ms
    h.lanes.push(props);
    await h.drain();
    expect(props.steps!.timing()).toEqual({
      lane: 'interactive',
      waitMs: 0,
      rasterMs: 4,
      slices: 1,
      longestMs: 4,
    });
    // The slide waited 4 ms for its second turn, behind the props slice.
    expect(slide.steps!.timing()).toEqual({
      lane: 'interactive',
      waitMs: 4,
      rasterMs: 60,
      slices: 2,
      longestMs: 30,
    });
    const warm = h.job('warm', { chain: 'warm', rank: RANK.bulk, ms: 5 });
    h.lanes.push(h.job('busy', { chain: 'other', rank: RANK.live, ms: 20 }));
    h.lanes.push(warm);
    await h.drain();
    expect(warm.steps!.timing()).toMatchObject({ lane: 'bulk', waitMs: 20, rasterMs: 5 });
  });
});

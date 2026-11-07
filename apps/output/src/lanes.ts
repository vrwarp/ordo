/**
 * The asset worker's raster lanes (design/27 §7.5, M7): jobs that must flip on time go ahead of work that
 * only prepares what comes later, and a job that was superseded stops at its next step.
 *
 * - **Lanes.** *interactive*: the props layer (a clock flips once a second, rasterized 150 ms ahead of its
 *   boundary), then the live cue's layers, then the armed cue's; *bulk*: work for later (the pictures of the
 *   cue after the armed one). A job's rank says which; lower ranks go first.
 * - **Chains.** Jobs of one chain run one at a time, in rank then arrival order: a layer's content must
 *   reach the renderer in the order its stacks expect it (`LayerStack.offer`), so each layer is a chain. Jobs
 *   of different chains run side by side: one awaiting a file read or a decode (off this thread) never
 *   holds up another. A bulk job starts only while no interactive job is queued or running, so its decodes
 *   do not compete for the cores with theirs.
 * - **Turns.** A job does its synchronous work (preparing a picture band, drawing the slide) in slices
 *   (`Steps.slice`), and each slice waits for its turn: the most urgent waiting slice runs next, in its own
 *   task, after the messages that arrived meanwhile. A props job that arrives while a slide decodes therefore
 *   waits for at most the slice running then, never for the whole slide (the M7 exit: the props flip is
 *   never more than one frame late while a slide decodes; `asset.lanes.browser.test.ts`). Nothing preempts a
 *   slice that runs: slices are kept short instead (pictures are prepared in bands, `preparePictureSteps`).
 * - **Cancellation.** `cancel(keys)` drops queued jobs and makes running ones throw `Cancelled` at their next
 *   slice or `check()`; they unwind through their `finally` blocks (unpinning, closing what they decoded).
 * - **Timing.** Per job: the time it waited (in its queue, for its fonts, for its turns), the time its slices
 *   ran on this thread, the number of slices and the longest one. The asset worker reports them with each
 *   result, and the link keeps per-lane percentiles (`lane-stats.ts`).
 *
 * Pure apart from the task poster it is given, so it is unit tested with a fake clock and poster.
 */

/** Thrown inside a job that was cancelled. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

export type LaneName = 'interactive' | 'bulk';

/** Job ranks, most urgent first: the first three are the interactive lane, `bulk` the other. */
export const RANK = { props: 0, live: 1, armed: 2, bulk: 3 } as const;

export function laneOf(rank: number): LaneName {
  return rank >= RANK.bulk ? 'bulk' : 'interactive';
}

export type JobTiming = {
  lane: LaneName;
  /** Time spent waiting: in the queue, for the fonts sent before it, and for its turns. */
  waitMs: number;
  /** Time its slices ran on this thread. */
  busyMs: number;
  slices: number;
  longestMs: number;
};

/** What a running job can do. */
export interface Steps {
  /** Run `fn` (synchronous) on the job's next turn and return its result; throws `Cancelled` instead. */
  slice<T>(fn: () => T): Promise<T>;
  /** Throws `Cancelled` once the job has been cancelled. */
  check(): void;
  readonly cancelled: boolean;
  /** The job's timing so far. */
  timing(): JobTiming;
}

export type LaneJob = {
  /** What `cancel` matches. */
  key: string;
  /** Jobs of one chain run one at a time (a layer). */
  chain: string;
  /** `RANK`. */
  rank: number;
  /** Waited for before the job starts: the font loads sent before it, so text never draws without them. */
  gate?: Promise<unknown>;
  run(steps: Steps): Promise<void>;
};

type Entry = {
  job: LaneJob;
  seq: number;
  pushedAt: number;
  cancelled: boolean;
  waited: number;
  busy: number;
  slices: number;
  longest: number;
};

type Waiter = { e: Entry; at: number; resolve: () => void; reject: (err: Error) => void };
type Chain = { running?: Entry; queue: Entry[] };

export type LanesOptions = {
  /** Runs `fn` in a task of its own (default: a MessageChannel message, else setTimeout 0). */
  post?: (fn: () => void) => void;
  now?: () => number;
  /** A job threw something other than `Cancelled` (its own errors are its business). */
  onError?: (err: unknown, job: LaneJob) => void;
};

/** A task poster without timer clamping: a message on a channel of its own. */
function defaultPost(): (fn: () => void) => void {
  if (typeof MessageChannel !== 'undefined') {
    const ch = new MessageChannel();
    const queue: (() => void)[] = [];
    ch.port1.onmessage = () => queue.shift()?.();
    // Node (tests) keeps a process alive while a port is open; a worker has no such method.
    (ch.port1 as unknown as { unref?: () => void }).unref?.();
    (ch.port2 as unknown as { unref?: () => void }).unref?.();
    return (fn) => {
      queue.push(fn);
      ch.port2.postMessage(0);
    };
  }
  return (fn) => setTimeout(fn, 0);
}

export class Lanes {
  private chains = new Map<string, Chain>();
  private waiters: Waiter[] = [];
  /** A slice was granted and has not ended. */
  private busy = false;
  private pumpPosted = false;
  private seq = 0;
  private idleWaiters: (() => void)[] = [];
  private readonly post: (fn: () => void) => void;
  private readonly now: () => number;
  private readonly onError: (err: unknown, job: LaneJob) => void;

  constructor(opts: LanesOptions = {}) {
    this.post = opts.post ?? defaultPost();
    this.now = opts.now ?? (() => performance.now());
    this.onError = opts.onError ?? ((err) => console.error('[ordo asset]', err));
  }

  /** Queue a job; it starts as soon as its chain is free. */
  push(job: LaneJob): void {
    const e: Entry = {
      job,
      seq: this.seq++,
      pushedAt: this.now(),
      cancelled: false,
      waited: 0,
      busy: 0,
      slices: 0,
      longest: 0,
    };
    let chain = this.chains.get(job.chain);
    if (!chain) this.chains.set(job.chain, (chain = { queue: [] }));
    // In rank then arrival order.
    let i = chain.queue.length;
    while (i > 0 && chain.queue[i - 1]!.job.rank > job.rank) i--;
    chain.queue.splice(i, 0, e);
    this.start(chain);
  }

  /** Cancel the queued and running jobs with these keys; returns how many. */
  cancel(keys: Iterable<string>): number {
    const set = new Set(keys);
    if (!set.size) return 0;
    let n = 0;
    for (const chain of this.chains.values()) {
      const keep: Entry[] = [];
      for (const e of chain.queue) {
        if (set.has(e.job.key)) {
          e.cancelled = true;
          n++;
        } else keep.push(e);
      }
      chain.queue = keep;
      const r = chain.running;
      if (r && !r.cancelled && set.has(r.job.key)) {
        r.cancelled = true;
        n++;
      }
    }
    // A cancelled job waiting for its turn unwinds at once.
    const left: Waiter[] = [];
    for (const w of this.waiters) {
      if (w.e.cancelled) w.reject(new Cancelled());
      else left.push(w);
    }
    this.waiters = left;
    this.settle();
    return n;
  }

  /** Jobs queued or running. */
  get size(): number {
    let n = 0;
    for (const c of this.chains.values()) n += c.queue.length + (c.running ? 1 : 0);
    return n;
  }

  /** Keys of the jobs queued or running, by chain (introspection). */
  keys(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [name, c] of this.chains) {
      const ks = [...(c.running ? [c.running.job.key] : []), ...c.queue.map((e) => e.job.key)];
      if (ks.length) out[name] = ks;
    }
    return out;
  }

  /** Resolves once no job is queued or running. */
  idle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private start(chain: Chain): void {
    if (chain.running) return;
    const next = chain.queue[0];
    if (!next) return;
    // Bulk work starts only while nothing interactive is queued or running: its file reads and decodes run
    // off this thread, but on the same cores as the interactive job's.
    if (next.job.rank >= RANK.bulk && this.interactiveBusy()) return;
    chain.queue.shift();
    chain.running = next;
    void this.exec(chain, next);
  }

  private interactiveBusy(): boolean {
    for (const c of this.chains.values()) {
      if (c.running && c.running.job.rank < RANK.bulk) return true;
      if (c.queue.some((e) => e.job.rank < RANK.bulk)) return true;
    }
    return false;
  }

  private async exec(chain: Chain, e: Entry): Promise<void> {
    try {
      if (e.job.gate) {
        const t = this.now();
        await e.job.gate.catch(() => undefined);
        e.waited += this.now() - t;
      }
      // The time it spent in its queue.
      e.waited += this.startedAt(e);
      if (e.cancelled) throw new Cancelled();
      await e.job.run(this.steps(e));
    } catch (err) {
      if (!(err instanceof Cancelled)) this.onError(err, e.job);
    } finally {
      chain.running = undefined;
      this.start(chain);
      // Bulk work waiting for the interactive jobs may start now.
      for (const c of this.chains.values()) this.start(c);
      this.settle();
    }
  }

  /** Queue time: from push until the job started (measured once). */
  private startedAt(e: Entry): number {
    return Math.max(0, this.now() - e.pushedAt - e.waited);
  }

  private steps(e: Entry): Steps {
    const timing = (): JobTiming => ({
      lane: laneOf(e.job.rank),
      waitMs: e.waited,
      busyMs: e.busy,
      slices: e.slices,
      longestMs: e.longest,
    });
    return {
      slice: async <T>(fn: () => T): Promise<T> => {
        await this.turn(e);
        try {
          if (e.cancelled) throw new Cancelled();
          const t0 = this.now();
          try {
            return fn();
          } finally {
            const d = this.now() - t0;
            e.busy += d;
            e.slices++;
            if (d > e.longest) e.longest = d;
          }
        } finally {
          this.release();
        }
      },
      check: () => {
        if (e.cancelled) throw new Cancelled();
      },
      get cancelled() {
        return e.cancelled;
      },
      timing,
    };
  }

  private turn(e: Entry): Promise<void> {
    if (e.cancelled) return Promise.reject(new Cancelled());
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ e, at: this.now(), resolve, reject });
      this.schedule();
    });
  }

  /** The slice granted last has ended: the next one runs in a task of its own. */
  private release(): void {
    this.busy = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.busy || this.pumpPosted || !this.waiters.length) return;
    this.pumpPosted = true;
    this.post(() => this.pump());
  }

  /** Grant the most urgent waiting slice: lowest rank, then the job that arrived first. */
  private pump(): void {
    this.pumpPosted = false;
    if (this.busy || !this.waiters.length) return;
    let best = 0;
    for (let i = 1; i < this.waiters.length; i++) {
      const a = this.waiters[i]!.e;
      const b = this.waiters[best]!.e;
      if (a.job.rank < b.job.rank || (a.job.rank === b.job.rank && a.seq < b.seq)) best = i;
    }
    const w = this.waiters.splice(best, 1)[0]!;
    w.e.waited += this.now() - w.at;
    this.busy = true;
    w.resolve();
  }

  private settle(): void {
    if (this.size || this.waiters.length) return;
    for (const r of this.idleWaiters.splice(0)) r();
  }
}

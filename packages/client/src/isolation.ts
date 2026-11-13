/**
 * Supervision primitives (design/25, ADR 0014). A main thread hosts; workers compute. Every worker has a
 * supervisor that watches its heartbeat and restarts it from persisted state within a restart budget.
 *
 * Worker side:  startHeartbeat(self)                 — posts { __ordo: 'hb' } every 250 ms
 *               reportFatal(self, reason)            — asks the supervisor for a clean restart
 * Main side:    const sup = new Supervisor();
 *               sup.add({ name: 'link', create: () => new Worker(...), start: (w, gen) => { ...wire ports... } });
 *
 * Supervisor-control messages are tagged with `__ordo` so they never collide with a worker's own protocol
 * (worker protocols switch on `t`).
 */
import { Emitter } from './emitter.ts';

export const HEARTBEAT_MS = 250;
export const DEAD_AFTER_MS = 2000;

export type SupervisorControl = { __ordo: 'hb'; at: number } | { __ordo: 'fatal'; reason: string };

export function isControl(d: unknown): d is SupervisorControl {
  return !!d && typeof d === 'object' && typeof (d as { __ordo?: unknown }).__ordo === 'string';
}

type Poster = { postMessage(m: unknown): void };

/** Worker side: post a heartbeat every `ms`. Returns a stop function. */
export function startHeartbeat(scope: Poster, ms = HEARTBEAT_MS): () => void {
  const beat = () => scope.postMessage({ __ordo: 'hb', at: Date.now() } satisfies SupervisorControl);
  beat();
  const t = setInterval(beat, ms);
  return () => clearInterval(t);
}

/** Worker side: ask to be restarted cleanly (an invariant failed, state is not trustworthy). */
export function reportFatal(scope: Poster, reason: string): void {
  scope.postMessage({ __ordo: 'fatal', reason: reason.slice(0, 300) } satisfies SupervisorControl);
}

export interface WorkerLike {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', fn: (e: Event) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', fn: (e: Event) => void): void;
}

export type RestartBudget = { max: number; windowMs: number };

export type SupervisedSpec<W extends WorkerLike = WorkerLike> = {
  name: string;
  create: () => W;
  /** Wire the (re)started worker: send init, transfer ports. Generation 0 is the first start. */
  start: (w: W, generation: number) => void;
  /** Called just before a worker is terminated for a restart (release ports, mark state). */
  stop?: (w: W, reason: string) => void;
  deadAfterMs?: number;
  budget?: RestartBudget;
};

export type SupervisedStats = {
  name: string;
  generation: number;
  restarts: number;
  lastReason?: string;
  lastRestartAt?: number;
  sinceHeartbeatMs: number;
  gaveUp: boolean;
};

type Entry = {
  spec: SupervisedSpec;
  w?: WorkerLike;
  generation: number;
  restarts: number;
  recent: number[];
  lastBeat: number;
  lastReason?: string;
  lastRestartAt?: number;
  gaveUp: boolean;
  detach?: () => void;
};

export type SupervisorClock = {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
};

const realClock: SupervisorClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * Restarts supervised workers that crash, post `fatal`, or miss heartbeats. Gives up on a worker that
 * needs more than `budget.max` restarts within `budget.windowMs` (default 5 per minute) and reports it,
 * so a deterministic crash cannot become a tight restart loop.
 */
export class Supervisor extends Emitter<{
  restart: { name: string; generation: number; reason: string };
  gaveUp: { name: string; reason: string };
}> {
  private entries = new Map<string, Entry>();
  private timer: unknown;
  private lastCheck: number;
  private checkEveryMs: number;

  private clock: SupervisorClock;
  constructor(clock: SupervisorClock = realClock, checkEveryMs = HEARTBEAT_MS) {
    super();
    this.clock = clock;
    this.checkEveryMs = checkEveryMs;
    this.lastCheck = clock.now();
    this.timer = clock.setInterval(() => this.check(), checkEveryMs);
  }

  add<W extends WorkerLike>(spec: SupervisedSpec<W>): W {
    if (this.entries.has(spec.name)) throw new Error(`supervisor: ${spec.name} already added`);
    const e: Entry = {
      spec: spec as unknown as SupervisedSpec,
      generation: -1,
      restarts: 0,
      recent: [],
      lastBeat: this.clock.now(),
      gaveUp: false,
    };
    this.entries.set(spec.name, e);
    this.launch(e);
    return e.w as W;
  }

  worker<W extends WorkerLike = WorkerLike>(name: string): W | undefined {
    return this.entries.get(name)?.w as W | undefined;
  }

  /** Restart a worker now (also used by the host when the worker's own invariants fail). */
  restart(name: string, reason: string): boolean {
    const e = this.entries.get(name);
    if (!e || e.gaveUp) return false;
    const now = this.clock.now();
    const budget = e.spec.budget ?? { max: 5, windowMs: 60_000 };
    e.recent = e.recent.filter((t) => now - t < budget.windowMs);
    if (e.recent.length >= budget.max) {
      e.gaveUp = true;
      e.lastReason = reason;
      this.teardown(e, reason);
      this.emit('gaveUp', { name, reason });
      return false;
    }
    e.recent.push(now);
    e.restarts++;
    e.lastReason = reason;
    e.lastRestartAt = now;
    this.teardown(e, reason);
    this.launch(e);
    this.emit('restart', { name, generation: e.generation, reason });
    return true;
  }

  /** Clear a give-up (an operator action) and start the worker again. */
  revive(name: string): void {
    const e = this.entries.get(name);
    if (!e || !e.gaveUp) return;
    e.gaveUp = false;
    e.recent = [];
    this.launch(e);
  }

  stats(): SupervisedStats[] {
    const now = this.clock.now();
    return [...this.entries.values()].map((e) => ({
      name: e.spec.name,
      generation: e.generation,
      restarts: e.restarts,
      lastReason: e.lastReason,
      lastRestartAt: e.lastRestartAt,
      sinceHeartbeatMs: now - e.lastBeat,
      gaveUp: e.gaveUp,
    }));
  }

  dispose(): void {
    this.clock.clearInterval(this.timer);
    for (const e of this.entries.values()) this.teardown(e, 'dispose');
    this.entries.clear();
  }

  private launch(e: Entry): void {
    e.generation++;
    e.lastBeat = this.clock.now();
    let w: WorkerLike;
    try {
      w = e.spec.create();
    } catch (err) {
      e.lastReason = `create failed: ${(err as Error).message}`;
      e.w = undefined;
      return; // the heartbeat check will retry within the budget
    }
    e.w = w;
    const gen = e.generation;
    const onMessage = (ev: Event) => {
      const d = (ev as MessageEvent).data;
      if (!isControl(d) || e.generation !== gen) return;
      if (d.__ordo === 'hb') e.lastBeat = this.clock.now();
      else if (d.__ordo === 'fatal')
        queueMicrotask(() => e.generation === gen && this.restart(e.spec.name, `fatal: ${d.reason}`));
    };
    const onError = (ev: Event) => {
      if (e.generation !== gen) return;
      const msg = (ev as ErrorEvent).message ?? ev.type;
      queueMicrotask(() => e.generation === gen && this.restart(e.spec.name, `error: ${msg}`));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.addEventListener('messageerror', onError);
    e.detach = () => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      w.removeEventListener('messageerror', onError);
    };
    try {
      e.spec.start(w, gen);
    } catch (err) {
      e.lastReason = `start failed: ${(err as Error).message}`;
    }
  }

  private teardown(e: Entry, reason: string): void {
    const w = e.w;
    e.detach?.();
    e.detach = undefined;
    e.w = undefined;
    if (!w) return;
    try {
      e.spec.stop?.(w, reason);
    } catch {
      /* stop hooks must not block a restart */
    }
    try {
      w.terminate();
    } catch {
      /* already gone */
    }
  }

  private check(): void {
    const now = this.clock.now();
    const gap = now - this.lastCheck;
    this.lastCheck = now;
    // The host's own thread stalled (a long task): heartbeats are still queued behind this check, so
    // their absence says nothing about the workers. Judge again once the queue has drained.
    if (gap > this.checkEveryMs * 4) {
      for (const e of this.entries.values()) e.lastBeat = Math.max(e.lastBeat, now - this.checkEveryMs);
      return;
    }
    for (const e of this.entries.values()) {
      if (e.gaveUp) continue;
      const dead = e.spec.deadAfterMs ?? DEAD_AFTER_MS;
      if (!e.w) this.restart(e.spec.name, e.lastReason ?? 'not running');
      else if (now - e.lastBeat > dead) this.restart(e.spec.name, `no heartbeat for ${now - e.lastBeat} ms`);
    }
  }
}

export type BudgetLimit = { max: number; windowMs: number };
export type BudgetRow = {
  kind: string;
  count: number;
  max: number;
  windowMs: number;
  exceeded: boolean;
  last?: string;
};

/**
 * Per-subsystem error budgets (design/25): count failures in a sliding window; once a budget is exceeded
 * the caller stops retrying and shows a red state instead of looping.
 */
export class ErrorBudget {
  private events = new Map<string, { at: number; detail?: string }[]>();
  private limits: Record<string, BudgetLimit>;
  private now: () => number;
  private fallback: BudgetLimit;
  constructor(
    limits: Record<string, BudgetLimit>,
    now: () => number = () => Date.now(),
    fallback: BudgetLimit = { max: 10, windowMs: 60_000 },
  ) {
    this.limits = limits;
    this.now = now;
    this.fallback = fallback;
  }

  record(kind: string, detail?: string): { count: number; exceeded: boolean } {
    const list = this.prune(kind);
    list.push({ at: this.now(), detail: detail?.slice(0, 200) });
    if (list.length > 1000) list.splice(0, list.length - 1000);
    const lim = this.limit(kind);
    return { count: list.length, exceeded: list.length > lim.max };
  }

  exceeded(kind: string): boolean {
    return this.prune(kind).length > this.limit(kind).max;
  }

  reset(kind?: string): void {
    if (kind) this.events.delete(kind);
    else this.events.clear();
  }

  snapshot(): BudgetRow[] {
    const kinds = new Set([...Object.keys(this.limits), ...this.events.keys()]);
    return [...kinds].map((kind) => {
      const list = this.prune(kind);
      const lim = this.limit(kind);
      return {
        kind,
        count: list.length,
        max: lim.max,
        windowMs: lim.windowMs,
        exceeded: list.length > lim.max,
        last: list.at(-1)?.detail,
      };
    });
  }

  private limit(kind: string): BudgetLimit {
    return this.limits[kind] ?? this.fallback;
  }

  private prune(kind: string): { at: number; detail?: string }[] {
    const lim = this.limit(kind);
    const now = this.now();
    const list = (this.events.get(kind) ?? []).filter((e) => now - e.at < lim.windowMs);
    this.events.set(kind, list);
    return list;
  }
}

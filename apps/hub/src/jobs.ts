import { newId } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import type { Logger } from 'pino';
import { type DB, nowIso } from './db.ts';
import { errorMessage, notFound } from './errors.ts';

export type JobClass = 'heavy' | 'light';
export type JobCtx<P = unknown> = {
  id: string;
  payload: P;
  signal: AbortSignal;
  log(msg: string): void;
  progress(f: number): void;
  /** Persist a payload change (resume points). */
  setPayload(p: P): void;
};
export type JobHandler<P = unknown> = (ctx: JobCtx<P>) => Promise<unknown>;

type JobRow = {
  id: string;
  kind: string;
  class: JobClass;
  state: Job['state'];
  progress: number;
  payload: string;
  log: string;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_LOG = 500;

/**
 * Thrown by a handler that cannot run yet (a pptx follow-up while its presentation is live-locked, ADR 0007):
 * the job goes back to the queue and is not started again for `delayMs`. It is not a failure and does not
 * count as a crashed attempt. The delay lives in this process only: after a restart the job runs at once and
 * defers itself again if it still has to.
 */
export class JobDeferred extends Error {
  readonly delayMs: number;
  constructor(delayMs: number, message: string) {
    super(message);
    this.delayMs = delayMs;
  }
}
/**
 * A job that was running when its process died is re-queued; after this many starts it fails for good
 * (design/25: a file that crashes the decoder is marked and never retried in a loop).
 */
export const MAX_JOB_ATTEMPTS = 3;

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    progress: r.progress,
    log: JSON.parse(r.log) as string[],
    result: r.result ? JSON.parse(r.result) : undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Persisted in-process job queue: `heavy` jobs (video, documents) run one at a time, `light` jobs two at
 * a time. Jobs left `running` by a crash or shutdown are re-queued on start.
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler<never>>();
  private giveUps = new Map<string, (payload: never, error: string) => void>();
  private running = new Map<string, { cls: JobClass; ctrl: AbortController; done: Promise<void> }>();
  private stopped = true;
  private lastNotify = new Map<string, number>();
  private idleWaiters: (() => void)[] = [];
  /** Deferred jobs (JobDeferred): not started before this time (ms since the epoch). */
  private notBefore = new Map<string, number>();
  private wake: NodeJS.Timeout | undefined;

  private db: DB;
  private log: Logger;
  private limits: { heavy: number; light: number };
  private notify: (job: Job) => void;
  constructor(db: DB, log: Logger, limits: { heavy: number; light: number }, notify: (job: Job) => void) {
    this.db = db;
    this.log = log;
    this.limits = limits;
    this.notify = notify;
  }

  /** `giveUp` runs when a job of this kind is abandoned without its handler (too many crashed attempts). */
  register<P>(kind: string, handler: JobHandler<P>, giveUp?: (payload: P, error: string) => void): void {
    this.handlers.set(kind, handler as JobHandler<never>);
    if (giveUp) this.giveUps.set(kind, giveUp as (payload: never, error: string) => void);
  }

  attempts(id: string): number {
    const r = this.db.prepare(`SELECT attempts FROM job_attempts WHERE job_id = ?`).get(id) as
      | { attempts: number }
      | undefined;
    return r?.attempts ?? 0;
  }

  /**
   * Queue a job. With `after`, it is created at least a millisecond after that job: jobs of a class start
   * in creation order, and ids (random within a millisecond) would otherwise order two jobs queued in the
   * same millisecond either way (the PowerPoint import queues its clips after its LibreOffice follow-up).
   */
  enqueue(kind: string, payload: unknown, cls: JobClass = 'light', opts: { after?: Job } = {}): Job {
    let now = nowIso();
    const after = opts.after ? Date.parse(opts.after.createdAt) + 1 : Number.NaN;
    if (Number.isFinite(after) && after > Date.parse(now)) now = new Date(after).toISOString();
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, class, state, progress, payload, log, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, '[]', ?, ?)`,
      )
      .run(id, kind, cls, JSON.stringify(payload), now, now);
    const job = this.get(id);
    this.notify(job);
    queueMicrotask(() => this.pump());
    return job;
  }

  /**
   * Whether a job of `kind` whose payload holds `value` at its top-level `field` is queued or running. Every
   * such job is looked at (the `jobs_kind_state` index), in SQLite: no row cap, nothing parsed here.
   */
  active(kind: string, field: string, value: string): boolean {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field)) throw new Error(`not a payload field: ${field}`);
    const row = this.db
      .prepare(
        `SELECT 1 FROM jobs WHERE kind = ? AND state IN ('queued','running')
           AND (CASE WHEN json_valid(payload) THEN json_extract(payload, ?) END) = ? LIMIT 1`,
      )
      .get(kind, `$.${field}`, value);
    return row !== undefined;
  }

  get(id: string): Job {
    const r = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
    if (!r) throw notFound(`job ${id}`);
    return toJob(r);
  }

  list(limit = 100): Job[] {
    return (
      this.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as JobRow[]
    ).map(toJob);
  }

  start(): void {
    this.stopped = false;
    // Jobs left running were interrupted: by a shutdown (normally re-queued already) or by the process
    // dying under them. One that has already been started MAX_JOB_ATTEMPTS times is not tried again.
    for (const r of this.db.prepare(`SELECT * FROM jobs WHERE state = 'running'`).all() as JobRow[]) {
      const n = this.attempts(r.id);
      if (n < MAX_JOB_ATTEMPTS) {
        this.db.prepare(`UPDATE jobs SET state = 'queued' WHERE id = ?`).run(r.id);
        continue;
      }
      const error = `Stopped ${n} times while this job was running (the process crashed or was killed); not retried`;
      this.log.error({ job: r.id, kind: r.kind, attempts: n }, 'job abandoned after repeated crashes');
      const lines = [...(JSON.parse(r.log) as string[]), `error: ${error}`];
      this.update(r.id, { state: 'failed', error, log: JSON.stringify(lines) });
      try {
        this.giveUps.get(r.kind)?.(JSON.parse(r.payload) as never, error);
      } catch (e) {
        this.log.warn({ job: r.id, err: errorMessage(e) }, 'job give-up handler failed');
      }
    }
    this.db
      .prepare(
        `DELETE FROM job_attempts WHERE job_id NOT IN (SELECT id FROM jobs WHERE state IN ('queued','running'))`,
      )
      .run();
    // Old finished jobs are pruned after 30 days.
    this.db
      .prepare(`DELETE FROM jobs WHERE state IN ('done','failed') AND updated_at < ?`)
      .run(new Date(Date.now() - 30 * 86400_000).toISOString());
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.wake);
    for (const r of this.running.values()) r.ctrl.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }

  /** Jobs deferred by their handler (`JobDeferred`), with the time each may start again. */
  deferred(): { id: string; notBefore: number }[] {
    return [...this.notBefore].map(([id, notBefore]) => ({ id, notBefore }));
  }

  /** Let a deferred job start at the next chance (tests; End service could call it too). */
  undefer(id?: string): void {
    if (id === undefined) this.notBefore.clear();
    else this.notBefore.delete(id);
    queueMicrotask(() => this.pump());
  }

  /** Resolves when nothing is queued or running (tests). Deferred jobs do not count as queued. */
  idle(): Promise<void> {
    if (!this.running.size && !this.nextQueued('heavy') && !this.nextQueued('light'))
      return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private nextQueued(cls: JobClass): JobRow | undefined {
    const busy = [...this.running.keys()];
    const now = Date.now();
    const waiting = (id: string) => (this.notBefore.get(id) ?? 0) > now;
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE state = 'queued' AND class = ? ORDER BY created_at, id LIMIT ${20 + this.notBefore.size}`,
      )
      .all(cls) as JobRow[];
    return rows.find((r) => !busy.includes(r.id) && !waiting(r.id));
  }

  /** Pump again when the earliest deferred job may start. */
  private schedule(): void {
    clearTimeout(this.wake);
    this.wake = undefined;
    if (this.stopped || !this.notBefore.size) return;
    const now = Date.now();
    for (const [id, t] of this.notBefore) if (t <= now) this.notBefore.delete(id);
    if (!this.notBefore.size) return;
    const next = Math.min(...this.notBefore.values());
    this.wake = setTimeout(() => this.pump(), Math.max(0, next - now) + 5);
    this.wake.unref();
  }

  private pump(): void {
    if (this.stopped) return;
    for (const cls of ['heavy', 'light'] as const) {
      let active = [...this.running.values()].filter((r) => r.cls === cls).length;
      while (active < this.limits[cls]) {
        const row = this.nextQueued(cls);
        if (!row) break;
        this.launch(row);
        active++;
      }
    }
    this.schedule();
    if (!this.running.size && this.idleWaiters.length) {
      const w = this.idleWaiters.splice(0);
      for (const f of w) f();
    }
  }

  private update(id: string, fields: Partial<Omit<JobRow, 'id'>>, force = true): void {
    const keys = Object.keys(fields);
    this.db
      .prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(fields), nowIso(), id);
    const now = Date.now();
    if (force || now - (this.lastNotify.get(id) ?? 0) > 500) {
      this.lastNotify.set(id, now);
      this.notify(this.get(id));
    }
  }

  private launch(row: JobRow): void {
    const ctrl = new AbortController();
    const handler = this.handlers.get(row.kind);
    const logLines = JSON.parse(row.log) as string[];
    let payload = JSON.parse(row.payload) as unknown;
    // Counted before the handler runs, so a crash inside it still counts.
    this.db
      .prepare(
        `INSERT INTO job_attempts (job_id, attempts) VALUES (?, 1) ON CONFLICT(job_id) DO UPDATE SET attempts = attempts + 1`,
      )
      .run(row.id);
    this.update(row.id, { state: 'running' });
    const ctx: JobCtx<unknown> = {
      id: row.id,
      payload,
      signal: ctrl.signal,
      log: (m) => {
        logLines.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
        // Over the cap, routine lines go first so the warnings of a large import are what remains.
        while (logLines.length > MAX_LOG) {
          const i = logLines.findIndex((l) => !/\[(warn|error)\]/.test(l));
          logLines.splice(i >= 0 ? i : 0, 1);
        }
        this.update(row.id, { log: JSON.stringify(logLines) }, false);
      },
      progress: (f) => this.update(row.id, { progress: Math.max(0, Math.min(1, f)) }, false),
      setPayload: (p) => {
        payload = p;
        ctx.payload = p;
        this.update(row.id, { payload: JSON.stringify(p) }, false);
      },
    };
    const done = (async () => {
      await Promise.resolve();
      try {
        if (!handler) throw new Error(`No handler for job kind ${row.kind}`);
        const result = await handler(ctx as JobCtx<never>);
        this.update(row.id, {
          state: 'done',
          progress: 1,
          result: result === undefined ? null : JSON.stringify(result),
          log: JSON.stringify(logLines),
        });
      } catch (e) {
        if (e instanceof JobDeferred && !this.stopped) {
          // Not a crashed attempt: back to the queue, not started again before its time.
          this.db
            .prepare(`UPDATE job_attempts SET attempts = MAX(0, attempts - 1) WHERE job_id = ?`)
            .run(row.id);
          const delay = Math.max(0, Math.min(24 * 3600_000, e.delayMs));
          this.notBefore.set(row.id, Date.now() + delay);
          logLines.push(`${new Date().toISOString().slice(11, 19)} ${e.message}`);
          this.update(row.id, { state: 'queued', log: JSON.stringify(logLines) });
        } else if (ctrl.signal.aborted && this.stopped) {
          // Shutdown: leave it queued so the next start resumes it. A clean stop is not a crashed attempt.
          this.db
            .prepare(`UPDATE job_attempts SET attempts = MAX(0, attempts - 1) WHERE job_id = ?`)
            .run(row.id);
          this.update(row.id, { state: 'queued', log: JSON.stringify(logLines) });
        } else {
          logLines.push(`error: ${errorMessage(e)}`);
          this.log.warn({ job: row.id, kind: row.kind, err: errorMessage(e) }, 'job failed');
          this.update(row.id, { state: 'failed', error: errorMessage(e), log: JSON.stringify(logLines) });
        }
      } finally {
        this.running.delete(row.id);
        this.lastNotify.delete(row.id);
        this.pump();
      }
    })();
    this.running.set(row.id, { cls: row.class, ctrl, done });
  }
}

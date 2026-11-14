import { newId } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import type { Logger } from 'pino';
import { type DB, nowIso } from './db.ts';
import { errorMessage, notFound } from './errors.ts';
import type { JobPacing } from './pacing.ts';
import { inPacedScope, pacedScope } from './reqctx.ts';

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
/** Node fires a longer delay (Infinity included) after 1 ms: never ask for more. */
const MAX_DELAY_MS = 2 ** 31 - 1;

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

function toJob(r: JobRow, waiting = false): Job {
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
    ...(waiting ? { waiting: 'service' as const } : {}),
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
  /** Running jobs stopped by `pause()` (going back to the queue when their handler ends). */
  private pausing = new Set<string>();
  private onPauses = new Map<string, (payload: never) => void>();

  private db: DB;
  private log: Logger;
  private limits: { heavy: number; light: number };
  private notify: (job: Job) => void;
  /** Jobs paced while live (design/28 §5.3); absent: nothing is ever held. */
  readonly pacing?: JobPacing;
  constructor(
    db: DB,
    log: Logger,
    limits: { heavy: number; light: number },
    notify: (job: Job) => void,
    opts: { pacing?: JobPacing } = {},
  ) {
    this.db = db;
    this.log = log;
    this.limits = limits;
    this.notify = notify;
    this.pacing = opts.pacing;
  }

  /**
   * `giveUp` runs when a job of this kind is abandoned without its handler (too many crashed attempts);
   * `onPause` when a running job of this kind was stopped for a service (`pause()`) and is queued again.
   */
  register<P>(
    kind: string,
    handler: JobHandler<P>,
    giveUp?: (payload: P, error: string) => void,
    hooks: { onPause?: (payload: P) => void } = {},
  ): void {
    this.handlers.set(kind, handler as JobHandler<never>);
    if (giveUp) this.giveUps.set(kind, giveUp as (payload: never, error: string) => void);
    if (hooks.onPause) this.onPauses.set(kind, hooks.onPause as (payload: never) => void);
  }

  /** Was this job queued during a capped request, or by a job that was (`job_paced`)? */
  paced(id: string): boolean {
    return this.db.prepare(`SELECT 1 FROM job_paced WHERE job_id = ?`).get(id) !== undefined;
  }

  /** Whether the pacing rule holds this queued job now. */
  private heldNow(r: Pick<JobRow, 'id' | 'kind' | 'class' | 'state'>): boolean {
    if (!this.pacing || r.state !== 'queued' || r.class !== 'heavy' || !this.pacing.holding()) return false;
    return this.pacing.held({
      kind: r.kind,
      class: r.class,
      paced: this.pacing.enabled() || this.paced(r.id),
    });
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
    // Queued during a capped (phone) request, or by a job that was: held while live whatever Phones says
    // (design/28 §10 items 8 and 11). Every class is marked, so a light job's heavy children inherit it.
    if (inPacedScope()) this.db.prepare(`INSERT OR IGNORE INTO job_paced (job_id) VALUES (?)`).run(id);
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
    return toJob(r, this.heldNow(r));
  }

  list(limit = 100): Job[] {
    return (
      this.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as JobRow[]
    ).map((r) => toJob(r, this.heldNow(r)));
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
    this.db
      .prepare(
        `DELETE FROM job_paced WHERE job_id NOT IN (SELECT id FROM jobs WHERE state IN ('queued','running'))`,
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
    // Held heavy jobs are filtered in SQL, so they never fill the LIMIT and starve a job that may run.
    const held = this.heldFilter(cls);
    if (held === null) return undefined;
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE state = 'queued' AND class = ?${held.sql} ORDER BY created_at, id LIMIT ${20 + this.notBefore.size}`,
      )
      .all(cls, ...held.args) as JobRow[];
    return rows.find((r) => !busy.includes(r.id) && !waiting(r.id));
  }

  /**
   * The SQL that leaves out the jobs the pacing rule holds (design/28 §5.3): every heavy job but the exempt
   * kinds while Phones is on (null: none can start), the paced ones otherwise; nothing outside a hold.
   */
  private heldFilter(cls: JobClass): { sql: string; args: string[] } | null {
    const p = this.pacing;
    if (!p || cls !== 'heavy' || !p.holding()) return { sql: '', args: [] };
    const exempt = p.exemptKinds();
    const inExempt = exempt.length ? `kind IN (${exempt.map(() => '?').join(', ')})` : '0';
    if (p.enabled()) return exempt.length ? { sql: ` AND ${inExempt}`, args: [...exempt] } : null;
    return {
      sql: ` AND (id NOT IN (SELECT job_id FROM job_paced) OR ${inExempt})`,
      args: [...exempt],
    };
  }

  /** Whether any heavy job is queued (the pacing timer is set only then). */
  private heavyQueued(): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM jobs WHERE state = 'queued' AND class = 'heavy' LIMIT 1`).get() !==
      undefined
    );
  }

  /**
   * Pump again when the earliest deferred job may start, or when the pacing grace ends with held jobs
   * queued. While live there is no pacing timer at all: End service wakes the queue (`repump`).
   */
  private schedule(): void {
    clearTimeout(this.wake);
    this.wake = undefined;
    if (this.stopped) return;
    const now = Date.now();
    for (const [id, t] of this.notBefore) if (t <= now) this.notBefore.delete(id);
    let next = this.notBefore.size ? Math.min(...this.notBefore.values()) : undefined;
    const paceAt = this.pacing?.wakeAt(now);
    if (paceAt !== undefined && this.heavyQueued())
      next = next === undefined ? paceAt : Math.min(next, paceAt);
    if (next === undefined) return;
    this.wake = setTimeout(() => this.pump(), Math.min(MAX_DELAY_MS, Math.max(0, next - now) + 5));
    this.wake.unref();
  }

  /**
   * At goLive (design/28 §5.3, owner question 3): a running heavy job the pacing rule now holds is stopped and
   * queued again without counting an attempt; its kind's `onPause` puts what it was working on back as it
   * was (media: 'processing' back to 'uploaded'). It starts again from the beginning after the service.
   */
  pause(): void {
    if (!this.pacing) return;
    for (const [id, r] of this.running) {
      if (r.cls !== 'heavy' || this.pausing.has(id)) continue;
      const row = this.db.prepare(`SELECT kind FROM jobs WHERE id = ?`).get(id) as
        | { kind: string }
        | undefined;
      if (!row) continue;
      const paced = this.pacing.enabled() || this.paced(id);
      if (!this.pacing.held({ kind: row.kind, class: 'heavy', paced })) continue;
      this.log.info({ job: id, kind: row.kind }, 'heavy job stopped for the service; queued again');
      this.pausing.add(id);
      r.ctrl.abort();
    }
  }

  /**
   * The live service's mode, as this process learns it (design/28 §5.3): goLive stops the heavy jobs the rule
   * now holds (`pause`), End service starts the grace; either way the queue looks again. Call it before
   * `start()` with the mode at start, so a library restarted during a service never relaunches a held job.
   */
  onLiveMode(mode: 'idle' | 'live'): void {
    const p = this.pacing;
    if (!p || (mode === 'live') === p.live()) return;
    p.onMode(mode);
    if (mode === 'live') this.pause();
    this.repump();
  }

  /** `settings.phones.enabled` changed: during a service, heavy jobs it now holds are stopped too. */
  setPhones(on: boolean): void {
    const p = this.pacing;
    if (!p || p.enabled() === on) return;
    p.setEnabled(on);
    if (on && p.live()) this.pause();
    this.repump();
  }

  /**
   * The live mode or the Phones setting changed: tell clients which queued heavy jobs now wait for the
   * service (`Job.waiting`), then start what may start and set the timer for the rest.
   */
  repump(): void {
    if (this.stopped) return;
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE state = 'queued' AND class = 'heavy' ORDER BY created_at, id LIMIT 200`,
      )
      .all() as JobRow[];
    for (const r of rows) this.notify(toJob(r, this.heldNow(r)));
    this.pump();
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
    // The handler runs in its own job's scope: a job it queues inherits this job's flag, and a pump started
    // inside a capped request never marks another session's jobs (reqctx.ts).
    const done = pacedScope.run(this.paced(row.id), async () => {
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
        this.db.prepare(`DELETE FROM job_paced WHERE job_id = ?`).run(row.id);
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
        } else if (ctrl.signal.aborted && this.pausing.has(row.id) && !this.stopped) {
          // Stopped for the service (`pause()`): not a crashed attempt; back to the queue, held until it ends.
          this.db
            .prepare(`UPDATE job_attempts SET attempts = MAX(0, attempts - 1) WHERE job_id = ?`)
            .run(row.id);
          logLines.push(
            `${new Date().toISOString().slice(11, 19)} stopped for the service; starts again after it`,
          );
          this.update(row.id, { state: 'queued', progress: 0, log: JSON.stringify(logLines) });
          try {
            this.onPauses.get(row.kind)?.(payload as never);
          } catch (err) {
            this.log.warn({ job: row.id, err: errorMessage(err) }, 'job pause hook failed');
          }
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
          this.db.prepare(`DELETE FROM job_paced WHERE job_id = ?`).run(row.id);
        }
      } finally {
        this.pausing.delete(row.id);
        this.running.delete(row.id);
        this.lastNotify.delete(row.id);
        this.pump();
      }
    });
    this.running.set(row.id, { cls: row.class, ctrl, done });
  }
}

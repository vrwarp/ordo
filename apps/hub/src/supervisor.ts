/**
 * The hub supervisor (design/25 "Hub", design/12 "Processes"): a small Node parent, the container's
 * entrypoint under tini, that runs two children and does nothing else. It never touches HTTP, SQLite or
 * user data, so the code that must not crash is a few hundred lines with no inputs from the network.
 *
 * - **library** process first (it creates and migrates ordo.db), then **live** (the front door on
 *   ORDO_PORT). The live process starts anyway if the library is not ready within START_WAIT_MS.
 * - A child that exits, or whose heartbeat stops (stuck event loop: STALL_MS), is restarted within a
 *   second (RESTART_DELAYS_MS), at most BUDGET.max times in BUDGET.windowMs. Past the budget it stays
 *   down and is reported: a failed library leaves the live service running (and /health says
 *   `library: failed`); a failed live process ends the supervisor with exit code 1, so the container
 *   restart policy takes over with its own backoff.
 * - IPC relay with memory: the live process's locks go to the library, library changes go to the live
 *   process, each child learns the other's address; the last value of each is replayed to a restarted child.
 * - Shutdown (SIGTERM/SIGINT): both children get SIGTERM, then SIGKILL after SHUTDOWN_MS.
 * - `<data>/supervisor.json` holds the current pids, states and restart counts (operators and chaos tests).
 */
import { type ChildProcess, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { ChildName, ChildState, FromChild, LocksMsg, ProcessStatus, ToChild } from './ipc.ts';

export const BUDGET = { max: 5, windowMs: 60_000 };
/** Delay before restart n (1-based) within the budget window; all under a second. */
export const RESTART_DELAYS_MS = [100, 200, 400, 800, 1000];
export const START_WAIT_MS = 15_000;
export const SHUTDOWN_MS = 5000;
/** No heartbeat for this long: the child is killed and restarted. The library may run long synchronous SQLite work (VACUUM INTO). */
export const STALL_MS: Record<ChildName, number> = { live: 5000, library: 60_000 };

type Child = {
  name: ChildName;
  proc?: ChildProcess;
  status: ProcessStatus;
  crashes: number[];
  url?: string;
  lastBeat: number;
  restartTimer?: NodeJS.Timeout;
  ready?: () => void;
};

export type SupervisorOpts = {
  /** Module the children run (`node <entry> __child <name>`). */
  entry: string;
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
  dataDir: string;
  log: Logger;
  budget?: { max: number; windowMs: number };
  restartDelaysMs?: number[];
  stallMs?: Partial<Record<ChildName, number>>;
  /** Called when a child exhausted its budget. Default: exit 1 for live, nothing for library. */
  onGiveUp?(name: ChildName): void;
};

export class Supervisor {
  readonly secret = randomBytes(24).toString('base64url');
  private children: Record<ChildName, Child>;
  private locks?: LocksMsg;
  private stopping = false;
  private watchdog?: NodeJS.Timeout;

  constructor(private opts: SupervisorOpts) {
    mkdirSync(opts.dataDir, { recursive: true });
    const mk = (name: ChildName): Child => ({
      name,
      status: { name, state: 'stopped', restarts: 0, recentCrashes: 0 },
      crashes: [],
      lastBeat: 0,
    });
    this.children = { library: mk('library'), live: mk('live') };
  }

  status(): ProcessStatus[] {
    return [this.children.library.status, this.children.live.status].map((s) => ({ ...s }));
  }

  async start(): Promise<void> {
    const libReady = new Promise<void>((r) => {
      this.children.library.ready = r;
    });
    this.spawn('library');
    const t = new Promise<void>((r) => setTimeout(r, START_WAIT_MS).unref());
    await Promise.race([libReady, t]);
    if (this.children.library.status.state !== 'up')
      this.opts.log.warn('library process not ready; starting the live process anyway');
    this.spawn('live');
    this.watchdog = setInterval(() => this.checkHeartbeats(), 1000);
    this.watchdog.unref();
  }

  private spawn(name: ChildName): void {
    const c = this.children[name];
    if (this.stopping) return;
    const other = name === 'live' ? this.children.library : this.children.live;
    const env: NodeJS.ProcessEnv = {
      ...(this.opts.env ?? process.env),
      ORDO_INTERNAL_SECRET: this.secret,
      ...(name === 'live' && other.url && other.status.state === 'up' ? { ORDO_LIBRARY_URL: other.url } : {}),
      ...(name === 'library' && other.url && other.status.state === 'up' ? { ORDO_LIVE_URL: other.url } : {}),
      ...(name === 'library' && this.locks ? { ORDO_LIVE_LOCKS: JSON.stringify(this.locks) } : {}),
    };
    let proc: ChildProcess;
    try {
      proc = fork(this.opts.entry, ['__child', name], {
        env,
        execArgv: this.opts.execArgv ?? process.execArgv,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        serialization: 'advanced',
      });
    } catch (e) {
      this.opts.log.error({ child: name, err: (e as Error).message }, 'could not start child process');
      this.onExit(c, undefined, 1, null);
      return;
    }
    c.proc = proc;
    c.url = undefined;
    c.lastBeat = Date.now();
    c.status = { ...c.status, state: 'starting', pid: proc.pid };
    this.opts.log.info({ child: name, pid: proc.pid }, 'child process started');
    proc.on('message', (m: FromChild) => this.onMessage(c, proc, m));
    proc.on('exit', (code, signal) => this.onExit(c, proc, code, signal));
    proc.on('error', (e) => this.opts.log.error({ child: name, err: e.message }, 'child process error'));
    this.publish();
  }

  private send(name: ChildName, m: ToChild): void {
    const p = this.children[name].proc;
    if (!p?.connected) return;
    try {
      p.send(m);
    } catch {
      /* exiting */
    }
  }

  private onMessage(c: Child, proc: ChildProcess, m: FromChild): void {
    if (c.proc !== proc || !m || typeof m !== 'object') return;
    c.lastBeat = Date.now();
    switch (m.t) {
      case 'beat':
        return;
      case 'ready': {
        c.url = m.url;
        c.status = { ...c.status, state: 'up' };
        this.opts.log.info({ child: c.name, pid: proc.pid, url: m.url }, 'child process ready');
        c.ready?.();
        c.ready = undefined;
        const lib = this.children.library;
        const live = this.children.live;
        if (c.name === 'library') {
          this.send('live', { t: 'library', url: lib.url, state: 'up' });
          if (this.locks) this.send('library', this.locks);
          if (live.url && live.status.state === 'up')
            this.send('library', { t: 'live', url: live.url, state: 'up' });
        } else {
          this.send('library', { t: 'live', url: live.url, state: 'up' });
          this.send('live', { t: 'library', url: lib.url, state: lib.status.state });
        }
        this.publish();
        return;
      }
      case 'locks':
        if (c.name !== 'live') return;
        this.locks = m;
        this.send('library', m);
        return;
      case 'changes':
        if (c.name !== 'library') return;
        this.send('live', m);
        return;
      case 'log':
        this.opts.log[m.level]({ child: c.name }, m.msg);
        return;
    }
  }

  private onExit(
    c: Child,
    proc: ChildProcess | undefined,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (proc && c.proc !== proc) return;
    c.proc = undefined;
    c.url = undefined;
    const now = Date.now();
    c.status = { ...c.status, pid: undefined, lastExit: { code, signal, at: now } };
    if (this.stopping) {
      c.status.state = 'stopped';
      this.publish();
      return;
    }
    const budget = this.opts.budget ?? BUDGET;
    c.crashes = c.crashes.filter((t) => now - t < budget.windowMs);
    c.crashes.push(now);
    c.status.recentCrashes = c.crashes.length;
    const other: ChildName = c.name === 'live' ? 'library' : 'live';
    if (c.crashes.length > budget.max) {
      c.status.state = 'failed';
      this.opts.log.error(
        { child: c.name, code, signal, crashes: c.crashes.length, windowS: budget.windowMs / 1000 },
        'child process keeps crashing; restart budget exhausted, leaving it down',
      );
      this.send(other, { t: c.name, state: 'failed' });
      this.publish();
      if (this.opts.onGiveUp) this.opts.onGiveUp(c.name);
      else if (c.name === 'live') void this.shutdown('live process failed').then(() => process.exit(1));
      return;
    }
    c.status.state = 'down';
    const delays = this.opts.restartDelaysMs ?? RESTART_DELAYS_MS;
    const delay = delays[Math.min(c.crashes.length, delays.length) - 1] ?? 100;
    this.opts.log.error(
      { child: c.name, code, signal, restartInMs: delay },
      'child process exited; restarting',
    );
    this.send(other, { t: c.name, state: 'down' });
    this.publish();
    c.restartTimer = setTimeout(() => {
      c.status.restarts++;
      this.spawn(c.name);
    }, delay);
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const c of Object.values(this.children)) {
      if (!c.proc || this.stopping) continue;
      const limit = this.opts.stallMs?.[c.name] ?? STALL_MS[c.name];
      if (now - c.lastBeat > limit) {
        this.opts.log.error(
          { child: c.name, pid: c.proc.pid, silentMs: now - c.lastBeat },
          'child process stalled; killing it',
        );
        c.lastBeat = now;
        c.proc.kill('SIGKILL');
      }
    }
  }

  /** Kill a child as if it crashed (chaos tests, diagnostics). */
  kill(name: ChildName, signal: NodeJS.Signals = 'SIGKILL'): void {
    this.children[name].proc?.kill(signal);
  }

  /** Tell both children the current states, and write supervisor.json. */
  private publish(): void {
    const processes = this.status();
    this.send('live', { t: 'status', processes });
    this.send('library', { t: 'status', processes });
    const file = join(this.opts.dataDir, 'supervisor.json');
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, at: Date.now(), processes }, null, 1));
      renameSync(`${file}.tmp`, file);
    } catch {
      /* the data dir may be read-only for a moment; the status is informative only */
    }
  }

  async shutdown(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.watchdog);
    this.opts.log.info({ reason }, 'supervisor shutting down');
    const waits = Object.values(this.children).map((c) => {
      clearTimeout(c.restartTimer);
      const p = c.proc;
      if (!p) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.opts.log.warn({ child: c.name }, 'child did not stop in time; killing it');
          p.kill('SIGKILL');
        }, SHUTDOWN_MS);
        p.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        p.kill('SIGTERM');
      });
    });
    await Promise.all(waits);
    this.publish();
  }
}

/** States as a compact string for logs. */
export function describe(states: { name: ChildName; state: ChildState }[]): string {
  return states.map((s) => `${s.name}=${s.state}`).join(' ');
}

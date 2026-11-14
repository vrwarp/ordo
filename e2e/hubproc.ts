import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A hub process owned by a test, so the test can kill and restart it (hub-loss scenarios). */
export class HubProcess {
  proc?: ChildProcess;
  readonly port: number;
  readonly dataDir: string;
  /** Where the hub's log lines go (appended across restarts); none: next to the data, `<data>.log`. */
  readonly logFile: string;
  constructor(port: number, dataDir: string, logFile = `${dataDir}.log`) {
    this.port = port;
    this.dataDir = dataDir;
    this.logFile = logFile;
  }

  /**
   * Data under ORDO_E2E_DATA_ROOT when set (a scratch dir), else `test-results/.e2e-data-<port>`: with the
   * other test output, out of the linter's way and removed with it.
   */
  static fresh(port: number): HubProcess {
    const root = process.env.ORDO_E2E_DATA_ROOT ?? 'test-results';
    const dir = `${root}/.e2e-data-${port}`;
    rmSync(dir, { recursive: true, force: true });
    // Not a dot file: CI's artifact upload leaves hidden files out.
    const log = `${root}/hub-${port}.log`;
    rmSync(log, { force: true });
    return new HubProcess(port, dir, log);
  }

  async start(): Promise<void> {
    // A hub still answering here after 10 s is a leftover of an earlier test (a timed-out one whose worker
    // was torn down before its finally): kill() would then kill nothing and the hub-loss steps wait
    // forever. A hub just killed lets go within a few seconds (its children exit on their own).
    for (let waited = 0; ; waited += 250) {
      const up = await fetch(`http://localhost:${this.port}/api/v1/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (!up) break;
      if (waited >= 10_000)
        throw new Error(`port ${this.port} still serves a hub: a leftover of an earlier test`);
      await new Promise((r) => setTimeout(r, 250));
    }
    // ORDO_E2E_HUB_CMD lets a run use the sources (e.g. "npx tsx apps/hub/src/main.ts") instead of the build.
    const [cmd, ...args] = (process.env.ORDO_E2E_HUB_CMD ?? 'node apps/hub/dist/main.js').split(/\s+/);
    if (!HubProcess.exitHook) {
      // The worker goes away (a test timed out: its finally never runs): take every hub with it.
      HubProcess.exitHook = true;
      process.on('exit', () => {
        for (const h of HubProcess.running) h.kill();
      });
    }
    HubProcess.running.add(this);
    // The hub's log lines (pino on stdout) go to its log file (test-results/hub-<port>.log), appended across
    // restarts, so a failing spec's uploaded test-results say what the hub did; ORDO_E2E_HUB_STDOUT=1 shows
    // them on the terminal instead.
    let out: 'inherit' | number = 'inherit';
    if (!process.env.ORDO_E2E_HUB_STDOUT) {
      mkdirSync(dirname(this.logFile), { recursive: true });
      out = openSync(this.logFile, 'a');
    }
    this.proc = spawn(cmd!, args, {
      env: {
        ...process.env,
        ORDO_DATA: this.dataDir,
        ORDO_DOMAIN: 'localhost',
        ORDO_PORT: String(this.port),
        ORDO_HOST: '127.0.0.1',
        ORDO_DEV_PIN: '246810',
        ORDO_TZ: 'UTC',
      },
      stdio: ['ignore', out, 'inherit'],
    });
    if (typeof out === 'number') closeSync(out);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://localhost:${this.port}/api/v1/health`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('hub did not start');
  }

  private static exitHook = false;
  private static readonly running = new Set<HubProcess>();

  kill(): void {
    HubProcess.running.delete(this);
    // A stopped child cannot notice its supervisor vanished: never leave one behind. Only a pid the
    // supervisor still lists is ours (one its watchdog already replaced is gone, and its pid may be reused).
    const stopped = this.stopped.splice(0);
    let listed: number[] = [];
    try {
      listed = Object.values(this.children()).map((c) => c.pid ?? 0);
    } catch {
      /* no supervisor.json */
    }
    const supervisor = this.proc?.pid;
    this.frozen = [];
    this.proc?.kill('SIGKILL');
    this.proc = undefined;
    for (const pid of stopped) {
      if (!listed.includes(pid) && pid !== supervisor) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  /** Pids this test stopped with SIGSTOP (killed by kill() if still there). */
  private stopped: number[] = [];

  /** Freeze one child (SIGSTOP: a stuck event loop as the supervisor sees it); its watchdog kills it. */
  stopChild(name: 'live' | 'library'): number {
    const pid = this.children()[name].pid;
    if (!pid) throw new Error(`${name} process is not running`);
    this.stopped.push(pid);
    process.kill(pid, 'SIGSTOP');
    return pid;
  }

  /**
   * Freeze the whole hub, supervisor and both children (SIGSTOP each): its sockets stay open and silent, no
   * pong, no delta, no close, and the supervisor's own watchdog is frozen with them, so the silence lasts as
   * long as the test wants (freezing only the live child gets it replaced after 5 s). `thaw()` resumes them.
   */
  freeze(): number[] {
    const pids = [this.proc?.pid ?? 0];
    try {
      for (const c of Object.values(this.children())) pids.push(c.pid ?? 0);
    } catch {
      /* no supervisor.json yet */
    }
    const frozen = pids.filter((p) => p > 0);
    for (const pid of frozen) {
      this.stopped.push(pid);
      process.kill(pid, 'SIGSTOP');
    }
    this.frozen = frozen;
    return frozen;
  }

  /** Resume a hub frozen by `freeze()`. */
  thaw(): void {
    for (const pid of this.frozen.splice(0)) {
      try {
        process.kill(pid, 'SIGCONT');
      } catch {
        /* gone */
      }
    }
  }

  private frozen: number[] = [];

  /** The supervisor's children (two-process hub): pids from <data>/supervisor.json. */
  children(): Record<'live' | 'library', { pid?: number; state: string; restarts: number }> {
    const s = JSON.parse(readFileSync(join(this.dataDir, 'supervisor.json'), 'utf8')) as {
      processes: { name: 'live' | 'library'; pid?: number; state: string; restarts: number }[];
    };
    return Object.fromEntries(s.processes.map((p) => [p.name, p])) as never;
  }

  /** Kill one child process as if it crashed; the supervisor restarts it. */
  killChild(name: 'live' | 'library'): number {
    const pid = this.children()[name].pid;
    if (!pid) throw new Error(`${name} process is not running`);
    process.kill(pid, 'SIGKILL');
    return pid;
  }
}

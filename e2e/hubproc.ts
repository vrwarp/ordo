import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** A hub process owned by a test, so the test can kill and restart it (hub-loss scenarios). */
export class HubProcess {
  proc?: ChildProcess;
  constructor(
    readonly port: number,
    readonly dataDir: string,
  ) {}

  /**
   * Data under ORDO_E2E_DATA_ROOT when set (a scratch dir), else `test-results/.e2e-data-<port>`: with the
   * other test output, out of the linter's way and removed with it.
   */
  static fresh(port: number): HubProcess {
    const root = process.env.ORDO_E2E_DATA_ROOT ?? 'test-results';
    const dir = `${root}/.e2e-data-${port}`;
    rmSync(dir, { recursive: true, force: true });
    return new HubProcess(port, dir);
  }

  async start(): Promise<void> {
    // A hub already answering here is a leftover of an earlier test (a timed-out one whose worker was
    // torn down before its finally): kill() would then kill nothing and the hub-loss steps wait forever.
    try {
      const r = await fetch(`http://localhost:${this.port}/api/v1/health`);
      if (r.ok) throw new Error(`port ${this.port} already serves a hub: a leftover of an earlier test`);
    } catch (e) {
      if (e instanceof Error && e.message.includes('leftover')) throw e;
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
      // ORDO_E2E_HUB_STDOUT=1 shows the hub's log lines (pino on stdout) while debugging a spec.
      stdio: ['ignore', process.env.ORDO_E2E_HUB_STDOUT ? 'inherit' : 'ignore', 'inherit'],
    });
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
    this.proc?.kill('SIGKILL');
    this.proc = undefined;
    for (const pid of stopped) {
      if (!listed.includes(pid)) continue;
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

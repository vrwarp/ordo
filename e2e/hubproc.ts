import { type ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

/** A hub process owned by a test, so the test can kill and restart it (hub-loss scenarios). */
export class HubProcess {
  proc?: ChildProcess;
  constructor(
    readonly port: number,
    readonly dataDir: string,
  ) {}

  static fresh(port: number): HubProcess {
    const dir = `.e2e-data-${port}`;
    rmSync(dir, { recursive: true, force: true });
    return new HubProcess(port, dir);
  }

  async start(): Promise<void> {
    this.proc = spawn('node', ['apps/hub/dist/main.js'], {
      env: {
        ...process.env,
        ORDO_DATA: this.dataDir,
        ORDO_DOMAIN: 'localhost',
        ORDO_PORT: String(this.port),
        ORDO_HOST: '127.0.0.1',
        ORDO_DEV_PIN: '246810',
        ORDO_TZ: 'UTC',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
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

  kill(): void {
    this.proc?.kill('SIGKILL');
    this.proc = undefined;
  }
}

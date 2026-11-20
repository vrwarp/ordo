import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { HubProcess } from './hubproc.ts';

/**
 * The hubs the e2e suite starts have the free-space floor off (design/29 A25, ORDO_MIN_FREE_GB=0): the floor
 * refuses every upload with 507 on a volume with less free than the floor (5 % of the volume, 5 to 25 GiB: a dev
 * machine, a small CI disk), whatever the spec is about. Two places start them: `HubProcess` (a spec that owns its hub) and the shared web server of
 * `playwright.config.ts`. The hub the specs start is the real one; this file starts a stand-in that writes the
 * environment it was given, and reads the configuration.
 */
const dirs: string[] = [];
const running: HubProcess[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const h of running.splice(0)) h.kill();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The stand-in hub: writes what it was given into its data folder, then answers the health request (its port is its argument). */
const STAND_IN = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
mkdirSync(process.env.ORDO_DATA, { recursive: true });
writeFileSync(process.env.ORDO_DATA + '/env.json', JSON.stringify({ floor: process.env.ORDO_MIN_FREE_GB ?? null }));
createServer((_req, res) => res.end('{}')).listen(Number(process.argv[2]), '127.0.0.1');
`;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** The floor the stand-in hub saw, started by a `HubProcess` whose own environment is `own`. */
async function floorSeen(own: Record<string, string> = {}): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'ordo-e2e-floor-'));
  dirs.push(dir);
  const script = join(dir, 'stand-in.mjs');
  writeFileSync(script, STAND_IN);
  const port = await freePort();
  vi.stubEnv('ORDO_E2E_HUB_CMD', `node ${script} ${port}`);
  vi.stubEnv('ORDO_E2E_HUB_STDOUT', '');
  const hub = new HubProcess(port, join(dir, 'data'), join(dir, 'hub.log'));
  Object.assign(hub.env, own);
  running.push(hub);
  await hub.start();
  return (JSON.parse(readFileSync(join(dir, 'data', 'env.json'), 'utf8')) as { floor: string | null }).floor;
}

describe('the floor of the hubs the e2e suite starts', () => {
  it('is off in a HubProcess, whatever the environment of the run says', async () => {
    vi.stubEnv('ORDO_MIN_FREE_GB', '10000');
    expect(await floorSeen()).toBe('0');
  });

  it('is the spec own value when it sets one in hub.env (a spec of the floor)', async () => {
    expect(await floorSeen({ ORDO_MIN_FREE_GB: '9' })).toBe('9');
  });

  it('is off in the shared web server of playwright.config.ts', async () => {
    const { default: config } = await import('../playwright.config.ts');
    const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
    expect(server?.env?.ORDO_MIN_FREE_GB).toBe('0');
  });
});

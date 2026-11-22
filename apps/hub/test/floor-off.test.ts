/**
 * The hubs the tests start have the free-space floor off (design/29 A25, ORDO_MIN_FREE_GB=0): the floor refuses every
 * upload with 507 when the data volume has less free than the floor (5 % of the volume, 5 to 25 GiB: a dev machine, a
 * small CI disk), and no test but those of the floor itself (`diskfloor.test.ts`, the floor cases of `processes.test.ts`, `slidefiles.test.ts` and
 * `prerenders.test.ts`) is about that. `helpers.ts` `testFloor` is the rule; the e2e suite pins the same in
 * `e2e/floor-off.test.ts`, the fidelity tool's hubs in `tools/pptx-fidelity` `hubEnv`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIB, type StatFsFn } from '../src/diskfloor.ts';
import { prerenderConfig } from '../src/config.ts';
import { type Client, EDIT_PIN, login, sleep, startHub, testFloor } from './helpers.ts';
import { twoProcesses } from './phones-helpers.ts';
import { fullOf, makePng, presentationOf, uploadSlideFile } from './prerender-helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** A volume of 100 GiB with `free` bytes free. */
const volume =
  (free: number): StatFsFn =>
  async () => ({ bsize: 4096, bavail: Math.floor(free / 4096), blocks: Math.floor((100 * GIB) / 4096) });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const upload = (c: Client) => {
  const fd = new FormData();
  fd.append('file', new Blob([PNG]), 'a.png');
  return c.fetch('/media', { method: 'POST', body: fd });
};

/** GET /health once the hub has measured its volume (it does so at start, a moment after listening). */
async function health(url: string): Promise<Record<string, number>> {
  const end = Date.now() + 5000;
  for (;;) {
    const h = (await (await fetch(`${url}/api/v1/health`)).json()) as Record<string, number>;
    if (h.diskFreeBytes !== undefined || Date.now() > end) return h;
    await sleep(50);
  }
}

afterEach(() => vi.unstubAllEnvs());

describe('the floor of a test hub', () => {
  it('is off in the hub startHub makes, whatever the process environment says: nothing is refused for room', async () => {
    vi.stubEnv('ORDO_MIN_FREE_GB', '10000');
    const hub = await startHub();
    expect(hub.cfg.minFreeBytes).toBe(0);
    expect((await health(hub.url)).diskFloorBytes).toBe(0);
    // an upload is not refused 507, on this machine's volume whatever its free space
    const res = await upload(await login(hub.url, EDIT_PIN));
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  });

  it('is off in both processes twoProcesses makes', async () => {
    vi.stubEnv('ORDO_MIN_FREE_GB', '10000');
    const tp = await twoProcesses();
    try {
      expect(tp.lib.cfg.minFreeBytes).toBe(0);
      const res = await upload(await login(tp.base, EDIT_PIN));
      expect(res.status, await res.clone().text()).toBeLessThan(300);
    } finally {
      await tp.close();
    }
  });

  it('is the computed one for a test that gives its hub a volume of its own (a floor test), whatever the process environment says', async () => {
    vi.stubEnv('ORDO_MIN_FREE_GB', '0');
    expect(testFloor({ statfs: volume(GIB) })).toBeUndefined();
    const hub = await startHub({ statfs: volume(GIB) });
    expect(hub.cfg.minFreeBytes).toBeUndefined();
    expect((await health(hub.url)).diskFloorBytes).toBe(5 * GIB);
    expect((await upload(await login(hub.url, EDIT_PIN))).status).toBe(507);
  });

  it("is the test's own value when it sets one", async () => {
    const hub = await startHub({ minFreeBytes: 7 * GIB });
    expect(hub.cfg.minFreeBytes).toBe(7 * GIB);
    expect((await health(hub.url)).diskFloorBytes).toBe(7 * GIB);
  });
});

/**
 * The pre-render state of a hub a test starts (store-2, C-S2-5): the hub of 0.10.0, whatever ORDO_PRERENDER says in the
 * process environment and whatever PRERENDER_ON becomes at the release's switch commit: the setting auto, the constant
 * read as false (operators told off, no picture line), the store open. A test that wants another state gives
 * `prerender` itself.
 */
describe('the pre-render state of a test hub', () => {
  /** PUT a 640 picture for the slide's key: refused 503 only when the store is closed. */
  async function putPicture(base: string) {
    const ed = await login(base, EDIT_PIN);
    const f = fullOf();
    await uploadSlideFile(ed, f.pages);
    const p = await ed.json<{ id: string }>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn]),
    });
    return ed.fetch(`/presentations/${p.id}/prerenders/${f.key}?size=640`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(makePng(640, 360)),
    });
  }

  it('is the 0.10.0 hub in the hub startHub makes, whatever the process environment says', async () => {
    vi.stubEnv('ORDO_PRERENDER', 'off');
    const hub = await startHub();
    expect(hub.cfg.prerender).toEqual({ setting: 'auto', on: false, store: true });
    expect((await putPicture(hub.url)).status).toBe(201);
  });

  it('is the same in both processes twoProcesses makes', async () => {
    vi.stubEnv('ORDO_PRERENDER', 'off');
    const tp = await twoProcesses();
    try {
      expect(tp.lib.cfg.prerender).toEqual({ setting: 'auto', on: false, store: true });
      expect((await putPicture(tp.base)).status).toBe(201);
    } finally {
      await tp.close();
    }
  });

  it("is the test's own value when it gives one", async () => {
    const hub = await startHub({ prerender: prerenderConfig('off') });
    expect(hub.cfg.prerender.store).toBe(false);
    expect((await putPicture(hub.url)).status).toBe(503);
    const on = await startHub({ prerender: prerenderConfig('on') });
    expect(on.cfg.prerender).toEqual({ setting: 'on', on: true, store: true });
  });
});

describe('every hub the test folder starts says what its floor is', () => {
  // A hub started in this folder without `startHub` or `twoProcesses` (`createHub`, `createLibraryProcess`,
  // `createLiveProcess`, or a child process of `src/main.ts`) builds its own configuration or environment, and an
  // unset floor is the computed one: its file must name `minFreeBytes`, `ORDO_MIN_FREE_GB` or `testFloor`.
  const START = /\b(?:createHub|createLibraryProcess|createLiveProcess)\(|\/src\/main\.ts/;
  const SAYS = /minFreeBytes|ORDO_MIN_FREE_GB|testFloor/;

  it('names it in every file that starts one', () => {
    const files = (readdirSync(here, { recursive: true }) as string[]).filter(
      (f) => f.endsWith('.ts') && f !== 'floor-off.test.ts',
    );
    const starting = files.filter((f) => START.test(readFileSync(join(here, f), 'utf8')));
    // the helpers are among them: if this list ever lacks them, the pattern no longer finds a start
    expect(starting).toContain('helpers.ts');
    expect(starting.filter((f) => !SAYS.test(readFileSync(join(here, f), 'utf8')))).toEqual([]);
  });
});

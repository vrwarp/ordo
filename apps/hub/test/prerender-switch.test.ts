/**
 * The hub's switch for the release's pictures, ORDO_PRERENDER (store-2, design/29 §1.11), as the routes and the
 * parts of the hub honour it. PR* cases of step 1 are about what is TOLD (capabilities, health, the log); PS1-PS8 of step 2 are
 * about what it DOES (the picture route, the keys job, goLive). One hub per setting: `startHub({ prerender })`.
 * Before the release's switch commit `auto` is the 0.10.0 hub (the store open, operators told off).
 */
import { PRERENDER_ON } from '@ordo/domain/prerender.ts';
import type { HubCapabilities } from '@ordo/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { prerenderConfig } from '../src/config.ts';
import { EDIT_PIN, login, startHub, type TestHub } from './helpers.ts';

const hubs: TestHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.cleanup();
});
const start = async (setting: string | undefined, extra: { logLevel?: string } = {}) => {
  const h = await startHub({ prerender: prerenderConfig(setting), ...extra });
  hubs.push(h);
  return h;
};
const health = async (h: TestHub) =>
  (await (await fetch(`${h.url}/api/v1/health`)).json()) as Record<string, unknown>;

describe('what the hub tells about its switch (PR1-PR3)', () => {
  it('PR1: GET /capabilities carries prerender { state, setting } and keeps the tool fields', async () => {
    const want: [string | undefined, unknown][] = [
      ['on', { state: 'on', setting: 'on' }],
      ['off', { state: 'off', setting: 'off' }],
      [undefined, { state: PRERENDER_ON ? 'on' : 'off', setting: 'auto' }],
    ];
    for (const [setting, expected] of want) {
      const h = await start(setting);
      const caps = await (await login(h.url, EDIT_PIN)).json<HubCapabilities>('/capabilities');
      expect(caps.prerender, String(setting)).toEqual(expected);
      expect(caps).toMatchObject({ libreoffice: { state: 'available' }, pdf: true });
    }
  });

  it('PR2: the public GET /health says on or off, and no tool name or version', async () => {
    const want: [string | undefined, string][] = [
      ['on', 'on'],
      ['off', 'off'],
      [undefined, PRERENDER_ON ? 'on' : 'off'],
    ];
    for (const [setting, expected] of want) {
      const h = await start(setting);
      const body = await health(h);
      expect(body.prerender, String(setting)).toBe(expected);
      expect(JSON.stringify(body)).not.toMatch(/libreoffice/i);
    }
  });

  it('PR3: the log says it once, in plain words, for off and for a value it does not understand, and not for auto or on', async () => {
    const lines = (h: TestHub) =>
      h.ring.snapshot().filter((l) => /ORDO_PRERENDER|Pictures of heavy slides/.test(l));
    expect(lines(await start('off', { logLevel: 'info' }))).toHaveLength(1);
    expect(lines(await start('off', { logLevel: 'info' }))[0]).toMatch(
      /Pictures of heavy slides are turned off \(ORDO_PRERENDER=off\): heavy slides are drawn live and whole, and nothing already stored is deleted\./,
    );
    const odd = lines(await start('maybe', { logLevel: 'info' }));
    expect(odd).toHaveLength(1);
    expect(odd[0]).toMatch(/ORDO_PRERENDER is neither auto, on nor off \(\\"maybe\\"\): auto/);
    expect(lines(await start(undefined, { logLevel: 'info' }))).toHaveLength(0);
    expect(lines(await start('on', { logLevel: 'info' }))).toHaveLength(0);
  });
});

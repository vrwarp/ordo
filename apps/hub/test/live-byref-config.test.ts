/**
 * The technician switch ORDO_LIVE_BYREF (live-by-ref, OQ-LBR2), read once at start: `on` (default, and anything
 * unset), `off`, and any other value is `on` with one start-up warning, the way ORDO_LIBREOFFICE is read
 * (tools.test.ts). `loadConfig` carries it into `HubConfig.liveByRef`, which the live service is built with.
 */
import { describe, expect, it } from 'vitest';
import { liveByRefConfig, loadConfig } from '../src/config.ts';
import { startHub } from './helpers.ts';

describe('ORDO_LIVE_BYREF', () => {
  it('is on when unset, empty or any spelling of on; off for any spelling of off', () => {
    expect(liveByRefConfig(undefined)).toEqual({ on: true });
    expect(liveByRefConfig('')).toEqual({ on: true });
    expect(liveByRefConfig('   ')).toEqual({ on: true });
    for (const v of ['on', 'ON', 'On', '1', 'true', 'yes', ' on '])
      expect(liveByRefConfig(v)).toEqual({ on: true });
    for (const v of ['off', 'OFF', 'Off', '0', 'false', 'no', ' off '])
      expect(liveByRefConfig(v)).toEqual({ on: false });
  });

  it('a value that is neither is on, with a warning that names it (cut at 100 characters)', () => {
    const odd = liveByRefConfig('maybe');
    expect(odd.on).toBe(true);
    expect(odd.warning).toMatch(/ORDO_LIVE_BYREF is neither on nor off \("maybe"\): on/);
    const long = liveByRefConfig(`x${'y'.repeat(500)}`);
    expect(long.on).toBe(true);
    expect(long.warning?.length).toBeLessThan(200);
    expect(long.warning).toContain('"xyyyy');
    // not 'off' by a prefix or a substring
    expect(liveByRefConfig('offline').on).toBe(true);
    expect(liveByRefConfig('offline').warning).toBeTruthy();
    expect(liveByRefConfig('0 off').on).toBe(true);
  });

  it('loadConfig carries it into HubConfig.liveByRef (and the warning into liveByRefWarning)', () => {
    expect(loadConfig({}).liveByRef).toBe(true);
    expect(loadConfig({}).liveByRefWarning).toBeUndefined();
    expect(loadConfig({ ORDO_LIVE_BYREF: 'off' }).liveByRef).toBe(false);
    expect(loadConfig({ ORDO_LIVE_BYREF: 'off' }).liveByRefWarning).toBeUndefined();
    expect(loadConfig({ ORDO_LIVE_BYREF: 'on' }).liveByRef).toBe(true);
    const garbage = loadConfig({ ORDO_LIVE_BYREF: 'sometimes' });
    expect(garbage.liveByRef).toBe(true);
    expect(garbage.liveByRefWarning).toMatch(/neither on nor off/);
  });

  it('the live service of a hub started with the loaded value follows it', async () => {
    for (const [env, want] of [
      ['off', false],
      [undefined, true],
    ] as const) {
      const hub = await startHub({ liveByRef: loadConfig({ ORDO_LIVE_BYREF: env }).liveByRef });
      try {
        expect(hub.live.byRef).toBe(want);
      } finally {
        await hub.cleanup();
      }
    }
  });
});

/**
 * The hub's one switch for the release's pictures, ORDO_PRERENDER (store-2, design/29 §1.11), read once at start
 * by every hub process: `auto` (the default: follows the domain constant `PRERENDER_ON`), `on`, `off`; any other
 * value is `auto` with one start-up warning, the way ORDO_LIVE_BYREF is read (live-byref-config.test.ts).
 * `store` is false only for an explicit `off`: before the release's switch commit `auto` keeps the store open
 * and operators are told what the constant says, so the hub is the 0.10.0 hub. The test compares with the
 * IMPORTED constant, never a literal, so it passes before and after the switch commit.
 */
import { PRERENDER_ON } from '@ordo/domain/prerender.ts';
import { describe, expect, it } from 'vitest';
import { loadConfig, prerenderConfig } from '../src/config.ts';

describe('ORDO_PRERENDER', () => {
  it('is auto when unset, empty, blank or any spelling of auto: on follows the constant and the store is open', () => {
    for (const v of [undefined, '', '   ', 'auto', 'AUTO', ' Auto ']) {
      const c = prerenderConfig(v);
      expect(c, String(v)).toEqual({ setting: 'auto', on: PRERENDER_ON, store: true });
      expect(c.warning).toBeUndefined();
    }
  });

  it('is on for on, 1, true and yes (any case, trimmed): on and the store open', () => {
    for (const v of ['on', 'ON', '1', 'true', 'True', 'yes', ' On ']) {
      expect(prerenderConfig(v), v).toEqual({ setting: 'on', on: true, store: true });
    }
  });

  it('is off for off, 0, false and no: not on and the store closed', () => {
    for (const v of ['off', 'OFF', '0', 'false', 'no', ' Off ']) {
      expect(prerenderConfig(v), v).toEqual({ setting: 'off', on: false, store: false });
    }
  });

  it('a value that is none of these is auto, with a warning that names the setting and the value (cut at 100 characters)', () => {
    const odd = prerenderConfig('maybe');
    expect(odd.setting).toBe('auto');
    expect(odd.on).toBe(PRERENDER_ON);
    expect(odd.store).toBe(true);
    expect(odd.warning).toMatch(/ORDO_PRERENDER is neither auto, on nor off \("maybe"\): auto/);
    const long = prerenderConfig(`x${'y'.repeat(500)}`);
    expect(long.warning?.length).toBeLessThan(200);
    expect(long.warning).toContain('"xyyyy');
    // not 'off' by a prefix or a substring
    expect(prerenderConfig('offline').setting).toBe('auto');
    expect(prerenderConfig('offline').warning).toBeTruthy();
    expect(prerenderConfig('0 off').setting).toBe('auto');
  });

  it('the constant is injected: auto follows it, on and off do not', () => {
    expect(prerenderConfig(undefined, true).on).toBe(true);
    expect(prerenderConfig(undefined, false).on).toBe(false);
    expect(prerenderConfig(undefined, true).store).toBe(true);
    expect(prerenderConfig('off', true)).toEqual({ setting: 'off', on: false, store: false });
    expect(prerenderConfig('on', false)).toEqual({ setting: 'on', on: true, store: true });
  });

  it('loadConfig carries it into HubConfig.prerender', () => {
    expect(loadConfig({}).prerender.setting).toBe('auto');
    expect(loadConfig({}).prerender.store).toBe(true);
    expect(loadConfig({ ORDO_PRERENDER: 'off' }).prerender.store).toBe(false);
    expect(loadConfig({ ORDO_PRERENDER: 'off' }).prerender.on).toBe(false);
    expect(loadConfig({ ORDO_PRERENDER: 'on' }).prerender.on).toBe(true);
    expect(loadConfig({ ORDO_PRERENDER: 'sometimes' }).prerender.warning).toMatch(/neither auto, on nor off/);
    // an override of a test wins
    expect(loadConfig({}, { prerender: prerenderConfig('off') }).prerender.store).toBe(false);
  });
});

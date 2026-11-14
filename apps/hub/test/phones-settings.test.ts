/**
 * The Phones switch (design/28 §9, design/24 "Feature flags are settings"): `settings.phones.enabled`, off by
 * default, read by edit and operate sessions, written by operate only, in the snapshot and in settings deltas,
 * and in the live process's copy of the settings (its routes read it from there).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EDIT_PIN, login, OPERATE_PIN, startHub, type TestHub } from './helpers.ts';
import { type TwoProcesses, twoProcesses } from './phones-helpers.ts';

describe('settings.phones', () => {
  let hub: TestHub | undefined;
  let two: TwoProcesses | undefined;
  afterEach(async () => {
    await hub?.cleanup();
    await two?.close();
    hub = undefined;
    two = undefined;
  });

  it('is off by default; edit reads it, operate writes it, edit may not', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const ed = await login(hub.url, EDIT_PIN);
    // Before this setting existed the key was unknown: 404 (the test fails there).
    expect(await ed.json('/settings/phones')).toEqual({ enabled: false });
    expect((await ed.fetch('/settings/phones', { method: 'PUT', json: { enabled: true } })).status).toBe(403);
    expect(await op.json('/settings/phones', { method: 'PUT', json: { enabled: true } })).toEqual({
      enabled: true,
    });
    expect(await ed.json('/settings/phones')).toEqual({ enabled: true });
    expect((await op.json<{ phones: unknown }>('/settings')).phones).toEqual({ enabled: true });
    expect(hub.lib.getSetting('phones')).toEqual({ enabled: true });
  });

  it('refuses a body with an unknown key or a wrong type', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const odd = await op.fetch('/settings/phones', { method: 'PUT', json: { enabled: true, extra: 1 } });
    expect(odd.status).toBe(400);
    const wrong = await op.fetch('/settings/phones', { method: 'PUT', json: { enabled: 'yes' } });
    expect(wrong.status).toBe(400);
    expect(hub.lib.getSetting('phones')).toEqual({ enabled: false });
  });

  it('is in the snapshot and in the settings delta', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const snap = await ed.json<{ settings: { phones?: unknown } }>('/library/snapshot');
    expect(snap.settings.phones).toEqual({ enabled: false });
    const seen: unknown[] = [];
    hub.lib.onChange((changes) => {
      for (const c of changes) if (c.kind === 'settings') seen.push(c);
    });
    const op = await login(hub.url, OPERATE_PIN);
    await op.json('/settings/phones', { method: 'PUT', json: { enabled: true } });
    expect(seen).toEqual([{ kind: 'settings', id: 'phones', entity: { enabled: true } }]);
  });

  it('a missing row reads as off, a bad stored value too', async () => {
    hub = await startHub();
    hub.db.prepare(`DELETE FROM settings WHERE key = 'phones'`).run();
    expect(hub.lib.getSetting('phones')).toEqual({ enabled: false });
    hub.db.prepare(`INSERT INTO settings (key, rev, json, updated_at) VALUES ('phones', 1, '"x"', '')`).run();
    expect(hub.lib.getSetting('phones')).toEqual({ enabled: false });
  });

  it("reaches the live process's copy of the settings (two processes)", async () => {
    two = await twoProcesses();
    const op = await login(two.base, OPERATE_PIN);
    expect(two.live.link.context?.settings.phones).toEqual({ enabled: false });
    await op.json('/settings/phones', { method: 'PUT', json: { enabled: true } });
    // The answer to the write waits until the live process has applied it (read-your-writes).
    expect(two.live.link.context?.settings.phones).toEqual({ enabled: true });
  });
});

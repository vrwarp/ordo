/**
 * Service-safety fixes from the 2026-11-13 review, on the hub: MIDI pedals kept for venues upgraded from
 * before MIDI became opt-in.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { login, OPERATE_PIN, startHub, type TestHub } from './helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

describe('MIDI after an upgrade from before MIDI became opt-in', () => {
  const store = (h: TestHub, surfaces: Record<string, unknown>) =>
    h.db.prepare(`UPDATE settings SET json = ? WHERE key = 'surfaces'`).run(JSON.stringify(surfaces));

  it('reads stored settings with MIDI mappings and no midiEnabled as enabled, so the pedals keep working', async () => {
    hub = await startHub();
    const stored = hub.lib.getSetting('surfaces');
    const { midiEnabled: _, ...old } = stored;
    expect(old.midi.length).toBeGreaterThan(0);
    store(hub, old);
    expect(hub.lib.getSetting('surfaces').midiEnabled).toBe(true);
    // What the operator loads says the same.
    const op = await login(hub.url, OPERATE_PIN);
    const all = await op.json<{ surfaces: { midiEnabled: boolean } }>('/settings');
    expect(all.surfaces.midiEnabled).toBe(true);
  });

  it('leaves a venue without mappings off (no MIDI permission prompt), and a stored choice as it is', async () => {
    hub = await startHub();
    const { midiEnabled: _, ...old } = hub.lib.getSetting('surfaces');
    store(hub, { ...old, midi: [] });
    expect(hub.lib.getSetting('surfaces').midiEnabled).toBe(false);
    store(hub, { ...old, midiEnabled: false });
    expect(hub.lib.getSetting('surfaces').midiEnabled).toBe(false);
    // A new library is seeded off.
    hub.db.prepare(`DELETE FROM settings WHERE key = 'surfaces'`).run();
    expect(hub.lib.getSetting('surfaces').midiEnabled).toBe(false);
  });
});

/**
 * `HubCapabilities.prerender` (store-2, C-S2-2): the hub's EFFECTIVE answer about pictures of heavy slides. Every field
 * has a `.catch` default like the rest of the schema, so a hub from before, a bad value or a field of a later
 * hub never breaks a screen; a missing answer is `off`.
 */
import { describe, expect, it } from 'vitest';
import { HubCapabilities, LEGACY_CAPABILITIES } from './api.ts';

describe('HubCapabilities.prerender', () => {
  it('is off when the hub gives no field (a hub from before the release)', () => {
    expect(HubCapabilities.parse({}).prerender).toEqual({ state: 'off' });
    expect(HubCapabilities.parse({ pdf: true }).prerender.state).toBe('off');
  });

  it('parses what the hub says, with its setting', () => {
    expect(HubCapabilities.parse({ prerender: { state: 'on', setting: 'off' } }).prerender).toEqual({
      state: 'on',
      setting: 'off',
    });
    expect(HubCapabilities.parse({ prerender: { state: 'on', setting: 'auto' } }).prerender).toEqual({
      state: 'on',
      setting: 'auto',
    });
    expect(HubCapabilities.parse({ prerender: { state: 'off' } }).prerender).toEqual({ state: 'off' });
  });

  it('a bad answer parses to state off or an unknown setting: the schema catches, nothing throws', () => {
    expect(HubCapabilities.parse({ prerender: { state: 'maybe' } }).prerender.state).toBe('off');
    expect(HubCapabilities.parse({ prerender: 5 }).prerender).toEqual({ state: 'off' });
    expect(HubCapabilities.parse({ prerender: null }).prerender).toEqual({ state: 'off' });
    const odd = HubCapabilities.parse({ prerender: { state: 'on', setting: 7 } }).prerender;
    expect(odd.state).toBe('on');
    expect(odd.setting).toBeUndefined();
    expect(
      HubCapabilities.parse({ prerender: { state: 'on', setting: 'sometimes' } }).prerender.setting,
    ).toBe(undefined);
  });

  it('ignores unknown fields', () => {
    const p = HubCapabilities.parse({ prerender: { state: 'on', anchored: true, future: 1 } }).prerender;
    expect(p).toEqual({ state: 'on' });
  });

  it('a hub before M9 is read as off for pictures', () => {
    expect(LEGACY_CAPABILITIES.prerender.state).toBe('off');
  });
});

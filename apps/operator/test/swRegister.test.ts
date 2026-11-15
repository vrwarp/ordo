/**
 * Which service worker a device registers (src/sw/register.ts; design/28 §3.1): a phone the compact set after
 * load and idle; a tablet, an iPad in a narrow window and the full profile './sw.js' at once; a layout change
 * registers nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isPhone } from '../src/lib/layout.ts';
import { applyLayout, resetLayoutForTests } from '../src/lib/layout.ts';
import { registerServiceWorker, SW_URL, SW_URL_COMPACT, type SwRegisterEnv } from '../src/sw/register.ts';

function env(phone: boolean) {
  const registered: string[] = [];
  let onLoad: (() => void) | undefined;
  let onIdle: (() => void) | undefined;
  const e: SwRegisterEnv = {
    phone,
    register: async (url) => {
      registered.push(url);
    },
    afterLoad: (fn) => {
      onLoad = fn;
    },
    whenIdle: (fn) => {
      onIdle = fn;
    },
  };
  return { e, registered, load: () => onLoad?.(), idle: () => onIdle?.() };
}

afterEach(() => resetLayoutForTests());

describe('service worker registration', () => {
  it('a phone registers the compact set after the load event and idle', () => {
    const h = env(isPhone('edit', { width: 390, height: 844 }));
    registerServiceWorker(h.e);
    expect(h.registered).toEqual([]);
    h.load();
    expect(h.registered).toEqual([]);
    h.idle();
    expect(h.registered).toEqual([SW_URL_COMPACT]);
  });

  it('a tablet, an iPad in a narrow Split View and the venue PC register ./sw.js at once', () => {
    for (const phone of [
      isPhone('edit', { width: 800, height: 1280 }),
      // An iPad in a 320 px Split View: the screen is still the iPad's.
      isPhone('edit', { width: 834, height: 1194 }),
      isPhone('full', { width: 1920, height: 1080 }),
    ]) {
      const h = env(phone);
      registerServiceWorker(h.e);
      expect(h.registered).toEqual([SW_URL]);
    }
  });

  it('a layout change registers nothing', () => {
    const h = env(false);
    registerServiceWorker(h.e);
    applyLayout('compact', undefined);
    applyLayout('regular', undefined);
    expect(h.registered).toEqual([SW_URL]);
  });
});

/**
 * Which service worker a device registers (design/28 §3.1, design/17, ADR 0013), decided once at startup from
 * the device class, never from the layout: a phone (lib/layout.ts isPhone: the screen, not the viewport)
 * registers './sw.js?set=compact' once the page has loaded and gone idle, so its precache does not compete with
 * the first load; every other device (the venue PC, an iPad, an Android tablet, an iPad starting in a narrow
 * Split View) registers './sw.js' at once, as before. A later layout change registers nothing (no reinstall on
 * a Split View toggle; an iPad keeps the editor offline).
 */
export type SwRegisterEnv = {
  phone: boolean;
  register(url: string): Promise<unknown>;
  /** Run once the page's load event has fired (now if it has). */
  afterLoad(fn: () => void): void;
  /** Run when the page is idle. */
  whenIdle(fn: () => void): void;
};

export const SW_URL = './sw.js';
export const SW_URL_COMPACT = './sw.js?set=compact';

export function registerServiceWorker(env: SwRegisterEnv): void {
  const go = (url: string) => void env.register(url).catch(() => undefined);
  if (!env.phone) {
    go(SW_URL);
    return;
  }
  env.afterLoad(() => env.whenIdle(() => go(SW_URL_COMPACT)));
}

/** The browser's environment for registerServiceWorker. */
export function browserSwEnv(phone: boolean): SwRegisterEnv {
  return {
    phone,
    register: (url) => navigator.serviceWorker.register(url),
    afterLoad(fn) {
      if (document.readyState === 'complete') fn();
      else window.addEventListener('load', () => fn(), { once: true });
    },
    whenIdle(fn) {
      const w = window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      };
      if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(fn, { timeout: 5000 });
      else setTimeout(fn, 1500);
    },
  };
}

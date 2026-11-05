/**
 * The GitHub Pages demo (apps/demo): the operator, output and stage apps built with `ORDO_DEMO=1` run with
 * no hub. A service worker at the site root (`hub-sw.js`) answers the hub's REST API from bundled sample
 * content and the visitor's IndexedDB; there is no WebSocket, so the apps never open one and go live from
 * the browser (design/17 "Going live without the hub").
 */
declare const __ORDO_DEMO__: boolean | undefined;

export const DEMO: boolean = typeof __ORDO_DEMO__ !== 'undefined' && __ORDO_DEMO__ === true;

/**
 * Demo only: make sure the demo hub service worker controls this page before the app talks to "the hub".
 * The first visit registers it and reloads once it is active; later visits return at once.
 * `scriptUrl` and `scope` are relative to the page (`'./hub-sw.js'` for the operator at the site root,
 * `'../hub-sw.js'` and `'../'` for the output and stage windows one level down).
 */
export async function ensureDemoHub(scriptUrl: string, scope = './'): Promise<boolean> {
  if (!DEMO || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return true;
  if (navigator.serviceWorker.controller) return true;
  await navigator.serviceWorker.register(scriptUrl, { scope });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return true;
  // Activated but not yet controlling this page (first visit): reload under it.
  location.reload();
  return false;
}

/**
 * The GitHub Pages demo (apps/demo): the operator, output and stage apps built with `ORDO_DEMO=1` run with
 * no hub. A service worker at the site root (`hub-sw.js`) answers the hub's REST API from bundled sample
 * content and the visitor's IndexedDB; there is no WebSocket, so the apps never open one and go live from
 * the browser (design/17 "Going live without the hub").
 */
declare const __ORDO_DEMO__: boolean | undefined;

export const DEMO: boolean = typeof __ORDO_DEMO__ !== 'undefined' && __ORDO_DEMO__ === true;

/** Set across the one reload that puts the page under the demo hub, so a failed takeover never loops. */
const RELOAD_FLAG = 'ordo-demo-reloaded';

function reloadFlag(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_FLAG) === '1';
  } catch {
    return false;
  }
}

function setReloadFlag(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(RELOAD_FLAG, '1');
    else sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    /* no site storage: the flag is only a guard against looping */
  }
}

/** What the page shows instead of the app when the demo hub cannot run in this browser. */
function showUnsupported(detail: string): void {
  const box = document.createElement('div');
  box.setAttribute('data-demo-unsupported', '');
  box.style.cssText =
    'max-width: 40rem; margin: 15vh auto; padding: 0 1.5rem; font: 16px/1.5 system-ui, sans-serif;';
  const h = document.createElement('h1');
  h.style.cssText = 'font-size: 1.4rem; margin: 0 0 0.75rem;';
  h.textContent = 'This demo needs a browser with service workers and site storage enabled.';
  const p = document.createElement('p');
  p.textContent =
    'The ordo demo runs the hub inside your browser. Private or incognito windows, blocked site data and some ' +
    'older browsers cannot do that: open the demo in a regular window of a current Chrome, Edge, Firefox or ' +
    'Safari.';
  const why = document.createElement('p');
  why.style.cssText = 'opacity: 0.7; font-size: 0.9rem;';
  why.textContent = detail;
  box.append(h, p, why);
  document.body.replaceChildren(box);
}

/**
 * Demo only: make sure the demo hub service worker controls this page before the app talks to "the hub".
 * The first visit registers it and reloads once it is active; later visits return at once. When the
 * browser cannot run it (no service workers, storage blocked, the reload did not take) the page shows a
 * plain explanation instead of the app and this resolves `false`.
 * `scriptUrl` and `scope` are relative to the page (`'./hub-sw.js'` for the operator at the site root,
 * `'../hub-sw.js'` and `'../'` for the output and stage windows one level down).
 */
export async function ensureDemoHub(scriptUrl: string, scope = './'): Promise<boolean> {
  if (!DEMO) return true;
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator))
      throw new Error('Service workers are not available in this browser.');
    if (navigator.serviceWorker.controller) {
      setReloadFlag(false);
      return true;
    }
    await navigator.serviceWorker.register(scriptUrl, { scope });
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) {
      setReloadFlag(false);
      return true;
    }
    // Activated but not yet controlling this page (first visit): reload under it, once.
    if (reloadFlag()) throw new Error('The demo hub is installed but does not control this page.');
    setReloadFlag(true);
    location.reload();
    return false;
  } catch (e) {
    setReloadFlag(false);
    showUnsupported(e instanceof Error ? e.message : String(e));
    return false;
  }
}

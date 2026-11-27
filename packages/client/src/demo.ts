/**
 * The GitHub Pages demo (apps/demo, docs/design/26-pages-demo.md): the operator, output and stage apps built with
 * `ORDO_DEMO=1`, with no server. A service worker at the site root (`hub-sw.js`) takes every hub request, and the
 * hub is one of two (`DemoHubMode`, chosen by the operator page in `ensureDemoHub`):
 * - 'vm': the real hub, in a Linux machine (unkernel) that the operator tab runs in a Web Worker; the service worker
 *   relays requests to it, and the apps' hub sockets reach it through `DemoSocket`. The apps behave as with a hub.
 * - 'legacy': the hub's REST API answered by the service worker itself, from bundled sample content and the
 *   visitor's IndexedDB; there is no WebSocket, so the apps never open one and go live from the browser
 *   (design/17 "Going live without the hub"). For browsers that cannot run the machine, or `?hub=legacy`.
 */
import { DemoSocket } from './demoSocket.ts';

declare const __ORDO_DEMO__: boolean | undefined;

export const DEMO: boolean = typeof __ORDO_DEMO__ !== 'undefined' && __ORDO_DEMO__ === true;

export type DemoHubMode = 'vm' | 'legacy';

let modeNow: DemoHubMode | undefined;
let modeAsk: Promise<DemoHubMode> | undefined;

/**
 * The demo's hub mode, as the service worker keeps it (it answers `api/v1/__demo/mode` itself). Windows and workers
 * alike ask it once, before they open a hub socket; outside the demo it is 'legacy' and never asked.
 */
export function demoHubMode(): Promise<DemoHubMode> {
  if (!DEMO) return Promise.resolve('legacy');
  if (modeNow) return Promise.resolve(modeNow);
  modeAsk ??= fetch(new URL('api/v1/__demo/mode', location.href))
    .then((r): Promise<{ mode?: string }> | { mode?: string } => (r.ok ? r.json() : {}))
    .then((j) => (j.mode === 'vm' ? 'vm' : 'legacy') as DemoHubMode)
    .catch(() => 'legacy' as DemoHubMode)
    .then((m) => (modeNow = m));
  return modeAsk;
}

/**
 * The demo without a hub (mode 'legacy'): no hub socket, services run in the browser. False outside the demo and with
 * the VM hub, where the apps behave as with a real hub. Read after `demoHubMode()` (or `ensureDemoHub`) settled.
 */
export function demoWithoutHub(): boolean {
  return DEMO && modeNow !== 'vm';
}

/** A hub socket: the browser's WebSocket, or in the demo with the VM hub, `DemoSocket`. */
export function openHubSocket(url: string): WebSocket {
  return DEMO && modeNow === 'vm' ? (new DemoSocket(url) as unknown as WebSocket) : new WebSocket(url);
}

/** What the demo page that runs the VM hub exposes (tests and diagnostics read it as `window.__ordoVm`). */
type VmHostHandle = {
  started: string;
  reset(): Promise<void>;
  checkpoint(force?: boolean): Promise<boolean>;
  status(): { lastWriteAt: number; checkpointAt: number; saving: boolean };
};
type VmProgress = { stage: string; text: string; frac?: number };

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
export async function ensureDemoHub(
  scriptUrl: string,
  scope = './',
  opts: { host?: boolean } = {},
): Promise<boolean> {
  if (!DEMO) return true;
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator))
      throw new Error('Service workers are not available in this browser.');
    if (navigator.serviceWorker.controller) {
      setReloadFlag(false);
      return await chooseHub(scope, !!opts.host);
    }
    await navigator.serviceWorker.register(scriptUrl, { scope });
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) {
      setReloadFlag(false);
      return await chooseHub(scope, !!opts.host);
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

/** Can this browser run the demo's VM hub (unkernel needs JSPI, workers, IndexedDB and Web Locks)? */
function vmCapable(): boolean {
  const wasm = (globalThis as { WebAssembly?: { Suspending?: unknown } }).WebAssembly;
  return (
    typeof wasm?.Suspending === 'function' &&
    typeof Worker === 'function' &&
    typeof indexedDB !== 'undefined' &&
    typeof navigator.locks?.request === 'function' &&
    typeof CompressionStream === 'function'
  );
}

/**
 * Was this site built with the VM hub? A site built without it (ORDO_VM=off: PR previews) has no vm/manifest.json,
 * and a host that answers a missing path with the app's index.html (Cloudflare Pages, a 200) must not read as one
 * that has it: the manifest must parse and be one.
 */
async function vmBuilt(root: URL): Promise<boolean> {
  try {
    const r = await fetch(new URL('vm/manifest.json', root), { cache: 'no-cache' });
    if (!r.ok) return false;
    const m = (await r.json()) as { version?: unknown; id?: unknown; snapshot?: { path?: unknown } };
    return m.version === 1 && typeof m.id === 'string' && typeof m.snapshot?.path === 'string';
  } catch {
    return false;
  }
}

/** Tell the service worker the mode and wait until it keeps it. */
async function setServiceWorkerMode(mode: DemoHubMode): Promise<void> {
  const sw = navigator.serviceWorker.controller;
  if (!sw) return;
  await new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(resolve, 3000);
    ch.port1.onmessage = () => {
      clearTimeout(timer);
      resolve();
    };
    sw.postMessage({ t: 'ordo-demo-mode', mode }, [ch.port2]);
  });
}

/** The boot screen while the operator page starts the VM hub. */
function bootScreen(): { set(p: VmProgress): void; fail(message: string): void; remove(): void } {
  const box = document.createElement('div');
  box.setAttribute('data-demo-boot', '');
  box.style.cssText =
    'position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; background: #111318; color: #e8e9ed; font: 15px/1.5 system-ui, sans-serif;';
  const inner = document.createElement('div');
  inner.style.cssText = 'width: min(26rem, 88vw);';
  const h = document.createElement('div');
  h.style.cssText = 'font-size: 1.15rem; font-weight: 600; margin-bottom: 0.4rem;';
  h.textContent = 'Starting the ordo hub in your browser';
  const line = document.createElement('div');
  line.setAttribute('data-demo-boot-text', '');
  line.style.cssText = 'opacity: 0.75; min-height: 1.5em;';
  const bar = document.createElement('div');
  bar.style.cssText =
    'height: 4px; background: #2a2e38; border-radius: 2px; margin-top: 0.8rem; overflow: hidden;';
  const fill = document.createElement('div');
  fill.style.cssText = 'height: 100%; width: 0; background: #5b8cff; transition: width 0.2s;';
  bar.append(fill);
  const note = document.createElement('div');
  note.style.cssText = 'opacity: 0.55; font-size: 0.85rem; margin-top: 1rem;';
  note.textContent =
    'The real hub runs here, in a Linux machine inside this tab. Keep this tab open while output windows are in use.';
  inner.append(h, line, bar, note);
  box.append(inner);
  document.body.append(box);
  return {
    set(p) {
      line.textContent = p.text + (p.frac !== undefined ? ` (${Math.round(p.frac * 100)} %)` : '');
      fill.style.width =
        p.frac !== undefined
          ? `${Math.round(p.frac * 100)}%`
          : p.stage === 'ready'
            ? '100%'
            : fill.style.width;
    },
    fail(message) {
      h.textContent = 'The hub could not start in this browser';
      line.textContent = message;
      const a = document.createElement('a');
      const u = new URL(location.href);
      u.searchParams.set('hub', 'legacy');
      a.href = u.href;
      a.textContent = 'Open the demo without the hub';
      a.style.cssText = 'display: inline-block; margin-top: 1rem; color: #8fb0ff;';
      inner.append(a);
    },
    remove() {
      box.remove();
    },
  };
}

/**
 * Decide the hub. A window that is not the operator (an output, the stage) asks the service worker. The operator
 * chooses: the VM hub where the browser can run it (unless `?hub=legacy`), and starts it here before the app.
 */
async function chooseHub(scope: string, host: boolean): Promise<boolean> {
  if (!host) {
    await demoHubMode();
    return true;
  }
  const params = new URLSearchParams(location.search);
  const root = new URL(scope, location.href);
  const built = await vmBuilt(root);
  const mode: DemoHubMode = params.get('hub') === 'legacy' || !built || !vmCapable() ? 'legacy' : 'vm';
  await setServiceWorkerMode(mode);
  modeNow = mode;
  if (mode === 'legacy') return true;
  const screen = bootScreen();
  try {
    const mod = (await import(/* @vite-ignore */ new URL('vm/host.js', root).href)) as {
      startVmHost(o: { root: URL; onProgress: (p: VmProgress) => void }): Promise<VmHostHandle | null>;
    };
    const vm = await mod.startVmHost({ root, onProgress: (p) => screen.set(p) });
    (window as unknown as { __ordoVm?: VmHostHandle | null }).__ordoVm = vm;
    screen.remove();
    return true;
  } catch (e) {
    console.error('[demo] the VM hub did not start', e);
    screen.fail(e instanceof Error ? e.message : String(e));
    return false;
  }
}

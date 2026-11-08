import { requestPersistence } from '@ordo/cache';
import { DEMO, ensureDemoHub } from '@ordo/client';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { StageHost } from './host.ts';
import './styles.css';

/**
 * Stage window entry (design/16). The main thread hosts: React renders the view model the supervised link
 * worker posts. `ordoStage.telemetry()` in the console for diagnostics; with `?test=1`,
 * `window.__ordo` exposes telemetry, the view and chaos hooks for the end-to-end suite.
 */
const host = new StageHost();
(globalThis as unknown as { ordoStage: StageHost }).ordoStage = host;
// The GitHub Pages demo: start once the site's demo hub service worker controls this window (apps/demo).
void ensureDemoHub('../hub-sw.js', '../').then((ok) => {
  if (ok) host.start();
});
void requestPersistence();

if (host.testMode) {
  (window as unknown as { __ordo: unknown }).__ordo = {
    telemetry: () => host.telemetry(),
    view: () => host.view(),
    chaos: host.chaos(),
  };
}

createRoot(document.getElementById('root')!).render(<App host={host} />);

// Wake Lock: keep the stage screen on; re-acquire when the page becomes visible again.
type WakeLockSentinelLike = { released: boolean; release(): Promise<void> };
let wakeLock: WakeLockSentinelLike | null = null;
async function holdWakeLock(): Promise<void> {
  const wl = (
    navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }
  ).wakeLock;
  if (!wl || document.visibilityState !== 'visible') return;
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await wl.request('screen');
  } catch {
    // Needs a visible, focused page; retried on the next visibility change or click.
  }
}
void holdWakeLock();
document.addEventListener('visibilitychange', () => void holdWakeLock());

// Fullscreen on any click or key (the operator opens the window on the stage screen).
function goFullscreen(): void {
  void holdWakeLock();
  if (document.fullscreenElement) return;
  document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => undefined);
}
window.addEventListener('click', goFullscreen);
window.addEventListener('keydown', goFullscreen);

// App shell service worker (build only; dev serves from Vite).
if (import.meta.env.PROD && 'serviceWorker' in navigator && !DEMO) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => undefined);
  });
}

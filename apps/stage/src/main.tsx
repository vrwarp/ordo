import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { StageController } from './controller.ts';
import './styles.css';

const controller = new StageController();
(globalThis as unknown as { ordoStage: StageController }).ordoStage = controller;
void controller.start();

createRoot(document.getElementById('root')!).render(<App controller={controller} />);

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
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => undefined);
  });
}

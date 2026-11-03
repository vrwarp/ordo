import { OutputApp } from './app.ts';
import './style.css';
import { type WakeSentinel, WakeLockKeeper } from './wakelock.ts';

/**
 * Output window entry. URL: `?output=<id>&token=<token>` (plus `&out=K` in path mode). Test hooks:
 * `?test=1` writes the live slide cue index into the top-left pixel; `?renderer=2d` forces the Canvas 2D
 * compositor; `?res=1280x720` overrides the render resolution.
 */

const q = new URLSearchParams(location.search);
const testMode = import.meta.env.MODE === 'test' || q.get('test') === '1';

function resolution(): { width: number; height: number } {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(q.get('res') ?? '');
  if (m) return { width: Number(m[1]), height: Number(m[2]) };
  // Render at the screen's device resolution in 16:9 (the logical canvas), capped at 4K.
  const dpr = window.devicePixelRatio || 1;
  const sw = Math.round((screen.width || window.innerWidth) * dpr);
  const sh = Math.round((screen.height || window.innerHeight) * dpr);
  let width = Math.min(3840, Math.max(320, sw));
  let height = Math.round((width * 9) / 16);
  if (height > sh && sh > 0) {
    height = Math.max(180, Math.min(2160, sh));
    width = Math.round((height * 16) / 9);
  }
  return { width: width - (width % 2), height: height - (height % 2) };
}

const { width, height } = resolution();
const canvas = document.getElementById('out') as HTMLCanvasElement;
const hold = document.getElementById('hold') as HTMLCanvasElement;
const mediaBox = document.getElementById('media') as HTMLElement;
canvas.width = width;
canvas.height = height;

const app = new OutputApp({
  canvas,
  hold,
  mediaBox,
  width,
  height,
  testMode,
  forceCanvas2d: q.get('renderer') === '2d',
});

declare global {
  interface Window {
    __ordo: { telemetry(): Record<string, unknown>; state(): Record<string, unknown>; app: OutputApp };
  }
}
window.__ordo = { telemetry: () => app.telemetry(), state: () => app.introspect(), app };

void app.start().catch((err: Error) => app.diag.showFatal('The output failed to start.', err.message));

// ---- window behaviour: fullscreen, wake lock, keys, cursor ----

async function goFullscreen(): Promise<void> {
  if (document.fullscreenElement) return;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    /* needs a user gesture or the window-management permission; retried on click/keypress */
  }
}

// Chrome releases the sentinel whenever the window is hidden or covered; the keeper watches the
// sentinel's `release` event and requests the lock again on every chance (review item 11).
const wakeApi = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<WakeSentinel> } })
  .wakeLock;
const wake = new WakeLockKeeper({
  request: wakeApi ? () => wakeApi.request('screen') : undefined,
  visible: () => document.visibilityState === 'visible',
  setInterval: (fn, ms) => setInterval(fn, ms),
  log: (m) => app.diag.log(m),
});
const keepAwake = (): Promise<void> => wake.acquire();

document.addEventListener('visibilitychange', () => void keepAwake());
document.addEventListener('fullscreenchange', () => void keepAwake());
window.addEventListener('focus', () => void keepAwake());

window.addEventListener(
  'keydown',
  (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'Q' || e.key === 'q')) {
      e.preventDefault();
      window.close();
      return;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      app.diag.toggle();
      return;
    }
    // Every other key is ignored, but counts as a gesture for fullscreen and audio.
    e.preventDefault();
    void goFullscreen();
    app.onGesture();
  },
  true,
);
window.addEventListener('pointerdown', () => {
  void goFullscreen();
  app.onGesture();
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

void goFullscreen();
void keepAwake();

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !import.meta.env.DEV) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((err: Error) => {
    console.warn('[ordo] service worker registration failed', err);
  });
}

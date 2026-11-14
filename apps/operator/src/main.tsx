import { DEMO, ensureDemoHub } from '@ordo/client';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { deviceProfile } from './lib/capabilities.ts';
import { applyLayout, startLayout, thisIsPhone } from './lib/layout.ts';
import { preloadFor } from './pages.ts';
import { installGlobalErrorLog } from './services/log.ts';
import './styles.css';
import './ipad.css';

installGlobalErrorLog();
// The layout class before the session (design/28 §3.1): the sign-in screen is compact from the first paint on
// a phone; the venue PC's document gains nothing (regular removes the attribute).
const layout = startLayout();
applyLayout(layout);
// The pages this device can open, loaded in parallel with the session request (src/pages.ts): every regular page
// (and the operate services on the full profile) on a regular device, so the venue PC's live view and editor open
// as fast as before; nothing of the regular set on a phone or the compact layout.
preloadFor(layout, deviceProfile('operate'), thisIsPhone());

if (DEMO) {
  // The GitHub Pages demo: the hub is a service worker at the site root (apps/demo).
  void ensureDemoHub('./hub-sw.js').then((ok) => {
    if (ok) createRoot(document.getElementById('root')!).render(<App />);
  });
} else {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }
  createRoot(document.getElementById('root')!).render(<App />);
}

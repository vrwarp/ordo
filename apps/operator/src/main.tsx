import { DEMO, ensureDemoHub } from '@ordo/client';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { deviceProfile } from './lib/capabilities.ts';
import { applyLayout, startLayout, thisIsPhone } from './lib/layout.ts';
import { preloadFor } from './pages.ts';
import { installGlobalErrorLog } from './services/log.ts';
import { browserSwEnv, registerServiceWorker } from './sw/register.ts';
import './styles.css';
import './ipad.css';
import './pro-ui.css';
// The compact layout's rules, every one under html[data-layout="compact"] (inert on the venue PC and the iPad).
import './compact.css';

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
  // The GitHub Pages demo: the hub sits behind a service worker at the site root (apps/demo); this page starts it.
  void ensureDemoHub('./hub-sw.js', './', { host: true }).then((ok) => {
    if (ok) createRoot(document.getElementById('root')!).render(<App />);
  });
} else {
  // The precache set by device class, once (src/sw/register.ts): a phone's after load and idle, every other
  // device's at once, as before.
  if ('serviceWorker' in navigator && import.meta.env.PROD)
    registerServiceWorker(browserSwEnv(thisIsPhone()));
  createRoot(document.getElementById('root')!).render(<App />);
}

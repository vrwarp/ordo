import { DEMO, ensureDemoHub } from '@ordo/client';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { installGlobalErrorLog } from './services/log.ts';
import './styles.css';
import './ipad.css';

installGlobalErrorLog();

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

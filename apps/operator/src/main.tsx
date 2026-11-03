import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { installGlobalErrorLog } from './services/log.ts';
import './styles.css';

installGlobalErrorLog();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}

createRoot(document.getElementById('root')!).render(<App />);

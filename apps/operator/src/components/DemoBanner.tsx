import { DEMO } from '@ordo/client';
import { confirmDialog } from './Confirm.tsx';

/** Forget everything this browser stored for the demo (the demo hub re-seeds on the next request). */
async function resetDemo(): Promise<void> {
  if (
    !(await confirmDialog(
      'Reset the demo',
      'Remove your songs, playlists, imports and settings from this browser and start again from the sample service?',
      'Reset',
      true,
    ))
  )
    return;
  try {
    await fetch('/api/v1/demo/reset', { method: 'POST' });
  } catch {
    /* the service worker may be gone: clear below anyway */
  }
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise<void>((done) => {
            if (!d.name) return done();
            const r = indexedDB.deleteDatabase(d.name);
            r.onsuccess = r.onerror = r.onblocked = () => done();
          }),
      ),
    );
    for (const k of await caches.keys()) await caches.delete(k);
    localStorage.clear();
    sessionStorage.clear();
  } finally {
    location.reload();
  }
}

/**
 * The GitHub Pages demo (apps/demo): say what this is, once, at the top of every page. Nothing leaves the
 * browser; Launch outputs opens the screens as windows on this computer.
 */
export function DemoBanner() {
  if (!DEMO) return null;
  return (
    <div className="demo-banner" data-demo-banner>
      <span>
        <b>ordo demo.</b> Everything runs in this browser and stays in it: import a ProPresenter song or
        playlist, edit the sample service, press Go live and Launch outputs.
      </span>
      <a href="https://github.com/vrwarp/ordo" target="_blank" rel="noreferrer">
        Source
      </a>
      <button type="button" className="small" onClick={() => void resetDemo()}>
        Reset demo
      </button>
    </div>
  );
}

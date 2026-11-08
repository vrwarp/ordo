import { APP_VERSION } from '@ordo/protocol';
import { retryUpdate, useUpdate } from '../services/update.ts';

/** Shown while the hub told this tab its version is stale and the reload is about to happen. */
export function UpdatingOverlay() {
  const u = useUpdate();
  if (u.phase !== 'updating') return null;
  return (
    <div className="backdrop" style={{ zIndex: 300 }} role="status">
      <div className="card col" style={{ width: 380, alignItems: 'center', textAlign: 'center' }}>
        <h2>Updating…</h2>
        <span>The hub runs a newer version of ordo. Reloading this page to match it.</span>
        <span className="muted small">
          Attempt {u.attempt} of {u.cap}
        </span>
      </div>
    </div>
  );
}

/** Shown on load after the reload cap was reached: no hub connection is started, so nothing loops. */
export function UpdateFailedScreen() {
  const u = useUpdate();
  return (
    <div className="center">
      <div className="card col" style={{ width: 440 }}>
        <h2>Could not update ordo</h2>
        <div className="banner red">
          This page (version {APP_VERSION}) still does not match the hub after {u.attempt} reloads. The new
          version did not install.
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Check that the hub finished its own update, then try again. If it keeps failing, clear this site's
          data in Chrome (Settings → Privacy → Site settings) or ask whoever deployed the hub.
        </p>
        <button type="button" className="primary big" onClick={() => void retryUpdate()}>
          Try again
        </button>
      </div>
    </div>
  );
}

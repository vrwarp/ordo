import { useState } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { controller } from '../../services/controller.ts';
import { outputWindows, useLaunch } from '../../services/outputs.ts';
import { useLive } from '../../state/live.ts';

/** Outputs whose remembered screen was not found: pick a screen for each. */
export function PlacementDialog() {
  const { unmatched, screens } = useLaunch();
  const [choice, setChoice] = useState<Record<string, number>>({});
  if (!unmatched.length) return null;
  return (
    <Dialog
      title="Place outputs on screens"
      onClose={() => useLaunch.setState({ unmatched: [] })}
      footer={
        <button type="button" onClick={() => useLaunch.setState({ unmatched: [] })}>
          Leave on the main screen
        </button>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        These outputs opened on the main screen because their screen was not found. Choose where each one
        belongs; ordo remembers it.
      </p>
      <table className="list">
        <tbody>
          {unmatched.map((p) => (
            <tr key={p.output.id}>
              <td>
                <b>{p.output.name}</b>
              </td>
              <td>
                <select
                  value={choice[p.output.id] ?? -1}
                  onChange={(e) => setChoice({ ...choice, [p.output.id]: Number(e.target.value) })}
                >
                  <option value={-1}>Choose a screen…</option>
                  {screens.map((s, i) => (
                    <option key={`${s.label}-${s.left}-${s.top}`} value={i}>
                      {s.label || 'Screen'} — {s.width}×{s.height} at {s.left},{s.top}
                      {s.isPrimary ? ' (main)' : ''}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <button
                  type="button"
                  className="primary small"
                  disabled={(choice[p.output.id] ?? -1) < 0}
                  onClick={() => {
                    const s = screens[choice[p.output.id]!];
                    if (s) void outputWindows()?.place(p.output, s);
                  }}
                >
                  Place
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

export function ConflictDialog() {
  const conflict = useLive((s) => s.conflict);
  if (!conflict) return null;
  return (
    <Dialog title="The hub is back with a different service">
      <p style={{ marginTop: 0 }}>
        While the hub was unreachable this PC ran <b>{conflict.localPlaylist ?? 'the service'}</b>. The hub
        now has <b>{conflict.hubPlaylist ?? 'another playlist'}</b> live (someone went live elsewhere).
      </p>
      <p>Which one should the outputs show?</p>
      <div className="row">
        <button type="button" className="primary big" onClick={() => controller()?.resolveConflict('local')}>
          Keep this PC's service
        </button>
        <button type="button" className="big" onClick={() => controller()?.resolveConflict('hub')}>
          Take the hub's service
        </button>
      </div>
    </Dialog>
  );
}

export function GoLiveErrorDialog() {
  const err = useLive((s) => s.goLiveError);
  if (!err) return null;
  const close = () => useLive.setState({ goLiveError: undefined });
  return (
    <Dialog
      title="Could not go live"
      onClose={close}
      footer={
        <button type="button" onClick={close}>
          OK
        </button>
      }
    >
      <div className="banner red" style={{ whiteSpace: 'pre-line' }}>
        {err}
      </div>
      <p className="muted">
        Fix the items above (for example wait for media to finish processing) and try again.
      </p>
    </Dialog>
  );
}

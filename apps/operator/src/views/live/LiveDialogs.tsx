import { useState } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { primaryScreen, type ScreenInfo, toScreenRef } from '../../lib/screens.ts';
import { controller } from '../../services/controller.ts';
import { log } from '../../services/log.ts';
import { outputWindows, useLaunch } from '../../services/outputs.ts';
import { saveSettings, settings } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';

/** "Leave on the main screen": remember the primary screen for the unmatched outputs so Launch stops asking. */
async function keepOnMainScreen(ids: string[], screens: ScreenInfo[]): Promise<void> {
  useLaunch.setState({ unmatched: [] });
  const primary = primaryScreen(screens);
  if (!primary || !ids.length) return;
  const ref = toScreenRef(primary);
  const set = new Set(ids);
  await saveSettings(
    'outputs',
    settings().outputs.map((o) => (set.has(o.id) ? { ...o, screen: ref } : o)),
  ).catch((e) => log('warn', `saving placements: ${String(e)}`));
}

/**
 * Outputs whose remembered screen was not found on a multi-screen PC: pick a screen for each. With one
 * screen there is nothing to choose and the launch plan already saved it (review item 9).
 */
export function PlacementDialog() {
  const { unmatched, screens } = useLaunch();
  const [choice, setChoice] = useState<Record<string, number>>({});
  if (!unmatched.length || screens.length <= 1) return null;
  const leave = () =>
    void keepOnMainScreen(
      unmatched.map((p) => p.output.id),
      screens,
    );
  return (
    <Dialog
      title="Place outputs on screens"
      onClose={leave}
      footer={
        <button type="button" onClick={leave}>
          Leave on the main screen
        </button>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        These outputs opened on the main screen because their screen was not found. Choose where each one
        belongs; ordo remembers it. "Leave on the main screen" remembers that instead.
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

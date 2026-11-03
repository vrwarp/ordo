import { API_PREFIX } from '@ordo/protocol';
import { useEffect, useState } from 'react';
import { keyed } from '../../lib/keys.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { outputDot } from '../../lib/health.ts';
import { APP_VERSION, controller } from '../../services/controller.ts';
import { logLines, onLog } from '../../services/log.ts';
import { outputWindows, useLaunch } from '../../services/outputs.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { toast } from '../../state/toasts.ts';
import { setUi, useUi } from '../../state/ui.ts';

export function downloadOperatorLog(): void {
  const live = useLive.getState();
  const data = {
    app: 'operator',
    version: APP_VERSION,
    at: new Date().toISOString(),
    authority: live.authority,
    hubConnected: live.hubConnected,
    seq: live.state.seq,
    mode: live.state.mode,
    health: live.health,
    ownCache: live.ownCache,
    cacheCheck: live.cacheCheck,
    log: logLines(),
    /** Last log lines of every output and stage window, as reported in health (prd/08). */
    outputLogs: Object.fromEntries(
      Object.values(live.health).map((h) => [h.name ?? h.outputId, h.recentLog ?? []]),
    ),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ordo-operator-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function HealthTable() {
  const health = useLive((s) => s.health);
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const open = useLaunch((s) => s.open);
  return (
    <table className="list">
      <thead>
        <tr>
          <th />
          <th>Output</th>
          <th>Window</th>
          <th>Bus</th>
          <th>Frames</th>
          <th>Missed</th>
          <th>Long tasks</th>
          <th>Late flips</th>
          <th>Video dropped</th>
          <th>GPU lost</th>
          <th>Cache</th>
          <th>Armed / live</th>
          <th>Audio</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        {outputs.map((o) => {
          const h = health[o.id];
          return (
            <tr key={o.id}>
              <td>
                <span className={`dot sm ${outputDot(h)}`} />
              </td>
              <td>{o.name}</td>
              <td>{open[o.id] ? 'open' : '—'}</td>
              <td>{h?.connected ? (h.bus ?? 'hub') : 'offline'}</td>
              <td>{h?.presented ?? '—'}</td>
              <td>{h?.missed ?? '—'}</td>
              <td>{h?.longTasks ?? '—'}</td>
              <td>{h?.lateFlips ?? '—'}</td>
              <td>{h?.videoDropped ?? '—'}</td>
              <td>{h?.gpuLost ?? '—'}</td>
              <td>{h ? `${h.cache.ready}/${h.cache.total}` : '—'}</td>
              <td>
                {h?.armed ?? '—'}
                {h?.armedOk === false ? ' ✕' : ''} / {h?.live ?? '—'}
              </td>
              <td>{h?.audio ?? '—'}</td>
              <td className="small" style={{ color: 'var(--red)' }}>
                {h?.error ?? h?.armError ?? ''}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function OperatorLog({ limit = 50 }: { limit?: number }) {
  const [, setN] = useState(0);
  useEffect(() => onLog(() => setN((x) => x + 1)), []);
  const lines = logLines().slice(-limit);
  return (
    <div className="logbox">
      {lines.length === 0 && <span className="muted">No log lines yet.</span>}
      {keyed(lines, (l) => `${l.at}`).map(({ key, value: l }) => (
        <div
          key={key}
          style={{ color: l.level === 'error' ? '#fca5a5' : l.level === 'warn' ? '#fcd34d' : undefined }}
        >
          {new Date(l.at).toLocaleTimeString()} {l.text}
        </div>
      ))}
    </div>
  );
}

/** The last log lines of each output and stage window, from their health reports (prd/08). */
export function OutputLogs() {
  const health = useLive((s) => s.health);
  const outputs = useLibrary((s) => s.data.settings.outputs);
  return (
    <div className="col" style={{ gap: 8 }}>
      {outputs.map((o) => {
        const h = health[o.id];
        const lines = h?.recentLog ?? [];
        return (
          <div key={o.id} className="col" style={{ gap: 4 }}>
            <span className="small">
              <b>{o.name}</b>{' '}
              <span className="muted">
                {h?.connected ? `${lines.length} lines` : 'not connected'}
                {h?.compositor ? `, ${h.compositor} compositor` : ''}
                {h?.mainThreadStallMs !== undefined && h.mainThreadStallMs > 250
                  ? `, main thread stalled ${Math.round(h.mainThreadStallMs)} ms`
                  : ''}
              </span>
            </span>
            {lines.length > 0 && (
              <div className="logbox" style={{ maxHeight: 140 }}>
                {keyed(lines, (l) => l).map(({ key, value }) => (
                  <div key={key}>{value}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {outputs.length === 0 && <span className="muted">No outputs configured.</span>}
    </div>
  );
}

export function DiagnosticsPanel() {
  const show = useUi((s) => s.showDiagnostics);
  const live = useLive();
  if (!show) return null;
  const ctl = controller();
  return (
    <Dialog title="Diagnostics" onClose={() => setUi({ showDiagnostics: false })} width={1100}>
      <div className="col" style={{ gap: 14 }}>
        <div className="row wrap">
          <span className="tag">seq {live.state.seq}</span>
          <span className="tag">authority {live.authority}</span>
          <span className="tag">hub {live.hubConnected ? 'connected' : 'disconnected'}</span>
          <span className="tag">
            clock offset {live.clock.offset.toFixed(0)} ms, rtt {live.clock.rtt.toFixed(0)} ms
          </span>
          <span className="tag">
            operator cache {live.ownCache.ready}/{live.ownCache.total}
            {live.ownCache.failed ? `, ${live.ownCache.failed} failed` : ''}
          </span>
        </div>
        <HealthTable />
        {live.cacheCheck && (
          <div className={`banner ${live.cacheCheck.message ? '' : 'blue'}`}>
            {live.cacheCheck.message ?? 'Service cache complete on every output'} (checked{' '}
            {new Date(live.cacheCheck.at).toLocaleTimeString()})
          </div>
        )}
        <h4>Output window logs</h4>
        <OutputLogs />
        <h4>Operator log (last 50 lines)</h4>
        <OperatorLog />
        <div className="row wrap">
          <a className="btn" href={`${API_PREFIX}/diagnostics/export`} download>
            Download hub diagnostics (zip)
          </a>
          <button type="button" onClick={downloadOperatorLog}>
            Download operator log
          </button>
          <button
            type="button"
            onClick={() => {
              const n = outputWindows()?.reacquire() ?? 0;
              toast(`Re-acquired ${n} output window${n === 1 ? '' : 's'}.`);
            }}
          >
            Re-acquire output windows
          </button>
          <button type="button" onClick={() => ctl?.hub.send({ t: 'live.resync' })}>
            Resync live state
          </button>
        </div>
      </div>
    </Dialog>
  );
}

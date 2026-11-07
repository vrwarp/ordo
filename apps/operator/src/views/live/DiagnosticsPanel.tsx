import { API_PREFIX } from '@ordo/protocol';
import { useEffect, useState } from 'react';
import { keyed } from '../../lib/keys.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { BUDGET_INFO, type BudgetKind } from '../../lib/budgets.ts';
import { outputDot, outputIssues, rasterText } from '../../lib/health.ts';
import { APP_VERSION, controller } from '../../services/controller.ts';
import { logLines, onLog } from '../../services/log.ts';
import { outputWindows, useLaunch } from '../../services/outputs.ts';
import { runRedAction } from '../../services/redState.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { toast } from '../../state/toasts.ts';
import { setUi, useUi } from '../../state/ui.ts';

/**
 * A healthy window reports its 250 ms watchdog tick as about 250 ms (plus timer jitter); only gaps well beyond
 * one tick are a stall worth showing.
 */
const STALL_REPORT_MS = 400;

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
    workers: live.workers,
    budgets: [...live.mainBudgets, ...live.coreBudgets],
    core: live.core,
    unacknowledged: live.unacknowledged,
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

/**
 * Performance and fonts per output (design/27 §13, M7): what the asset worker takes to draw a slide, what
 * the render worker takes to upload one, the GPU memory its textures hold, each against the budget for the
 * output's size, and the fonts and characters it could not draw as asked. Each issue reads in plain words;
 * the figures are in its detail (hover, or below it).
 */
export function PerformanceTable() {
  const health = useLive((s) => s.health);
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const over = (on: boolean | undefined) => (on ? { color: 'var(--amber)' } : undefined);
  return (
    <table className="list" data-performance>
      <thead>
        <tr>
          <th>Output</th>
          <th title="Asset worker, last slides drawn: p50 / p95">Slide drawing</th>
          <th title="Render worker, longest frame of strip uploads in the last minute (CPU time)">
            Upload per frame
          </th>
          <th title="Layer and scene textures: fixed by the output's size, and a scene's over textures">
            GPU memory
          </th>
          <th>Fonts</th>
          <th>What to look at</th>
        </tr>
      </thead>
      <tbody>
        {outputs.map((o) => {
          const h = health[o.id];
          const b = h?.budgets;
          const alarms = new Set(h?.alarms ?? []);
          const issues = outputIssues(h);
          const fonts = [
            h?.fontFallbacks?.length ? `missing ${h.fontFallbacks.join(', ')}` : '',
            h?.fontCoverage?.count ? `${h.fontCoverage.count} character(s) without a font` : '',
          ].filter(Boolean);
          return (
            <tr key={o.id} data-performance-output={o.id}>
              <td>{o.name}</td>
              <td style={over(alarms.has('raster'))}>
                {rasterText(h)}
                {b ? <span className="muted"> (p95 ≤ {b.rasterP95Ms} ms)</span> : null}
              </td>
              <td style={over(alarms.has('upload'))}>
                {h?.uploadMs !== undefined ? `${h.uploadMs} ms` : h?.compositor === '2d' ? 'none (2D)' : '—'}
                {b && h?.uploadMs !== undefined ? <span className="muted"> (≤ {b.uploadMs} ms)</span> : null}
                {h?.wholeUploads?.count ? (
                  <div
                    className="muted small"
                    title="Content on screen uploaded at once by design (a slide drawn again, recovery after a GPU reset)"
                  >
                    whole: {h.wholeUploads.count}×, up to {h.wholeUploads.maxMs} ms
                  </div>
                ) : null}
              </td>
              <td>
                {h?.gpuMB !== undefined ? `${h.gpuMB} MB` : h?.compositor === '2d' ? 'none (2D)' : '—'}
                {b && h?.gpuMB !== undefined ? <span className="muted"> (≤ {b.gpuMB} MB)</span> : null}
              </td>
              <td className="small" title={h?.fontCoverage ? [...h.fontCoverage.chars].join(' ') : undefined}>
                {fonts.length ? fonts.join('; ') : h?.connected ? 'ok' : '—'}
              </td>
              <td className="small">
                {issues.length === 0
                  ? ''
                  : issues.map((i) => (
                      <div key={i.id} data-issue={i.id} data-level={i.level} title={i.detail}>
                        {i.level === 'warn' ? <b>{i.label}</b> : <span>{i.label}</span>}
                        <div className="muted">{i.detail}</div>
                      </div>
                    ))}
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
                {h?.gpuMB !== undefined ? `, ${h.gpuMB} MB GPU` : ''}
                {h?.mainThreadStallMs !== undefined && h.mainThreadStallMs > STALL_REPORT_MS
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

/**
 * Isolation and supervision (design/25): the operator's own workers, the core's view of the main thread,
 * the fallback-bus channel per window, and every window's supervised workers and quarantined items.
 */
export function IsolationPanel() {
  const live = useLive();
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const core = live.core;
  const budgets = [...live.mainBudgets, ...live.coreBudgets];
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row wrap">
        <span className={`tag ${live.recovering ? 'amber' : ''}`}>
          core {live.coreGaveUp ? 'stopped' : live.recovering ? 'recovering' : 'running'}
          {core ? `, generation ${core.generation}` : ''}
        </span>
        <span className={`tag ${(core?.mainThreadStallMaxMs ?? 0) >= 1000 ? 'amber' : ''}`}>
          main thread stall {Math.round(core?.mainThreadStallMs ?? 0)} ms, peak{' '}
          {Math.round(core?.mainThreadStallMaxMs ?? 0)} ms (last minute)
        </span>
        <span className={`tag ${live.unacknowledged ? 'amber' : ''}`}>
          {live.unacknowledged} action{live.unacknowledged === 1 ? '' : 's'} awaiting the core
        </span>
        {!!core?.persistFailures && (
          <span className="tag red">{core.persistFailures} state saves failed</span>
        )}
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Window</th>
            <th>Worker</th>
            <th>Generation</th>
            <th>Restarts</th>
            <th>Heartbeat</th>
            <th>Last restart reason</th>
          </tr>
        </thead>
        <tbody>
          {live.workers.map((w) => (
            <tr key={`op-${w.name}`}>
              <td>Operator</td>
              <td>{w.name}</td>
              <td>{w.generation}</td>
              <td>{w.restarts}</td>
              <td style={{ color: w.gaveUp ? 'var(--red)' : undefined }}>
                {w.gaveUp ? 'stopped' : `${Math.round(w.sinceHeartbeatMs)} ms ago`}
              </td>
              <td className="small">{w.lastReason ?? ''}</td>
            </tr>
          ))}
          {outputs.flatMap((o) =>
            (live.health[o.id]?.workers ?? []).map((w) => (
              <tr key={`${o.id}-${w.name}`}>
                <td>{o.name}</td>
                <td>{w.name}</td>
                <td>{w.generation}</td>
                <td>{w.restarts}</td>
                <td style={{ color: w.gaveUp ? 'var(--red)' : undefined }}>{w.gaveUp ? 'stopped' : 'ok'}</td>
                <td className="small">{w.lastReason ?? ''}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      <table className="list">
        <thead>
          <tr>
            <th>Window</th>
            <th>Fallback bus</th>
            <th>Last heard</th>
            <th>Main thread stall</th>
            <th>Quarantined</th>
          </tr>
        </thead>
        <tbody>
          {outputs.map((o) => {
            const ep = core?.endpoints[o.id];
            const h = live.health[o.id];
            return (
              <tr key={o.id}>
                <td>{o.name}</td>
                <td>
                  {ep
                    ? `${ep.active === 'port' ? 'direct port' : ep.active === 'window' ? 'window relay' : ep.active}${ep.ready ? ', on bus' : ''}`
                    : 'no window'}
                </td>
                <td>
                  {ep ? (ep.sinceRxMs < 0 ? 'never' : `${Math.round(ep.sinceRxMs / 1000)} s ago`) : '—'}
                </td>
                <td>{h?.mainThreadStallMs !== undefined ? `${Math.round(h.mainThreadStallMs)} ms` : '—'}</td>
                <td className="small" title={h?.quarantined?.items.join('\n')}>
                  {h?.quarantined?.count
                    ? `${h.quarantined.count}: ${h.quarantined.items.slice(0, 3).join(', ')}`
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <table className="list">
        <thead>
          <tr>
            <th>Error budget</th>
            <th>Count</th>
            <th>Limit</th>
            <th>Last</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {budgets.map((b) => {
            const info = BUDGET_INFO[b.kind as BudgetKind];
            return (
              <tr key={b.kind} style={{ color: b.exceeded ? 'var(--red)' : undefined }}>
                <td>{info?.label ?? b.kind}</td>
                <td>{b.count}</td>
                <td>
                  {b.max} per {Math.round(b.windowMs / 60_000)} min
                </td>
                <td className="small">{b.last ?? ''}</td>
                <td>
                  {b.exceeded && info && (
                    <button
                      type="button"
                      className="small"
                      onClick={() => runRedAction({ kind: b.kind as BudgetKind, info })}
                    >
                      {info.actionLabel}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
        <h4>Performance and fonts</h4>
        <PerformanceTable />
        {live.cacheCheck && (
          <div className={`banner ${live.cacheCheck.message ? '' : 'blue'}`}>
            {live.cacheCheck.message ?? 'Service cache complete on every output'} (checked{' '}
            {new Date(live.cacheCheck.at).toLocaleTimeString()})
          </div>
        )}
        <h4>Isolation and supervision</h4>
        <IsolationPanel />
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
          <button type="button" onClick={() => ctl?.resync()}>
            Resync live state
          </button>
        </div>
      </div>
    </Dialog>
  );
}

import { formatClock } from '@ordo/domain';
import { useEffect, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { cacheSummary, dotTitle, outputDot } from '../../lib/health.ts';
import { useHubNow } from '../../hooks.ts';
import { controller, dispatch } from '../../services/controller.ts';
import { useLaunch } from '../../services/outputs.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { setUi } from '../../state/ui.ts';

function useOnline(): boolean {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true);
    const b = () => setOn(false);
    window.addEventListener('online', a);
    window.addEventListener('offline', b);
    return () => {
      window.removeEventListener('online', a);
      window.removeEventListener('offline', b);
    };
  }, []);
  return on;
}

export function TopBar() {
  const now = useHubNow(1000);
  const general = useLibrary((s) => s.data.settings.general);
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const live = useLive();
  const launch = useLaunch();
  const online = useOnline();
  const s = live.state;
  const isLive = s.mode === 'live';
  const fallback = live.authority === 'fallback';
  const hubDot = fallback ? 'amber' : live.hubConnected ? 'green' : 'red';
  const hubText = fallback
    ? live.reconcile === 'adopting'
      ? 'Hub back: handing over…'
      : 'Hub lost: running from this PC'
    : live.hubConnected
      ? 'Hub'
      : live.everConnected
        ? 'Hub reconnecting…'
        : 'Connecting…';
  const entries = Object.values(live.health);
  const cache = cacheSummary(entries, live.ownCache.total ? live.ownCache : undefined);
  const cacheDot = !isLive ? 'grey' : cache.frac >= 1 ? 'green' : 'amber';
  const tone = fallback || (isLive && !live.hubConnected) ? 'amber' : '';
  return (
    <div className={`topbar ${tone}`}>
      <div className="col" style={{ gap: 0, minWidth: 160 }}>
        <span className="muted small">{isLive ? 'LIVE' : 'Not live'}</span>
        <b className="ellipsis" style={{ maxWidth: 240 }}>
          {s.resolved?.playlist.name ?? '—'}
        </b>
      </div>
      <span className="stat" title={hubText}>
        <span className={`dot ${hubDot}`} /> {hubText}
      </span>
      <span className="stat" title="Internet connection of this PC">
        <span className={`dot ${online ? 'green' : 'amber'}`} /> WAN
      </span>
      <span className="stat" title={`Service cache ${cache.ready}/${cache.total}`}>
        <span className={`dot ${cacheDot}`} /> Cache {isLive ? `${Math.floor(cache.frac * 100)}%` : ''}
      </span>
      <span className="stat">
        {outputs
          .filter((o) => o.enabled)
          .map((o) => {
            const h = live.health[o.id];
            const d = outputDot(h);
            return (
              <span key={o.id} className="row" style={{ gap: 4 }} title={dotTitle(h, o.name)}>
                <span className={`dot ${d}`} />
                <span className="small">{o.name}</span>
              </span>
            );
          })}
      </span>
      {live.pending > 0 && !fallback && <span className="tag amber">{live.pending} pending</span>}
      <span className="spacer" />
      <span className="clock">{formatClock(now, general.timeZone, general.clock24h)}</span>
      <button type="button" className="big" disabled={launch.busy} onClick={() => dispatch({ id: 'launchOutputs' })} title="Ctrl+Shift+L">
        Launch outputs
      </button>
      <button type="button" className="big" disabled={launch.busy} onClick={() => dispatch({ id: 'relaunchOutputs' })} title="Ctrl+Shift+R">
        Relaunch
      </button>
      {isLive && (
        <button
          type="button"
          className="danger big"
          onClick={async () => {
            if (await confirmDialog('End service', 'Clear every output and unlock the playlist for editing?', 'End service', true))
              controller()?.endService();
          }}
        >
          End service
        </button>
      )}
      <button type="button" className="ghost" onClick={() => setUi({ showDiagnostics: true })} title="Diagnostics">
        ⚙
      </button>
    </div>
  );
}

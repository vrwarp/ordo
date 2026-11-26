import { DEMO } from '@ordo/client';
import { formatClock } from '@ordo/domain';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { confirmDialog } from '../../components/Confirm.tsx';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { Icon } from '../../components/Icons.tsx';
import { usePopupOf } from '../../components/popupOf.ts';
import { useHubNow } from '../../hooks.ts';
import { cacheSummary, dotTitle, outputDot, outputIssues } from '../../lib/health.ts';
import { hubStatus } from '../../lib/hubStatus.ts';
import { controller, dispatch } from '../../services/controller.ts';
import { useLaunch } from '../../services/outputs.ts';
import { missingHandles, reacquireMissing } from '../../services/reacquire.ts';
import { currentRedState, runRedAction } from '../../services/redState.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { toast } from '../../state/toasts.ts';
import { setUi } from '../../state/ui.ts';
import { navigate } from '../../useRoute.ts';

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

export function TopBar({ inline = false }: { inline?: boolean }) {
  const now = useHubNow(1000);
  const general = useLibrary((s) => s.data.settings.general);
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const live = useLive();
  const launch = useLaunch();
  const online = useOnline();
  const [slot, setSlot] = useState<HTMLElement | null>(() =>
    inline && typeof document !== 'undefined' ? document.getElementById('nav-live-slot') : null,
  );
  const [popOpen, setPopOpen] = useState(false);
  const lampRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  usePopupOf(popRef, lampRef, popOpen, () => setPopOpen(false));

  useLayoutEffect(() => {
    if (!inline) {
      setSlot(null);
      return;
    }
    setSlot(document.getElementById('nav-live-slot'));
  }, [inline]);

  useLayoutEffect(() => {
    if (!popOpen || !lampRef.current || !popRef.current) return;
    const place = () => {
      if (!lampRef.current || !popRef.current) return;
      const tr = lampRef.current.getBoundingClientRect();
      const pr = popRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(tr.right - pr.width, window.innerWidth - pr.width - 8));
      const top = Math.max(8, Math.min(tr.bottom + 6, window.innerHeight - pr.height - 8));
      setPos({ left: Math.round(left), top: Math.round(top) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [popOpen]);

  useEffect(() => {
    if (!popOpen) return;
    const onOutside = (e: Event) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (!lampRef.current?.contains(target) && !popRef.current?.contains(target)) setPopOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setPopOpen(false);
        lampRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [popOpen]);

  const s = live.state;
  const isLive = s.mode === 'live';
  const status = hubStatus(live);
  const { fallback } = status;
  // The GitHub Pages demo has no hub by design: say so instead of "Connecting…".
  const hubDot = DEMO ? (live.held ? 'amber' : 'green') : status.dot;
  const hubText = DEMO
    ? live.held
      ? 'Demo: live in this browser'
      : 'Demo: runs in this browser'
    : status.text;
  const entries = Object.values(live.health);
  const cache = cacheSummary(entries, live.ownCache.total ? live.ownCache : undefined);
  const cacheDot = !isLive ? 'grey' : cache.frac >= 1 ? 'green' : 'amber';
  const tone = fallback || (isLive && !live.hubConnected) ? 'amber' : '';
  // Fallback link: windows this tab holds a handle for, out of the output windows known to exist
  // (held, or reported connected by the hub). Without a handle the fallback bus cannot reach a window.
  const enabled = outputs.filter((o) => o.enabled);
  const held = enabled.filter((o) => launch.open[o.id]).length;
  const known = enabled.filter((o) => launch.open[o.id] || live.health[o.id]?.connected).length;
  const linkMissing = isLive && held < known;
  // Performance alarms on the screens, in plain words; the diagnostics view has the figures, and the fonts
  // (nothing a volunteer can do during the service: notes for the tech, not here).
  const notes = enabled.flatMap((o) =>
    outputIssues(live.health[o.id])
      .filter((i) => i.level === 'warn')
      .map((i) => `${o.name}: ${i.label}`),
  );
  const red = currentRedState(live);
  // Peak main-thread stall of the last minute as the core worker saw it (250 ms watchdog tick; design/25).
  const stall = live.core?.mainThreadStallMaxMs ?? 0;
  const onFallbackLink = async () => {
    const n = await reacquireMissing(true);
    const still = missingHandles(Date.now(), true).ids.length;
    if (still)
      toast(
        `${still} output window${still === 1 ? '' : 's'} could not be reached from this tab: opened by another operator tab or another computer. Use Relaunch to take ${still === 1 ? 'it' : 'them'} over.`,
        'warn',
        10_000,
      );
    else if (n) toast(`Re-acquired ${n} output window${n === 1 ? '' : 's'}: the fallback link is back.`);
  };

  const endService = async () => {
    if (
      await confirmDialog(
        'End service',
        'Clear every output and unlock the playlist for editing?',
        'End service',
        true,
      )
    )
      controller()?.endService();
  };

  const urgentBadges = (
    <>
      {notes.length > 0 && (
        <button
          type="button"
          className="tag amber"
          data-output-notes={notes.length}
          onClick={() => setUi({ showDiagnostics: true })}
          title={`${notes.join('\n')}\n\nClick for the details.`}
        >
          {notes.length === 1 ? '1 screen check' : `${notes.length} screen checks`}
        </button>
      )}
      {live.pending > 0 && !fallback && <span className="tag amber">{live.pending} pending</span>}
      {live.recovering && (
        <span
          className="tag amber"
          data-recovering
          title="The operator core is restarting. Keys and Stream Deck presses are kept and sent when it is back (about a second)."
        >
          Recovering…
        </span>
      )}
      {red && (
        <button
          type="button"
          className="tag red"
          data-red-state={red.kind ?? 'core'}
          onClick={() => runRedAction(red)}
          title={red.detail ? `Last: ${red.detail}` : red.info.label}
        >
          {red.info.label} — {red.info.actionLabel}
        </button>
      )}
      {stall >= 1000 && (
        <span
          className="tag amber"
          title="The operator page was busy (peak in the last minute); the hub link, the fallback bus and the outputs were not affected. Use the Stream Deck if keys feel late."
        >
          UI stalled {(stall / 1000).toFixed(1)} s
        </span>
      )}
      {linkMissing && (
        <button
          type="button"
          className="tag amber"
          data-fallback-link
          onClick={onFallbackLink}
          title="This tab holds no handle for some output windows, so it could not drive them if the hub were lost. Click to re-acquire them, or use Relaunch."
        >
          fallback link {held}/{known}
        </button>
      )}
    </>
  );

  if (inline && slot) {
    const telemetryPopover = popOpen ? (
      <div
        ref={popRef}
        className="output-telemetry-popover"
        role="dialog"
        aria-label="Output telemetry"
        style={{ position: 'fixed', left: pos.left, top: pos.top }}
      >
        <div className="otp-head">
          <span>Output Telemetry</span>
          <div className="row" style={{ gap: 6 }}>
            <span className="otp-meta" title={hubText}>
              <span className={`dot sm ${hubDot}`} /> {hubText}
            </span>
          </div>
        </div>
        <div className="otp-sys-row">
          <span className="otp-meta" title="Internet connection of this PC">
            <span className={`dot sm ${online ? 'green' : 'amber'}`} /> WAN {online ? 'Online' : 'Offline'}
          </span>
          <span className="otp-meta" title={`Service cache ${cache.ready}/${cache.total}`}>
            <span className={`dot sm ${cacheDot}`} /> Cache{isLive ? ` ${Math.floor(cache.frac * 100)}%` : ''}
          </span>
        </div>
        <div className="otp-list">
          {enabled.map((o) => {
            const h = live.health[o.id];
            const d = outputDot(h);
            return (
              <div
                key={o.id}
                className="otp-row"
                onContextMenu={(e) => {
                  openContextMenu(
                    e,
                    [
                      { kind: 'label', label: o.name },
                      {
                        label: 'Open diagnostics…',
                        onSelect: () => {
                          setPopOpen(false);
                          setUi({ showDiagnostics: true });
                        },
                      },
                      {
                        label: 'Configure outputs…',
                        onSelect: () => {
                          setPopOpen(false);
                          navigate('#/settings/outputs');
                        },
                      },
                    ],
                    { ariaLabel: `${o.name} status actions` },
                  );
                }}
              >
                <span className={`dot sm ${d}`} />
                <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 500, fontSize: 12.5 }}>{o.name}</span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {dotTitle(h, o.name)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="otp-foot">
          <button
            type="button"
            className="small"
            disabled={launch.busy}
            onClick={() => {
              setPopOpen(false);
              dispatch({ id: 'relaunchOutputs' });
            }}
          >
            <Icon name="restart" size={12} />
            Relaunch outputs
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="small ghost"
            onClick={() => {
              setPopOpen(false);
              navigate('#/settings/outputs');
            }}
          >
            Screens…
          </button>
          <button
            type="button"
            className="small ghost"
            onClick={() => {
              setPopOpen(false);
              setUi({ showDiagnostics: true });
            }}
          >
            Diagnostics
          </button>
        </div>
      </div>
    ) : null;

    return createPortal(
      <>
        <div className={`topbar topbar-inline ${tone}`}>
          {tone ? (
            <span className="tag amber" title={hubText} data-hub-status>
              {hubText}
            </span>
          ) : (
            <span className="sr-only" data-hub-status>
              {hubText}
            </span>
          )}
          {urgentBadges}
          {enabled.length > 0 && (
            <button
              ref={lampRef}
              type="button"
              className={`output-lamp-cluster${popOpen ? ' on' : ''}`}
              aria-haspopup="dialog"
              aria-expanded={popOpen}
              title="Output status & telemetry"
              onClick={() => setPopOpen((o) => !o)}
            >
              {enabled.map((o) => {
                const h = live.health[o.id];
                const d = outputDot(h);
                return (
                  <span key={o.id} className="lamp-chip" title={dotTitle(h, o.name)}>
                    <span className={`dot sm ${d}`} aria-hidden="true" />
                    <span className="lamp-name">{o.name}</span>
                  </span>
                );
              })}
            </button>
          )}
          <span className="topbar-cell-sep" aria-hidden="true" />
          <span className="clock">{formatClock(now, general.timeZone, general.clock24h)}</span>
          <span
            className={`live-status-pill ${isLive ? 'live' : 'idle'}`}
            data-live-status={isLive ? 'live' : 'idle'}
          >
            <span className={`dot sm ${isLive ? 'red' : 'grey'}`} />
            {isLive ? 'ON AIR' : 'STANDBY'}
          </span>
          <span className="topbar-cell-sep" aria-hidden="true" />
          <div className="topbar-actions-group">
            <button
              type="button"
              className="small toolbar-flat-btn"
              disabled={launch.busy}
              data-launch
              onClick={() => dispatch({ id: 'launchOutputs' })}
              title="Launch outputs (Ctrl+Shift+L)"
            >
              <Icon name="external" size={13} />
              Launch outputs
            </button>
            <button
              type="button"
              className="ghost icon-btn toolbar-flat-btn"
              disabled={launch.busy}
              data-launch
              onClick={() => dispatch({ id: 'relaunchOutputs' })}
              title="Relaunch outputs (Ctrl+Shift+R)"
              aria-label="Relaunch"
            >
              <Icon name="restart" size={14} />
            </button>
            {isLive && (
              <button type="button" className="danger small" onClick={() => void endService()}>
                <Icon name="power" size={12} />
                End service
              </button>
            )}
          </div>
        </div>
        {telemetryPopover && createPortal(telemetryPopover, document.body)}
      </>,
      slot,
    );
  }

  return (
    <div className={`topbar ${tone}`}>
      <div className="row" style={{ gap: 7, alignItems: 'center', minWidth: 0 }}>
        <span
          className={`live-status-pill ${isLive ? 'live' : 'idle'}`}
          data-live-status={isLive ? 'live' : 'idle'}
        >
          <span className={`dot sm ${isLive ? 'red' : 'grey'}`} />
          {isLive ? 'ON AIR' : 'STANDBY'}
        </span>
        {s.resolved?.playlist.name && (
          <b className="ellipsis" style={{ maxWidth: 200, fontSize: 12 }}>
            {s.resolved.playlist.name}
          </b>
        )}
      </div>
      <span className="topbar-cell-sep" aria-hidden="true" />
      <span className="stat" title={hubText} data-hub-status>
        <span className={`dot ${hubDot}`} /> {hubText}
      </span>
      <span className="stat" title="Internet connection of this PC">
        <span className={`dot ${online ? 'green' : 'amber'}`} /> WAN
      </span>
      <span className="stat" title={`Service cache ${cache.ready}/${cache.total}`}>
        <span className={`dot ${cacheDot}`} /> Cache{isLive ? ` ${Math.floor(cache.frac * 100)}%` : ''}
      </span>
      {enabled.length > 0 && <span className="topbar-cell-sep" aria-hidden="true" />}
      <span className="stat" style={{ gap: 8 }}>
        {enabled.map((o) => {
          const h = live.health[o.id];
          const d = outputDot(h);
          return (
            <span
              key={o.id}
              className="row"
              style={{ gap: 4, cursor: 'default' }}
              title={dotTitle(h, o.name)}
              onContextMenu={(e) => {
                openContextMenu(
                  e,
                  [
                    { kind: 'label', label: o.name },
                    { label: 'Open diagnostics…', onSelect: () => setUi({ showDiagnostics: true }) },
                    { label: 'Configure outputs…', onSelect: () => navigate('#/settings/outputs') },
                  ],
                  { ariaLabel: `${o.name} status actions` },
                );
              }}
            >
              <span className={`dot ${d}`} />
              <span>{o.name}</span>
            </span>
          );
        })}
      </span>
      {urgentBadges}
      <span className="spacer" />
      <span className="clock">{formatClock(now, general.timeZone, general.clock24h)}</span>
      <span className="topbar-cell-sep" aria-hidden="true" />
      <div className="topbar-actions-group">
        <button
          type="button"
          className="small"
          disabled={launch.busy}
          data-launch
          onClick={() => dispatch({ id: 'launchOutputs' })}
          title="Launch outputs (Ctrl+Shift+L)"
        >
          <Icon name="external" size={12} />
          Launch outputs
        </button>
        <button
          type="button"
          className="small"
          disabled={launch.busy}
          data-launch
          onClick={() => dispatch({ id: 'relaunchOutputs' })}
          title="Relaunch outputs (Ctrl+Shift+R)"
        >
          <Icon name="restart" size={12} />
          Relaunch
        </button>
      </div>
      {isLive && (
        <>
          <span className="topbar-cell-sep" aria-hidden="true" />
          <div className="topbar-danger-zone">
            <button type="button" className="danger small" onClick={() => void endService()}>
              <Icon name="power" size={12} />
              End service
            </button>
          </div>
        </>
      )}
      <button
        type="button"
        className="ghost icon-btn"
        onClick={() => setUi({ showDiagnostics: true })}
        title="Diagnostics"
        aria-label="Diagnostics"
      >
        <Icon name="activity" size={14} />
      </button>
    </div>
  );
}

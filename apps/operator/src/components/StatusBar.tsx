import type { Route } from '../lib/route.ts';
import { useLibrary } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import { useSession } from '../state/session.ts';
import { dismissToast, useToasts } from '../state/toasts.ts';
import { Icon } from './Icons.tsx';

function routeHints(route: Route): string {
  switch (route.name) {
    case 'live':
      return 'Space Next · ←/→ Step · F1 Clear Slide · F2 Clear All';
    case 'playlists':
      return 'Double-click to add · Drag to reorder · ⌘K Jump';
    case 'edit':
      return '⌘S Save · ⌘Z Undo · ⌘F Find · Alt+N Notes';
    case 'library':
      return 'Drop files anywhere to import · ⌘K Jump';
    case 'settings':
      return '⌘S Save preferences · ⌘K Jump';
    default:
      return '⌘K Command palette';
  }
}

/**
 * Persistent 26px studio status bar docked at the bottom of the desktop RegularFrame.
 * Displays hub connectivity, service cache readiness, active background jobs, inline ok/info
 * confirmations (keeping floating HUD alerts for warnings/errors only), and contextual key hints.
 */
export function StatusBar({ route, onOpenPalette }: { route: Route; onOpenPalette: () => void }) {
  const sessionStatus = useSession((s) => s.status);
  const liveMode = useLive((s) => s.state.mode);
  const authority = useLive((s) => s.authority);
  const health = useLive((s) => s.health);
  const jobs = useLibrary((s) => s.data.jobs);
  const toasts = useToasts((s) => s.list);

  const inlineNotice = [...toasts].reverse().find((t) => (t.kind === 'ok' || t.kind === 'info') && !t.sticky);
  const activeJobs = Object.values(jobs).filter((j) => j.state === 'queued' || j.state === 'running');

  const cacheEntries = Object.values(health).filter((h) => (h.cache?.total ?? 0) > 0);
  const cachePct = cacheEntries.length
    ? Math.round(
        (cacheEntries.reduce((sum, h) => sum + (h.cache?.ready ?? 0), 0) /
          Math.max(
            1,
            cacheEntries.reduce((sum, h) => sum + (h.cache?.total ?? 0), 0),
          )) *
          100,
      )
    : null;

  const isOffline = sessionStatus === 'offline' || sessionStatus === 'error';
  const connLabel = isOffline
    ? authority === 'fallback'
      ? 'Fallback authority'
      : 'Hub offline'
    : 'Hub connected';

  return (
    <footer className="studio-statusbar no-print" aria-label="Status bar">
      <div className="sb-left">
        <span className="sb-item" title={connLabel}>
          <span className={`dot sm ${isOffline ? (authority === 'fallback' ? 'amber' : 'red') : 'green'}`} />
          <span>{connLabel}</span>
        </span>

        {liveMode === 'live' && (
          <>
            <span className="sb-sep" aria-hidden="true" />
            <span className="sb-item sb-onair">
              <span className="dot sm red" />
              <span>ON AIR</span>
            </span>
          </>
        )}

        {cachePct !== null && (
          <>
            <span className="sb-sep" aria-hidden="true" />
            <span className="sb-item" title="Service asset cache across outputs">
              <span>Cache {cachePct}%</span>
            </span>
          </>
        )}

        {activeJobs.length > 0 && (
          <>
            <span className="sb-sep" aria-hidden="true" />
            <span className="sb-item sb-job">
              <Icon name="activity" size={12} />
              <span>
                {activeJobs.length === 1
                  ? `Running job (${Math.round((activeJobs[0]?.progress ?? 0) * 100)}%)`
                  : `${activeJobs.length} active jobs`}
              </span>
            </span>
          </>
        )}

        {inlineNotice && (
          <>
            <span className="sb-sep" aria-hidden="true" />
            <span className={`sb-notice sb-notice-${inlineNotice.kind}`} role="status">
              <Icon name={inlineNotice.kind === 'ok' ? 'check' : 'info'} size={12} />
              <span className="ellipsis">{inlineNotice.text}</span>
              <button
                type="button"
                className="sb-dismiss"
                aria-label="Dismiss status message"
                onClick={() => dismissToast(inlineNotice.id)}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          </>
        )}
      </div>

      <div className="sb-right">
        <span className="sb-hints ellipsis">{routeHints(route)}</span>
        <span className="sb-sep" aria-hidden="true" />
        <button
          type="button"
          className="sb-cmd-btn"
          onClick={onOpenPalette}
          title="Open Command Palette (Ctrl+K / ⌘K)"
        >
          <Icon name="command" size={12} />
          <span>Command</span>
          <span className="kbd">⌘K</span>
        </button>
      </div>
    </footer>
  );
}

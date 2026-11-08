import type { Profile } from '../lib/capabilities.ts';
import type { Route } from '../lib/route.ts';
import { useVenueLive } from '../lib/venueLive.ts';
import { useLibrary } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import { logout, useSession } from '../state/session.ts';

/**
 * "Live now: <playlist>, <cue>" on an edit-profile device, so the worship lead knows which playlist is
 * locked while a service runs at the venue (read-only; the hub refuses edits to it with 423).
 */
function LiveChip() {
  // A string selector: a fresh object per read would re-render forever.
  const own = useLive((s) => {
    const st = s.state;
    if (st.mode !== 'live' || !st.resolved) return '';
    const cue = st.live !== undefined ? st.cues[st.live] : undefined;
    return `Live now: ${st.resolved.playlist.name}${cue?.label ? `, ${cue.label}` : ''}`;
  });
  // The edit core gets no live state from the hub: the polled summary (lib/venueLive.ts).
  const venue = useVenueLive((s) =>
    s.live ? `Live now: ${s.live.playlistName}${s.live.cueLabel ? `, ${s.live.cueLabel}` : ''}` : '',
  );
  const text = own || venue;
  if (!text) return null;
  return (
    <span className="tag red live-chip ellipsis" data-live-chip aria-live="polite">
      ● {text}
    </span>
  );
}

export function Nav({
  role,
  route,
  profile = 'full',
}: {
  role: 'operate' | 'edit';
  route: Route;
  profile?: Profile;
}) {
  const venue = useLibrary((s) => s.data.settings.general.venueName);
  const offline = useSession((s) => s.status === 'offline');
  const live = useLive((s) => s.state.mode === 'live');
  const link = (href: string, label: string, active: boolean) => (
    <a href={href} className={active ? 'active' : ''}>
      {label}
    </a>
  );
  if (profile === 'edit')
    return (
      <nav className="nav no-print" data-profile="edit">
        <span className="brand">{venue || 'ordo'}</span>
        {link('#/library', 'Library', route.name === 'library' || route.name === 'edit')}
        {link('#/playlists', 'Playlists', route.name === 'playlists')}
        {link('#/previews', 'Previews', route.name === 'previews')}
        {role === 'operate' && link('#/settings/themes', 'Settings', route.name === 'settings')}
        <span className="spacer" />
        <LiveChip />
        {offline && <span className="tag amber">offline: hub unreachable</span>}
        {role === 'operate' && (
          <span className="muted small edit-device-note" data-edit-device-note>
            This device edits; run services from the venue PC
          </span>
        )}
        <span className="tag">{role === 'operate' ? 'Operate' : 'Edit'}</span>
        <button type="button" className="ghost small" onClick={() => void logout()}>
          Sign out
        </button>
      </nav>
    );
  return (
    <nav className="nav no-print">
      <span className="brand">{venue || 'ordo'}</span>
      {role === 'operate' && link('#/live', live ? '● Live' : 'Live', route.name === 'live')}
      {link('#/playlists', 'Playlists', route.name === 'playlists')}
      {link('#/library', 'Library', route.name === 'library' || route.name === 'edit')}
      {role === 'operate' && link('#/settings/outputs', 'Settings', route.name === 'settings')}
      {role === 'operate' && link('#/checklist', 'Checklist', route.name === 'checklist')}
      <span className="spacer" />
      {offline && <span className="tag amber">offline: hub unreachable</span>}
      <span className="tag">{role === 'operate' ? 'Operate' : 'Edit'}</span>
      <button type="button" className="ghost small" onClick={() => void logout()}>
        Sign out
      </button>
    </nav>
  );
}

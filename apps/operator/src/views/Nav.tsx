import type { Route } from '../lib/route.ts';
import { useLibrary } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import { logout, useSession } from '../state/session.ts';

export function Nav({ role, route }: { role: 'operate' | 'edit'; route: Route }) {
  const venue = useLibrary((s) => s.data.settings.general.venueName);
  const offline = useSession((s) => s.status === 'offline');
  const live = useLive((s) => s.state.mode === 'live');
  const link = (href: string, label: string, active: boolean) => (
    <a href={href} className={active ? 'active' : ''}>
      {label}
    </a>
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

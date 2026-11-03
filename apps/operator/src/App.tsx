import { useEffect, useState } from 'react';
import { ConfirmHost } from './components/Confirm.tsx';
import { Toasts } from './components/Toasts.tsx';
import { UpdateFailedScreen, UpdatingOverlay } from './components/UpdatingScreen.tsx';
import { allowedForRole } from './lib/route.ts';
import { installCacheCheck } from './services/cacheCheck.ts';
import { startController } from './services/controller.ts';
import { syncFonts } from './services/fonts.ts';
import { installOutputWindows } from './services/outputs.ts';
import { installProgramViews } from './services/programView.ts';
import { installSurfaces, surfaces } from './services/surfaces.ts';
import { installUpdateGuard, useUpdate } from './services/update.ts';
import { loadCachedLibrary, loadLibrary, useLibrary } from './state/library.ts';
import { refreshSession, useSession } from './state/session.ts';
import { navigate, useRoute } from './useRoute.ts';
import { LoginView } from './views/auth/LoginView.tsx';
import { SetupView } from './views/auth/SetupView.tsx';
import { Nav } from './views/Nav.tsx';
import { ChecklistView } from './views/checklist/ChecklistView.tsx';
import { EditorView } from './views/editor/EditorView.tsx';
import { LibraryView } from './views/library/LibraryView.tsx';
import { LiveView } from './views/live/LiveView.tsx';
import { PlaylistsView } from './views/playlists/PlaylistsView.tsx';
import { SettingsView } from './views/settings/SettingsView.tsx';
import { reacquireOnFirstGesture } from './services/reacquire.ts';

export function App() {
  const session = useSession();
  const updateFailed = useUpdate((u) => u.phase === 'failed');
  useEffect(() => {
    if (!updateFailed) void refreshSession();
  }, [updateFailed]);
  useEffect(() => {
    if (session.status !== 'error') return;
    const t = setInterval(() => void refreshSession(), 5000);
    return () => clearInterval(t);
  }, [session.status]);

  // A stale tab that could not update: no hub connection is started, so the reload loop stops here.
  if (updateFailed) return <UpdateFailedScreen />;
  if (session.status === 'loading')
    return (
      <div className="center">
        <span className="muted">Connecting to the hub…</span>
      </div>
    );
  if (session.status === 'error' && !session.me)
    return (
      <div className="center">
        <div className="card col" style={{ width: 380 }}>
          <h2>ordo</h2>
          <div className="banner red">{session.error}</div>
          <button type="button" onClick={() => void refreshSession()}>
            Retry
          </button>
        </div>
      </div>
    );
  if (session.me?.setupRequired) return <SetupView />;
  const role = session.me?.role ?? session.offlineRole;
  if (role !== 'operate' && role !== 'edit') return <LoginView />;
  return <Shell role={role} />;
}

function Shell({ role }: { role: 'operate' | 'edit' }) {
  const route = useRoute();
  const [ready, setReady] = useState(false);
  const fonts = useLibrary((s) => s.data.fonts);
  useEffect(() => {
    let alive = true;
    void (async () => {
      await loadCachedLibrary();
      if (alive) setReady(true);
      await loadLibrary();
      if (alive) setReady(true);
    })();
    const ctl = startController(role);
    const offUpdate = installUpdateGuard(ctl.hub);
    let offCacheCheck: (() => void) | undefined;
    if (role === 'operate') {
      installOutputWindows(ctl);
      installProgramViews(ctl);
      installSurfaces(ctl);
      offCacheCheck = installCacheCheck();
      reacquireOnFirstGesture();
    }
    return () => {
      alive = false;
      offUpdate();
      offCacheCheck?.();
    };
  }, [role]);
  useEffect(() => syncFonts(fonts), [fonts]);
  // Live keys act on operator screens only; the editor uses arrows, Delete and Ctrl+Z itself.
  useEffect(() => {
    const keysOn =
      role === 'operate' && (route.name === 'live' || route.name === 'playlists' || route.name === 'library');
    surfaces()?.setKeyboard(keysOn);
  }, [role, route.name]);
  useEffect(() => {
    if (!allowedForRole(route, role)) navigate({ name: 'library', tab: 'presentations' });
  }, [route, role]);

  let body: React.ReactNode;
  if (!ready) body = <div className="center muted">Loading library…</div>;
  else
    switch (route.name) {
      case 'live':
        body = role === 'operate' ? <LiveView /> : null;
        break;
      case 'library':
        body = <LibraryView tab={route.tab} />;
        break;
      case 'edit':
        body = <EditorView id={route.id} key={route.id} />;
        break;
      case 'playlists':
        body = <PlaylistsView id={route.id} />;
        break;
      case 'settings':
        body = role === 'operate' ? <SettingsView page={route.page} /> : null;
        break;
      case 'checklist':
        body = <ChecklistView />;
        break;
    }
  return (
    <div className="app">
      <Nav role={role} route={route} />
      <div className="page">{body}</div>
      <Toasts />
      <ConfirmHost />
      <UpdatingOverlay />
    </div>
  );
}

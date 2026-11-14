import { lazy, Suspense, useEffect, useState } from 'react';
import { ErrorBoundary, PageError } from './components/ErrorBoundary.tsx';
import { ConfirmHost } from './components/Confirm.tsx';
import { Toasts } from './components/Toasts.tsx';
import { UpdateFailedScreen, UpdatingOverlay } from './components/UpdatingScreen.tsx';
import { sessionEndedMessage } from './lib/hubStatus.ts';
import { requestPersistentStorage, useProfile } from './lib/capabilities.ts';
import { allowedForRole } from './lib/route.ts';
import { watchVenueLive } from './lib/venueLive.ts';
import { installCacheCheck } from './services/cacheCheck.ts';
import { controller, startController } from './services/controller.ts';
import { syncFonts } from './services/fonts.ts';
import { installOutputWindows } from './services/outputs.ts';
import { installProgramViews } from './services/programView.ts';
import { installSurfaces, surfaces } from './services/surfaces.ts';
import { installUpdateGuard, useUpdate } from './services/update.ts';
import { useLibrary } from './state/library.ts';
import { useLive } from './state/live.ts';
import { refreshSession, useSession } from './state/session.ts';
import { navigate, useRoute } from './useRoute.ts';
import { LoginView } from './views/auth/LoginView.tsx';
import { SetupView } from './views/auth/SetupView.tsx';
import { Nav } from './views/Nav.tsx';
import { EditorView } from './views/editor/EditorView.tsx';
import { LibraryView } from './views/library/LibraryView.tsx';
import { LiveView } from './views/live/LiveView.tsx';
import { PlaylistsView } from './views/playlists/PlaylistsView.tsx';
import { PreviewsView } from './views/editor/PreviewsView.tsx';
import { reacquireOnFirstGesture } from './services/reacquire.ts';

/*
 * Pages loaded when first opened (the operator's initial bundle budget, `tools/bundle-report.mjs`): the device
 * checklist and the Setup pages (settings) are opened before or after a service, never in its hot path. The
 * service worker precaches every built file, so they open offline as the rest of the app does.
 */
const SettingsView = lazy(() =>
  import('./views/settings/SettingsView.tsx').then((m) => ({ default: m.SettingsView })),
);
const DeviceSetupView = lazy(() =>
  import('./views/setup/DeviceSetupView.tsx').then((m) => ({ default: m.DeviceSetupView })),
);
const pageLoading = <div className="center muted">Loading…</div>;

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
  if (role !== 'operate' && role !== 'edit') {
    // The session ended under a running operator (review item 5): keep the shell, its output windows and
    // the core mounted (the outputs stay on the hub) and sign in over it.
    const running = controller()?.role;
    if (running) return <Shell role={running} signedOut />;
    return <LoginView />;
  }
  return <Shell role={role} />;
}

function Shell({ role, signedOut = false }: { role: 'operate' | 'edit'; signedOut?: boolean }) {
  const route = useRoute();
  // An edit-profile device (an iPad, or the edit role) builds services but never runs one: its core joins
  // the hub as an editor (no service-cache fill, no fallback authority, no snapshot), and no output
  // windows, program views, keyboard, Stream Deck or MIDI are installed (design/15 "iPad editing").
  const profile = useProfile(role);
  const coreRole = profile === 'edit' ? 'edit' : role;
  // The core worker posts the library once it has tried its IndexedDB copy (and the hub snapshot).
  const attempted = useLibrary((s) => s.attempted);
  const [timedOut, setTimedOut] = useState(false);
  const ready = attempted || timedOut;
  const fonts = useLibrary((s) => s.data.fonts);
  // Signed out while this PC runs the outputs (the hub refused the session after the fallback took over):
  // the service must stay operable from the keys and surfaces, so the sign-in is a card, not a wall.
  const fallback = useLive((s) => s.authority === 'fallback');
  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), 3000);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const ctl = startController(coreRole);
    const offUpdate = installUpdateGuard(ctl.hub);
    let offCacheCheck: (() => void) | undefined;
    if (coreRole === 'operate') {
      installOutputWindows(ctl);
      installProgramViews(ctl);
      installSurfaces(ctl);
      offCacheCheck = installCacheCheck();
      reacquireOnFirstGesture();
    }
    return () => {
      offUpdate();
      offCacheCheck?.();
    };
  }, [coreRole]);
  useEffect(() => {
    // The venue PC too: the service files downloaded for offline use live in the Cache API.
    if (!signedOut) void requestPersistentStorage();
  }, [signedOut]);
  // What the venue runs, for the "Live now" chip and the editor lock (GET /live/summary, either PIN).
  useEffect(
    () => (profile === 'edit' && role && !signedOut ? watchVenueLive(role) : undefined),
    [profile, role, signedOut],
  );
  useEffect(() => syncFonts(fonts), [fonts]);
  // Live keys act on operator screens only; the editor uses arrows, Delete and Ctrl+Z itself. A signed-out
  // operator keeps its keys only while it is the fallback authority (the outputs would otherwise be stuck).
  useEffect(() => {
    const keysOn =
      (!signedOut || fallback) &&
      coreRole === 'operate' &&
      (route.name === 'live' || route.name === 'playlists' || route.name === 'library');
    surfaces()?.setKeyboard(keysOn);
  }, [coreRole, route.name, signedOut, fallback]);
  useEffect(() => {
    if (!allowedForRole(route, role, profile)) navigate({ name: 'library', tab: 'presentations' });
  }, [route, role, profile]);

  let body: React.ReactNode;
  if (!ready) body = <div className="center muted">Loading library…</div>;
  else
    switch (route.name) {
      case 'live':
        body = role === 'operate' && profile === 'full' ? <LiveView /> : null;
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
        body =
          role === 'operate' ? (
            <Suspense fallback={pageLoading}>
              <SettingsView page={route.page} profile={profile} />
            </Suspense>
          ) : null;
        break;
      case 'setup':
      case 'checklist':
        body = (
          <Suspense fallback={pageLoading}>
            <DeviceSetupView />
          </Suspense>
        );
        break;
      case 'previews':
        body = <PreviewsView id={route.id} slideId={route.slideId} />;
        break;
    }
  return (
    <div className={`app app-route-${route.name}`}>
      <Nav role={role} route={route} profile={profile} />
      <div className="page">
        <ErrorBoundary
          key={route.name}
          name={`page ${route.name}`}
          resetKey={JSON.stringify(route)}
          fallback={(retry) => <PageError route={route.name} retry={retry} />}
        >
          {body}
        </ErrorBoundary>
      </div>
      <Toasts />
      <ConfirmHost />
      <UpdatingOverlay />
      {signedOut && (
        <div
          className={fallback ? 'signin-overlay nonmodal' : 'signin-overlay'}
          data-session-expired
          data-session-expired-mode={fallback ? 'fallback' : 'hub'}
        >
          <div className="banner">{sessionEndedMessage(fallback)}</div>
          {/* No autofocus on the PIN while the keys run the service: a focused text field eats Space. */}
          <LoginView autoFocus={!fallback} />
        </div>
      )}
    </div>
  );
}

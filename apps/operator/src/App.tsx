import { useEffect, useLayoutEffect, useState } from 'react';
import { PageHost } from './components/PageHost.tsx';
import { UpdateFailedScreen } from './components/UpdatingScreen.tsx';
import { deviceProfile, requestPersistentStorage, useProfile } from './lib/capabilities.ts';
import { type Layout, thisIsPhone, useLayout } from './lib/layout.ts';
import { pageFor, routeHash } from './lib/route.ts';
import { watchVenueLive } from './lib/venueLive.ts';
import { PAGES } from './pages.ts';
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
import { LibraryView } from './views/library/LibraryView.tsx';
import { RegularFrame } from './views/RegularFrame.tsx';
import { reacquireOnFirstGesture } from './services/reacquire.ts';

/*
 * Pages come from the registry (src/pages.ts): loaded when first needed, or preloaded at startup on a regular
 * device, and rendered synchronously once loaded (no React.lazy, whose Suspense fallback costs about 300 ms on
 * every first open). The service worker precaches them, so they open offline as the rest of the app does.
 */

export function App() {
  // The layout class, once, from the device's capability profile (never the session's: lib/layout.ts).
  const layout = useLayout(deviceProfile('operate'), useRoute().name);
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
    if (running) return <Shell role={running} layout={layout} signedOut />;
    return <LoginView />;
  }
  return <Shell role={role} layout={layout} />;
}

function Shell({
  role,
  layout,
  signedOut = false,
}: {
  role: 'operate' | 'edit';
  layout: Layout;
  signedOut?: boolean;
}) {
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
  // What this route shows (lib/route.ts pageFor): on the compact layout or a phone a refused route is decided
  // here, before any body, and replaced (its chunk is never requested, history does not grow); on the regular
  // layout a route allowedForRole refuses renders nothing and is pushed to the library, as before.
  const decision = pageFor(route, { role, profile, layout, restricted: thisIsPhone() });
  const redirect = 'redirect' in decision ? decision : undefined;
  const redirectKey = redirect
    ? `${redirect.replace ? 'replace' : 'push'} ${routeHash(redirect.redirect)}`
    : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the redirect
  useLayoutEffect(() => {
    if (redirect?.replace) navigate(redirect.redirect, { replace: true });
  }, [redirectKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the redirect
  useEffect(() => {
    if (redirect && !redirect.replace) navigate(redirect.redirect);
  }, [redirectKey]);

  let body: React.ReactNode = null;
  if (!ready) body = <div className="center muted">Loading library…</div>;
  else
    switch (decision.page) {
      case 'live':
        body = <PageHost name="live" chunk={PAGES.live} props={{}} />;
        break;
      case 'library':
        body = <LibraryView tab={decision.props.tab} />;
        break;
      case 'edit':
        body = <PageHost name="edit" chunk={PAGES.edit} props={decision.props} key={decision.props.id} />;
        break;
      case 'playlists':
        body = <PageHost name="playlists" chunk={PAGES.playlists} props={decision.props} />;
        break;
      case 'settings':
        body = <PageHost name="settings" chunk={PAGES.settings} props={{ ...decision.props, profile }} />;
        break;
      case 'setup':
        body = <PageHost name="setup" chunk={PAGES.setup} props={{}} />;
        break;
      case 'previews':
        body = <PageHost name="previews" chunk={PAGES.previews} props={decision.props} />;
        break;
    }
  return (
    <RegularFrame
      role={role}
      route={route}
      profile={profile}
      layout={layout}
      signedOut={signedOut}
      fallback={fallback}
      body={body}
    />
  );
}

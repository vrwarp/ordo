import { useEffect, useLayoutEffect, useState } from 'react';
import { PageHost } from './components/PageHost.tsx';
import { PageError } from './components/ErrorBoundary.tsx';
import { UpdateFailedScreen } from './components/UpdatingScreen.tsx';
import { t, uiLanguage } from './i18n/index.ts';
import { deviceProfile, requestPersistentStorage, useProfile } from './lib/capabilities.ts';
import { type Layout, thisIsPhone, useLayout } from './lib/layout.ts';
import { pageFor, routeHash } from './lib/route.ts';
import { watchVenueLive } from './lib/venueLive.ts';
import {
  type Chunk,
  hubAnswers,
  OPERATE,
  PAGES,
  preloadFor,
  REGULAR_FULL,
  retryOrReload,
  useChunk,
  useChunkStatus,
  useChunks,
  VENUE_CRITICAL,
} from './pages.ts';
import { controller, startController, testMode } from './services/controller.ts';
import { syncFonts } from './services/fonts.ts';
import { thumbs } from './services/thumbs.ts';
import { installUpdateGuard, useUpdate } from './services/update.ts';
import { useLibrary } from './state/library.ts';
import { useLive } from './state/live.ts';
import { capOf, HUB_UNREACHABLE, refreshSession, useSession } from './state/session.ts';
import { navigate, useRoute } from './useRoute.ts';
import { LoginView } from './views/auth/LoginView.tsx';
import { SetupView } from './views/auth/SetupView.tsx';
import { LibraryView } from './views/library/LibraryView.tsx';
import { RegularFrame } from './views/RegularFrame.tsx';

/*
 * Pages come from the registry (src/pages.ts): loaded when first needed, or preloaded at startup on a regular
 * device, and rendered synchronously once loaded (no React.lazy, whose Suspense fallback costs about 300 ms on
 * every first open). The service worker precaches them, so they open offline as the rest of the app does.
 */

export function App() {
  // The layout class, once, from the device's capability profile (never the session's: lib/layout.ts).
  const layout = useLayout(deviceProfile('operate'), useRoute().name);
  // A compact device that is not a phone (an iPad leaving a narrow Split View) turns regular: load the regular
  // pages it can now open (a no-op where main.tsx already started them; a regular device turning compact keeps
  // what it has).
  useEffect(() => {
    if (layout === 'regular' && !thisIsPhone()) preloadFor('regular', deviceProfile('operate'), false);
  }, [layout]);
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
  // The waits before the shell: the compact layout in its own words (design/28 §2.12), the regular as before.
  const compact = layout === 'compact';
  if (session.status === 'loading')
    return (
      <div className="center">
        <span className="muted" data-connecting>
          {compact ? t('shell.connecting') : 'Connecting to the hub…'}
        </span>
      </div>
    );
  if (session.status === 'error' && !session.me)
    return (
      <div className="center">
        <div className="card col" style={{ width: 380 }}>
          <h2>ordo</h2>
          <div className="banner red" data-session-error>
            {compact && session.error === HUB_UNREACHABLE ? t('shell.unreachable') : session.error}
          </div>
          <button type="button" onClick={() => void refreshSession()}>
            {compact ? t('shell.retry') : 'Retry'}
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
    // The same element tree as a signed-in session (OperateGate, then Shell): the Shell stays mounted.
    if (running) return <OperateGate role={running} layout={layout} signedOut />;
    return <LoginView />;
  }
  return <OperateGate role={role} layout={layout} />;
}

/**
 * The venue PC (the operate role on the full profile) mounts its Shell once every regular page and the operate
 * services have settled (preloaded from main.tsx, in parallel with the session request): its live view and
 * editor then render at once, and the Shell's controller effect installs the operate services synchronously,
 * so the keyboard effect after it finds the surfaces. Until then "Connecting to the hub…". Only the live view or
 * the operate services failing holds it (VENUE_CRITICAL): the error card, whose Retry loads them again and
 * reloads the page when that cannot work (Chromium keeps a failed import; no Shell or output window is mounted
 * yet, so a reload is safe). Any other page that failed is its own page's error. Every other session mounts its
 * Shell at once.
 */
function OperateGate({
  role,
  layout,
  signedOut = false,
}: {
  role: 'operate' | 'edit';
  layout: Layout;
  signedOut?: boolean;
}) {
  const profile = useProfile(role);
  const operate = role === 'operate' && profile === 'full';
  const s = useChunks(REGULAR_FULL, operate, VENUE_CRITICAL);
  if (operate && s.error !== undefined)
    return (
      <div className="center">
        <div className="card col" style={{ width: 380 }}>
          <h2>ordo</h2>
          <div className="banner red" data-gate-error>
            Part of ordo could not be loaded from the hub. Check the connection, then Retry.
          </div>
          <button
            type="button"
            onClick={() =>
              void retryOrReload(VENUE_CRITICAL, { reachable: hubAnswers, reload: () => location.reload() })
            }
          >
            Retry
          </button>
        </div>
      </div>
    );
  if (operate && !s.ready)
    return (
      <div className="center">
        <span className="muted">Connecting to the hub…</span>
      </div>
    );
  return <Shell role={role} layout={layout} signedOut={signedOut} />;
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
    // Loaded before this Shell mounted (OperateGate): installed now, in the order they always were.
    if (coreRole === 'operate') offCacheCheck = OPERATE.get()?.installOperate(ctl);
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
  // The thumbnail worker starts here on the regular layout (the venue PC and the iPad, as before); the compact
  // layout starts it with its first thumbnail (services/thumbs.ts).
  useEffect(() => {
    if (layout === 'regular') thumbs.warm();
  }, [layout]);
  // The bake service (pictures of heavy slides, design/29 section 1.4). Its boot is a lazy chunk of a few kilobytes that
  // only the regular layout fetches (a phone never does; test mode fetches it everywhere, for window.__ordo.bake); the
  // boot's gate then lets only a desktop browser with the hub's switch on fetch the service itself, and the service
  // never runs during a service.
  useEffect(() => {
    if (layout !== 'regular' && !testMode()) return;
    let gone = false;
    let off: (() => void) | undefined;
    import('./services/bakeBoot.ts').then(
      (m) => {
        if (!gone && layout === 'regular' && !signedOut) off = m.installBake();
      },
      () => undefined,
    );
    return () => {
      gone = true;
      off?.();
    };
  }, [layout, signedOut]);
  // Live keys act on operator screens only; the editor uses arrows, Delete and Ctrl+Z itself. A signed-out
  // operator keeps its keys only while it is the fallback authority (the outputs would otherwise be stuck).
  useEffect(() => {
    const keysOn =
      (!signedOut || fallback) &&
      coreRole === 'operate' &&
      (route.name === 'live' || route.name === 'playlists' || route.name === 'library');
    OPERATE.get()?.surfaces()?.setKeyboard(keysOn);
  }, [coreRole, route.name, signedOut, fallback]);
  // What this route shows (lib/route.ts pageFor): on the compact layout, on a phone (either layout) or in a
  // capped session (design/28 §3.2) a refused route is decided here, before any body, and replaced (its chunk
  // is never requested, history does not grow); on the regular layout a route allowedForRole refuses renders
  // nothing and is pushed to the library, as before.
  const cap = useSession((s) => capOf(s.me));
  const restricted = thisIsPhone() || cap !== 'full';
  const decision = pageFor(route, { role, profile, layout, restricted });
  // The compact layout's frame and views (src/pages.ts PAGES.compact): loaded only on the compact layout, so the
  // venue PC and the iPad's regular layout never fetch them.
  const compact = useChunk(PAGES.compact, layout === 'compact');
  // The compact UI's language on <html lang> (design/28 §6; English in P0); the regular layout keeps index.html's.
  useLayoutEffect(() => {
    if (layout === 'compact') document.documentElement.lang = uiLanguage(navigator.languages);
  }, [layout]);
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

  // On the regular layout the page's module loads under "Loading library…" (preloaded from main.tsx, so it is
  // usually there before the library): the first page appears without a "Loading…" in between.
  const pageChunk =
    decision.page && decision.page !== 'library' ? (PAGES[decision.page] as Chunk<unknown>) : undefined;
  const pageStatus = useChunkStatus(layout === 'regular' && !restricted ? pageChunk : undefined);
  const pageWaits = pageStatus === 'idle' || pageStatus === 'loading';

  if (layout === 'compact') {
    if (compact.status === 'failed')
      return <PageError route="compact" retry={() => void PAGES.compact.load().catch(() => undefined)} />;
    const C = compact.value;
    if (!C)
      return (
        <div className="center muted" data-page-loading>
          {t('shell.loading')}
        </div>
      );
    // pageFor answers only the Library (Presentations, Media), the plans and a presentation's previews here: the
    // P0 bodies of the compact chunk (read-only; P1's phone-first views replace them).
    let page: React.ReactNode = null;
    if (!ready)
      page = (
        <div className="center muted" data-page-loading>
          {t('shell.loading')}
        </div>
      );
    else if (decision.page === 'library')
      page = decision.props.tab === 'media' ? <C.MediaP0 /> : <C.LibraryP0 />;
    else if (decision.page === 'playlists') page = <C.PlansP0 id={decision.props.id} />;
    else if (decision.page === 'previews')
      page = <C.PreviewP0 id={decision.props.id} slideId={decision.props.slideId} />;
    return (
      <C.CompactFrame
        role={role}
        route={route}
        profile={profile}
        layout={layout}
        signedOut={signedOut}
        fallback={fallback}
        body={page}
      />
    );
  }

  let body: React.ReactNode = null;
  if (!ready || pageWaits) body = <div className="center muted">Loading library…</div>;
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

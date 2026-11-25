import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import { ConfirmHost } from '../components/Confirm.tsx';
import { ContextMenuHost } from '../components/ContextMenu.tsx';
import { ErrorBoundary, PageError } from '../components/ErrorBoundary.tsx';
import { useCoarsePointer } from '../components/pointer.ts';
import { StatusBar } from '../components/StatusBar.tsx';
import { Toasts } from '../components/Toasts.tsx';
import { UpdatingOverlay } from '../components/UpdatingScreen.tsx';
import type { Profile } from '../lib/capabilities.ts';
import { sessionEndedMessage } from '../lib/hubStatus.ts';
import type { Layout } from '../lib/layout.ts';
import type { Route } from '../lib/route.ts';
import { LoginView } from './auth/LoginView.tsx';
import { Nav } from './Nav.tsx';

const CommandPalette = lazy(() => import('../components/CommandPalette.tsx'));

/** What App hands a frame: the session, the route and its decided body (design/28 §3.1). */
export type FrameProps = {
  role: 'operate' | 'edit';
  route: Route;
  profile: Profile;
  layout: Layout;
  /** The session ended under a running operator: the sign-in sits over the frame. */
  signedOut: boolean;
  /** This PC is the fallback authority: the sign-in is a card, not a wall (no autofocus). */
  fallback: boolean;
  body: ReactNode;
};

/**
 * The regular frame (the venue PC, the iPad, an Android tablet): the top nav, `.page` (the one scroller)
 * with the page's error boundary, the desktop studio status bar, lazy Command Palette (⌘K), the toasts,
 * confirm dialog, context menu, update overlay, and sign-in over a running operator.
 */
export function RegularFrame({ role, route, profile, signedOut, fallback, body }: FrameProps) {
  const coarse = useCoarsePointer();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (coarse || signedOut) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [coarse, signedOut]);

  return (
    <div className={`app app-route-${route.name}${!coarse ? ' has-statusbar' : ''}`}>
      <Nav
        role={role}
        route={route}
        profile={profile}
        onOpenPalette={!coarse ? () => setPaletteOpen(true) : undefined}
      />
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
      {!coarse && <StatusBar route={route} onOpenPalette={() => setPaletteOpen(true)} />}
      {paletteOpen && !signedOut && (
        <Suspense fallback={null}>
          <CommandPalette role={role} profile={profile} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      )}
      <Toasts />
      <ConfirmHost />
      <ContextMenuHost />
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

import type { ReactNode } from 'react';
import { ConfirmHost } from '../components/Confirm.tsx';
import { ErrorBoundary, PageError } from '../components/ErrorBoundary.tsx';
import { Toasts } from '../components/Toasts.tsx';
import { UpdatingOverlay } from '../components/UpdatingScreen.tsx';
import type { Profile } from '../lib/capabilities.ts';
import { sessionEndedMessage } from '../lib/hubStatus.ts';
import type { Layout } from '../lib/layout.ts';
import type { Route } from '../lib/route.ts';
import { LoginView } from './auth/LoginView.tsx';
import { Nav } from './Nav.tsx';

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
 * with the page's error boundary, the toasts, the confirm dialog, the update overlay and the sign-in over a
 * running operator. Moved verbatim out of App; the compact shell adds its own frame beside it.
 */
export function RegularFrame({ role, route, profile, signedOut, fallback, body }: FrameProps) {
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

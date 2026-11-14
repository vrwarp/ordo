import { useEffect, useState } from 'react';
import { ConfirmHost } from '../../components/Confirm.tsx';
import { trackPresses } from '../../components/dialogEscape.ts';
import { ErrorBoundary, PageError } from '../../components/ErrorBoundary.tsx';
import { Toasts } from '../../components/Toasts.tsx';
import { UpdatingOverlay } from '../../components/UpdatingScreen.tsx';
import { type MessageKey, t } from '../../i18n/index.ts';
import { sessionEndedMessage } from '../../lib/hubStatus.ts';
import type { Route } from '../../lib/route.ts';
import { useLibrary } from '../../state/library.ts';
import { navigate } from '../../useRoute.ts';
import { LoginView } from '../auth/LoginView.tsx';
import type { FrameProps } from '../RegularFrame.tsx';
import { Icon } from './icons.tsx';
import { FreshnessLine, LiveNowStrip } from './LiveNow.tsx';
import { MoreSheet } from './MoreSheet.tsx';
import { backTarget, isDetail, nextTrail, type Tab, type Trail, tabOf } from './tabs.ts';

/**
 * The previous screen, kept across re-renders and remounts of the frame (a session refresh remounts it): Back
 * is the browser's own back when that screen is the one it leads to (views/compact/tabs.ts).
 */
let trail: Trail = {};

/** The header's title: the tab's name on a list, the plan's or presentation's name on a detail screen. */
function useTitle(route: Route): string {
  const detail = useLibrary((s) => {
    if (route.name === 'playlists' && route.id) return s.data.playlists.find((p) => p.id === route.id)?.name;
    if (route.name === 'previews' && route.id)
      return s.data.presentations.find((p) => p.id === route.id)?.title;
    return undefined;
  });
  if (detail !== undefined) return detail;
  const tab = tabOf(route);
  return tab ? t(`title.${tab}` as MessageKey) : '';
}

const TABS: { tab: Tab; href: string; label: MessageKey }[] = [
  { tab: 'plans', href: '#/playlists', label: 'tab.plans' },
  { tab: 'library', href: '#/library', label: 'tab.library' },
  { tab: 'media', href: '#/library/media', label: 'tab.media' },
];

/**
 * The compact frame (design/28 §2.2, decision 4): a phone's shell, in the compact chunk (src/pages.ts
 * `PAGES.compact`; the venue PC never fetches it). The top block (padded by the top safe area) holds the Live
 * now strip and the freshness line and the header, with Back on a detail screen; `.page` is the one scroller;
 * the tab bar (Plans, Library, Media, More) sits at the bottom, padded by the bottom safe area, and a detail
 * screen hides it. Toasts, the confirm sheet, the update overlay and the sign-in over an expired session as on
 * the regular frame.
 */
export function CompactFrame({ route, signedOut, fallback, body }: FrameProps) {
  const [more, setMore] = useState(false);
  const detail = isDetail(route);
  const tab = tabOf(route);
  const title = useTitle(route);
  const routeKey = JSON.stringify(route);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the route
  useEffect(() => {
    trail = nextTrail(trail, route);
  }, [routeKey]);
  // A sheet gives focus back to the control it opened from; Safari does not focus a tapped button, so the
  // frame records presses (components/dialogEscape.ts).
  useEffect(() => trackPresses(), []);
  const back = () => {
    const target = backTarget(route, trail.previous);
    if (target === 'history') history.back();
    else navigate(target, { replace: true });
  };
  return (
    <div className={`app compact-app app-route-${route.name}`}>
      <div className="compact-top">
        <LiveNowStrip />
        <FreshnessLine />
        <header className="compact-header" data-compact-header>
          {detail && (
            <button type="button" className="compact-back" data-back aria-label={t('back')} onClick={back}>
              <Icon name="back" />
            </button>
          )}
          <h1 dir="auto">{title}</h1>
        </header>
      </div>
      <div className={detail ? 'page compact-page detail' : 'page compact-page'}>
        <ErrorBoundary
          key={route.name}
          name={`page ${route.name}`}
          resetKey={routeKey}
          fallback={(retry) => <PageError route={route.name} retry={retry} />}
        >
          {body}
        </ErrorBoundary>
      </div>
      {!detail && (
        <nav className="tabbar" aria-label={t('tab.bar')}>
          {TABS.map((x) => (
            <a key={x.tab} href={x.href} className="tab" aria-current={tab === x.tab ? 'page' : undefined}>
              <Icon name={x.tab} />
              <span>{t(x.label)}</span>
            </a>
          ))}
          <button
            type="button"
            className="tab"
            aria-haspopup="dialog"
            aria-expanded={more}
            onClick={() => setMore(true)}
          >
            <Icon name="more" />
            <span>{t('tab.more')}</span>
          </button>
        </nav>
      )}
      <Toasts />
      <ConfirmHost />
      <UpdatingOverlay />
      {more && <MoreSheet onClose={() => setMore(false)} />}
      {signedOut && (
        <div
          className={fallback ? 'signin-overlay nonmodal' : 'signin-overlay'}
          data-session-expired
          data-session-expired-mode={fallback ? 'fallback' : 'hub'}
        >
          <div className="banner">{sessionEndedMessage(fallback)}</div>
          <LoginView autoFocus={false} />
        </div>
      )}
    </div>
  );
}

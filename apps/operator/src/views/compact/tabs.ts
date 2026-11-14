import type { Route } from '../../lib/route.ts';

/**
 * The compact layout's tab model (design/28 decision 4, §2.2): four tabs (Plans, Library, Media, More), list
 * then detail. A detail screen (a plan, a presentation's previews) hides the tab bar and shows Back. Pure: the
 * frame (CompactFrame.tsx) renders it, compactTabs.test.ts pins it.
 */
export type Tab = 'plans' | 'library' | 'media';

/** The tab a route belongs to (previews belong to the Library), or undefined for a route the frame never shows. */
export function tabOf(r: Route): Tab | undefined {
  switch (r.name) {
    case 'playlists':
      return 'plans';
    case 'library':
      return r.tab === 'media' ? 'media' : r.tab === 'presentations' ? 'library' : undefined;
    case 'previews':
      return 'library';
    default:
      return undefined;
  }
}

/** A detail screen: a plan, a presentation's previews. */
export function isDetail(r: Route): boolean {
  return (r.name === 'playlists' || r.name === 'previews') && !!r.id;
}

/** Where Back leads from a detail screen: the list of its tab (itself for a list). */
export function parentOf(r: Route): Route {
  if (r.name === 'playlists' && r.id) return { name: 'playlists' };
  if (r.name === 'previews') return { name: 'library', tab: 'presentations' };
  return r;
}

/** The same screen: the same route and id (a slide of the same presentation's previews included). */
export function sameScreen(a: Route | undefined, b: Route | undefined): boolean {
  if (!a || !b || a.name !== b.name) return false;
  switch (a.name) {
    case 'library':
      return a.tab === (b as typeof a).tab;
    case 'playlists':
    case 'previews':
    case 'edit':
      return a.id === (b as typeof a).id;
    case 'settings':
      return a.page === (b as typeof a).page;
    default:
      return true;
  }
}

/**
 * The screen before the current one, kept as routes change: a change within one screen (another slide of the
 * same previews, which the frame navigates by replace) keeps the previous screen.
 */
export type Trail = { readonly current?: Route; readonly previous?: Route };

export function nextTrail(trail: Trail, route: Route): Trail {
  if (sameScreen(trail.current, route)) return { current: route, previous: trail.previous };
  return { current: route, previous: trail.current };
}

/**
 * What Back does on a detail screen: 'history' (history.back(), so the browser's own back and the iOS edge
 * swipe agree with the button) when the previous screen was the one it leads back to, its parent, or for a
 * presentation's previews the plan it was opened from; otherwise the parent, by replace (a detail opened from
 * a link or a reload leaves the app's history as it was).
 */
export function backTarget(route: Route, previous: Route | undefined): 'history' | Route {
  const parent = parentOf(route);
  if (previous && sameScreen(previous, parent)) return 'history';
  if (route.name === 'previews' && previous?.name === 'playlists' && previous.id) return 'history';
  return parent;
}

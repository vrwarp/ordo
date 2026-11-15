import { useSyncExternalStore } from 'react';
import { parseRoute, type Route, routeHash } from './lib/route.ts';

function subscribe(fn: () => void): () => void {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return parseRoute(hash) ?? { name: 'live' };
}

/**
 * Go to a route. With `replace` the current history entry is replaced (a redirect that must not grow
 * history: design/28 §3.1); otherwise a new entry is pushed, as before.
 */
export function navigate(r: Route | string, opts: { replace?: boolean } = {}): void {
  const hash = typeof r === 'string' ? r : routeHash(r);
  if (!opts.replace) {
    location.hash = hash;
    return;
  }
  const u = new URL(location.href);
  u.hash = hash;
  // A fragment-only navigation: no reload, hashchange fires, the entry is replaced.
  location.replace(u.href);
}

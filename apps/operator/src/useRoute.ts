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

export function navigate(r: Route | string): void {
  location.hash = typeof r === 'string' ? r : routeHash(r);
}

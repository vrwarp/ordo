import { useEffect, useState } from 'react';

/** A finger, not a mouse: the primary pointer is coarse (iPad, phone). Desktop Chrome with a mouse is false. */
export const COARSE_QUERY = '(pointer: coarse)';

function matches(q: string): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(q).matches;
  } catch {
    return false;
  }
}

/** Follows a media query (re-renders when it changes, e.g. an iPad rotating or a keyboard attaching). */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => matches(query));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const fn = () => setOn(mq.matches);
    fn();
    mq.addEventListener?.('change', fn);
    return () => mq.removeEventListener?.('change', fn);
  }, [query]);
  return on;
}

export function useCoarsePointer(): boolean {
  return useMedia(COARSE_QUERY);
}

export function isCoarsePointer(): boolean {
  return matches(COARSE_QUERY);
}

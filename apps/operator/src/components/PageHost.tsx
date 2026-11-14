import { createElement, type FunctionComponent, type ReactNode, useState } from 'react';
import { type Chunk, hubAnswers, retryOrReload, useChunk } from '../pages.ts';
import { useLive } from '../state/live.ts';
import { PageError } from './ErrorBoundary.tsx';

/**
 * Whether this page may reload to load a page again: never while a service runs from it (the venue PC live, or
 * the outputs running from it), so a Retry never takes the keys away during a service.
 */
export function reloadSafe(): boolean {
  const l = useLive.getState();
  return l.authority !== 'fallback' && l.state.mode !== 'live';
}

/**
 * A page's Try again: load its chunk again, or reload the page when that cannot work and no service runs from
 * it. Resolves true when it held back from reloading because a service runs (Chromium keeps a failed import,
 * so nothing changes until the service ends): the page's error then says so (review of P0 repair 1).
 */
export async function retryPage(
  chunk: Chunk<unknown>,
  deps: { reachable: () => Promise<boolean>; reload: () => void; safe: () => boolean } = {
    reachable: hubAnswers,
    reload: () => location.reload(),
    safe: reloadSafe,
  },
): Promise<boolean> {
  return (await retryOrReload([chunk], deps)) === 'held';
}

/**
 * A page from the registry (src/pages.ts): rendered synchronously once its module has loaded (a preloaded
 * page shows at once, with no Suspense fallback); "Loading…" while it loads; the page error with a Retry that
 * loads it again when it failed (a dropped connection, a stale chunk after a deploy), and reloads the page when
 * that cannot work (Chromium keeps a failed import) and no service runs from it; while one does, the error says
 * the page comes back after the service.
 */
export function PageHost<P extends object>(host: {
  chunk: Chunk<(props: P) => ReactNode>;
  props: P;
  name: string;
}) {
  const s = useChunk(host.chunk);
  const [held, setHeld] = useState(false);
  if (s.status === 'loaded' && s.value) return createElement(s.value as FunctionComponent<P>, host.props);
  if (s.status === 'failed')
    return (
      <PageError
        route={host.name}
        held={held}
        retry={() => void retryPage(host.chunk as Chunk<unknown>).then(setHeld)}
      />
    );
  return (
    <div className="center muted" data-page-loading>
      Loading…
    </div>
  );
}

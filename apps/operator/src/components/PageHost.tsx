import { createElement, type FunctionComponent, type ReactNode } from 'react';
import { type Chunk, hubAnswers, retryOrReload, useChunk } from '../pages.ts';
import { useLive } from '../state/live.ts';
import { PageError } from './ErrorBoundary.tsx';

/**
 * Whether this page may reload to load a page again: never while a service runs from it (the venue PC live, or
 * the outputs running from it), so a Retry never takes the keys away during a service.
 */
function reloadSafe(): boolean {
  const l = useLive.getState();
  return l.authority !== 'fallback' && l.state.mode !== 'live';
}

/**
 * A page from the registry (src/pages.ts): rendered synchronously once its module has loaded (a preloaded
 * page shows at once, with no Suspense fallback); "Loading…" while it loads; the page error with a Retry that
 * loads it again when it failed (a dropped connection, a stale chunk after a deploy), and reloads the page when
 * that cannot work (Chromium keeps a failed import) and no service runs from it.
 */
export function PageHost<P extends object>(host: {
  chunk: Chunk<(props: P) => ReactNode>;
  props: P;
  name: string;
}) {
  const s = useChunk(host.chunk);
  if (s.status === 'loaded' && s.value) return createElement(s.value as FunctionComponent<P>, host.props);
  if (s.status === 'failed')
    return (
      <PageError
        route={host.name}
        retry={() =>
          void retryOrReload([host.chunk as Chunk<unknown>], {
            reachable: hubAnswers,
            reload: () => location.reload(),
            safe: reloadSafe,
          })
        }
      />
    );
  return (
    <div className="center muted" data-page-loading>
      Loading…
    </div>
  );
}

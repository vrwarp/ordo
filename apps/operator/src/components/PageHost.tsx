import { createElement, type FunctionComponent, type ReactNode } from 'react';
import { type Chunk, useChunk } from '../pages.ts';
import { PageError } from './ErrorBoundary.tsx';

/**
 * A page from the registry (src/pages.ts): rendered synchronously once its module has loaded (a preloaded
 * page shows at once, with no Suspense fallback); "Loading…" while it loads; the page error with a Retry that
 * loads it again when it failed (a dropped connection, a stale chunk after a deploy).
 */
export function PageHost<P extends object>(host: {
  chunk: Chunk<(props: P) => ReactNode>;
  props: P;
  name: string;
}) {
  const s = useChunk(host.chunk);
  if (s.status === 'loaded' && s.value) return createElement(s.value as FunctionComponent<P>, host.props);
  if (s.status === 'failed')
    return <PageError route={host.name} retry={() => void host.chunk.load().catch(() => undefined)} />;
  return (
    <div className="center muted" data-page-loading>
      Loading…
    </div>
  );
}
